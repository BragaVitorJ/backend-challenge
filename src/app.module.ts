import { MiddlewareConsumer, Module, NestModule, RequestMethod } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { loadEnv } from './config/env';
import {
  GetWager,
  GetWallet,
  ListLedger,
  OpenWallet,
  ReconcileWallet,
  ReprocessPendingReferences,
  SubmitWager,
} from './application/wagering';
import { AppMetrics } from './infrastructure/observability/metrics';
import { JsonLogger, LogContext } from './infrastructure/observability/json-logger';
import { mikroOrmOptions } from './infrastructure/persistence/orm';
import { TransactionRunner } from './infrastructure/persistence/transaction-runner';
import { WageringStore } from './infrastructure/persistence/wagering-store';
import { SqsGateway } from './infrastructure/sqs/sqs-gateway';
import { WagerConsumer } from './infrastructure/sqs/wager-consumer';
import { AuthGuard, ApiExceptionFilter } from './interfaces/http/auth';
import { HealthController, MetricsController, WagerController, WalletController } from './interfaces/http/http';
import { CorrelationMiddleware } from './interfaces/http/correlation';
import { OutboxPublisher, PendingReferenceWorker } from './workers/background';
import { DatabaseBootstrap } from './infrastructure/persistence/bootstrap';

const env = loadEnv();

@Module({
  imports: [
    MikroOrmModule.forRoot({
      ...mikroOrmOptions(env),
      registerRequestContext: false,
    }),
  ],
  controllers: [WalletController, WagerController, HealthController, MetricsController],
  providers: [
    { provide: 'ENV', useValue: env },
    LogContext,
    JsonLogger,
    AppMetrics,
    WageringStore,
    TransactionRunner,
    OpenWallet,
    SubmitWager,
    ReprocessPendingReferences,
    GetWallet,
    ListLedger,
    GetWager,
    ReconcileWallet,
    SqsGateway,
    CorrelationMiddleware,
    WagerConsumer,
    OutboxPublisher,
    PendingReferenceWorker,
    DatabaseBootstrap,
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_FILTER, useClass: ApiExceptionFilter },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationMiddleware).forRoutes({ path: '*', method: RequestMethod.ALL });
  }
}
