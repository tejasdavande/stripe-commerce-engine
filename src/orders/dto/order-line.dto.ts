import { IsInt, IsUUID, Max, Min } from 'class-validator';

export class OrderLineDto {
  @IsUUID()
  productId: string;

  @IsInt()
  @Min(1)
  @Max(100)
  quantity: number;
}
