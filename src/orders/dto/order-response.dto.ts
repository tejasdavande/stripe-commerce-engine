import { OrderStatus } from '../../generated/prisma/client';
import { OrderWithItems } from '../order.repository';

export class OrderItemResponseDto {
  productId: string;
  sku: string;
  name: string;
  unitAmount: number;
  quantity: number;
  lineAmount: number;
}

export class OrderResponseDto {
  id: string;
  email: string;
  status: OrderStatus;
  currency: string;
  totalAmount: number;
  items: OrderItemResponseDto[];
  clientSecret?: string;
  createdAt: Date;

  static fromModel(order: OrderWithItems, clientSecret?: string): OrderResponseDto {
    return {
      id: order.id,
      email: order.email,
      status: order.status,
      currency: order.currency,
      totalAmount: order.totalAmount,
      items: order.items.map((item) => ({
        productId: item.productId,
        sku: item.sku,
        name: item.name,
        unitAmount: item.unitAmount,
        quantity: item.quantity,
        lineAmount: item.unitAmount * item.quantity,
      })),
      clientSecret,
      createdAt: order.createdAt,
    };
  }
}
