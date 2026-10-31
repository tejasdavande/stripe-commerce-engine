import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Channel, ChannelModel, ConsumeMessage } from 'amqplib';
import { connectBroker } from '../messaging/connect-broker';
import { EVENTS_EXCHANGE } from '../messaging/event-publisher';
import { errorReason } from '../common/error-reason';
import { OrderConfirmationService } from './order-confirmation.service';
import { parseOrderPaidMessage } from './order-paid.message';

export const ORDER_CONFIRMATIONS_QUEUE = 'order-confirmations';
export const DEAD_LETTER_EXCHANGE = 'commerce.dead-letter';
export const ORDER_CONFIRMATIONS_DEAD_LETTER_QUEUE = 'order-confirmations.dead-letter';
export const DELIVERY_LIMIT = 5;

const PREFETCH = 10;
const RECONNECT_DELAY_MS = 5_000;
const MAX_RETRY_DELAY_MS = 30_000;

@Injectable()
export class OrderConfirmationConsumer implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(OrderConfirmationConsumer.name);
  private connection?: ChannelModel;
  private starting?: Promise<void>;
  private reconnectTimer?: NodeJS.Timeout;
  private readonly retryTimers = new Set<NodeJS.Timeout>();
  private stopped = false;
  private failing = false;

  constructor(
    private readonly config: ConfigService,
    private readonly orderConfirmationService: OrderConfirmationService
  ) {}

  // not awaited, so the api boots and serves requests while the broker is down
  onApplicationBootstrap(): void {
    this.start();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    this.retryTimers.forEach((timer) => clearTimeout(timer));
    this.retryTimers.clear();
    await this.starting;
    await this.connection?.close().catch(() => undefined);
  }

  private start(): void {
    this.starting = this.consume()
      .then(() => {
        if (this.failing) {
          this.failing = false;
          this.logger.log(`reconnected, consuming ${ORDER_CONFIRMATIONS_QUEUE} again`);
        }
      })
      .catch((error: Error) => this.onFailure(error));
  }

  private async consume(): Promise<void> {
    const connection = await connectBroker(this.config.getOrThrow<string>('RABBITMQ_URL'));
    connection.on('error', (error: Error) => {
      this.logger.warn(`rabbitmq connection error: ${error.message}`);
    });

    try {
      const channel = await connection.createChannel();
      channel.on('error', (error: Error) => {
        this.logger.warn(`rabbitmq channel error: ${error.message}`);
      });
      channel.on('close', () => {
        connection.close().catch(() => undefined);
      });

      await this.assertTopology(channel);
      await channel.prefetch(PREFETCH);
      await channel.consume(ORDER_CONFIRMATIONS_QUEUE, (message) => {
        // null means the broker cancelled the consumer, e.g. the queue was deleted
        if (!message) {
          connection.close().catch(() => undefined);
          return;
        }
        void this.handle(channel, message);
      });
    } catch (error) {
      await connection.close().catch(() => undefined);
      throw error;
    }

    if (this.stopped) {
      await connection.close().catch(() => undefined);
      return;
    }

    this.connection = connection;
    connection.on('close', () => {
      if (this.connection === connection) {
        this.connection = undefined;
        this.onFailure(new Error('connection closed'));
      }
    });
  }

  private async assertTopology(channel: Channel): Promise<void> {
    await channel.assertExchange(EVENTS_EXCHANGE, 'topic', { durable: true });
    await channel.assertExchange(DEAD_LETTER_EXCHANGE, 'direct', { durable: true });
    await channel.assertQueue(ORDER_CONFIRMATIONS_DEAD_LETTER_QUEUE, {
      durable: true,
      arguments: { 'x-queue-type': 'quorum' },
    });
    await channel.bindQueue(
      ORDER_CONFIRMATIONS_DEAD_LETTER_QUEUE,
      DEAD_LETTER_EXCHANGE,
      ORDER_CONFIRMATIONS_QUEUE
    );
    // quorum queues count redeliveries (x-delivery-count) and dead-letter a message once it goes
    // past the limit, so a requeue loop can't go on forever
    await channel.assertQueue(ORDER_CONFIRMATIONS_QUEUE, {
      durable: true,
      deadLetterExchange: DEAD_LETTER_EXCHANGE,
      deadLetterRoutingKey: ORDER_CONFIRMATIONS_QUEUE,
      arguments: { 'x-queue-type': 'quorum', 'x-delivery-limit': DELIVERY_LIMIT },
    });
    await channel.bindQueue(ORDER_CONFIRMATIONS_QUEUE, EVENTS_EXCHANGE, 'order.paid');
  }

  private async handle(channel: Channel, message: ConsumeMessage): Promise<void> {
    const messageId: string | undefined = message.properties.messageId;
    const order = parseOrderPaidMessage(message.content);

    if (!messageId || !order) {
      this.logger.error(`dead-lettering malformed message ${messageId ?? '(no message id)'}`);
      this.settle(() => channel.nack(message, false, false));
      return;
    }

    try {
      await this.orderConfirmationService.handle(messageId, order);
      this.settle(() => channel.ack(message));
    } catch (error) {
      // the channel goes down with the app and the broker requeues the message
      if (this.stopped) {
        return;
      }

      const redeliveries = Number(message.properties.headers?.['x-delivery-count'] ?? 0);
      const reason = errorReason(error);

      if (redeliveries >= DELIVERY_LIMIT) {
        this.logger.error(
          `dead-lettering message ${messageId} after ${redeliveries + 1} attempts: ${reason}`
        );
        this.settle(() => channel.nack(message, false, false));
        return;
      }

      // holding on to the message before requeueing spaces out the retries, and while the database
      // is down every prefetch slot fills up, which pauses the consumer instead of burning through
      // the delivery limit in a few milliseconds
      const delay = Math.min(1_000 * 2 ** redeliveries, MAX_RETRY_DELAY_MS);
      this.logger.warn(`message ${messageId} failed, requeueing in ${delay}ms: ${reason}`);
      const timer = setTimeout(() => {
        this.retryTimers.delete(timer);
        this.settle(() => channel.nack(message, false, true));
      }, delay);
      this.retryTimers.add(timer);
    }
  }

  // acking on a channel that has closed since throws, and the broker requeues the message anyway
  private settle(fn: () => void): void {
    try {
      fn();
    } catch {
      return;
    }
  }

  private onFailure(error: Error): void {
    if (this.stopped || this.reconnectTimer) {
      return;
    }

    if (!this.failing) {
      this.failing = true;
      this.logger.warn(
        `not consuming ${ORDER_CONFIRMATIONS_QUEUE}, retrying every ${RECONNECT_DELAY_MS / 1000}s: ${error.message}`
      );
    }

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.start();
    }, RECONNECT_DELAY_MS);
  }
}
