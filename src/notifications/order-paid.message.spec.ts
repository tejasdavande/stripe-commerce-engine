import 'reflect-metadata';
import { parseOrderPaidMessage } from './order-paid.message';

describe('parseOrderPaidMessage', () => {
  const body = {
    orderId: 'f4d3f7a4-3c3e-4a5e-9a59-2a1c2b0f5a11',
    status: 'paid',
    email: 'buyer@example.com',
    currency: 'usd',
    totalAmount: 1500,
    items: [],
  };

  it('parses an order.paid payload', () => {
    expect(parseOrderPaidMessage(Buffer.from(JSON.stringify(body)))).toMatchObject({
      orderId: body.orderId,
      email: body.email,
      totalAmount: 1500,
      currency: 'usd',
    });
  });

  it.each([
    ['not json', Buffer.from('{oops')],
    ['a json string', Buffer.from('"paid"')],
    ['null', Buffer.from('null')],
    ['a missing email', Buffer.from(JSON.stringify({ ...body, email: undefined }))],
    ['a bad order id', Buffer.from(JSON.stringify({ ...body, orderId: '42' }))],
    ['a string amount', Buffer.from(JSON.stringify({ ...body, totalAmount: '1500' }))],
  ])('rejects %s', (_, content) => {
    expect(parseOrderPaidMessage(content)).toBeUndefined();
  });
});
