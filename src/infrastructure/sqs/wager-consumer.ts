import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { Message } from '@aws-sdk/client-sqs';
import type { Env } from '../../config/env';
import { SubmitWager, type SubmitWagerInput } from '../../application/wagering';
import { EXTERNAL_KINDS, type WagerTransactionKind } from '../../domain/enums';
import {
  IdempotencyConflictError,
  InvalidPayloadError,
  WalletNotFoundError,
  isTransientError,
} from '../../domain/errors';
import { hashBusinessPayload } from '../../domain/idempotency/payload-hash';
import { Money } from '../../domain/money/money';
import { AppMetrics } from '../observability/metrics';
import { JsonLogger } from '../observability/json-logger';
import { LogContext } from '../observability/json-logger';
import { SqsGateway } from './sqs-gateway';

type Disposition = 'ack' | 'retry' | 'dlq';

@Injectable()
export class WagerConsumer implements OnModuleInit, OnModuleDestroy {
  private running = false;
  private loopPromise: Promise<void> | null = null;
  private current: Promise<void> | null = null;

  constructor(
    @Inject('ENV') private readonly env: Env,
    @Inject(SqsGateway) private readonly sqs: SqsGateway,
    @Inject(SubmitWager) private readonly submit: SubmitWager,
    @Inject(AppMetrics) private readonly metrics: AppMetrics,
    @Inject(JsonLogger) private readonly logger: JsonLogger,
    @Inject(LogContext) private readonly logContext: LogContext,
  ) {}

  onModuleInit(): void {
    if (!this.env.workersEnabled) {
      return;
    }
    this.running = true;
    this.loopPromise = this.loop();
  }

  async onModuleDestroy(): Promise<void> {
    this.running = false;
    if (this.current) {
      await this.current;
    }
    if (this.loopPromise) {
      await this.loopPromise;
    }
  }

  async handleDelivery(message: Message): Promise<Disposition> {
    const body = message.Body ?? '';
    let groupId = 'unknown';
    try {
      const command = this.parse(body, message.MessageId);
      groupId = command.walletId;
      await this.logContext.run(
        {
          correlationId: command.correlationId,
          messageId: command.inbox?.messageId,
          walletId: command.walletId,
          providerId: command.providerId,
        },
        () => this.submit.execute(command),
      );
      return 'ack';
    } catch (error) {
      if (error instanceof InvalidPayloadError || error instanceof IdempotencyConflictError) {
        this.logger.error('permanent wager message', { messageId: message.MessageId });
        return 'dlq';
      }
      if (error instanceof WalletNotFoundError || isTransientError(error)) {
        return 'retry';
      }
      this.logger.error('unexpected wager message failure', { messageId: message.MessageId });
      return 'dlq';
    }
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        const messages = await this.sqs.receiveWagers();
        for (const message of messages) {
          if (!this.running) {
            if (message.ReceiptHandle) {
              await this.sqs.releaseWager(message.ReceiptHandle);
            }
            continue;
          }
          this.current = this.consume(message);
          await this.current;
          this.current = null;
        }
      } catch (error) {
        if (!isTransientError(error)) {
          this.logger.error('wager consumer poll failed');
        }
        await sleep(1000);
      }
    }
  }

  private async consume(message: Message): Promise<void> {
    if (!message.ReceiptHandle || !message.Body) {
      return;
    }
    const disposition = await this.handleDelivery(message);
    const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? '1');
    if (disposition === 'ack') {
      await this.sqs.deleteWager(message.ReceiptHandle);
      return;
    }
    if (disposition === 'dlq' || receiveCount >= this.env.sqsMaxReceiveCount) {
      await this.sqs.sendToDlq(message.Body, message.MessageId ?? 'wager');
      await this.sqs.deleteWager(message.ReceiptHandle);
      this.metrics.addDlq();
      return;
    }
    this.metrics.addRetry();
    await this.sqs.retryWager(message.ReceiptHandle, receiveCount);
  }

  private parse(body: string, sqsMessageId?: string): SubmitWagerInput {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new InvalidPayloadError('message body is not json');
    }
    if (!parsed || typeof parsed !== 'object') {
      throw new InvalidPayloadError('message body must be an object');
    }
    const envelope = parsed as Record<string, unknown>;
    const data = envelope.data;
    if (!data || typeof data !== 'object') {
      throw new InvalidPayloadError('message data is required');
    }
    const record = data as Record<string, unknown>;
    const kind = record.kind;
    if (typeof kind !== 'string' || !EXTERNAL_KINDS.includes(kind as WagerTransactionKind)) {
      throw new InvalidPayloadError('kind is invalid');
    }
    const moneyRecord = record.money;
    if (!moneyRecord || typeof moneyRecord !== 'object') {
      throw new InvalidPayloadError('money is required');
    }
    const money = Money.from(moneyRecord as { amount: string; currency: string });
    const required = [
      'providerId',
      'externalTransactionId',
      'playerId',
      'walletId',
      'roundId',
      'gameId',
    ] as const;
    const values: Record<string, string> = {};
    for (const field of required) {
      const value = record[field];
      if (typeof value !== 'string' || value.length === 0) {
        throw new InvalidPayloadError(`${field} is required`);
      }
      values[field] = value;
    }
    const reference =
      typeof record.referenceExternalTransactionId === 'string'
        ? record.referenceExternalTransactionId
        : undefined;
    const idempotencyKey =
      typeof record.idempotencyKey === 'string' && record.idempotencyKey.length > 0
        ? record.idempotencyKey
        : `${values.providerId}:${values.externalTransactionId}`;
    const messageId = typeof envelope.messageId === 'string' ? envelope.messageId : sqsMessageId;
    if (!messageId) {
      throw new InvalidPayloadError('messageId is required');
    }
    const payloadHash = hashBusinessPayload({
      providerId: values.providerId ?? '',
      externalTransactionId: values.externalTransactionId ?? '',
      playerId: values.playerId ?? '',
      walletId: values.walletId ?? '',
      roundId: values.roundId ?? '',
      gameId: values.gameId ?? '',
      kind,
      money: money.toJSON(),
      ...(reference ? { referenceExternalTransactionId: reference } : {}),
    });
    return {
      idempotencyKey,
      providerId: values.providerId ?? '',
      externalTransactionId: values.externalTransactionId ?? '',
      playerId: values.playerId ?? '',
      walletId: values.walletId ?? '',
      roundId: values.roundId ?? '',
      gameId: values.gameId ?? '',
      kind: kind as WagerTransactionKind,
      money,
      ...(reference ? { referenceExternalTransactionId: reference } : {}),
      correlationId: messageId,
      causationId: messageId,
      inbox: { messageId, consumerName: this.env.consumerName, payloadHash },
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
