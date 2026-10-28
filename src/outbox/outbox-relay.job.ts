import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { OutboxRelayService } from './outbox-relay.service';

@Injectable()
export class OutboxRelayJob {
  private readonly logger = new Logger(OutboxRelayJob.name);
  private running = false;
  private failing = false;

  constructor(private readonly outboxRelayService: OutboxRelayService) {}

  // runs every second, so a broker outage is logged once when it starts and once when it ends
  @Interval('outbox-relay', 1_000)
  async run(): Promise<void> {
    if (this.running) {
      return;
    }

    this.running = true;
    try {
      await this.outboxRelayService.relayPending();
      if (this.failing) {
        this.failing = false;
        this.logger.log('outbox relay recovered');
      }
    } catch (error) {
      if (!this.failing) {
        this.failing = true;
        this.logger.warn(`outbox relay failed, retrying every second: ${(error as Error).message}`);
      }
    } finally {
      this.running = false;
    }
  }
}
