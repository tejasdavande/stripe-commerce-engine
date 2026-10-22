import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
import { PaymentService } from './payment.service';

@Module({
  providers: [
    {
      provide: Stripe,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const apiUrl = config.get<string>('STRIPE_API_URL');
        const target = apiUrl ? new URL(apiUrl) : undefined;

        return new Stripe(config.getOrThrow<string>('STRIPE_SECRET_KEY'), {
          maxNetworkRetries: 2,
          timeout: 10_000,
          ...(target && {
            host: target.hostname,
            port: target.port,
            protocol: target.protocol === 'http:' ? 'http' : 'https',
          }),
        });
      },
    },
    PaymentService,
  ],
  exports: [Stripe, PaymentService],
})
export class PaymentModule {}
