import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { Env } from '../config/env';
import { ReprocessPendingReferences } from '../application/wagering';
import { isTransientError } from '../domain/errors';
import { JsonLogger } from '../infrastructure/observability/json-logger';
import { AppMetrics } from '../infrastructure/observability/metrics';
import { TransactionRunner } from '../infrastructure/persistence/transaction-runner';
import { WageringStore } from '../infrastructure/persistence/wagering-store';
import { SqsGateway } from '../infrastructure/sqs/sqs-gateway';

@Injectable()
export class OutboxPublisher implements OnModuleInit, OnModuleDestroy {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<void> | null = null;
  private stopped = false;

  constructor(
    @Inject('ENV') private readonly env: Env,
    @Inject(TransactionRunner) private readonly runner: TransactionRunner,
    @Inject(WageringStore) private readonly store: WageringStore,
    @Inject(SqsGateway) private readonly sqs: SqsGateway,
    @Inject(AppMetrics) private readonly metrics: AppMetrics,
    @Inject(JsonLogger) private readonly logger: JsonLogger,
  ) {}

  onModuleInit(): void {
    if (!this.env.workersEnabled) {
      return;
    }
    this.timer = setInterval(() => {
      void this.safePublish();
    }, this.env.outboxPollMs);
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
    }
    if (this.running) {
      await this.running;
    }
  }

  async publishOnce(): Promise<number> {
    const claimed = await this.runner.run(() => this.store.claimOutbox(new Date(), 20, 30_000));
    let published = 0;
    for (const message of claimed) {
      if (this.stopped) {
        break;
      }
      try {
        await this.sqs.publishEvent(message);
        await this.runner.run(() => this.store.markOutboxPublished(message.id, new Date()));
        published += 1;
      } catch (error) {
        this.metrics.addRetry();
        const now = new Date();
        if (message.attempts >= 20) {
          message.scheduleRetry(now, 3_600_000, 3_600_000);
        } else {
          message.scheduleRetry(now, 1000, 60_000);
        }
        await this.runner.run(() => this.store.saveOutboxRetry(message));
        if (!isTransientError(error)) {
          this.logger.warn('outbox publish failed', { transactionId: message.id });
        }
      }
    }
    const lag = await this.runner.run(() => this.store.outboxLagMs(new Date()));
    this.metrics.setOutboxLag(lag);
    return published;
  }

  private async safePublish(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = this.publishOnce().then(() => undefined);
    try {
      await this.running;
    } catch (error) {
      if (!isTransientError(error)) {
        this.logger.error('outbox publisher failed');
      }
    } finally {
      this.running = null;
    }
  }
}

@Injectable()
export class PendingReferenceWorker implements OnModuleInit, OnModuleDestroy {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<void> | null = null;

  constructor(
    @Inject('ENV') private readonly env: Env,
    @Inject(ReprocessPendingReferences) private readonly reprocess: ReprocessPendingReferences,
    @Inject(JsonLogger) private readonly logger: JsonLogger,
  ) {}

  onModuleInit(): void {
    if (!this.env.workersEnabled) {
      return;
    }
    this.timer = setInterval(() => {
      void this.safeRun();
    }, this.env.pendingPollMs);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
    }
    if (this.running) {
      await this.running;
    }
  }

  private async safeRun(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = this.reprocess.runOnce().then(() => undefined);
    try {
      await this.running;
    } catch {
      this.logger.error('pending reference worker failed');
    } finally {
      this.running = null;
    }
  }
}
