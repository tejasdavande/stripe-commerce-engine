import { Injectable } from '@nestjs/common';
import { EventPublisher } from '../messaging/event-publisher';
import { PrismaService } from '../prisma/prisma.service';
import { OutboxRepository } from './outbox.repository';

export const RELAY_BATCH_SIZE = 100;

@Injectable()
export class OutboxRelayService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly outboxRepository: OutboxRepository,
    private readonly eventPublisher: EventPublisher
  ) {}

  async relayPending(): Promise<number> {
    let total = 0;

    for (;;) {
      const relayed = await this.relayBatch();
      total += relayed;

      if (relayed < RELAY_BATCH_SIZE) {
        return total;
      }
    }
  }

  // publishing inside the tx means a crash between the broker confirm and the commit sends the
  // batch again on the next run, so delivery is at least once and consumers dedupe on messageId
  private relayBatch(): Promise<number> {
    return this.prisma.$transaction(
      async (tx) => {
        const events = await this.outboxRepository.claimUnpublished(RELAY_BATCH_SIZE, tx);
        if (events.length === 0) {
          return 0;
        }

        await this.eventPublisher.publish(
          events.map((event) => ({
            id: event.id,
            type: event.type,
            payload: event.payload,
            occurredAt: event.createdAt,
          }))
        );
        await this.outboxRepository.markPublished(
          events.map((event) => event.id),
          tx
        );

        return events.length;
      },
      { timeout: 30_000 }
    );
  }
}
