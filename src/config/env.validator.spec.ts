import 'reflect-metadata';
import { validate } from './env.validator';

describe('validate', () => {
  const base = {
    PORT: '3000',
    DATABASE_URL: 'postgresql://commerce:commerce@localhost:5432/commerce',
    STRIPE_SECRET_KEY: 'sk_test_123',
    STRIPE_WEBHOOK_SECRET: 'whsec_test',
  };

  it('converts PORT to a number', () => {
    expect(validate(base).PORT).toBe(3000);
  });

  it('rejects a missing DATABASE_URL', () => {
    expect(() => validate({ ...base, DATABASE_URL: undefined })).toThrow();
  });

  it('rejects a missing or empty STRIPE_SECRET_KEY', () => {
    expect(() => validate({ ...base, STRIPE_SECRET_KEY: undefined })).toThrow();
    expect(() => validate({ ...base, STRIPE_SECRET_KEY: '' })).toThrow();
  });

  it('rejects a missing STRIPE_WEBHOOK_SECRET', () => {
    expect(() => validate({ ...base, STRIPE_WEBHOOK_SECRET: undefined })).toThrow();
  });

  it('accepts a stripe-mock url without a tld and rejects one without a protocol', () => {
    expect(validate({ ...base, STRIPE_API_URL: 'http://stripe-mock:12111' }).STRIPE_API_URL).toBe(
      'http://stripe-mock:12111'
    );
    expect(() => validate({ ...base, STRIPE_API_URL: 'localhost:12111' })).toThrow();
  });

  it('defaults the unpaid order ttl to 30 minutes and rejects anything below 1', () => {
    expect(validate(base).ORDER_PAYMENT_TTL_MINUTES).toBe(30);
    expect(validate({ ...base, ORDER_PAYMENT_TTL_MINUTES: '5' }).ORDER_PAYMENT_TTL_MINUTES).toBe(5);
    expect(() => validate({ ...base, ORDER_PAYMENT_TTL_MINUTES: '0' })).toThrow();
    expect(() => validate({ ...base, ORDER_PAYMENT_TTL_MINUTES: '1.5' })).toThrow();
  });
});
