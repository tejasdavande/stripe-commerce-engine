import { Injectable, Logger } from '@nestjs/common';
import { OrderPaidMessage } from './order-paid.message';

@Injectable()
export class OrderConfirmationMailer {
  private readonly logger = new Logger(OrderConfirmationMailer.name);

  // TODO: real mail transport, this only logs for now
  async send(order: OrderPaidMessage): Promise<void> {
    this.logger.log(
      `order confirmation for ${order.orderId} to ${order.email}: ${order.totalAmount} ${order.currency}`
    );
  }
}
