import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { createHash } from 'crypto';
import { Prisma, Product } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ProductRepository } from '../products/product.repository';
import { CreateOrderDto } from './dto/create-order.dto';
import { OrderLineDto } from './dto/order-line.dto';
import { OrderResponseDto } from './dto/order-response.dto';
import { IdempotencyKeyRepository } from './idempotency-key.repository';
import { OrderRepository } from './order.repository';

export interface CreateOrderResult {
  order: OrderResponseDto;
  replayed: boolean;
}

@Injectable()
export class OrderService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly productRepository: ProductRepository,
    private readonly orderRepository: OrderRepository,
    private readonly idempotencyKeyRepository: IdempotencyKeyRepository
  ) {}

  async create(dto: CreateOrderDto, idempotencyKey?: string): Promise<CreateOrderResult> {
    if (!idempotencyKey) {
      return { order: await this.placeOrder(dto), replayed: false };
    }

    const requestHash = this.hashRequest(dto);

    try {
      return {
        order: await this.placeOrder(dto, { key: idempotencyKey, requestHash }),
        replayed: false,
      };
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
        throw error;
      }
    }

    return { order: await this.replay(idempotencyKey, requestHash), replayed: true };
  }

  async getById(id: string): Promise<OrderResponseDto> {
    const order = await this.orderRepository.findById(id);

    if (!order) {
      throw new NotFoundException('order not found');
    }

    return OrderResponseDto.fromModel(order);
  }

  // the key row goes in first, so a concurrent request with the same key blocks on its primary key
  // until this transaction ends, then either replays the committed order or proceeds after a rollback
  private async placeOrder(
    { email, items }: CreateOrderDto,
    idempotency?: { key: string; requestHash: string }
  ): Promise<OrderResponseDto> {
    const requested = this.mergeLines(items);

    const order = await this.prisma.$transaction(async (tx) => {
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

    return OrderResponseDto.fromModel(order);
  }

  private async replay(key: string, requestHash: string): Promise<OrderResponseDto> {
    const stored = await this.idempotencyKeyRepository.findByKey(key);

    if (!stored?.orderId) {
      throw new ConflictException('conflicting request for this Idempotency-Key, retry it');
    }

    if (stored.requestHash !== requestHash) {
      throw new UnprocessableEntityException(
        'this Idempotency-Key was already used with a different request'
      );
    }

    return await this.getById(stored.orderId);
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
