import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';

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
}
