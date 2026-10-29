import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { OrderConfirmationMailer } from './order-confirmation.mailer';
import {
  ORDER_CONFIRMATION_CONSUMER,
  OrderConfirmationService,
} from './order-confirmation.service';
import { OrderPaidMessage } from './order-paid.message';
import { ProcessedMessageRepository } from './processed-message.repository';

describe('OrderConfirmationService', () => {
  const tx = {};
  const order: OrderPaidMessage = {
    orderId: 'f4d3f7a4-3c3e-4a5e-9a59-2a1c2b0f5a11',
    email: 'buyer@example.com',
    totalAmount: 1500,
    currency: 'usd',
  };

  let processedMessageRepository: jest.Mocked<Pick<ProcessedMessageRepository, 'create'>>;
  let mailer: jest.Mocked<Pick<OrderConfirmationMailer, 'send'>>;
  let service: OrderConfirmationService;

  beforeEach(() => {
    const prisma = {
      $transaction: jest.fn((fn: (client: unknown) => Promise<unknown>) => fn(tx)),
    };
    processedMessageRepository = { create: jest.fn().mockResolvedValue(undefined) };
    mailer = { send: jest.fn().mockResolvedValue(undefined) };
    service = new OrderConfirmationService(
      prisma as unknown as PrismaService,
      processedMessageRepository as unknown as ProcessedMessageRepository,
      mailer as unknown as OrderConfirmationMailer
    );
  });

  it('records the message and sends the confirmation in one transaction', async () => {
    await expect(service.handle('msg-1', order)).resolves.toBe(true);

    expect(processedMessageRepository.create).toHaveBeenCalledWith(
      ORDER_CONFIRMATION_CONSUMER,
      'msg-1',
      tx
    );
    expect(mailer.send).toHaveBeenCalledWith(order);
  });

  it('skips a message it has already processed', async () => {
    processedMessageRepository.create.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('duplicate', {
        code: 'P2002',
        clientVersion: 'test',
      })
    );

    await expect(service.handle('msg-1', order)).resolves.toBe(false);
    expect(mailer.send).not.toHaveBeenCalled();
  });

  it('rethrows a failed send so the message gets retried', async () => {
    mailer.send.mockRejectedValueOnce(new Error('smtp down'));

    await expect(service.handle('msg-1', order)).rejects.toThrow('smtp down');
  });
});
