import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PaymentService } from '../payments/payment.service';
import { PrismaService } from '../prisma/prisma.service';
import { errorReason } from '../common/error-reason';
import { OrderRepository, OrderWithItems } from './order.repository';
import { OrderService } from './order.service';

const BATCH_SIZE = 100;

@Injectable()
export class OrderExpiryService {
  private readonly logger = new Logger(OrderExpiryService.name);
  private readonly ttlMs: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly orderRepository: OrderRepository,
    private readonly orderService: OrderService,
    private readonly paymentService: PaymentService,
    config: ConfigService
  ) {
    this.ttlMs = config.getOrThrow<number>('ORDER_PAYMENT_TTL_MINUTES') * 60_000;
  }

  // every step is conditional, so two instances running this at once only cost a few wasted calls
  async expireUnpaid(): Promise<number> {
    const orders = await this.orderRepository.findPendingCreatedBefore(
      new Date(Date.now() - this.ttlMs),
      BATCH_SIZE
    );

    let expired = 0;
    for (const order of orders) {
      try {
        if (await this.expire(order)) {
          expired++;
        }
      } catch (error) {
        this.logger.warn(`could not expire order ${order.id}: ${errorReason(error)}`);
      }
    }

    if (expired > 0) {
      this.logger.log(`expired ${expired} unpaid orders`);
    }

    return expired;
  }

  // the intent is cancelled at stripe first, so the buyer can't pay for an order that's about to be
  // cancelled here. the payment_intent.canceled webhook that follows finds it already cancelled
  private async expire(order: OrderWithItems): Promise<boolean> {
    if (order.paymentIntentId && !(await this.paymentService.cancelIntent(order.paymentIntentId))) {
      return false;
    }

    return await this.prisma.$transaction((tx) => this.orderService.cancel(order, tx));
  }
}
