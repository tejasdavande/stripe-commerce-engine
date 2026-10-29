import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class ProcessedMessageRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(
    consumer: string,
    messageId: string,
    db: Prisma.TransactionClient = this.prisma
  ): Promise<void> {
    await db.processedMessage.create({ data: { consumer, messageId } });
  }
}
