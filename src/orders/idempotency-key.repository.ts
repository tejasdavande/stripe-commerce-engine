import { Injectable } from '@nestjs/common';
import { IdempotencyKey, Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class IdempotencyKeyRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(
    key: string,
    requestHash: string,
    db: Prisma.TransactionClient = this.prisma
  ): Promise<void> {
    await db.idempotencyKey.create({ data: { key, requestHash } });
  }

  async findByKey(key: string): Promise<IdempotencyKey | null> {
    return await this.prisma.idempotencyKey.findUnique({ where: { key } });
  }
}
