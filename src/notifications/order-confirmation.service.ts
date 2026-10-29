import { Injectable, Logger } from '@nestjs/common';
import { isUniqueViolation } from '../prisma/is-unique-violation';
import { PrismaService } from '../prisma/prisma.service';
import { OrderConfirmationMailer } from './order-confirmation.mailer';
import { OrderPaidMessage } from './order-paid.message';
import { ProcessedMessageRepository } from './processed-message.repository';

export const ORDER_CONFIRMATION_CONSUMER = 'order-confirmation';

@Injectable()
export class OrderConfirmationService {
  private readonly logger = new Logger(OrderConfirmationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly processedMessageRepository: ProcessedMessageRepository,
    private readonly mailer: OrderConfirmationMailer
  ) {}

  // the processed row only commits after the mail went out, so a failed send gets retried. a crash
  // between the send and the commit sends it twice, which beats not sending it at all
  async handle(messageId: string, order: OrderPaidMessage): Promise<boolean> {
    try {
      await this.prisma.$transaction(async (tx) => {
        await this.processedMessageRepository.create(ORDER_CONFIRMATION_CONSUMER, messageId, tx);
        await this.mailer.send(order);
      });
      return true;
    } catch (error) {
      if (!isUniqueViolation(error)) {
        throw error;
      }

      this.logger.log(`skipping duplicate message ${messageId}`);
      return false;
    }
  }
}
