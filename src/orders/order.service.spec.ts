import { ConflictException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { BadGatewayException } from '@nestjs/common';
import { OrderStatus, Prisma, Product } from '../generated/prisma/client';
import { OutboxRepository } from '../outbox/outbox.repository';
import { PaymentService } from '../payments/payment.service';
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

  let productRepository: jest.Mocked<
    Pick<ProductRepository, 'findActiveByIds' | 'reserveStock' | 'releaseStock'>
  >;
  let orderRepository: jest.Mocked<
    Pick<
      OrderRepository,
      'create' | 'findById' | 'setPaymentIntent' | 'findByPaymentIntent' | 'transition'
    >
  >;
  let idempotencyKeyRepository: jest.Mocked<Pick<IdempotencyKeyRepository, 'create' | 'findByKey'>>;
  let paymentService: jest.Mocked<
    Pick<PaymentService, 'createIntent' | 'getClientSecret' | 'cancelIntent'>
  >;
  let outboxRepository: jest.Mocked<Pick<OutboxRepository, 'add'>>;
  let service: OrderService;

  beforeEach(() => {
    productRepository = {
      findActiveByIds: jest
        .fn()
        .mockResolvedValue([makeProduct(idB, { unitAmount: 2500 }), makeProduct(idA)]),
      reserveStock: jest.fn().mockResolvedValue(true),
      releaseStock: jest.fn().mockResolvedValue(undefined),
    };
    orderRepository = {
      create: jest.fn().mockImplementation(async (data) => ({
        id: 'order-1',
        email: data.email,
        status: 'pending_payment',
        currency: data.currency,
        totalAmount: data.totalAmount,
        paymentIntentId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        items: data.items.create.map((item: { product: { connect: { id: string } } }) => ({
          ...item,
          productId: item.product.connect.id,
        })),
      })),
      findById: jest.fn().mockResolvedValue(null),
      setPaymentIntent: jest.fn().mockResolvedValue(true),
      findByPaymentIntent: jest.fn().mockResolvedValue(null),
      transition: jest.fn().mockResolvedValue(true),
    };
    idempotencyKeyRepository = {
      create: jest.fn().mockResolvedValue(undefined),
      findByKey: jest.fn().mockResolvedValue(null),
    };
    paymentService = {
      createIntent: jest.fn().mockResolvedValue({ id: 'pi_new', clientSecret: 'pi_new_secret' }),
      getClientSecret: jest.fn().mockResolvedValue('pi_old_secret'),
      cancelIntent: jest.fn().mockResolvedValue(true),
    };
    outboxRepository = { add: jest.fn().mockResolvedValue(undefined) };
    const prisma = {
      $transaction: jest.fn((fn: (client: unknown) => Promise<unknown>) => fn(tx)),
    };
    service = new OrderService(
      prisma as unknown as PrismaService,
      productRepository as unknown as ProductRepository,
      orderRepository as unknown as OrderRepository,
      idempotencyKeyRepository as unknown as IdempotencyKeyRepository,
      paymentService as unknown as PaymentService,
      outboxRepository as unknown as OutboxRepository
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

  describe('payment', () => {
    const dto = { email: 'buyer@example.com', items: [{ productId: idA, quantity: 1 }] };
    const stored = (overrides: Partial<OrderWithItems>): OrderWithItems => ({
      id: 'order-1',
      email: dto.email,
      status: 'pending_payment',
      currency: 'usd',
      totalAmount: 1000,
      paymentIntentId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      items: [],
      ...overrides,
    });

    const replayWith = async (order: OrderWithItems) => {
      await service.create(dto, 'key-1');
      const requestHash = idempotencyKeyRepository.create.mock.calls[0][1];
      idempotencyKeyRepository.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
          code: 'P2002',
          clientVersion: 'test',
        })
      );
      idempotencyKeyRepository.findByKey.mockResolvedValue({
        key: 'key-1',
        requestHash,
        orderId: order.id,
        createdAt: new Date(),
      });
      orderRepository.findById.mockResolvedValue(order);
      paymentService.createIntent.mockClear();
      orderRepository.setPaymentIntent.mockClear();

      return await service.create(dto, 'key-1');
    };

    it('creates a payment intent for the order total and returns its client secret', async () => {
      const { order } = await service.create(dto);

      expect(paymentService.createIntent).toHaveBeenCalledWith({
        orderId: 'order-1',
        email: dto.email,
        currency: 'usd',
        amount: 1000,
      });
      expect(orderRepository.setPaymentIntent).toHaveBeenCalledWith('order-1', 'pi_new');
      expect(order.clientSecret).toBe('pi_new_secret');
    });

    it('keeps the order and fails with 502 when stripe is down', async () => {
      paymentService.createIntent.mockRejectedValue(new BadGatewayException());

      await expect(service.create(dto, 'key-1')).rejects.toThrow(BadGatewayException);
      expect(orderRepository.create).toHaveBeenCalled();
      expect(orderRepository.setPaymentIntent).not.toHaveBeenCalled();
    });

    it('reuses the stored intent when replaying', async () => {
      const { order, replayed } = await replayWith(stored({ paymentIntentId: 'pi_old' }));

      expect(replayed).toBe(true);
      expect(paymentService.getClientSecret).toHaveBeenCalledWith('pi_old');
      expect(paymentService.createIntent).not.toHaveBeenCalled();
      expect(order.clientSecret).toBe('pi_old_secret');
    });

    it('creates the intent on replay when the first attempt never got one', async () => {
      const { order } = await replayWith(stored({ paymentIntentId: null }));

      expect(paymentService.createIntent).toHaveBeenCalledTimes(1);
      expect(orderRepository.setPaymentIntent).toHaveBeenCalledWith('order-1', 'pi_new');
      expect(order.clientSecret).toBe('pi_new_secret');
    });

    it('cancels the new intent and throws 409 when the order expired in the meantime', async () => {
      orderRepository.setPaymentIntent.mockResolvedValue(false);

      await expect(service.create(dto)).rejects.toThrow(ConflictException);
      expect(paymentService.cancelIntent).toHaveBeenCalledWith('pi_new');
    });

    it('still throws 409 when cancelling the orphaned intent fails', async () => {
      orderRepository.setPaymentIntent.mockResolvedValue(false);
      paymentService.cancelIntent.mockRejectedValue(new BadGatewayException());

      await expect(service.create(dto)).rejects.toThrow(ConflictException);
    });

    it('returns no client secret once the order is no longer awaiting payment', async () => {
      const { order } = await replayWith(stored({ status: 'paid', paymentIntentId: 'pi_old' }));

      expect(paymentService.getClientSecret).not.toHaveBeenCalled();
      expect(paymentService.createIntent).not.toHaveBeenCalled();
      expect(order.clientSecret).toBeUndefined();
    });
  });

  const withStatus = (status: OrderStatus): OrderWithItems => ({
    id: 'order-1',
    email: 'buyer@example.com',
    status,
    currency: 'usd',
    totalAmount: 1000,
    paymentIntentId: 'pi_1',
    createdAt: new Date(),
    updatedAt: new Date(),
    items: [
      {
        id: 'item-b',
        orderId: 'order-1',
        productId: idB,
        sku: 'B',
        name: 'B',
        unitAmount: 300,
        quantity: 1,
      },
      {
        id: 'item-a',
        orderId: 'order-1',
        productId: idA,
        sku: 'C',
        name: 'A',
        unitAmount: 350,
        quantity: 2,
      },
    ],
  });

  describe('markPaid', () => {
    const payment = { paymentIntentId: 'pi_1', amount: 1000, currency: 'usd' };

    it('moves a pending order to paid inside the given transaction', async () => {
      orderRepository.findByPaymentIntent.mockResolvedValue(
        withStatus(OrderStatus.pending_payment)
      );

      await service.markPaid(payment, tx as unknown as Prisma.TransactionClient);

      expect(orderRepository.findByPaymentIntent).toHaveBeenCalledWith('pi_1', tx);
      expect(orderRepository.transition).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'order-1', status: OrderStatus.pending_payment }),
        OrderStatus.paid,
        tx
      );
      expect(outboxRepository.add).toHaveBeenCalledWith(
        'order.paid',
        'order-1',
        {
          orderId: 'order-1',
          status: OrderStatus.paid,
          email: 'buyer@example.com',
          currency: 'usd',
          totalAmount: 1000,
          paymentIntentId: 'pi_1',
          items: [
            { productId: idB, sku: 'B', unitAmount: 300, quantity: 1 },
            { productId: idA, sku: 'C', unitAmount: 350, quantity: 2 },
          ],
        },
        tx
      );
    });

    it.each([
      ['an unknown intent', null, payment],
      ['an already paid order', withStatus(OrderStatus.paid), payment],
      ['a cancelled order', withStatus(OrderStatus.cancelled), payment],
      ['a different amount', withStatus(OrderStatus.pending_payment), { ...payment, amount: 999 }],
      [
        'a different currency',
        withStatus(OrderStatus.pending_payment),
        { ...payment, currency: 'eur' },
      ],
    ])('leaves the order alone for %s', async (_, order, received) => {
      orderRepository.findByPaymentIntent.mockResolvedValue(order);

      await service.markPaid(received, tx as unknown as Prisma.TransactionClient);

      expect(orderRepository.transition).not.toHaveBeenCalled();
      expect(outboxRepository.add).not.toHaveBeenCalled();
    });

    it('throws 409 when the status changed underneath, so the event is retried', async () => {
      orderRepository.findByPaymentIntent.mockResolvedValue(
        withStatus(OrderStatus.pending_payment)
      );
      orderRepository.transition.mockResolvedValue(false);

      await expect(
        service.markPaid(payment, tx as unknown as Prisma.TransactionClient)
      ).rejects.toThrow(ConflictException);
      expect(outboxRepository.add).not.toHaveBeenCalled();
    });
  });

  describe('cancelForPayment', () => {
    const db = tx as unknown as Prisma.TransactionClient;

    it('cancels a pending order and releases its stock in product id order', async () => {
      orderRepository.findByPaymentIntent.mockResolvedValue(
        withStatus(OrderStatus.pending_payment)
      );

      await service.cancelForPayment('pi_1', db);

      expect(orderRepository.transition).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'order-1', status: OrderStatus.pending_payment }),
        OrderStatus.cancelled,
        tx
      );
      expect(productRepository.releaseStock.mock.calls).toEqual([
        [idA, 2, tx],
        [idB, 1, tx],
      ]);
      expect(outboxRepository.add).toHaveBeenCalledWith(
        'order.cancelled',
        'order-1',
        expect.objectContaining({ status: OrderStatus.cancelled }),
        tx
      );
    });

    it.each([
      ['an unknown intent', null],
      ['a paid order', withStatus(OrderStatus.paid)],
      ['an already cancelled order', withStatus(OrderStatus.cancelled)],
    ])('releases nothing for %s', async (_, order) => {
      orderRepository.findByPaymentIntent.mockResolvedValue(order);

      await service.cancelForPayment('pi_1', db);

      expect(orderRepository.transition).not.toHaveBeenCalled();
      expect(productRepository.releaseStock).not.toHaveBeenCalled();
      expect(outboxRepository.add).not.toHaveBeenCalled();
    });

    it('throws 409 and releases nothing when the order changed underneath', async () => {
      orderRepository.findByPaymentIntent.mockResolvedValue(
        withStatus(OrderStatus.pending_payment)
      );
      orderRepository.transition.mockResolvedValue(false);

      await expect(service.cancelForPayment('pi_1', db)).rejects.toThrow(ConflictException);
      expect(productRepository.releaseStock).not.toHaveBeenCalled();
      expect(outboxRepository.add).not.toHaveBeenCalled();
    });
  });

  describe('cancel', () => {
    const db = tx as unknown as Prisma.TransactionClient;

    it('reports whether this call cancelled the order', async () => {
      await expect(service.cancel(withStatus(OrderStatus.pending_payment), db)).resolves.toBe(true);
      await expect(service.cancel(withStatus(OrderStatus.cancelled), db)).resolves.toBe(false);
      expect(productRepository.releaseStock).toHaveBeenCalledTimes(2);
      expect(outboxRepository.add).toHaveBeenCalledTimes(1);
    });
  });

  describe('fulfil', () => {
    it('moves a paid order to fulfilled and records the event in the same transaction', async () => {
      orderRepository.findById
        .mockResolvedValueOnce(withStatus(OrderStatus.paid))
        .mockResolvedValueOnce(withStatus(OrderStatus.fulfilled));

      const order = await service.fulfil('order-1');

      expect(orderRepository.transition).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'order-1', status: OrderStatus.paid }),
        OrderStatus.fulfilled,
        tx
      );
      expect(outboxRepository.add).toHaveBeenCalledWith(
        'order.fulfilled',
        'order-1',
        expect.objectContaining({ status: OrderStatus.fulfilled }),
        tx
      );
      expect(order.status).toBe(OrderStatus.fulfilled);
    });

    it('returns an already fulfilled order without touching it', async () => {
      orderRepository.findById.mockResolvedValue(withStatus(OrderStatus.fulfilled));

      expect((await service.fulfil('order-1')).status).toBe(OrderStatus.fulfilled);
      expect(orderRepository.transition).not.toHaveBeenCalled();
      expect(outboxRepository.add).not.toHaveBeenCalled();
    });

    it.each([OrderStatus.pending_payment, OrderStatus.cancelled])(
      'throws 409 for a %s order',
      async (status) => {
        orderRepository.findById.mockResolvedValue(withStatus(status));

        await expect(service.fulfil('order-1')).rejects.toThrow(ConflictException);
        expect(orderRepository.transition).not.toHaveBeenCalled();
      }
    );

    it('throws 409 when the order changed underneath', async () => {
      orderRepository.findById.mockResolvedValue(withStatus(OrderStatus.paid));
      orderRepository.transition.mockResolvedValue(false);

      await expect(service.fulfil('order-1')).rejects.toThrow(ConflictException);
      expect(outboxRepository.add).not.toHaveBeenCalled();
    });

    it('throws 404 for an unknown order', async () => {
      await expect(service.fulfil('order-1')).rejects.toThrow(NotFoundException);
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
