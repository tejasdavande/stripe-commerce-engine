import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
import { Prisma } from '../generated/prisma/client';
import { OrderService } from '../orders/order.service';
import { isUniqueViolation } from '../prisma/is-unique-violation';
import { PrismaService } from '../prisma/prisma.service';
import { StripeEventRepository } from './stripe-event.repository';

@Injectable()
export class StripeWebhookService {
  private readonly logger = new Logger(StripeWebhookService.name);
  private readonly secret: string;

  constructor(
    private readonly stripe: Stripe,
    private readonly prisma: PrismaService,
    private readonly stripeEventRepository: StripeEventRepository,
    private readonly orderService: OrderService,
    config: ConfigService
  ) {
    this.secret = config.getOrThrow<string>('STRIPE_WEBHOOK_SECRET');
  }

  // the event row goes in first and commits together with its effects. a redelivery that races
  // the first one waits on the primary key, and if anything throws both roll back so stripe retries
  async handle(payload: Buffer | undefined, signature: string | undefined): Promise<void> {
    const event = this.verify(payload, signature);

    try {
      await this.prisma.$transaction(async (tx) => {
        await this.stripeEventRepository.create(event.id, event.type, tx);
        await this.dispatch(event, tx);
      });
    } catch (error) {
      if (!isUniqueViolation(error)) {
        throw error;
      }

      this.logger.log(`skipping duplicate stripe event ${event.id}`);
    }
  }

  private verify(payload: Buffer | undefined, signature: string | undefined): Stripe.Event {
    if (!payload || !signature) {
      throw new BadRequestException('missing stripe signature or body');
    }

    try {
      return this.stripe.webhooks.constructEvent(payload, signature, this.secret);
    } catch (error) {
      if (error instanceof Stripe.errors.StripeSignatureVerificationError) {
        throw new BadRequestException('invalid stripe signature');
      }

      throw error;
    }
  }

  private async dispatch(event: Stripe.Event, tx: Prisma.TransactionClient): Promise<void> {
    switch (event.type) {
      case 'payment_intent.succeeded': {
        const intent = event.data.object;
        await this.orderService.markPaid(
          {
            paymentIntentId: intent.id,
            amount: intent.amount_received,
            currency: intent.currency,
          },
          tx
        );
        break;
      }
      case 'payment_intent.payment_failed':
        this.logger.log(
          `payment attempt failed for intent ${event.data.object.id}, order stays pending_payment`
        );
        break;
      default:
        this.logger.debug(`ignoring stripe event ${event.type}`);
    }
  }
}
