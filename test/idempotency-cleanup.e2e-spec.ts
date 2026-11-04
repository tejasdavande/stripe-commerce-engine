import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { IdempotencyKeyCleanupService } from '../src/orders/idempotency-key-cleanup.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { ProductRepository } from '../src/products/product.repository';
import { setupApp } from '../src/setup-app';

describe('Idempotency key cleanup (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cleanup: IdempotencyKeyCleanupService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

    app = moduleRef.createNestApplication({ rawBody: true });
    setupApp(app);
    await app.init();
    prisma = app.get(PrismaService);
    cleanup = app.get(IdempotencyKeyCleanupService);
  });

  afterAll(async () => {
    await app.close();
  });

  it('drops keys older than a day but keeps recent ones and the orders', async () => {
    const product = await app.get(ProductRepository).upsertBySku({
      sku: `TEST-${randomUUID()}`,
      name: 'Test product',
      unitAmount: 1500,
      stock: 10,
    });
    const body = { email: 'buyer@example.com', items: [{ productId: product.id, quantity: 1 }] };
    const oldKey = randomUUID();
    const freshKey = randomUUID();

    const old = await request(app.getHttpServer())
      .post('/orders')
      .set('Idempotency-Key', oldKey)
      .send(body)
      .expect(201);
    await request(app.getHttpServer())
      .post('/orders')
      .set('Idempotency-Key', freshKey)
      .send(body)
      .expect(201);
    await prisma.idempotencyKey.update({
      where: { key: oldKey },
      data: { createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000) },
    });

    await cleanup.purgeExpired();

    expect(await prisma.idempotencyKey.findUnique({ where: { key: oldKey } })).toBeNull();
    expect(await prisma.idempotencyKey.findUnique({ where: { key: freshKey } })).not.toBeNull();
    expect(await prisma.order.findUnique({ where: { id: old.body.id } })).not.toBeNull();

    const reused = await request(app.getHttpServer())
      .post('/orders')
      .set('Idempotency-Key', oldKey)
      .send(body)
      .expect(201);
    expect(reused.body.id).not.toBe(old.body.id);
  });
});
