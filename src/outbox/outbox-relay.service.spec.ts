import { EventPublisher } from '../messaging/event-publisher';
import { PrismaService } from '../prisma/prisma.service';
import { OutboxRelayService, RELAY_BATCH_SIZE } from './outbox-relay.service';
import { OutboxRepository } from './outbox.repository';

describe('OutboxRelayService', () => {
  const tx = {};
  let outboxRepository: jest.Mocked<Pick<OutboxRepository, 'claimUnpublished' | 'markPublished'>>;
  let eventPublisher: jest.Mocked<Pick<EventPublisher, 'publish'>>;
  let service: OutboxRelayService;

  const row = (id: string) => ({
    id,
    type: 'order.paid',
    aggregateId: `order-${id}`,
    payload: { orderId: `order-${id}`, status: 'paid' },
    createdAt: new Date('2026-10-28T10:00:00Z'),
    publishedAt: null,
  });

  beforeEach(() => {
    const prisma = {
      $transaction: jest.fn((fn: (client: unknown) => Promise<unknown>) => fn(tx)),
    };
    outboxRepository = {
      claimUnpublished: jest.fn().mockResolvedValue([]),
      markPublished: jest.fn().mockResolvedValue(undefined),
    };
    eventPublisher = { publish: jest.fn().mockResolvedValue(undefined) };
    service = new OutboxRelayService(
      prisma as unknown as PrismaService,
      outboxRepository as unknown as OutboxRepository,
      eventPublisher as unknown as EventPublisher
    );
  });

  it('publishes claimed rows and marks them published in the same transaction', async () => {
    outboxRepository.claimUnpublished.mockResolvedValueOnce([row('1'), row('2')]);

    await expect(service.relayPending()).resolves.toBe(2);

    expect(outboxRepository.claimUnpublished).toHaveBeenCalledWith(RELAY_BATCH_SIZE, tx);
    expect(eventPublisher.publish).toHaveBeenCalledWith([
      {
        id: '1',
        type: 'order.paid',
        payload: { orderId: 'order-1', status: 'paid' },
        occurredAt: new Date('2026-10-28T10:00:00Z'),
      },
      expect.objectContaining({ id: '2' }),
    ]);
    expect(outboxRepository.markPublished).toHaveBeenCalledWith(['1', '2'], tx);
  });

  it('does nothing when there is nothing to publish', async () => {
    await expect(service.relayPending()).resolves.toBe(0);

    expect(eventPublisher.publish).not.toHaveBeenCalled();
    expect(outboxRepository.markPublished).not.toHaveBeenCalled();
  });

  it('keeps going while batches come back full', async () => {
    const full = Array.from({ length: RELAY_BATCH_SIZE }, (_, i) => row(String(i)));
    outboxRepository.claimUnpublished.mockResolvedValueOnce(full).mockResolvedValueOnce([row('x')]);

    await expect(service.relayPending()).resolves.toBe(RELAY_BATCH_SIZE + 1);

    expect(outboxRepository.claimUnpublished).toHaveBeenCalledTimes(2);
  });

  it('leaves rows unpublished when the broker fails', async () => {
    outboxRepository.claimUnpublished.mockResolvedValueOnce([row('1')]);
    eventPublisher.publish.mockRejectedValueOnce(new Error('could not connect to rabbitmq'));

    await expect(service.relayPending()).rejects.toThrow('could not connect to rabbitmq');

    expect(outboxRepository.markPublished).not.toHaveBeenCalled();
  });
});
