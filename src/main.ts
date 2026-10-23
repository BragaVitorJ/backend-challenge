import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { loadEnv } from './config/env';
import { JsonLogger } from './infrastructure/observability/json-logger';
import { LogContext } from './infrastructure/observability/json-logger';

async function bootstrap(): Promise<void> {
  const env = loadEnv();
  const logger = new JsonLogger(new LogContext());
  const app = await NestFactory.create(AppModule, { logger });
  app.enableShutdownHooks();
  await app.listen(env.port);
  logger.info('wagering processor listening', { port: env.port });
}

void bootstrap();
