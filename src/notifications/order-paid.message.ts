import { plainToInstance } from 'class-transformer';
import { IsEmail, IsInt, IsString, IsUUID, Length, Min, validateSync } from 'class-validator';

export class OrderPaidMessage {
  @IsUUID()
  orderId: string;

  @IsEmail()
  email: string;

  @IsInt()
  @Min(0)
  totalAmount: number;

  @IsString()
  @Length(3, 3)
  currency: string;
}

export function parseOrderPaidMessage(content: Buffer): OrderPaidMessage | undefined {
  let body: unknown;
  try {
    body = JSON.parse(content.toString());
  } catch {
    return undefined;
  }

  if (typeof body !== 'object' || body === null) {
    return undefined;
  }

  const message = plainToInstance(OrderPaidMessage, body);
  return validateSync(message).length === 0 ? message : undefined;
}
