import { ConflictException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { Prisma, Product } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ProductRepository } from '../products/product.repository';
import { IdempotencyKeyRepository } from './idempotency-key.repository';
import { OrderRepository, OrderWithItems } from './order.repository';
import { OrderService } from './order.service';

describe('OrderService', () => {
  const makeProduct = (id: string, overrides: Partial<Product> = {}): Product => ({
    id,
    sku: `SKU-${id.slice(0, 4)}`,
    name: `Product ${id.slice(0, 4)}`,
    description: null,
    unitAmount: 1000,
    currency: 'usd',
    stock: 10,
    active: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  });

  const idA = '1a1a1a1a-0000-4000-8000-000000000001';
  const idB = '2b2b2b2b-0000-4000-8000-000000000002';
  const tx = { tx: true };

  let productRepository: jest.Mocked<Pick<ProductRepository, 'findActiveByIds' | 'reserveStock'>>;
  let orderRepository: jest.Mocked<Pick<OrderRepository, 'create' | 'findById'>>;
  let idempotencyKeyRepository: jest.Mocked<Pick<IdempotencyKeyRepository, 'create' | 'findByKey'>>;
  let service: OrderService;

  beforeEach(() => {
    productRepository = {
      findActiveByIds: jest
        .fn()
        .mockResolvedValue([makeProduct(idB, { unitAmount: 2500 }), makeProduct(idA)]),
      reserveStock: jest.fn().mockResolvedValue(true),
    };
    orderRepository = {
      create: jest.fn().mockImplementation(async (data) => ({
        id: 'order-1',
        email: data.email,
        status: 'pending_payment',
        currency: data.currency,
        totalAmount: data.totalAmount,
        createdAt: new Date(),
        updatedAt: new Date(),
        items: data.items.create.map((item: { product: { connect: { id: string } } }) => ({
          ...item,
          productId: item.product.connect.id,
        })),
      })),
      findById: jest.fn().mockResolvedValue(null),
    };
    idempotencyKeyRepository = {
      create: jest.fn().mockResolvedValue(undefined),
      findByKey: jest.fn().mockResolvedValue(null),
    };
    const prisma = {
      $transaction: jest.fn((fn: (client: unknown) => Promise<unknown>) => fn(tx)),
    };
    service = new OrderService(
      prisma as unknown as PrismaService,
      productRepository as unknown as ProductRepository,
      orderRepository as unknown as OrderRepository,
      idempotencyKeyRepository as unknown as IdempotencyKeyRepository
    );
  });

  it('merges duplicate lines, reserves in product id order and prices from the catalog', async () => {
    const { order, replayed } = await service.create({
      email: 'buyer@example.com',
      items: [
        { productId: idB, quantity: 1 },
        { productId: idA, quantity: 2 },
        { productId: idB, quantity: 2 },
      ],
    });

    expect(productRepository.findActiveByIds).toHaveBeenCalledWith([idA, idB], tx);
    expect(productRepository.reserveStock.mock.calls).toEqual([
      [idA, 2, tx],
      [idB, 3, tx],
    ]);
    expect(orderRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({ currency: 'usd', totalAmount: 2 * 1000 + 3 * 2500 }),
      tx
    );
    expect(order.items.map((item) => item.lineAmount)).toEqual([2000, 7500]);
    expect(replayed).toBe(false);
    expect(idempotencyKeyRepository.create).not.toHaveBeenCalled();
  });

  it('throws 404 for unknown or inactive products before reserving anything', async () => {
    productRepository.findActiveByIds.mockResolvedValue([makeProduct(idA)]);

    await expect(
      service.create({
        email: 'buyer@example.com',
        items: [
          { productId: idA, quantity: 1 },
          { productId: idB, quantity: 1 },
        ],
      })
    ).rejects.toThrow(new NotFoundException(`products not found: ${idB}`));
    expect(productRepository.reserveStock).not.toHaveBeenCalled();
  });

  it('throws 422 when products use different currencies', async () => {
    productRepository.findActiveByIds.mockResolvedValue([
      makeProduct(idA),
      makeProduct(idB, { currency: 'eur' }),
    ]);

    await expect(
      service.create({
        email: 'buyer@example.com',
        items: [
          { productId: idA, quantity: 1 },
          { productId: idB, quantity: 1 },
        ],
      })
    ).rejects.toThrow(UnprocessableEntityException);
    expect(productRepository.reserveStock).not.toHaveBeenCalled();
  });

  it('throws 409 and creates no order when stock runs out', async () => {
    productRepository.reserveStock.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    await expect(
      service.create({
        email: 'buyer@example.com',
        items: [
          { productId: idA, quantity: 1 },
          { productId: idB, quantity: 1 },
        ],
      })
    ).rejects.toThrow(new ConflictException(`not enough stock for SKU-2b2b`));
    expect(orderRepository.create).not.toHaveBeenCalled();
  });

  describe('with an idempotency key', () => {
    const dto = { email: 'buyer@example.com', items: [{ productId: idA, quantity: 1 }] };
    const uniqueViolation = () =>
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: 'test',
      });

    it('stores the key before reserving stock and links it to the order', async () => {
      const callOrder: string[] = [];
      idempotencyKeyRepository.create.mockImplementation(async () => {
        callOrder.push('key');
      });
      productRepository.reserveStock.mockImplementation(async () => {
        callOrder.push('reserve');
        return true;
      });

      const { replayed } = await service.create(dto, 'key-1');

      expect(replayed).toBe(false);
      expect(idempotencyKeyRepository.create).toHaveBeenCalledWith(
        'key-1',
        expect.stringMatching(/^[0-9a-f]{64}$/),
        tx
      );
      expect(callOrder).toEqual(['key', 'reserve']);
      expect(orderRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ idempotencyKey: { connect: { key: 'key-1' } } }),
        tx
      );
    });

    it('replays the stored order when the key was already used for the same request', async () => {
      await service.create(dto, 'key-1');
      const requestHash = idempotencyKeyRepository.create.mock.calls[0][1];
      idempotencyKeyRepository.create.mockRejectedValue(uniqueViolation());
      idempotencyKeyRepository.findByKey.mockResolvedValue({
        key: 'key-1',
        requestHash,
        orderId: 'order-1',
        createdAt: new Date(),
      });
      orderRepository.findById.mockResolvedValue({
        id: 'order-1',
        email: dto.email,
        status: 'paid',
        currency: 'usd',
        totalAmount: 1000,
        paymentIntentId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        items: [],
      });
      productRepository.reserveStock.mockClear();

      const { order, replayed } = await service.create(dto, 'key-1');

      expect(replayed).toBe(true);
      expect(order).toMatchObject({ id: 'order-1', status: 'paid' });
      expect(productRepository.reserveStock).not.toHaveBeenCalled();
    });

    it('throws 422 when the key was used with a different request', async () => {
      idempotencyKeyRepository.create.mockRejectedValue(uniqueViolation());
      idempotencyKeyRepository.findByKey.mockResolvedValue({
        key: 'key-1',
        requestHash: 'a'.repeat(64),
        orderId: 'order-1',
        createdAt: new Date(),
      });

      await expect(service.create(dto, 'key-1')).rejects.toThrow(UnprocessableEntityException);
    });

    it('rethrows errors that are not a key conflict', async () => {
      productRepository.reserveStock.mockResolvedValue(false);

      await expect(service.create(dto, 'key-1')).rejects.toThrow(ConflictException);
      expect(idempotencyKeyRepository.findByKey).not.toHaveBeenCalled();
    });

    it('hashes the same request the same way and a different one differently', async () => {
      await service.create(dto, 'key-1');
      await service.create(dto, 'key-2');
      await service.create({ ...dto, items: [{ productId: idA, quantity: 2 }] }, 'key-3');

      const [first, second, third] = idempotencyKeyRepository.create.mock.calls.map(
        (call) => call[1]
      );
      expect(first).toBe(second);
      expect(third).not.toBe(first);
    });
  });

  it('throws 404 for an unknown order', async () => {
    await expect(service.getById(idA)).rejects.toThrow(NotFoundException);
  });

  it('returns an order with line amounts', async () => {
    orderRepository.findById.mockResolvedValue({
      id: 'order-1',
      email: 'buyer@example.com',
      status: 'pending_payment',
      currency: 'usd',
      totalAmount: 5000,
      paymentIntentId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      items: [
        {
          id: 'item-1',
          orderId: 'order-1',
          productId: idA,
          sku: 'SKU-1a1a',
          name: 'Product 1a1a',
          unitAmount: 2500,
          quantity: 2,
        },
      ],
    } satisfies OrderWithItems);

    const order = await service.getById('order-1');

    expect(order.items).toEqual([expect.objectContaining({ quantity: 2, lineAmount: 5000 })]);
    expect(order).not.toHaveProperty('updatedAt');
  });
});
