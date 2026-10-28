import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChannelModel, ConfirmChannel, connect } from 'amqplib';

export const EVENTS_EXCHANGE = 'commerce.events';

const CONNECT_TIMEOUT_MS = 5_000;
const CONFIRM_TIMEOUT_MS = 10_000;

export interface PublishableEvent {
  id: string;
  type: string;
  payload: unknown;
  occurredAt: Date;
}

@Injectable()
export class EventPublisher implements OnModuleDestroy {
  private readonly logger = new Logger(EventPublisher.name);
  private connection?: ChannelModel;
  private channel?: Promise<ConfirmChannel>;

  constructor(private readonly config: ConfigService) {}

  async publish(events: PublishableEvent[]): Promise<void> {
    if (events.length === 0) {
      return;
    }

    const channel = await this.getChannel();

    for (const event of events) {
      channel.publish(EVENTS_EXCHANGE, event.type, Buffer.from(JSON.stringify(event.payload)), {
        persistent: true,
        contentType: 'application/json',
        messageId: event.id,
        type: event.type,
        timestamp: Math.floor(event.occurredAt.getTime() / 1000),
      });
    }

    await this.waitForConfirms(channel);
  }

  async onModuleDestroy(): Promise<void> {
    await this.connection?.close().catch(() => undefined);
  }

  private getChannel(): Promise<ConfirmChannel> {
    if (!this.channel) {
      const channel = this.open();
      this.channel = channel;
      channel.catch(() => {
        if (this.channel === channel) {
          this.channel = undefined;
        }
      });
    }

    return this.channel;
  }

  private async open(): Promise<ConfirmChannel> {
    // a refused connection to a host with both ipv4 and ipv6 addresses is an AggregateError
    // with an empty message, so fall back to its code
    const connection = await connect(this.config.getOrThrow<string>('RABBITMQ_URL'), {
      timeout: CONNECT_TIMEOUT_MS,
    }).catch((error: NodeJS.ErrnoException) => {
      throw new Error(`could not connect to rabbitmq: ${error.message || error.code}`);
    });
    this.connection = connection;

    connection.on('error', (error: Error) => {
      this.logger.warn(`rabbitmq connection error: ${error.message}`);
    });
    connection.on('close', () => {
      if (this.connection === connection) {
        this.connection = undefined;
        this.channel = undefined;
      }
    });

    try {
      const channel = await connection.createConfirmChannel();
      channel.on('error', (error: Error) => {
        this.logger.warn(`rabbitmq channel error: ${error.message}`);
      });
      // a channel error (e.g. the exchange already declared with another type) closes only the
      // channel; dropping the connection with it keeps reconnecting in one place
      channel.on('close', () => {
        connection.close().catch(() => undefined);
      });

      await channel.assertExchange(EVENTS_EXCHANGE, 'topic', { durable: true });
      return channel;
    } catch (error) {
      await connection.close().catch(() => undefined);
      throw error;
    }
  }

  // a broker that stops answering without closing the socket would leave waitForConfirms
  // pending until the heartbeat notices, so give up sooner and reconnect next time
  private async waitForConfirms(channel: ConfirmChannel): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`no publisher confirm within ${CONFIRM_TIMEOUT_MS}ms`)),
        CONFIRM_TIMEOUT_MS
      );
    });

    try {
      await Promise.race([channel.waitForConfirms(), timeout]);
    } catch (error) {
      await this.connection?.close().catch(() => undefined);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}
