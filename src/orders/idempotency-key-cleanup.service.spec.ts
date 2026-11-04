import {
  IDEMPOTENCY_KEY_TTL_MS,
  IdempotencyKeyCleanupService,
} from './idempotency-key-cleanup.service';
import { IdempotencyKeyRepository } from './idempotency-key.repository';

describe('IdempotencyKeyCleanupService', () => {
  const now = new Date('2026-11-04T12:00:00Z');
  let repository: jest.Mocked<Pick<IdempotencyKeyRepository, 'deleteCreatedBefore'>>;
  let service: IdempotencyKeyCleanupService;

  beforeEach(() => {
    jest.useFakeTimers({ now, doNotFake: ['nextTick'] });
    repository = { deleteCreatedBefore: jest.fn().mockResolvedValue(0) };
    service = new IdempotencyKeyCleanupService(repository as unknown as IdempotencyKeyRepository);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('deletes keys older than 24 hours', async () => {
    await service.purgeExpired();

    expect(repository.deleteCreatedBefore).toHaveBeenCalledWith(
      new Date(now.getTime() - IDEMPOTENCY_KEY_TTL_MS),
      1000
    );
  });

  it('keeps deleting while batches come back full', async () => {
    repository.deleteCreatedBefore
      .mockResolvedValueOnce(1000)
      .mockResolvedValueOnce(1000)
      .mockResolvedValueOnce(12);

    await expect(service.purgeExpired()).resolves.toBe(2012);
    expect(repository.deleteCreatedBefore).toHaveBeenCalledTimes(3);
  });
});
