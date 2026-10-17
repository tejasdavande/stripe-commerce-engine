import { ProductResponseDto } from './product-response.dto';

export interface ProductPageDto {
  items: ProductResponseDto[];
  page: number;
  limit: number;
  total: number;
}
