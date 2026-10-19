import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { CreateOrderDto } from './dto/create-order.dto';
import { OrderResponseDto } from './dto/order-response.dto';
import { OrderService } from './order.service';

@Controller('orders')
export class OrderController {
  constructor(private readonly orderService: OrderService) {}

  @Post()
  async create(@Body() dto: CreateOrderDto): Promise<OrderResponseDto> {
    return await this.orderService.create(dto);
  }

  @Get(':id')
  async getById(@Param('id', ParseUUIDPipe) id: string): Promise<OrderResponseDto> {
    return await this.orderService.getById(id);
  }
}
