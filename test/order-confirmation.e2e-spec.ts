import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ChannelModel, connect } from 'amqplib';
import { randomUUID } from 'crypto';
import Stripe from 'stripe';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { EVENTS_EXCHANGE } from '../src/messaging/event-publisher';
import { ORDER_CONFIRMATIONS_DEAD_LETTER_QUEUE } from '../src/notifications/order-confirmation.consumer';
import { OrderConfirmationMailer } from '../src/notifications/order-confirmation.mailer';
import {
  ORDER_CONFIRMATION_CONSUMER,
  OrderConfirmationService,
} from '../src/notifications/order-confirmation.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { ProductRepository } from '../src/products/product.repository';
import { setupApp } from '../src/setup-app';

describe('Order confirmation consumer (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let stripe: Stripe;
  let broker: ChannelModel;

  const waitFor = async <T>(check: () => Promise<T | undefined>, timeoutMs = 10_000) => {
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
      unitAmount: 2500,
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
  });

  afterAll(async () => {
    await broker.close();
    await app.close();
  });

  it('records the order.paid message once the confirmation is sent', async () => {
    const order = await payOrder();
    const event = await prisma.outboxEvent.findFirstOrThrow({
      where: { aggregateId: order.id, type: 'order.paid' },
    });

    const processed = await waitFor(() =>
      prisma.processedMessage
        .findUnique({
          where: {
            consumer_messageId: { consumer: ORDER_CONFIRMATION_CONSUMER, messageId: event.id },
          },
        })
        .then((row) => row ?? undefined)
    );

    expect(processed.processedAt).toBeInstanceOf(Date);
  });

  it('sends one confirmation when the same message is handled twice at once', async () => {
    const send = jest.spyOn(app.get(OrderConfirmationMailer), 'send');
    const messageId = randomUUID();
    const order = {
      orderId: randomUUID(),
      email: 'buyer@example.com',
      totalAmount: 2500,
      currency: 'usd',
    };
    const service = app.get(OrderConfirmationService);

    const results = await Promise.all([
      service.handle(messageId, order),
      service.handle(messageId, order),
    ]);

    expect(results.sort()).toEqual([false, true]);
    expect(send).toHaveBeenCalledTimes(1);
    send.mockRestore();
  });

  it('dead-letters a malformed order.paid message', async () => {
    // this suite's consumer may not be the one that gets it, every e2e worker runs one
    await waitFor(async () => {
      const queue = await broker.createChannel();
      const { consumerCount } = await queue.checkQueue('order-confirmations');
      await queue.close();
      return consumerCount > 0 ? true : undefined;
    });

    const messageId = randomUUID();
    const channel = await broker.createConfirmChannel();
    channel.publish(EVENTS_EXCHANGE, 'order.paid', Buffer.from('{not json'), {
      messageId,
      contentType: 'application/json',
    });
    await channel.waitForConfirms();

    const dead = await waitFor(async () => {
      for (;;) {
        const message = await channel.get(ORDER_CONFIRMATIONS_DEAD_LETTER_QUEUE, { noAck: true });
        if (!message) {
          return undefined;
        }
        if (message.properties.messageId === messageId) {
          return message;
        }
      }
    });
    await channel.close();

    expect(dead.content.toString()).toBe('{not json');
    expect(dead.properties.headers?.['x-first-death-reason']).toBe('rejected');
    expect(dead.properties.headers?.['x-first-death-queue']).toBe('order-confirmations');
  });
});
