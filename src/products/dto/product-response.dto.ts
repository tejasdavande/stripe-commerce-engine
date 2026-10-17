import { Product } from '../../generated/prisma/client';

export class ProductResponseDto {
  id: string;
  sku: string;
  name: string;
  description: string | null;
  unitAmount: number;
  currency: string;
  inStock: boolean;

  static fromModel(product: Product): ProductResponseDto {
    return {
      id: product.id,
      sku: product.sku,
      name: product.name,
      description: product.description,
      unitAmount: product.unitAmount,
      currency: product.currency,
      inStock: product.stock > 0,
    };
  }
}
