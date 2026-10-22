import { Module } from '@nestjs/common';
import { OrderModule } from '../orders/order.module';
import { PaymentModule } from '../payments/payment.module';
import { StripeEventRepository } from './stripe-event.repository';
import { StripeWebhookController } from './stripe-webhook.controller';
import { StripeWebhookService } from './stripe-webhook.service';

@Module({
  imports: [PaymentModule, OrderModule],
  controllers: [StripeWebhookController],
  providers: [StripeEventRepository, StripeWebhookService],
})
export class WebhookModule {}
