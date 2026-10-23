import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Res } from '@nestjs/common';
import { Response } from 'express';
import { CreateOrderDto } from './dto/create-order.dto';
import { OrderResponseDto } from './dto/order-response.dto';
import { IdempotencyKey } from './idempotency-key.decorator';
import { OrderService } from './order.service';

@Controller('orders')
export class OrderController {
  constructor(private readonly orderService: OrderService) {}

  @Post()
  async create(
    @Body() dto: CreateOrderDto,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @Res({ passthrough: true }) res: Response
  ): Promise<OrderResponseDto> {
    const { order, replayed } = await this.orderService.create(dto, idempotencyKey);

    if (replayed) {
      res.setHeader('Idempotent-Replayed', 'true');
    }

    return order;
  }

  @Get(':id')
  async getById(@Param('id', ParseUUIDPipe) id: string): Promise<OrderResponseDto> {
    return await this.orderService.getById(id);
  }

  @Post(':id/fulfil')
  @HttpCode(200)
  async fulfil(@Param('id', ParseUUIDPipe) id: string): Promise<OrderResponseDto> {
    return await this.orderService.fulfil(id);
  }
}
