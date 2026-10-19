import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

const withItems = { items: { orderBy: { sku: 'asc' } } } satisfies Prisma.OrderInclude;

export type OrderWithItems = Prisma.OrderGetPayload<{ include: typeof withItems }>;

@Injectable()
export class OrderRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(
    data: Prisma.OrderCreateInput,
    db: Prisma.TransactionClient = this.prisma
  ): Promise<OrderWithItems> {
    return await db.order.create({ data, include: withItems });
  }

  async findById(id: string): Promise<OrderWithItems | null> {
    return await this.prisma.order.findUnique({ where: { id }, include: withItems });
  }
}
