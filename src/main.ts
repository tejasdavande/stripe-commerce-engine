import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { setupApp } from './setup-app';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const config = app.get(ConfigService);

  setupApp(app);
  app.enableShutdownHooks();

  await app.listen(config.get<number>('PORT') ?? 3000);
}

bootstrap();
