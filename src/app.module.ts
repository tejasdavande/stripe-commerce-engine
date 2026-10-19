import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validate } from './config/env.validator';
import { HealthModule } from './health/health.module';
import { OrderModule } from './orders/order.module';
import { PrismaModule } from './prisma/prisma.module';
import { ProductModule } from './products/product.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate }),
    PrismaModule,
    HealthModule,
    ProductModule,
    OrderModule,
  ],
})
export class AppModule {}
