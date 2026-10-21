import { Module } from '@nestjs/common';
import { PaymentModule } from '../payments/payment.module';
import { ProductModule } from '../products/product.module';
import { IdempotencyKeyRepository } from './idempotency-key.repository';
import { OrderController } from './order.controller';
import { OrderRepository } from './order.repository';
import { OrderService } from './order.service';

@Module({
  imports: [ProductModule, PaymentModule],
  controllers: [OrderController],
  providers: [OrderRepository, IdempotencyKeyRepository, OrderService],
})
export class OrderModule {}
