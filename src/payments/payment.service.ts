import { BadGatewayException, Injectable, Logger } from '@nestjs/common';
import Stripe from 'stripe';

export interface PaymentIntentRequest {
  orderId: string;
  email: string;
  currency: string;
  amount: number;
}

export interface CreatedPaymentIntent {
  id: string;
  clientSecret: string;
}

@Injectable()
export class PaymentService {
  private readonly logger = new Logger(PaymentService.name);

  constructor(private readonly stripe: Stripe) {}

  async createIntent({
    orderId,
    email,
    currency,
    amount,
  }: PaymentIntentRequest): Promise<CreatedPaymentIntent> {
    const intent = await this.call(() =>
      this.stripe.paymentIntents.create(
        {
          amount,
          currency,
          receipt_email: email,
          metadata: { orderId },
          automatic_payment_methods: { enabled: true },
        },
        { idempotencyKey: `order-${orderId}` }
      )
    );

    return { id: intent.id, clientSecret: this.clientSecretOf(intent) };
  }

  async getClientSecret(paymentIntentId: string): Promise<string> {
    const intent = await this.call(() => this.stripe.paymentIntents.retrieve(paymentIntentId));

    return this.clientSecretOf(intent);
  }

  // false when the intent can no longer be cancelled because it succeeded or is still processing
  async cancelIntent(paymentIntentId: string): Promise<boolean> {
    return await this.call(async () => {
      try {
        await this.stripe.paymentIntents.cancel(paymentIntentId, {
          cancellation_reason: 'abandoned',
        });
        return true;
      } catch (error) {
        if (
          error instanceof Stripe.errors.StripeError &&
          error.code === 'payment_intent_unexpected_state'
        ) {
          return error.payment_intent?.status === 'canceled';
        }

        throw error;
      }
    });
  }

  private async call<T>(request: () => Promise<T>): Promise<T> {
    try {
      return await request();
    } catch (error) {
      if (!(error instanceof Stripe.errors.StripeError)) {
        throw error;
      }

      this.logger.error(`stripe request failed: ${error.type}: ${error.message}`);
      throw new BadGatewayException('payment provider request failed');
    }
  }

  private clientSecretOf(intent: Stripe.PaymentIntent): string {
    if (!intent.client_secret) {
      throw new BadGatewayException(`payment intent ${intent.id} has no client secret`);
    }

    return intent.client_secret;
  }
}
