import { OrderStatus } from '../generated/prisma/client';

const allowed: Record<OrderStatus, OrderStatus[]> = {
  [OrderStatus.pending_payment]: [OrderStatus.paid, OrderStatus.cancelled],
  [OrderStatus.paid]: [OrderStatus.fulfilled],
  [OrderStatus.fulfilled]: [],
  [OrderStatus.cancelled]: [],
};

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return allowed[from].includes(to);
}
