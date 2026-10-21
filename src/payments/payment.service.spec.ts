import { BadGatewayException } from '@nestjs/common';
import Stripe from 'stripe';
import { PaymentService } from './payment.service';

describe('PaymentService', () => {
  let paymentIntents: { create: jest.Mock; retrieve: jest.Mock };
  let service: PaymentService;

  const request = {
    orderId: 'order-1',
    email: 'buyer@example.com',
    currency: 'usd',
    amount: 4200,
  };

  beforeEach(() => {
    paymentIntents = {
      create: jest.fn().mockResolvedValue({ id: 'pi_1', client_secret: 'pi_1_secret_abc' }),
      retrieve: jest.fn().mockResolvedValue({ id: 'pi_1', client_secret: 'pi_1_secret_abc' }),
    };
    service = new PaymentService({ paymentIntents } as unknown as Stripe);
  });

  it('creates one intent per order, keyed on the order id', async () => {
    await expect(service.createIntent(request)).resolves.toEqual({
      id: 'pi_1',
      clientSecret: 'pi_1_secret_abc',
    });

    expect(paymentIntents.create).toHaveBeenCalledWith(
      {
        amount: 4200,
        currency: 'usd',
        receipt_email: 'buyer@example.com',
        metadata: { orderId: 'order-1' },
        automatic_payment_methods: { enabled: true },
      },
      { idempotencyKey: 'order-order-1' }
    );
  });

  it('reads the client secret of an existing intent', async () => {
    await expect(service.getClientSecret('pi_1')).resolves.toBe('pi_1_secret_abc');
    expect(paymentIntents.retrieve).toHaveBeenCalledWith('pi_1');
  });

  it('turns stripe errors into 502', async () => {
    paymentIntents.create.mockRejectedValue(
      new Stripe.errors.StripeConnectionError({ message: 'connect ECONNREFUSED' })
    );
    paymentIntents.retrieve.mockRejectedValue(
      new Stripe.errors.StripeAPIError({ message: 'internal error' })
    );

    await expect(service.createIntent(request)).rejects.toThrow(BadGatewayException);
    await expect(service.getClientSecret('pi_1')).rejects.toThrow(BadGatewayException);
  });

  it('rethrows errors that do not come from stripe', async () => {
    paymentIntents.create.mockRejectedValue(new TypeError('boom'));

    await expect(service.createIntent(request)).rejects.toThrow(TypeError);
  });
});
