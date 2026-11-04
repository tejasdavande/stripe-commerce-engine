import { IdempotencyKeyCleanupJob } from './idempotency-key-cleanup.job';
import { IdempotencyKeyCleanupService } from './idempotency-key-cleanup.service';

describe('IdempotencyKeyCleanupJob', () => {
  let cleanupService: jest.Mocked<Pick<IdempotencyKeyCleanupService, 'purgeExpired'>>;
  let job: IdempotencyKeyCleanupJob;

  beforeEach(() => {
    cleanupService = { purgeExpired: jest.fn().mockResolvedValue(0) };
    job = new IdempotencyKeyCleanupJob(cleanupService as unknown as IdempotencyKeyCleanupService);
  });

  it('skips a tick while the previous run is still going', async () => {
    let finish!: () => void;
    cleanupService.purgeExpired.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = () => resolve(0);
      })
    );

    const first = job.run();
    await job.run();
    finish();
    await first;
    await job.run();

    expect(cleanupService.purgeExpired).toHaveBeenCalledTimes(2);
  });

  it('logs a failed run and runs again on the next tick', async () => {
    cleanupService.purgeExpired.mockRejectedValueOnce(new Error('connection refused'));

    await expect(job.run()).resolves.toBeUndefined();
    await job.run();

    expect(cleanupService.purgeExpired).toHaveBeenCalledTimes(2);
  });
});
