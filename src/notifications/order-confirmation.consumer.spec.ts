import { EventEmitter } from 'events';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ConsumeMessage } from 'amqplib';
import { connectBroker } from '../messaging/connect-broker';
import {
  DEAD_LETTER_EXCHANGE,
  DELIVERY_LIMIT,
  ORDER_CONFIRMATIONS_QUEUE,
  OrderConfirmationConsumer,
} from './order-confirmation.consumer';
import { OrderConfirmationService } from './order-confirmation.service';

jest.mock('../messaging/connect-broker', () => ({ connectBroker: jest.fn() }));

class FakeChannel extends EventEmitter {
  onMessage?: (message: ConsumeMessage | null) => void;
  assertExchange = jest.fn().mockResolvedValue({});
  assertQueue = jest.fn().mockResolvedValue({});
  bindQueue = jest.fn().mockResolvedValue({});
  prefetch = jest.fn().mockResolvedValue(undefined);
  consume = jest.fn(async (_queue: string, onMessage: (message: ConsumeMessage | null) => void) => {
    this.onMessage = onMessage;
    return { consumerTag: 'tag' };
  });
  ack = jest.fn();
  nack = jest.fn();
}

class FakeConnection extends EventEmitter {
  channel = new FakeChannel();
  createChannel = jest.fn().mockResolvedValue(this.channel);
  close = jest.fn().mockImplementation(async () => {
    this.emit('close');
  });
}

describe('OrderConfirmationConsumer', () => {
  const connectMock = connectBroker as jest.Mock;
  const config = { getOrThrow: () => 'amqp://localhost:5672' } as unknown as ConfigService;
  const body = {
    orderId: 'f4d3f7a4-3c3e-4a5e-9a59-2a1c2b0f5a11',
    email: 'buyer@example.com',
    totalAmount: 1500,
    currency: 'usd',
  };

  let orderConfirmationService: jest.Mocked<Pick<OrderConfirmationService, 'handle'>>;
  let consumer: OrderConfirmationConsumer;

  const message = (overrides: { content?: string; messageId?: string; deliveries?: number } = {}) =>
    ({
      content: Buffer.from(overrides.content ?? JSON.stringify(body)),
      fields: {},
      properties: {
        messageId: 'messageId' in overrides ? overrides.messageId : 'msg-1',
        headers: overrides.deliveries ? { 'x-delivery-count': overrides.deliveries } : {},
      },
    }) as unknown as ConsumeMessage;

  const flush = () => new Promise((resolve) => setImmediate(resolve));

  const started = async () => {
    const connection = new FakeConnection();
    connectMock.mockResolvedValueOnce(connection);
    consumer.onApplicationBootstrap();
    await flush();
    return connection;
  };

  beforeEach(() => {
    jest.useRealTimers();
    connectMock.mockReset();
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
    orderConfirmationService = { handle: jest.fn().mockResolvedValue(true) };
    consumer = new OrderConfirmationConsumer(
      config,
      orderConfirmationService as unknown as OrderConfirmationService
    );
  });

  afterEach(async () => {
    await consumer.onModuleDestroy();
    jest.restoreAllMocks();
  });

  it('declares a quorum queue with a delivery limit and a dead-letter queue', async () => {
    const { channel } = await started();

    expect(channel.assertQueue).toHaveBeenCalledWith(ORDER_CONFIRMATIONS_QUEUE, {
      durable: true,
      deadLetterExchange: DEAD_LETTER_EXCHANGE,
      deadLetterRoutingKey: ORDER_CONFIRMATIONS_QUEUE,
      arguments: { 'x-queue-type': 'quorum', 'x-delivery-limit': DELIVERY_LIMIT },
    });
    expect(channel.bindQueue).toHaveBeenCalledWith(
      ORDER_CONFIRMATIONS_QUEUE,
      'commerce.events',
      'order.paid'
    );
    expect(channel.consume).toHaveBeenCalledWith(ORDER_CONFIRMATIONS_QUEUE, expect.any(Function));
  });

  it('acks a message once it has been handled', async () => {
    const { channel } = await started();
    const msg = message();

    channel.onMessage!(msg);
    await flush();

    expect(orderConfirmationService.handle).toHaveBeenCalledWith(
      'msg-1',
      expect.objectContaining({ orderId: body.orderId })
    );
    expect(channel.ack).toHaveBeenCalledWith(msg);
  });

  it.each([
    ['invalid json', message({ content: '{oops' })],
    ['a payload without an email', message({ content: JSON.stringify({ ...body, email: '' }) })],
    ['no message id', message({ messageId: undefined })],
  ])('dead-letters %s without handling it', async (_, msg) => {
    const { channel } = await started();

    channel.onMessage!(msg);
    await flush();

    expect(orderConfirmationService.handle).not.toHaveBeenCalled();
    expect(channel.nack).toHaveBeenCalledWith(msg, false, false);
  });

  it('requeues a failed message after a delay that grows with each delivery', async () => {
    const { channel } = await started();
    jest.useFakeTimers();
    orderConfirmationService.handle.mockRejectedValue(new Error('db down'));
    const msg = message({ deliveries: 2 });

    channel.onMessage!(msg);
    await jest.advanceTimersByTimeAsync(3_999);
    expect(channel.nack).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(1);
    expect(channel.nack).toHaveBeenCalledWith(msg, false, true);
  });

  it('dead-letters a message that fails on its last allowed delivery', async () => {
    const { channel } = await started();
    orderConfirmationService.handle.mockRejectedValue(new Error('db down'));
    const msg = message({ deliveries: DELIVERY_LIMIT });

    channel.onMessage!(msg);
    await flush();

    expect(channel.nack).toHaveBeenCalledWith(msg, false, false);
  });

  it('does not schedule a requeue once it is shutting down', async () => {
    const { channel } = await started();
    let fail!: (error: Error) => void;
    orderConfirmationService.handle.mockReturnValueOnce(
      new Promise((_, reject) => {
        fail = reject;
      })
    );

    channel.onMessage!(message());
    await consumer.onModuleDestroy();
    fail(new Error('db closed'));
    await flush();

    expect(channel.nack).not.toHaveBeenCalled();
  });

  it('keeps retrying the connection while the broker is down', async () => {
    jest.useFakeTimers();
    connectMock
      .mockRejectedValueOnce(new Error('could not connect to rabbitmq: ECONNREFUSED'))
      .mockRejectedValueOnce(new Error('could not connect to rabbitmq: ECONNREFUSED'))
      .mockResolvedValueOnce(new FakeConnection());

    consumer.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(10_000);

    expect(connectMock).toHaveBeenCalledTimes(3);
    expect(Logger.prototype.warn).toHaveBeenCalledTimes(1);
    expect(Logger.prototype.log).toHaveBeenCalledWith(
      `reconnected, consuming ${ORDER_CONFIRMATIONS_QUEUE} again`
    );
  });

  it('reconnects when the connection drops', async () => {
    jest.useFakeTimers();
    const connection = new FakeConnection();
    connectMock.mockResolvedValueOnce(connection).mockResolvedValueOnce(new FakeConnection());
    consumer.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(0);

    connection.emit('close');
    await jest.advanceTimersByTimeAsync(5_000);

    expect(connectMock).toHaveBeenCalledTimes(2);
  });

  it('does not reconnect after shutdown', async () => {
    jest.useFakeTimers();
    connectMock.mockResolvedValueOnce(new FakeConnection());
    consumer.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(0);

    await consumer.onModuleDestroy();
    await jest.advanceTimersByTimeAsync(10_000);

    expect(connectMock).toHaveBeenCalledTimes(1);
  });
});
