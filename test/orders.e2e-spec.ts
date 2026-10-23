import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { ProductRepository } from '../src/products/product.repository';
import { setupApp } from '../src/setup-app';

describe('Orders (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let productRepository: ProductRepository;

  const createProduct = (
    overrides: { active?: boolean; stock?: number; unitAmount?: number; currency?: string } = {}
  ) =>
    productRepository.upsertBySku({
      sku: `TEST-${randomUUID()}`,
      name: 'Test product',
      unitAmount: 1999,
      stock: 5,
      ...overrides,
    });

  const stockOf = async (id: string) =>
    (await prisma.product.findUniqueOrThrow({ where: { id } })).stock;

  const postOrder = (items: { productId: string; quantity: number }[]) =>
    request(app.getHttpServer()).post('/orders').send({ email: 'buyer@example.com', items });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    setupApp(app);
    await app.listen(0);
    prisma = app.get(PrismaService);
    productRepository = app.get(ProductRepository);
  });

  afterAll(async () => {
    await app.close();
  });

  it('prices the order from the catalog, ignores client prices and reserves stock', async () => {
    const tee = await createProduct({ unitAmount: 2500, stock: 10 });
    const mug = await createProduct({ unitAmount: 1400, stock: 3 });

    const res = await request(app.getHttpServer())
      .post('/orders')
      .send({
        email: 'buyer@example.com',
        totalAmount: 1,
        items: [
          { productId: tee.id, quantity: 2, unitAmount: 1 },
          { productId: mug.id, quantity: 3 },
        ],
      })
      .expect(201);

    expect(res.body).toMatchObject({
      email: 'buyer@example.com',
      status: 'pending_payment',
      currency: 'usd',
      totalAmount: 2 * 2500 + 3 * 1400,
    });
    expect(res.body.items).toHaveLength(2);
    expect(res.body.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ productId: tee.id, unitAmount: 2500, lineAmount: 5000 }),
        expect.objectContaining({ productId: mug.id, unitAmount: 1400, lineAmount: 4200 }),
      ])
    );
    expect(await stockOf(tee.id)).toBe(8);
    expect(await stockOf(mug.id)).toBe(0);
  });

  it('creates a stripe payment intent and returns its client secret only on creation', async () => {
    const product = await createProduct({ unitAmount: 2500 });

    const res = await postOrder([{ productId: product.id, quantity: 2 }]).expect(201);

    expect(res.body.clientSecret).toMatch(/^pi_\w+_secret_\w+$/);
    const stored = await prisma.order.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(stored.paymentIntentId).toMatch(/^pi_\w+$/);

    const fetched = await request(app.getHttpServer()).get(`/orders/${res.body.id}`).expect(200);
    expect(fetched.body.clientSecret).toBeUndefined();
    expect(fetched.body).toEqual({ ...res.body, clientSecret: undefined });
  });

  it('rolls back earlier reservations when a later line is out of stock', async () => {
    const [first, second] = (await Promise.all([createProduct(), createProduct()])).sort((a, b) =>
      a.id < b.id ? -1 : 1
    );
    await prisma.product.update({ where: { id: second.id }, data: { stock: 1 } });

    const res = await postOrder([
      { productId: first.id, quantity: 2 },
      { productId: second.id, quantity: 2 },
    ]).expect(409);

    expect(res.body.message).toBe(`not enough stock for ${second.sku}`);
    expect(await stockOf(first.id)).toBe(5);
    expect(await stockOf(second.id)).toBe(1);
  });

  it('never oversells when orders race for the last units', async () => {
    const product = await createProduct({ stock: 3 });

    const results = await Promise.all(
      Array.from({ length: 10 }, () => postOrder([{ productId: product.id, quantity: 1 }]))
    );
    const statuses = results.map((res) => res.status);

    expect(statuses.filter((status) => status === 201)).toHaveLength(3);
    expect(statuses.filter((status) => status === 409)).toHaveLength(7);
    expect(await stockOf(product.id)).toBe(0);
  });

  it('returns 404 for unknown and inactive products', async () => {
    const inactive = await createProduct({ active: false });

    await postOrder([{ productId: randomUUID(), quantity: 1 }]).expect(404);
    await postOrder([{ productId: inactive.id, quantity: 1 }]).expect(404);
    expect(await stockOf(inactive.id)).toBe(5);
  });

  it('returns 422 when items use different currencies', async () => {
    const usd = await createProduct();
    const eur = await createProduct({ currency: 'eur' });

    await postOrder([
      { productId: usd.id, quantity: 1 },
      { productId: eur.id, quantity: 1 },
    ]).expect(422);
  });

  it('validates the request body', async () => {
    const product = await createProduct();

    await postOrder([]).expect(400);
    await postOrder([{ productId: product.id, quantity: 0 }]).expect(400);
    await postOrder([{ productId: product.id, quantity: 101 }]).expect(400);
    await postOrder([{ productId: 'not-a-uuid', quantity: 1 }]).expect(400);
    await request(app.getHttpServer())
      .post('/orders')
      .send({ email: 'nope', items: [{ productId: product.id, quantity: 1 }] })
      .expect(400);
  });

  describe('Idempotency-Key', () => {
    const postWithKey = (key: string, items: { productId: string; quantity: number }[]) =>
      postOrder(items).set('Idempotency-Key', key);

    it('replays the first order for a retry and reserves stock only once', async () => {
      const product = await createProduct();
      const key = randomUUID();

      const first = await postWithKey(key, [{ productId: product.id, quantity: 2 }]).expect(201);
      const retry = await postWithKey(key, [{ productId: product.id, quantity: 2 }]).expect(201);

      expect(first.headers['idempotent-replayed']).toBeUndefined();
      expect(retry.headers['idempotent-replayed']).toBe('true');
      expect(retry.body).toEqual(first.body);
      expect(retry.body.clientSecret).toBeDefined();
      expect(await stockOf(product.id)).toBe(3);
    });

    it('creates one order when the same key arrives concurrently', async () => {
      const product = await createProduct();
      const key = randomUUID();

      const results = await Promise.all(
        Array.from({ length: 10 }, () => postWithKey(key, [{ productId: product.id, quantity: 1 }]))
      );

      expect(results.map((res) => res.status)).toEqual(Array(10).fill(201));
      expect(new Set(results.map((res) => res.body.id)).size).toBe(1);
      expect(results.filter((res) => res.headers['idempotent-replayed'])).toHaveLength(9);
      expect(await stockOf(product.id)).toBe(4);
    });

    it('returns 422 when the key is reused with a different body', async () => {
      const product = await createProduct();
      const key = randomUUID();

      await postWithKey(key, [{ productId: product.id, quantity: 1 }]).expect(201);
      const res = await postWithKey(key, [{ productId: product.id, quantity: 2 }]).expect(422);

      expect(res.body.message).toBe(
        'this Idempotency-Key was already used with a different request'
      );
      expect(await stockOf(product.id)).toBe(4);
    });

    it('does not keep the key when the order fails, so the client can retry', async () => {
      const product = await createProduct({ stock: 1 });
      const key = randomUUID();

      await postWithKey(key, [{ productId: product.id, quantity: 2 }]).expect(409);
      await prisma.product.update({ where: { id: product.id }, data: { stock: 5 } });
      const retry = await postWithKey(key, [{ productId: product.id, quantity: 2 }]).expect(201);

      expect(retry.headers['idempotent-replayed']).toBeUndefined();
      expect(await stockOf(product.id)).toBe(3);
    });

    it('rejects an empty or overlong key', async () => {
      const product = await createProduct();

      await postWithKey('', [{ productId: product.id, quantity: 1 }]).expect(400);
      await postWithKey('k'.repeat(256), [{ productId: product.id, quantity: 1 }]).expect(400);
      expect(await stockOf(product.id)).toBe(5);
    });
  });

  it('only fulfils paid orders', async () => {
    const product = await createProduct();
    const { body } = await postOrder([{ productId: product.id, quantity: 1 }]).expect(201);

    await request(app.getHttpServer()).post(`/orders/${body.id}/fulfil`).expect(409);

    await prisma.order.update({ where: { id: body.id }, data: { status: 'cancelled' } });
    await request(app.getHttpServer()).post(`/orders/${body.id}/fulfil`).expect(409);

    await request(app.getHttpServer()).post(`/orders/${randomUUID()}/fulfil`).expect(404);
    await request(app.getHttpServer()).post('/orders/nope/fulfil').expect(400);
  });

  it('returns 404 for an unknown order and 400 for a malformed id', async () => {
    await request(app.getHttpServer()).get(`/orders/${randomUUID()}`).expect(404);
    await request(app.getHttpServer()).get('/orders/not-a-uuid').expect(400);
  });
});
