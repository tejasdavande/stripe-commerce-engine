import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsEmail, ValidateNested } from 'class-validator';
import { OrderLineDto } from './order-line.dto';

export class CreateOrderDto {
  @IsEmail()
  email: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => OrderLineDto)
  items: OrderLineDto[];
}
