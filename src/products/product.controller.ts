import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ListProductsQueryDto } from './dto/list-products-query.dto';
import { ProductPageDto } from './dto/product-page.dto';
import { ProductResponseDto } from './dto/product-response.dto';
import { ProductService } from './product.service';

@Controller('products')
export class ProductController {
  constructor(private readonly productService: ProductService) {}

  @Get()
  async list(@Query() query: ListProductsQueryDto): Promise<ProductPageDto> {
    return await this.productService.list(query);
  }

  @Get(':id')
  async getById(@Param('id', ParseUUIDPipe) id: string): Promise<ProductResponseDto> {
    return await this.productService.getById(id);
  }
}
