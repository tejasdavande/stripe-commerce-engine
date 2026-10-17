import { Injectable, NotFoundException } from '@nestjs/common';
import { ListProductsQueryDto } from './dto/list-products-query.dto';
import { ProductPageDto } from './dto/product-page.dto';
import { ProductResponseDto } from './dto/product-response.dto';
import { ProductRepository } from './product.repository';

@Injectable()
export class ProductService {
  constructor(private readonly productRepository: ProductRepository) {}

  async list({ page, limit }: ListProductsQueryDto): Promise<ProductPageDto> {
    const [products, total] = await this.productRepository.findActivePage(
      (page - 1) * limit,
      limit
    );

    return { items: products.map(ProductResponseDto.fromModel), page, limit, total };
  }

  async getById(id: string): Promise<ProductResponseDto> {
    const product = await this.productRepository.findActiveById(id);

    if (!product) {
      throw new NotFoundException('product not found');
    }

    return ProductResponseDto.fromModel(product);
  }
}
