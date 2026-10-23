import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Res,
  SetMetadata,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  GetWager,
  GetWallet,
  ListLedger,
  OpenWallet,
  ReconcileWallet,
  SubmitWager,
  type WagerResult,
} from '../../application/wagering';
import { EXTERNAL_KINDS, type WagerTransactionKind, WagerTransactionStatus } from '../../domain/enums';
import { InvalidMoneyError, InvalidPayloadError } from '../../domain/errors';
import { newId } from '../../domain/ids';
import { Money } from '../../domain/money/money';
import { MikroORM } from '@mikro-orm/core';
import { SqlEntityManager } from '@mikro-orm/postgresql';
import { SqsGateway } from '../../infrastructure/sqs/sqs-gateway';
import { AppMetrics } from '../../infrastructure/observability/metrics';

export const IS_PUBLIC = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC, true);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

@Controller('wallets')
export class WalletController {
  constructor(
    @Inject(OpenWallet) private readonly openWallet: OpenWallet,
    @Inject(GetWallet) private readonly getWallet: GetWallet,
    @Inject(ListLedger) private readonly listLedger: ListLedger,
    @Inject(ReconcileWallet) private readonly reconcile: ReconcileWallet,
  ) {}

  @Post()
  @HttpCode(201)
  open(
    @Body() body: unknown,
    @Headers('x-correlation-id') correlationId?: string,
  ) {
    const record = object(body, 'body');
    const playerId = uuid(record.playerId, 'playerId');
    const initialBalance = money(record.initialBalance, 'initialBalance');
    return this.openWallet.execute({
      playerId,
      initialBalance,
      correlationId: correlation(correlationId),
    });
  }

  @Get(':walletId')
  get(@Param('walletId') walletId: string) {
    return this.getWallet.execute(uuid(walletId, 'walletId'));
  }

  @Get(':walletId/ledger')
  ledger(
    @Param('walletId') walletId: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    return this.listLedger.execute(uuid(walletId, 'walletId'), cursor, pageLimit(limit));
  }

  @Post(':walletId/reconciliation')
  @HttpCode(200)
  reconciliation(@Param('walletId') walletId: string) {
    return this.reconcile.execute(uuid(walletId, 'walletId'));
  }
}

@Controller()
export class WagerController {
  constructor(
    @Inject(SubmitWager) private readonly submit: SubmitWager,
    @Inject(GetWager) private readonly getWager: GetWager,
  ) {}

  @Post('wagering/transactions')
  async submitTransaction(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<WagerResult> {
    const command = parseSubmit(body, idempotencyKey, correlation(correlationId));
    const result = await this.submit.execute(command);
    response.status(result.status === WagerTransactionStatus.PendingReference ? 202 : 200);
    return result;
  }

  @Get('wagering/transactions/:transactionId')
  byId(@Param('transactionId') transactionId: string) {
    return this.getWager.byId(uuid(transactionId, 'transactionId'));
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  byExternal(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ) {
    return this.getWager.byExternal(token(providerId, 'providerId'), token(externalTransactionId, 'externalTransactionId'));
  }
}

@Controller('health')
export class HealthController {
  constructor(
    @Inject(MikroORM) private readonly orm: MikroORM,
    @Inject(SqsGateway) private readonly sqs: SqsGateway,
  ) {}

  @Public()
  @Get('live')
  live() {
    return { status: 'ok' };
  }

  @Public()
  @Get('ready')
  async ready(@Res({ passthrough: true }) response: Response) {
    const database = await this.database();
    const queue = await this.sqs.ready();
    const status = database && queue ? 'ok' : 'unavailable';
    response.status(database && queue ? 200 : 503);
    return { status, database, queue };
  }

  private async database(): Promise<boolean> {
    try {
      await (this.orm.em.fork() as SqlEntityManager).execute('select 1');
      return true;
    } catch {
      return false;
    }
  }
}

@Controller()
export class MetricsController {
  constructor(@Inject(AppMetrics) private readonly metrics: AppMetrics) {}

  @Public()
  @Get('metrics')
  metricsText(@Res({ passthrough: true }) response: Response): string {
    response.type('text/plain; version=0.0.4');
    return this.metrics.render();
  }
}

function parseSubmit(body: unknown, idempotencyKey: string | undefined, correlationId: string) {
  if (!idempotencyKey || !KEY_PATTERN.test(idempotencyKey)) {
    throw new InvalidPayloadError('Idempotency-Key header is required');
  }
  const record = object(body, 'body');
  const kind = record.kind;
  if (typeof kind !== 'string' || !EXTERNAL_KINDS.includes(kind as WagerTransactionKind)) {
    throw new InvalidPayloadError('kind is invalid');
  }
  const reference = optionalToken(record.referenceExternalTransactionId, 'referenceExternalTransactionId');
  if ((kind === 'REFUND' || kind === 'ROLLBACK') && !reference) {
    throw new InvalidPayloadError('referenceExternalTransactionId is required for REFUND and ROLLBACK');
  }
  return {
    idempotencyKey,
    providerId: token(record.providerId, 'providerId'),
    externalTransactionId: token(record.externalTransactionId, 'externalTransactionId'),
    playerId: uuid(record.playerId, 'playerId'),
    walletId: uuid(record.walletId, 'walletId'),
    roundId: token(record.roundId, 'roundId'),
    gameId: token(record.gameId, 'gameId'),
    kind: kind as WagerTransactionKind,
    money: money(record.money, 'money'),
    ...(reference ? { referenceExternalTransactionId: reference } : {}),
    correlationId,
  };
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidPayloadError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function uuid(value: unknown, label: string): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new InvalidPayloadError(`${label} must be a uuid`);
  }
  return value.toLowerCase();
}

function token(value: unknown, label: string): string {
  if (typeof value !== 'string' || !TOKEN_PATTERN.test(value)) {
    throw new InvalidPayloadError(`${label} is invalid`);
  }
  return value;
}

function optionalToken(value: unknown, label: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return token(value, label);
}

function money(value: unknown, label: string): Money {
  try {
    return Money.from(value as { amount: string; currency: string });
  } catch (error) {
    if (error instanceof InvalidMoneyError) {
      throw new InvalidPayloadError(`${label} is invalid`);
    }
    throw error;
  }
}

function pageLimit(value: string | undefined): number {
  if (value === undefined || value === '') {
    return 50;
  }
  if (!/^\d+$/.test(value)) {
    throw new InvalidPayloadError('limit is invalid');
  }
  const parsed = Number.parseInt(value, 10);
  if (parsed < 1 || parsed > 100) {
    throw new InvalidPayloadError('limit must be between 1 and 100');
  }
  return parsed;
}

function correlation(value: string | undefined): string {
  if (value && KEY_PATTERN.test(value)) {
    return value;
  }
  return newId();
}
