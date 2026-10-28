import { Module } from '@nestjs/common';
import { EventPublisher } from './event-publisher';

@Module({
  providers: [EventPublisher],
  exports: [EventPublisher],
})
export class MessagingModule {}
