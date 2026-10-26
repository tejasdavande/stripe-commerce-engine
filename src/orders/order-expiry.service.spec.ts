import { BadGatewayException, ConflictException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OrderStatus } from '../generated/prisma/client';
import { PaymentService } from '../payments/payment.service';
import { PrismaService } from '../prisma/prisma.service';
import { OrderExpiryService } from './order-expiry.service';
import { OrderRepository, OrderWithItems } from './order.repository';
import { OrderService } from './order.service';

describe('OrderExpiryService', () => {
  const tx = { tx: true };
  const pending = (id: string, paymentIntentId: string | null): OrderWithItems => ({
    id,
    email: 'buyer@example.com',
    status: OrderStatus.pending_payment,
    currency: 'usd',
    totalAmount: 1000,
    paymentIntentId,
    createdAt: new Date(),
    updatedAt: new Date(),
    items: [],
  });

  let orderRepository: jest.Mocked<Pick<OrderRepository, 'findPendingCreatedBefore'>>;
  let orderService: jest.Mocked<Pick<OrderService, 'cancel'>>;
  let paymentService: jest.Mocked<Pick<PaymentService, 'cancelIntent'>>;
  let service: OrderExpiryService;

  beforeEach(() => {
    jest.useFakeTimers({ now: new Date('2026-10-26T12:00:00Z'), doNotFake: ['nextTick'] });
    orderRepository = { findPendingCreatedBefore: jest.fn().mockResolvedValue([]) };
    orderService = { cancel: jest.fn().mockResolvedValue(true) };
    paymentService = { cancelIntent: jest.fn().mockResolvedValue(true) };
    const prisma = {
      $transaction: jest.fn((fn: (client: unknown) => Promise<unknown>) => fn(tx)),
    };
    const config = { getOrThrow: jest.fn().mockReturnValue(30) };

    service = new OrderExpiryService(
      prisma as unknown as PrismaService,
      orderRepository as unknown as OrderRepository,
      orderService as unknown as OrderService,
      paymentService as unknown as PaymentService,
      config as unknown as ConfigService
    );
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('looks for pending orders older than the ttl', async () => {
    await expect(service.expireUnpaid()).resolves.toBe(0);

    expect(orderRepository.findPendingCreatedBefore).toHaveBeenCalledWith(
      new Date('2026-10-26T11:30:00Z'),
      100
    );
  });

  it('cancels the intent at stripe before cancelling the order', async () => {
    const calls: string[] = [];
    paymentService.cancelIntent.mockImplementation(async () => {
      calls.push('stripe');
      return true;
    });
    orderService.cancel.mockImplementation(async () => {
      calls.push('order');
      return true;
    });
    const order = pending('order-1', 'pi_1');
    orderRepository.findPendingCreatedBefore.mockResolvedValue([order]);

    await expect(service.expireUnpaid()).resolves.toBe(1);

    expect(paymentService.cancelIntent).toHaveBeenCalledWith('pi_1');
    expect(orderService.cancel).toHaveBeenCalledWith(order, tx);
    expect(calls).toEqual(['stripe', 'order']);
  });

  it('cancels an order that never got an intent without calling stripe', async () => {
    orderRepository.findPendingCreatedBefore.mockResolvedValue([pending('order-1', null)]);

    await expect(service.expireUnpaid()).resolves.toBe(1);

    expect(paymentService.cancelIntent).not.toHaveBeenCalled();
  });

  it('leaves the order alone when its intent already succeeded or is processing', async () => {
    paymentService.cancelIntent.mockResolvedValue(false);
    orderRepository.findPendingCreatedBefore.mockResolvedValue([pending('order-1', 'pi_1')]);

    await expect(service.expireUnpaid()).resolves.toBe(0);

    expect(orderService.cancel).not.toHaveBeenCalled();
  });

  it('keeps going when one order fails and counts only the ones it cancelled', async () => {
    paymentService.cancelIntent.mockRejectedValueOnce(new BadGatewayException());
    orderService.cancel
      .mockRejectedValueOnce(new ConflictException())
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    orderRepository.findPendingCreatedBefore.mockResolvedValue([
      pending('order-1', 'pi_1'),
      pending('order-2', 'pi_2'),
      pending('order-3', 'pi_3'),
      pending('order-4', null),
    ]);

    await expect(service.expireUnpaid()).resolves.toBe(1);

    expect(orderService.cancel).toHaveBeenCalledTimes(3);
  });
});
