import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ChannelModel, ConsumeMessage, connect } from 'amqplib';
import { randomUUID } from 'crypto';
import Stripe from 'stripe';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { Prisma } from '../src/generated/prisma/client';
import { EVENTS_EXCHANGE } from '../src/messaging/event-publisher';
import { OutboxRelayService } from '../src/outbox/outbox-relay.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { ProductRepository } from '../src/products/product.repository';
import { setupApp } from '../src/setup-app';

describe('Outbox relay (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let stripe: Stripe;
  let broker: ChannelModel;
  const received: ConsumeMessage[] = [];

  const waitFor = async <T>(check: () => Promise<T | undefined>, timeoutMs = 5_000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = await check();
      if (value !== undefined) {
        return value;
      }
      if (Date.now() > deadline) {
        throw new Error('timed out waiting');
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };

  const payOrder = async () => {
    const product = await app.get(ProductRepository).upsertBySku({
      sku: `TEST-${randomUUID()}`,
      name: 'Test product',
      unitAmount: 1500,
      stock: 5,
    });
    const res = await request(app.getHttpServer())
      .post('/orders')
      .send({ email: 'buyer@example.com', items: [{ productId: product.id, quantity: 1 }] })
      .expect(201);
    const order = await prisma.order.findUniqueOrThrow({ where: { id: res.body.id } });

    const payload = JSON.stringify({
      id: `evt_${randomUUID().replace(/-/g, '')}`,
      object: 'event',
      type: 'payment_intent.succeeded',
      data: {
        object: {
          object: 'payment_intent',
          id: order.paymentIntentId,
          amount_received: order.totalAmount,
          currency: 'usd',
        },
      },
    });
    await request(app.getHttpServer())
      .post('/webhooks/stripe')
      .set('Content-Type', 'application/json')
      .set(
        'Stripe-Signature',
        stripe.webhooks.generateTestHeaderString({
          payload,
          secret: process.env.STRIPE_WEBHOOK_SECRET!,
        })
      )
      .send(payload)
      .expect(200);

    return order;
  };

  // every e2e suite runs its own relay against this database, so keep inserting rows until
  // this test is the one holding the lock while they are still unpublished
  const lockUnpublishedRows = async (count: number) => {
    for (;;) {
      const ids = Array.from({ length: count }, () => randomUUID());
      await prisma.outboxEvent.createMany({
        data: ids.map((id) => ({
          id,
          type: 'order.paid',
          aggregateId: randomUUID(),
          payload: { test: true },
        })),
      });

      let release!: () => void;
      const released = new Promise<void>((resolve) => (release = resolve));
      let lockedUnpublished!: (value: boolean) => void;
      const locked = new Promise<boolean>((resolve) => (lockedUnpublished = resolve));

      const holder = prisma.$transaction(
        async (tx) => {
          const rows = await tx.$queryRaw<{ published_at: Date | null }[]>`
            SELECT published_at FROM outbox_events
            WHERE id IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))})
            FOR UPDATE`;
          lockedUnpublished(rows.every((row) => row.published_at === null));
          await released;
        },
        { timeout: 20_000 }
      );

      if (await locked) {
        return {
          ids,
          release: async () => {
            release();
            await holder;
          },
        };
      }
      release();
      await holder;
    }
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication({ rawBody: true });
    setupApp(app);
    await app.listen(0);
    prisma = app.get(PrismaService);
    stripe = app.get(Stripe);

    broker = await connect(process.env.RABBITMQ_URL!);
    const channel = await broker.createChannel();
    await channel.assertExchange(EVENTS_EXCHANGE, 'topic', { durable: true });
    const { queue } = await channel.assertQueue('', { exclusive: true });
    await channel.bindQueue(queue, EVENTS_EXCHANGE, 'order.#');
    await channel.consume(queue, (message) => message && received.push(message), {
      noAck: true,
    });
  });

  afterAll(async () => {
    await broker.close();
    await app.close();
  });

  it('publishes an order event to rabbitmq and marks the outbox row published', async () => {
    const order = await payOrder();
    const row = await prisma.outboxEvent.findFirstOrThrow({ where: { aggregateId: order.id } });

    const message = await waitFor(async () =>
      received.find((m) => m.properties.messageId === row.id)
    );

    expect(message.fields.routingKey).toBe('order.paid');
    expect(message.properties).toMatchObject({
      type: 'order.paid',
      contentType: 'application/json',
      deliveryMode: 2,
      timestamp: Math.floor(row.createdAt.getTime() / 1000),
    });
    expect(JSON.parse(message.content.toString())).toMatchObject({
      orderId: order.id,
      status: 'paid',
      totalAmount: 1500,
      paymentIntentId: order.paymentIntentId,
    });
    await waitFor(async () => {
      const current = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: row.id } });
      return current.publishedAt ?? undefined;
    });
  });

  it('skips rows another relay holds instead of waiting on them', async () => {
    const { ids, release } = await lockUnpublishedRows(2);

    try {
      const relayed = app.get(OutboxRelayService).relayPending();
      const outcome = await Promise.race([
        relayed.then(() => 'done'),
        new Promise((resolve) => setTimeout(() => resolve('blocked'), 3_000)),
      ]);
      expect(outcome).toBe('done');

      const rows = await prisma.outboxEvent.findMany({ where: { id: { in: ids } } });
      expect(rows.map((row) => row.publishedAt)).toEqual([null, null]);
    } finally {
      await release();
    }

    await waitFor(async () => {
      const published = await prisma.outboxEvent.count({
        where: { id: { in: ids }, publishedAt: { not: null } },
      });
      return published === 2 ? true : undefined;
    });
    await waitFor(async () =>
      received.filter((m) => ids.includes(m.properties.messageId)).length === 2 ? true : undefined
    );
  });
});
