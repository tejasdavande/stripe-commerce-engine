import { Injectable } from '@nestjs/common';
import { Order, OrderStatus, Prisma } from '../generated/prisma/client';
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

  async setPaymentIntent(id: string, paymentIntentId: string): Promise<boolean> {
    const { count } = await this.prisma.order.updateMany({
      where: { id, status: OrderStatus.pending_payment },
      data: { paymentIntentId },
    });

    return count === 1;
  }

  async findPendingCreatedBefore(createdBefore: Date, limit: number): Promise<OrderWithItems[]> {
    return await this.prisma.order.findMany({
      where: { status: OrderStatus.pending_payment, createdAt: { lt: createdBefore } },
      orderBy: { createdAt: 'asc' },
      take: limit,
      include: withItems,
    });
  }

  async findByPaymentIntent(
    paymentIntentId: string,
    db: Prisma.TransactionClient = this.prisma
  ): Promise<OrderWithItems | null> {
    return await db.order.findUnique({ where: { paymentIntentId }, include: withItems });
  }

  // only applies if the order still has the status and payment intent it was read with
  async transition(
    { id, status, paymentIntentId }: Pick<Order, 'id' | 'status' | 'paymentIntentId'>,
    to: OrderStatus,
    db: Prisma.TransactionClient = this.prisma
  ): Promise<boolean> {
    const { count } = await db.order.updateMany({
      where: { id, status, paymentIntentId },
      data: { status: to },
    });

    return count === 1;
  }
}
