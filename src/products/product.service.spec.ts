import { NotFoundException } from '@nestjs/common';
import { Product } from '../generated/prisma/client';
import { ProductRepository } from './product.repository';
import { ProductService } from './product.service';

describe('ProductService', () => {
  const product: Product = {
    id: '6f1c2b0e-3a51-4d8e-9a39-2f5f3b7c1d10',
    sku: 'TEE-BLK-M',
    name: 'Black tee',
    description: null,
    unitAmount: 2500,
    currency: 'usd',
    stock: 0,
    active: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  let repository: jest.Mocked<Pick<ProductRepository, 'findActivePage' | 'findActiveById'>>;
  let service: ProductService;

  beforeEach(() => {
    repository = {
      findActivePage: jest.fn().mockResolvedValue([[product], 41]),
      findActiveById: jest.fn().mockResolvedValue(product),
    };
    service = new ProductService(repository as unknown as ProductRepository);
  });

  it('pages with skip/take and maps stock to inStock', async () => {
    const result = await service.list({ page: 3, limit: 20 });

    expect(repository.findActivePage).toHaveBeenCalledWith(40, 20);
    expect(result).toEqual({
      items: [expect.objectContaining({ id: product.id, inStock: false })],
      page: 3,
      limit: 20,
      total: 41,
    });
    expect(result.items[0]).not.toHaveProperty('stock');
  });

  it('throws 404 for a missing or inactive product', async () => {
    repository.findActiveById.mockResolvedValue(null);

    await expect(service.getById(product.id)).rejects.toThrow(NotFoundException);
  });
});
