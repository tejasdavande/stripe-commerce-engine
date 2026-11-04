import { Injectable, Logger } from '@nestjs/common';
import { IdempotencyKeyRepository } from './idempotency-key.repository';

export const IDEMPOTENCY_KEY_TTL_MS = 24 * 60 * 60 * 1000;
const BATCH_SIZE = 1000;

@Injectable()
export class IdempotencyKeyCleanupService {
  private readonly logger = new Logger(IdempotencyKeyCleanupService.name);

  constructor(private readonly idempotencyKeyRepository: IdempotencyKeyRepository) {}

  async purgeExpired(): Promise<number> {
    const cutoff = new Date(Date.now() - IDEMPOTENCY_KEY_TTL_MS);
    let total = 0;
    let deleted: number;

    do {
      deleted = await this.idempotencyKeyRepository.deleteCreatedBefore(cutoff, BATCH_SIZE);
      total += deleted;
    } while (deleted === BATCH_SIZE);

    if (total > 0) {
      this.logger.log(`deleted ${total} expired idempotency keys`);
    }
    return total;
  }
}
