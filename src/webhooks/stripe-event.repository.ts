import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class StripeEventRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(
    id: string,
    type: string,
    db: Prisma.TransactionClient = this.prisma
  ): Promise<void> {
    await db.stripeEvent.create({ data: { id, type } });
  }
}
