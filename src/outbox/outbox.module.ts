import { Module } from '@nestjs/common';
import { MessagingModule } from '../messaging/messaging.module';
import { OutboxRelayJob } from './outbox-relay.job';
import { OutboxRelayService } from './outbox-relay.service';
import { OutboxRepository } from './outbox.repository';

@Module({
  imports: [MessagingModule],
  providers: [OutboxRepository, OutboxRelayService, OutboxRelayJob],
  exports: [OutboxRepository],
})
export class OutboxModule {}
