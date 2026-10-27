import { Module } from '@nestjs/common';
import { OutboxModule } from '../outbox/outbox.module';
import { PaymentModule } from '../payments/payment.module';
import { ProductModule } from '../products/product.module';
import { IdempotencyKeyRepository } from './idempotency-key.repository';
import { OrderExpiryJob } from './order-expiry.job';
import { OrderExpiryService } from './order-expiry.service';
import { OrderController } from './order.controller';
import { OrderRepository } from './order.repository';
import { OrderService } from './order.service';

@Module({
  imports: [ProductModule, PaymentModule, OutboxModule],
  controllers: [OrderController],
  providers: [
    OrderRepository,
    IdempotencyKeyRepository,
    OrderService,
    OrderExpiryService,
    OrderExpiryJob,
  ],
  exports: [OrderService],
})
export class OrderModule {}
