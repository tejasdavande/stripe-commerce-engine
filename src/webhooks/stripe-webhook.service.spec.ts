import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
import { Prisma } from '../generated/prisma/client';
import { OrderService } from '../orders/order.service';
import { PrismaService } from '../prisma/prisma.service';
import { StripeEventRepository } from './stripe-event.repository';
import { StripeWebhookService } from './stripe-webhook.service';

describe('StripeWebhookService', () => {
  const secret = 'whsec_test';
  const stripe = new Stripe('sk_test_123');
  const tx = { tx: true };

  let stripeEventRepository: jest.Mocked<Pick<StripeEventRepository, 'create'>>;
  let orderService: jest.Mocked<Pick<OrderService, 'markPaid' | 'cancelForPayment'>>;
  let service: StripeWebhookService;

  const event = (type: string, object: Record<string, unknown>) => ({
    id: 'evt_1',
    object: 'event',
    type,
    data: { object },
  });

  const signed = (body: unknown, signingSecret = secret) => {
    const payload = JSON.stringify(body);
    return {
      payload: Buffer.from(payload),
      signature: stripe.webhooks.generateTestHeaderString({ payload, secret: signingSecret }),
    };
  };

  const succeeded = event('payment_intent.succeeded', {
    id: 'pi_1',
    object: 'payment_intent',
    amount_received: 4200,
    currency: 'usd',
  });

  beforeEach(() => {
    stripeEventRepository = { create: jest.fn().mockResolvedValue(undefined) };
    orderService = {
      markPaid: jest.fn().mockResolvedValue(undefined),
      cancelForPayment: jest.fn().mockResolvedValue(undefined),
    };
    const prisma = {
      $transaction: jest.fn((fn: (client: unknown) => Promise<unknown>) => fn(tx)),
    };
    const config = { getOrThrow: jest.fn().mockReturnValue(secret) };

    service = new StripeWebhookService(
      stripe,
      prisma as unknown as PrismaService,
      stripeEventRepository as unknown as StripeEventRepository,
      orderService as unknown as OrderService,
      config as unknown as ConfigService
    );
  });

  it('records the event and marks the order paid in one transaction', async () => {
    const { payload, signature } = signed(succeeded);

    await service.handle(payload, signature);

    expect(stripeEventRepository.create).toHaveBeenCalledWith(
      'evt_1',
      'payment_intent.succeeded',
      tx
    );
    expect(orderService.markPaid).toHaveBeenCalledWith(
      { paymentIntentId: 'pi_1', amount: 4200, currency: 'usd' },
      tx
    );
  });

  it('cancels the order when its payment intent is canceled', async () => {
    const { payload, signature } = signed(
      event('payment_intent.canceled', { id: 'pi_1', object: 'payment_intent' })
    );

    await service.handle(payload, signature);

    expect(orderService.cancelForPayment).toHaveBeenCalledWith('pi_1', tx);
    expect(orderService.markPaid).not.toHaveBeenCalled();
  });

  it('rejects a missing signature or body', async () => {
    const { payload, signature } = signed(succeeded);

    await expect(service.handle(payload, undefined)).rejects.toThrow(BadRequestException);
    await expect(service.handle(undefined, signature)).rejects.toThrow(BadRequestException);
  });

  it('rejects a payload signed with another secret or changed after signing', async () => {
    const forged = signed(succeeded, 'whsec_other');
    const { signature } = signed(succeeded);
    const tampered = Buffer.from(JSON.stringify({ ...succeeded, id: 'evt_2' }));

    await expect(service.handle(forged.payload, forged.signature)).rejects.toThrow(
      BadRequestException
    );
    await expect(service.handle(tampered, signature)).rejects.toThrow(BadRequestException);
    expect(stripeEventRepository.create).not.toHaveBeenCalled();
  });

  it('skips an event it has already processed', async () => {
    stripeEventRepository.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: 'test',
      })
    );
    const { payload, signature } = signed(succeeded);

    await expect(service.handle(payload, signature)).resolves.toBeUndefined();
    expect(orderService.markPaid).not.toHaveBeenCalled();
  });

  it('rethrows other failures so stripe redelivers the event', async () => {
    orderService.markPaid.mockRejectedValue(new Error('connection lost'));
    const { payload, signature } = signed(succeeded);

    await expect(service.handle(payload, signature)).rejects.toThrow('connection lost');
  });

  it('records but ignores failed payments and unrelated events', async () => {
    for (const body of [
      event('payment_intent.payment_failed', { id: 'pi_1', object: 'payment_intent' }),
      event('customer.created', { id: 'cus_1', object: 'customer' }),
    ]) {
      const { payload, signature } = signed(body);
      await service.handle(payload, signature);
    }

    expect(stripeEventRepository.create).toHaveBeenCalledTimes(2);
    expect(orderService.markPaid).not.toHaveBeenCalled();
    expect(orderService.cancelForPayment).not.toHaveBeenCalled();
  });
});
