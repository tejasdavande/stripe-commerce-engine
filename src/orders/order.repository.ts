import { Injectable } from '@nestjs/common';
import { OrderStatus, Prisma } from '../generated/prisma/client';
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

  async setPaymentIntent(id: string, paymentIntentId: string): Promise<void> {
    await this.prisma.order.update({ where: { id }, data: { paymentIntentId } });
  }

  async findByPaymentIntent(
    paymentIntentId: string,
    db: Prisma.TransactionClient = this.prisma
  ): Promise<OrderWithItems | null> {
    return await db.order.findUnique({ where: { paymentIntentId }, include: withItems });
  }

  async transition(
    id: string,
    from: OrderStatus,
    to: OrderStatus,
    db: Prisma.TransactionClient = this.prisma
  ): Promise<boolean> {
    const { count } = await db.order.updateMany({
      where: { id, status: from },
      data: { status: to },
    });

    return count === 1;
  }
}
