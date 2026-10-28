import { EventEmitter } from 'events';
import { ConfigService } from '@nestjs/config';
import { connect } from 'amqplib';
import { EVENTS_EXCHANGE, EventPublisher } from './event-publisher';

jest.mock('amqplib', () => ({ connect: jest.fn() }));

class FakeChannel extends EventEmitter {
  publish = jest.fn().mockReturnValue(true);
  assertExchange = jest.fn().mockResolvedValue({});
  waitForConfirms = jest.fn().mockResolvedValue(undefined);
}

class FakeConnection extends EventEmitter {
  channel = new FakeChannel();
  createConfirmChannel = jest.fn().mockResolvedValue(this.channel);
  close = jest.fn().mockImplementation(async () => {
    this.emit('close');
  });
}

describe('EventPublisher', () => {
  const connectMock = connect as jest.Mock;
  const config = { getOrThrow: () => 'amqp://localhost:5672' } as unknown as ConfigService;
  const event = {
    id: 'evt-1',
    type: 'order.paid',
    payload: { orderId: 'order-1', status: 'paid' },
    occurredAt: new Date('2026-10-28T10:00:00Z'),
  };

  let publisher: EventPublisher;

  beforeEach(() => {
    connectMock.mockReset();
    publisher = new EventPublisher(config);
  });

  it('publishes persistent json messages keyed by event type and waits for confirms', async () => {
    const connection = new FakeConnection();
    connectMock.mockResolvedValue(connection);

    await publisher.publish([event]);

    expect(connection.channel.assertExchange).toHaveBeenCalledWith(EVENTS_EXCHANGE, 'topic', {
      durable: true,
    });
    const [exchange, routingKey, content, options] = connection.channel.publish.mock.calls[0];
    expect(exchange).toBe(EVENTS_EXCHANGE);
    expect(routingKey).toBe('order.paid');
    expect(JSON.parse(content.toString())).toEqual(event.payload);
    expect(options).toEqual({
      persistent: true,
      contentType: 'application/json',
      messageId: 'evt-1',
      type: 'order.paid',
      timestamp: 1793181600,
    });
    expect(connection.channel.waitForConfirms).toHaveBeenCalled();
  });

  it('reuses one channel across publishes', async () => {
    connectMock.mockResolvedValue(new FakeConnection());

    await publisher.publish([event]);
    await publisher.publish([event]);

    expect(connectMock).toHaveBeenCalledTimes(1);
  });

  it('does not connect for an empty batch', async () => {
    await publisher.publish([]);

    expect(connectMock).not.toHaveBeenCalled();
  });

  it('reconnects after the connection closes', async () => {
    const first = new FakeConnection();
    connectMock.mockResolvedValueOnce(first).mockResolvedValueOnce(new FakeConnection());

    await publisher.publish([event]);
    first.emit('close');
    await publisher.publish([event]);

    expect(connectMock).toHaveBeenCalledTimes(2);
  });

  it('retries the connection on the next publish after a failed connect', async () => {
    connectMock
      .mockRejectedValueOnce(Object.assign(new AggregateError([], ''), { code: 'ECONNREFUSED' }))
      .mockResolvedValueOnce(new FakeConnection());

    await expect(publisher.publish([event])).rejects.toThrow(
      'could not connect to rabbitmq: ECONNREFUSED'
    );
    await expect(publisher.publish([event])).resolves.toBeUndefined();
  });

  it('drops the connection when the broker nacks, so the next publish starts clean', async () => {
    const first = new FakeConnection();
    first.channel.waitForConfirms.mockRejectedValueOnce(new Error('message nacked'));
    connectMock.mockResolvedValueOnce(first).mockResolvedValueOnce(new FakeConnection());

    await expect(publisher.publish([event])).rejects.toThrow('message nacked');
    await publisher.publish([event]);

    expect(first.close).toHaveBeenCalled();
    expect(connectMock).toHaveBeenCalledTimes(2);
  });

  it('closes the connection when the channel closes on its own', async () => {
    const connection = new FakeConnection();
    connectMock.mockResolvedValue(connection);

    await publisher.publish([event]);
    connection.channel.emit('close');

    expect(connection.close).toHaveBeenCalled();
  });
});
