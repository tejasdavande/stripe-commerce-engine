import { Injectable } from '@nestjs/common';
import { OutboxEvent, Prisma } from '../generated/prisma/client';

@Injectable()
export class OutboxRepository {
  // no default client: an outbox row only means something if it commits with the change it describes
  async add(
    type: string,
    aggregateId: string,
    payload: Prisma.InputJsonObject,
    db: Prisma.TransactionClient
  ): Promise<void> {
    await db.outboxEvent.create({ data: { type, aggregateId, payload } });
  }

  // rows stay locked until the caller's tx ends, and SKIP LOCKED lets another relay take the next batch
  // instead of waiting on this one
  claimUnpublished(limit: number, db: Prisma.TransactionClient): Promise<OutboxEvent[]> {
    return db.$queryRaw<OutboxEvent[]>`
      SELECT id, type, aggregate_id AS "aggregateId", payload,
             created_at AS "createdAt", published_at AS "publishedAt"
      FROM outbox_events
      WHERE published_at IS NULL
      ORDER BY created_at, id
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED`;
  }

  async markPublished(ids: string[], db: Prisma.TransactionClient): Promise<void> {
    await db.outboxEvent.updateMany({
      where: { id: { in: ids } },
      data: { publishedAt: new Date() },
    });
  }
}
