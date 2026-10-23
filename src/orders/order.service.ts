import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { createHash } from 'crypto';
import { Order, OrderStatus, Prisma, Product } from '../generated/prisma/client';
import { PaymentService } from '../payments/payment.service';
import { isUniqueViolation } from '../prisma/is-unique-violation';
import { PrismaService } from '../prisma/prisma.service';
import { ProductRepository } from '../products/product.repository';
import { CreateOrderDto } from './dto/create-order.dto';
import { OrderLineDto } from './dto/order-line.dto';
import { OrderResponseDto } from './dto/order-response.dto';
import { IdempotencyKeyRepository } from './idempotency-key.repository';
import { canTransition } from './order-transitions';
import { OrderRepository, OrderWithItems } from './order.repository';

export interface CreateOrderResult {
  order: OrderResponseDto;
  replayed: boolean;
}

export interface ReceivedPayment {
  paymentIntentId: string;
  amount: number;
  currency: string;
}

@Injectable()
export class OrderService {
  private readonly logger = new Logger(OrderService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly productRepository: ProductRepository,
    private readonly orderRepository: OrderRepository,
    private readonly idempotencyKeyRepository: IdempotencyKeyRepository,
    private readonly paymentService: PaymentService
  ) {}

  async create(dto: CreateOrderDto, idempotencyKey?: string): Promise<CreateOrderResult> {
    if (!idempotencyKey) {
      return { order: await this.checkout(await this.placeOrder(dto)), replayed: false };
    }

    const requestHash = this.hashRequest(dto);
    let order: OrderWithItems;

    try {
      order = await this.placeOrder(dto, { key: idempotencyKey, requestHash });
    } catch (error) {
      if (!isUniqueViolation(error)) {
        throw error;
      }

      const stored = await this.replay(idempotencyKey, requestHash);
      return { order: await this.checkout(stored), replayed: true };
    }

    return { order: await this.checkout(order), replayed: false };
  }

  async getById(id: string): Promise<OrderResponseDto> {
    return OrderResponseDto.fromModel(await this.findOrThrow(id));
  }

  // fulfilling twice is a no-op, so a warehouse system can retry the call safely
  async fulfil(id: string): Promise<OrderResponseDto> {
    const order = await this.findOrThrow(id);

    if (order.status === OrderStatus.fulfilled) {
      return OrderResponseDto.fromModel(order);
    }

    if (
      !canTransition(order.status, OrderStatus.fulfilled) ||
      !(await this.orderRepository.transition(id, order.status, OrderStatus.fulfilled))
    ) {
      throw new ConflictException(`order is ${order.status}, only paid orders can be fulfilled`);
    }

    return OrderResponseDto.fromModel(await this.findOrThrow(id));
  }

  async markPaid(
    { paymentIntentId, amount, currency }: ReceivedPayment,
    db: Prisma.TransactionClient
  ): Promise<void> {
    const order = await this.orderRepository.findByPaymentIntent(paymentIntentId, db);

    if (!order) {
      this.logger.warn(`payment intent ${paymentIntentId} succeeded but matches no order`);
      return;
    }

    if (order.totalAmount !== amount || order.currency !== currency) {
      this.logger.error(
        `order ${order.id} expected ${order.totalAmount} ${order.currency} but intent ${paymentIntentId} received ${amount} ${currency}`
      );
      return;
    }

    await this.transition(order, OrderStatus.paid, db);
  }

  async cancelForPayment(paymentIntentId: string, db: Prisma.TransactionClient): Promise<void> {
    const order = await this.orderRepository.findByPaymentIntent(paymentIntentId, db);

    if (!order) {
      this.logger.warn(`payment intent ${paymentIntentId} was canceled but matches no order`);
      return;
    }

    if (!(await this.transition(order, OrderStatus.cancelled, db))) {
      return;
    }

    // product id order, same as placeOrder, so this can't deadlock with a concurrent checkout
    const items = [...order.items].sort((a, b) => (a.productId < b.productId ? -1 : 1));
    for (const { productId, quantity } of items) {
      await this.productRepository.releaseStock(productId, quantity, db);
    }
  }

  // returns whether this call moved the order. a webhook can't fix an illegal transition by
  // retrying, so it's logged and acknowledged.
  // TODO: a payment that lands on a cancelled order needs a refund
  private async transition(
    order: Order,
    to: OrderStatus,
    db: Prisma.TransactionClient
  ): Promise<boolean> {
    if (order.status === to) {
      return false;
    }

    if (!canTransition(order.status, to)) {
      this.logger.error(`order ${order.id} can't go from ${order.status} to ${to}`);
      return false;
    }

    if (!(await this.orderRepository.transition(order.id, order.status, to, db))) {
      throw new ConflictException(`order ${order.id} changed status concurrently`);
    }

    return true;
  }

