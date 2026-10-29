import { Module } from '@nestjs/common';
import { OrderConfirmationConsumer } from './order-confirmation.consumer';
import { OrderConfirmationMailer } from './order-confirmation.mailer';
import { OrderConfirmationService } from './order-confirmation.service';
import { ProcessedMessageRepository } from './processed-message.repository';

@Module({
  providers: [
    ProcessedMessageRepository,
    OrderConfirmationMailer,
    OrderConfirmationService,
    OrderConfirmationConsumer,
  ],
})
export class NotificationModule {}
