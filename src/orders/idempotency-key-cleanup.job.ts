import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { errorReason } from '../common/error-reason';
import { IdempotencyKeyCleanupService } from './idempotency-key-cleanup.service';

@Injectable()
export class IdempotencyKeyCleanupJob {
  private readonly logger = new Logger(IdempotencyKeyCleanupJob.name);
  private running = false;

  constructor(private readonly cleanupService: IdempotencyKeyCleanupService) {}

  @Cron(CronExpression.EVERY_HOUR, { name: 'idempotency-key-cleanup' })
  async run(): Promise<void> {
    if (this.running) {
      return;
    }

    this.running = true;
    try {
      await this.cleanupService.purgeExpired();
    } catch (error) {
      this.logger.error(`idempotency key cleanup failed: ${errorReason(error)}`);
    } finally {
      this.running = false;
    }
  }
}
