import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'crypto';
import Stripe from 'stripe';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { ProductRepository } from '../src/products/product.repository';
import { setupApp } from '../src/setup-app';

describe('Stripe webhooks (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let stripe: Stripe;

  const createOrder = async (unitAmount = 2500) => {
    const product = await app.get(ProductRepository).upsertBySku({
      sku: `TEST-${randomUUID()}`,
      name: 'Test product',
      unitAmount,
      stock: 5,
    });
    const res = await request(app.getHttpServer())
      .post('/orders')
      .send({ email: 'buyer@example.com', items: [{ productId: product.id, quantity: 2 }] })
      .expect(201);

    return await prisma.order.findUniqueOrThrow({
      where: { id: res.body.id },
      include: { items: true },
    });
  };

  const stockOf = async (order: { items: { productId: string }[] }) =>
    (await prisma.product.findUniqueOrThrow({ where: { id: order.items[0].productId } })).stock;

  const canceledEvent = (order: { paymentIntentId: string | null }) =>
    intentEvent('payment_intent.canceled', { id: order.paymentIntentId! });

  const intentEvent = (
    type: string,
    intent: { id: string; amount_received?: number; currency?: string }
  ) => ({
    id: `evt_${randomUUID().replace(/-/g, '')}`,
    object: 'event',
    type,
    data: { object: { object: 'payment_intent', ...intent } },
  });

  const paidEvent = (order: { paymentIntentId: string | null; totalAmount: number }) =>
    intentEvent('payment_intent.succeeded', {
      id: order.paymentIntentId!,
      amount_received: order.totalAmount,
      currency: 'usd',
    });

  const deliver = (event: unknown, secret = process.env.STRIPE_WEBHOOK_SECRET!) => {
    const payload = JSON.stringify(event);
    return request(app.getHttpServer())
      .post('/webhooks/stripe')
      .set('Content-Type', 'application/json')
      .set('Stripe-Signature', stripe.webhooks.generateTestHeaderString({ payload, secret }))
      .send(payload);
  };

  const statusOf = async (id: string) =>
    (await request(app.getHttpServer()).get(`/orders/${id}`).expect(200)).body.status;

  const outboxTypes = async (orderId: string) =>
    (
      await prisma.outboxEvent.findMany({
        where: { aggregateId: orderId },
        orderBy: { createdAt: 'asc' },
      })
    ).map((event) => event.type);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication({ rawBody: true });
    setupApp(app);
    await app.listen(0);
    prisma = app.get(PrismaService);
    stripe = app.get(Stripe);
  });

  afterAll(async () => {
    await app.close();
  });

  it('marks the order paid when its payment intent succeeds', async () => {
    const order = await createOrder();
    const event = paidEvent(order);

    await deliver(event).expect(200);

    expect(await statusOf(order.id)).toBe('paid');
    expect(await prisma.stripeEvent.findUnique({ where: { id: event.id } })).toMatchObject({
      type: 'payment_intent.succeeded',
    });
    expect(
      await prisma.outboxEvent.findFirstOrThrow({ where: { aggregateId: order.id } })
    ).toMatchObject({
      type: 'order.paid',
      payload: {
        orderId: order.id,
        status: 'paid',
        email: 'buyer@example.com',
        totalAmount: order.totalAmount,
        paymentIntentId: order.paymentIntentId,
        items: [{ productId: order.items[0].productId, quantity: 2 }],
      },
    });
  });

  it('lets a paid order be fulfilled, and fulfilling again is a no-op', async () => {
    const order = await createOrder();
    await deliver(paidEvent(order)).expect(200);

    for (let i = 0; i < 2; i++) {
      const res = await request(app.getHttpServer()).post(`/orders/${order.id}/fulfil`).expect(200);
      expect(res.body).toMatchObject({ id: order.id, status: 'fulfilled' });
    }

    await deliver(canceledEvent(order)).expect(200);
    expect(await statusOf(order.id)).toBe('fulfilled');
    expect(await outboxTypes(order.id)).toEqual(['order.paid', 'order.fulfilled']);
  });

  it('processes an event once when stripe delivers it concurrently', async () => {
    const order = await createOrder();
    const event = paidEvent(order);

    const results = await Promise.all(Array.from({ length: 5 }, () => deliver(event)));

    expect(results.map((res) => res.status)).toEqual(Array(5).fill(200));
    expect(await prisma.stripeEvent.count({ where: { id: event.id } })).toBe(1);
    expect(await statusOf(order.id)).toBe('paid');
    expect(await outboxTypes(order.id)).toEqual(['order.paid']);
  });

  it('rejects unsigned, forged and tampered payloads without touching the order', async () => {
    const order = await createOrder();
    const event = paidEvent(order);
    const payload = JSON.stringify(event);
    const signature = stripe.webhooks.generateTestHeaderString({
      payload,
      secret: process.env.STRIPE_WEBHOOK_SECRET!,
    });

    await request(app.getHttpServer())
      .post('/webhooks/stripe')
      .set('Content-Type', 'application/json')
      .send(payload)
      .expect(400);
    await deliver(event, 'whsec_forged').expect(400);
    await request(app.getHttpServer())
      .post('/webhooks/stripe')
      .set('Content-Type', 'application/json')
      .set('Stripe-Signature', signature)
      .send(payload.replace(`"amount_received":${order.totalAmount}`, '"amount_received":1'))
      .expect(400);

    expect(await statusOf(order.id)).toBe('pending_payment');
    expect(await prisma.stripeEvent.count({ where: { id: event.id } })).toBe(0);
    expect(await outboxTypes(order.id)).toEqual([]);
  });

  it('keeps the order pending when the amount received does not match', async () => {
    const order = await createOrder();

    await deliver({
      ...paidEvent(order),
      data: {
        object: {
          object: 'payment_intent',
          id: order.paymentIntentId,
          amount_received: order.totalAmount - 1,
          currency: 'usd',
        },
      },
    }).expect(200);

    expect(await statusOf(order.id)).toBe('pending_payment');
  });

  it('keeps the order pending after a failed payment attempt so the buyer can retry', async () => {
    const order = await createOrder();

    await deliver(
      intentEvent('payment_intent.payment_failed', { id: order.paymentIntentId! })
    ).expect(200);
    expect(await statusOf(order.id)).toBe('pending_payment');

    await deliver(paidEvent(order)).expect(200);
    expect(await statusOf(order.id)).toBe('paid');
  });

  it('does not revive a cancelled order', async () => {
    const order = await createOrder();
    await prisma.order.update({ where: { id: order.id }, data: { status: 'cancelled' } });

    await deliver(paidEvent(order)).expect(200);

    expect(await statusOf(order.id)).toBe('cancelled');
  });

  it('cancels the order and puts its stock back when the intent is canceled', async () => {
    const order = await createOrder();
    expect(await stockOf(order)).toBe(3);

    await deliver(canceledEvent(order)).expect(200);

    expect(await statusOf(order.id)).toBe('cancelled');
    expect(await stockOf(order)).toBe(5);
    expect(await outboxTypes(order.id)).toEqual(['order.cancelled']);
  });

  it('releases stock once when stripe sends the cancellation again under a new event id', async () => {
    const order = await createOrder();

    await deliver(canceledEvent(order)).expect(200);
    await deliver(canceledEvent(order)).expect(200);

    expect(await stockOf(order)).toBe(5);
    expect(await outboxTypes(order.id)).toEqual(['order.cancelled']);
  });

  it('leaves a paid order and its stock alone when the intent is canceled', async () => {
    const order = await createOrder();
    await deliver(paidEvent(order)).expect(200);

    await deliver(canceledEvent(order)).expect(200);

    expect(await statusOf(order.id)).toBe('paid');
    expect(await stockOf(order)).toBe(3);
  });

  it('settles on one outcome when payment and cancellation race', async () => {
    const order = await createOrder();
    const paid = paidEvent(order);
    const canceled = canceledEvent(order);

    const first = await Promise.all([deliver(paid), deliver(canceled)]);
    expect(first.map((res) => res.status)).toContain(200);
    // the loser gets 409 and stripe redelivers it
    await Promise.all([deliver(paid).expect(200), deliver(canceled).expect(200)]);

    const status = await statusOf(order.id);
    expect(['paid', 'cancelled']).toContain(status);
    expect(await stockOf(order)).toBe(status === 'paid' ? 3 : 5);
    expect(await outboxTypes(order.id)).toEqual([`order.${status}`]);
  });

  it('acknowledges events for unknown intents and unhandled types', async () => {
    await deliver(
      intentEvent('payment_intent.succeeded', {
        id: 'pi_unknown',
        amount_received: 100,
        currency: 'usd',
      })
    ).expect(200);
    await deliver({
      id: `evt_${randomUUID()}`,
      object: 'event',
      type: 'customer.created',
      data: { object: { id: 'cus_1', object: 'customer' } },
    }).expect(200);
  });
});
