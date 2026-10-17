import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { ProductRepository } from '../src/products/product.repository';
import { setupApp } from '../src/setup-app';

describe('Products (e2e)', () => {
  let app: INestApplication;
  let productRepository: ProductRepository;

  const createProduct = (overrides: { active?: boolean; stock?: number } = {}) =>
    productRepository.upsertBySku({
      sku: `TEST-${randomUUID()}`,
      name: 'Test product',
      unitAmount: 1999,
      stock: 5,
      ...overrides,
    });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    setupApp(app);
    await app.init();
    productRepository = app.get(ProductRepository);
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns an active product without exposing the stock count', async () => {
    const product = await createProduct({ stock: 0 });

    const res = await request(app.getHttpServer()).get(`/products/${product.id}`).expect(200);

    expect(res.body).toEqual({
      id: product.id,
      sku: product.sku,
      name: 'Test product',
      description: null,
      unitAmount: 1999,
      currency: 'usd',
      inStock: false,
    });
  });

  it('hides inactive products', async () => {
    const product = await createProduct({ active: false });

    await request(app.getHttpServer()).get(`/products/${product.id}`).expect(404);

    const list = await request(app.getHttpServer()).get('/products?limit=100').expect(200);
    expect(list.body.items.map((p: { id: string }) => p.id)).not.toContain(product.id);
  });

  it('lists newest first with paging info', async () => {
    const older = await createProduct();
    const newer = await createProduct();

    const res = await request(app.getHttpServer()).get('/products?limit=100').expect(200);
    const ids = res.body.items.map((p: { id: string }) => p.id);

    expect(res.body).toMatchObject({ page: 1, limit: 100 });
    expect(res.body.total).toBeGreaterThanOrEqual(2);
    expect(ids.indexOf(newer.id)).toBeLessThan(ids.indexOf(older.id));
  });

  it('returns 404 for an unknown id and 400 for a malformed one', async () => {
    await request(app.getHttpServer()).get(`/products/${randomUUID()}`).expect(404);
    await request(app.getHttpServer()).get('/products/not-a-uuid').expect(400);
  });

  it('rejects a page size over 100', async () => {
    await request(app.getHttpServer()).get('/products?limit=500').expect(400);
  });
});
