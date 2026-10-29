import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { validate } from './config/env.validator';
import { HealthModule } from './health/health.module';
import { NotificationModule } from './notifications/notification.module';
import { OrderModule } from './orders/order.module';
import { PrismaModule } from './prisma/prisma.module';
import { ProductModule } from './products/product.module';
import { WebhookModule } from './webhooks/webhook.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate }),
    ScheduleModule.forRoot(),
    PrismaModule,
    HealthModule,
    ProductModule,
    OrderModule,
    WebhookModule,
    NotificationModule,
  ],
})
export class AppModule {}
