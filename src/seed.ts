import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ProductRepository } from './products/product.repository';

const products = [
  {
    sku: 'TEE-BLK-M',
    name: 'Black tee, M',
    description: 'Heavyweight cotton t-shirt',
    unitAmount: 2500,
    stock: 120,
  },
  {
    sku: 'HOOD-GRY-L',
    name: 'Grey hoodie, L',
    description: 'Brushed fleece pullover',
    unitAmount: 6500,
    stock: 40,
  },
  {
    sku: 'MUG-WHT',
    name: 'White mug',
    description: '350 ml ceramic',
    unitAmount: 1400,
    stock: 200,
  },
  { sku: 'CAP-NVY', name: 'Navy cap', description: null, unitAmount: 2200, stock: 0 },
];

async function seed() {
  const logger = new Logger('Seed');
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  const productRepository = app.get(ProductRepository);

  for (const product of products) {
    await productRepository.upsertBySku(product);
  }
  logger.log(`seeded ${products.length} products`);

  await app.close();
}

seed().catch((error) => {
  new Logger('Seed').error(error);
  process.exit(1);
});
