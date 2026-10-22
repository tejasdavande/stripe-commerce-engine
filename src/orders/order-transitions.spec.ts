import { OrderStatus } from '../generated/prisma/client';
import { canTransition } from './order-transitions';

describe('canTransition', () => {
  it.each([
    [OrderStatus.pending_payment, OrderStatus.paid],
    [OrderStatus.pending_payment, OrderStatus.cancelled],
    [OrderStatus.paid, OrderStatus.fulfilled],
  ])('allows %s -> %s', (from, to) => {
    expect(canTransition(from, to)).toBe(true);
  });

  it.each([
    [OrderStatus.pending_payment, OrderStatus.fulfilled],
    [OrderStatus.paid, OrderStatus.pending_payment],
    [OrderStatus.paid, OrderStatus.cancelled],
    [OrderStatus.cancelled, OrderStatus.paid],
    [OrderStatus.fulfilled, OrderStatus.cancelled],
    [OrderStatus.paid, OrderStatus.paid],
  ])('rejects %s -> %s', (from, to) => {
    expect(canTransition(from, to)).toBe(false);
  });
});
