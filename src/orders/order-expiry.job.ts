import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { errorReason } from '../common/error-reason';
import { OrderExpiryService } from './order-expiry.service';

@Injectable()
export class OrderExpiryJob {
  private readonly logger = new Logger(OrderExpiryJob.name);
  private running = false;

  constructor(private readonly orderExpiryService: OrderExpiryService) {}

  // a slow stripe can make one run outlast the minute, so the next tick skips instead of overlapping
  @Cron(CronExpression.EVERY_MINUTE, { name: 'order-expiry' })
  async run(): Promise<void> {
    if (this.running) {
      return;
    }

    this.running = true;
    try {
      await this.orderExpiryService.expireUnpaid();
    } catch (error) {
      this.logger.error(`order expiry run failed: ${errorReason(error)}`);
    } finally {
      this.running = false;
    }
  }
}