  // runs after the order transaction commits, so no product rows stay locked during the stripe call.
  // if stripe fails the order stays pending_payment without an intent, and a retry with the same
  // Idempotency-Key replays the order and creates the intent then
  private async checkout(order: OrderWithItems): Promise<OrderResponseDto> {
    if (order.status !== OrderStatus.pending_payment) {
      return OrderResponseDto.fromModel(order);
    }

    if (order.paymentIntentId) {
      const clientSecret = await this.paymentService.getClientSecret(order.paymentIntentId);
      return OrderResponseDto.fromModel(order, clientSecret);
    }

    const intent = await this.paymentService.createIntent({
      orderId: order.id,
      email: order.email,
      currency: order.currency,
      amount: order.totalAmount,
    });
    await this.orderRepository.setPaymentIntent(order.id, intent.id);

    return OrderResponseDto.fromModel(order, intent.clientSecret);
  }

  // the key row goes in first, so a concurrent request with the same key blocks on its primary key
  // until this transaction ends, then either replays the committed order or proceeds after a rollback
  private async placeOrder(
    { email, items }: CreateOrderDto,
    idempotency?: { key: string; requestHash: string }
  ): Promise<OrderWithItems> {
    const requested = this.mergeLines(items);

    return await this.prisma.$transaction(async (tx) => {
      if (idempotency) {
        await this.idempotencyKeyRepository.create(idempotency.key, idempotency.requestHash, tx);
      }

      const products = await this.productRepository.findActiveByIds(
        requested.map((line) => line.productId),
        tx
      );
      const byId = new Map(products.map((product) => [product.id, product]));

      const lines: { product: Product; quantity: number }[] = [];
      const missing: string[] = [];
      for (const { productId, quantity } of requested) {
        const product = byId.get(productId);
        if (product) {
          lines.push({ product, quantity });
        } else {
          missing.push(productId);
        }
      }

      if (missing.length > 0) {
        throw new NotFoundException(`products not found: ${missing.join(', ')}`);
      }

      if (new Set(products.map((product) => product.currency)).size > 1) {
        throw new UnprocessableEntityException('all items in an order must use the same currency');
      }

      for (const { product, quantity } of lines) {
        if (!(await this.productRepository.reserveStock(product.id, quantity, tx))) {
          throw new ConflictException(`not enough stock for ${product.sku}`);
        }
      }

      return await this.orderRepository.create(
        {
          email,
          currency: products[0].currency,
          totalAmount: lines.reduce(
            (sum, { product, quantity }) => sum + product.unitAmount * quantity,
            0
          ),
          items: {
            create: lines.map(({ product, quantity }) => ({
              product: { connect: { id: product.id } },
              sku: product.sku,
              name: product.name,
              unitAmount: product.unitAmount,
              quantity,
            })),
          },
          idempotencyKey: idempotency ? { connect: { key: idempotency.key } } : undefined,
        },
        tx
      );
    });
  }

  private async replay(key: string, requestHash: string): Promise<OrderWithItems> {
    const stored = await this.idempotencyKeyRepository.findByKey(key);

    if (!stored?.orderId) {
      throw new ConflictException('conflicting request for this Idempotency-Key, retry it');
    }

    if (stored.requestHash !== requestHash) {
      throw new UnprocessableEntityException(
        'this Idempotency-Key was already used with a different request'
      );
    }

    return await this.findOrThrow(stored.orderId);
  }

  private async findOrThrow(id: string): Promise<OrderWithItems> {
    const order = await this.orderRepository.findById(id);

    if (!order) {
      throw new NotFoundException('order not found');
    }

    return order;
  }

  private hashRequest({ email, items }: CreateOrderDto): string {
    const body = {
      email,
      items: items.map(({ productId, quantity }) => ({ productId, quantity })),
    };

    return createHash('sha256').update(JSON.stringify(body)).digest('hex');
  }

  // sorted by product id so concurrent orders lock product rows in the same order and can't deadlock
  private mergeLines(items: OrderLineDto[]): OrderLineDto[] {
    const quantities = new Map<string, number>();
    for (const { productId, quantity } of items) {
      quantities.set(productId, (quantities.get(productId) ?? 0) + quantity);
    }

    return [...quantities]
      .map(([productId, quantity]) => ({ productId, quantity }))
      .sort((a, b) => (a.productId < b.productId ? -1 : 1));
  }
}
