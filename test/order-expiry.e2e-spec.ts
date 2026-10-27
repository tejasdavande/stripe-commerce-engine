import { ConflictException, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'crypto';
import Stripe from 'stripe';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { OrderExpiryService } from '../src/orders/order-expiry.service';
import { OrderRepository } from '../src/orders/order.repository';
import { OrderService } from '../src/orders/order.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { ProductRepository } from '../src/products/product.repository';
import { setupApp } from '../src/setup-app';

describe('Order expiry (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let expiry: OrderExpiryService;

  const createOrder = async () => {
    const product = await app.get(ProductRepository).upsertBySku({
      sku: `TEST-${randomUUID()}`,
      name: 'Test product',
      unitAmount: 1500,
      stock: 5,
    });
    const res = await request(app.getHttpServer())
      .post('/orders')
      .send({ email: 'buyer@example.com', items: [{ productId: product.id, quantity: 2 }] })
      .expect(201);

    return await prisma.order.findUniqueOrThrow({ where: { id: res.body.id } });
  };

  // far enough back that these come before any leftover orders in the first batch
  const backdate = (id: string, data: { paymentIntentId?: null } = {}) =>
    prisma.order.update({ where: { id }, data: { ...data, createdAt: new Date('2000-01-01') } });

  const stateOf = async (id: string) => {
    const order = await prisma.order.findUniqueOrThrow({
      where: { id },
      include: { items: { include: { product: true } } },
    });
    return { status: order.status, stock: order.items[0].product.stock };
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication({ rawBody: true });
    setupApp(app);
    await app.listen(0);
    prisma = app.get(PrismaService);
    expiry = app.get(OrderExpiryService);
  });

  afterAll(async () => {
    await app.close();
  });

  const cancelledEvents = (orderId: string) =>
    prisma.outboxEvent.count({ where: { aggregateId: orderId, type: 'order.cancelled' } });

  it('cancels unpaid orders past the ttl and releases their stock', async () => {
    const order = await createOrder();
    await backdate(order.id);

    await expiry.expireUnpaid();

    expect(await stateOf(order.id)).toEqual({ status: 'cancelled', stock: 5 });
    expect(await cancelledEvents(order.id)).toBe(1);
  });

  it('cancels an old order that never got a payment intent', async () => {
    const order = await createOrder();
    await backdate(order.id, { paymentIntentId: null });

    await expiry.expireUnpaid();

    expect(await stateOf(order.id)).toEqual({ status: 'cancelled', stock: 5 });
  });

  it('does not cancel an order that got an intent after the expiry read it', async () => {
    const order = await createOrder();
    await prisma.order.update({ where: { id: order.id }, data: { paymentIntentId: null } });
    const stale = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
      include: { items: true },
    });
    await app.get(OrderRepository).setPaymentIntent(order.id, `pi_${randomUUID()}`);

    await expect(
      prisma.$transaction((tx) => app.get(OrderService).cancel(stale, tx))
    ).rejects.toThrow(ConflictException);
    expect(await stateOf(order.id)).toEqual({ status: 'pending_payment', stock: 3 });
    expect(await cancelledEvents(order.id)).toBe(0);
  });

  it('leaves recent and paid orders alone', async () => {
    const recent = await createOrder();
    const paid = await createOrder();
    await backdate(paid.id);
    await prisma.order.update({ where: { id: paid.id }, data: { status: 'paid' } });

    await expiry.expireUnpaid();

    expect(await stateOf(recent.id)).toEqual({ status: 'pending_payment', stock: 3 });
    expect(await stateOf(paid.id)).toEqual({ status: 'paid', stock: 3 });
  });

  it('releases stock once when the canceled webhook arrives after the expiry', async () => {
    const order = await createOrder();
    await backdate(order.id);
    await expiry.expireUnpaid();
    await expiry.expireUnpaid();

    const payload = JSON.stringify({
      id: `evt_${randomUUID().replace(/-/g, '')}`,
      object: 'event',
      type: 'payment_intent.canceled',
      data: { object: { object: 'payment_intent', id: order.paymentIntentId } },
    });
    await request(app.getHttpServer())
      .post('/webhooks/stripe')
      .set('Content-Type', 'application/json')
      .set(
        'Stripe-Signature',
        app.get(Stripe).webhooks.generateTestHeaderString({
          payload,
          secret: process.env.STRIPE_WEBHOOK_SECRET!,
        })
      )
      .send(payload)
      .expect(200);

    expect(await stateOf(order.id)).toEqual({ status: 'cancelled', stock: 5 });
    expect(await cancelledEvents(order.id)).toBe(1);
  });

  it('no longer hands out a client secret for an expired order', async () => {
    const product = await app.get(ProductRepository).upsertBySku({
      sku: `TEST-${randomUUID()}`,
      name: 'Test product',
      unitAmount: 1500,
      stock: 5,
    });
    const key = randomUUID();
    const body = { email: 'buyer@example.com', items: [{ productId: product.id, quantity: 1 }] };
    const first = await request(app.getHttpServer())
      .post('/orders')
      .set('Idempotency-Key', key)
      .send(body)
      .expect(201);
    await backdate(first.body.id);
    await expiry.expireUnpaid();

    const retry = await request(app.getHttpServer())
      .post('/orders')
      .set('Idempotency-Key', key)
      .send(body)
      .expect(201);

    expect(retry.body).toMatchObject({ id: first.body.id, status: 'cancelled' });
    expect(retry.body.clientSecret).toBeUndefined();
  });
});
