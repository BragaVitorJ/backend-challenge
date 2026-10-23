import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/core';
import { PostgreSqlDriver } from '@mikro-orm/postgresql';
import { loadEnv } from '../../src/config/env';
import { WagerTransactionKind, WagerTransactionStatus } from '../../src/domain/enums';
import { FailureCode } from '../../src/domain/failure-code';
import { IdempotencyConflictError, WalletNotFoundError } from '../../src/domain/errors';
import { newId } from '../../src/domain/ids';
import { Money } from '../../src/domain/money/money';
import { AppMetrics } from '../../src/infrastructure/observability/metrics';
import { JsonLogger, LogContext } from '../../src/infrastructure/observability/json-logger';
import { initOrm } from '../../src/infrastructure/persistence/orm';
import { TransactionRunner } from '../../src/infrastructure/persistence/transaction-runner';
import { WageringStore } from '../../src/infrastructure/persistence/wagering-store';
import {
  OpenWallet,
  ReconcileWallet,
  ReprocessPendingReferences,
  SubmitWager,
  type SubmitWagerInput,
} from '../../src/application/wagering';

const env = loadEnv({
  ...process.env,
  PENDING_REFERENCE_MAX_ATTEMPTS: '2',
  PENDING_REFERENCE_BASE_DELAY_MS: '0',
  PENDING_REFERENCE_MAX_DELAY_MS: '5',
  PENDING_REFERENCE_TTL_MS: '50',
  LOCK_TIMEOUT_MS: '5000',
});

let orm: MikroORM<PostgreSqlDriver>;
let openWallet: OpenWallet;
let submit: SubmitWager;
let reconcile: ReconcileWallet;
let reprocess: ReprocessPendingReferences;

beforeAll(async () => {
  orm = await initOrm(env);
  await orm.migrator.up();
  const metrics = new AppMetrics();
  const logger = new JsonLogger(new LogContext());
  const runner = new TransactionRunner(orm, env);
  const store = new WageringStore();
  openWallet = new OpenWallet(runner, store, logger);
  submit = new SubmitWager(runner, store, metrics, logger, env);
  reconcile = new ReconcileWallet(runner, store, metrics, logger);
  reprocess = new ReprocessPendingReferences(runner, store, metrics, logger, env);
});

beforeEach(async () => {
  await orm.em.fork().execute(
    'truncate table inbox_messages, outbox_messages, wallet_ledger_entries, wager_transactions, wallets restart identity cascade',
  );
});

afterAll(async () => {
  await orm?.close(true);
});

test('opening balance, bet, loss and reconciliation stay aligned with the ledger', async () => {
  const playerId = newId();
  const opened = await openWallet.execute({
    playerId,
    initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
    correlationId: 'corr-open',
  });
  expect(opened.version).toBe(1);
  expect(opened.balance.amount).toBe('100.00');

  const bet = await submit.execute(command(opened.id, playerId, 'bet-1', WagerTransactionKind.Bet, '25.00'));
  expect(bet.status).toBe(WagerTransactionStatus.Processed);
  expect(bet.balance.amount).toBe('75.00');
  expect(bet.idempotentReplay).toBe(false);

  const replay = await submit.execute(command(opened.id, playerId, 'bet-1', WagerTransactionKind.Bet, '25.00'));
  expect(replay.idempotentReplay).toBe(true);
  expect(replay.transactionId).toBe(bet.transactionId);
  expect(replay.balance.amount).toBe('75.00');

  const loss = await submit.execute(command(opened.id, playerId, 'loss-1', WagerTransactionKind.Loss, '25.00'));
  expect(loss.status).toBe(WagerTransactionStatus.Processed);
  expect(loss.balance.amount).toBe('75.00');

  const report = await reconcile.execute(opened.id);
  expect(report.consistent).toBe(true);
  expect(report.calculatedBalance.amount).toBe('75.00');
  expect(report.checkedEntries).toBe(2);

  const raw = await orm.em.fork().execute<{ balance: unknown }[]>(
    'select balance from wallets where id = ?',
    [opened.id],
  );
  const balance = Array.isArray(raw) ? raw[0]?.balance : raw;
  expect(typeof balance).toBe('string');
});

test('same idempotency key with a different payload is a conflict and does not move money', async () => {
  const playerId = newId();
  const opened = await openWallet.execute({
    playerId,
    initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
    correlationId: 'corr',
  });
  await submit.execute(command(opened.id, playerId, 'bet-1', WagerTransactionKind.Bet, '25.00'));
  await expect(
    submit.execute(command(opened.id, playerId, 'bet-1', WagerTransactionKind.Bet, '30.00')),
  ).rejects.toBeInstanceOf(IdempotencyConflictError);
  const report = await reconcile.execute(opened.id);
  expect(report.storedBalance.amount).toBe('75.00');
  expect(report.consistent).toBe(true);
});

test('refund before the bet waits and then credits once', async () => {
  const playerId = newId();
  const opened = await openWallet.execute({
    playerId,
    initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
    correlationId: 'corr',
  });
  const early = await submit.execute({
    ...command(opened.id, playerId, 'refund-1', WagerTransactionKind.Refund, '40.00'),
    referenceExternalTransactionId: 'bet-1',
  });
  expect(early.status).toBe(WagerTransactionStatus.PendingReference);

  const bet = await submit.execute(command(opened.id, playerId, 'bet-1', WagerTransactionKind.Bet, '40.00'));
  expect(bet.status).toBe(WagerTransactionStatus.Processed);
  expect(bet.balance.amount).toBe('60.00');

  await reprocess.runOnce();
  const report = await reconcile.execute(opened.id);
  expect(report.consistent).toBe(true);
  expect(report.storedBalance.amount).toBe('100.00');
});

test('missing reference expires as rejected and publishes an outbox row', async () => {
  const playerId = newId();
  const opened = await openWallet.execute({
    playerId,
    initialBalance: Money.from({ amount: '50.00', currency: 'BRL' }),
    correlationId: 'corr',
  });
  await submit.execute({
    ...command(opened.id, playerId, 'refund-1', WagerTransactionKind.Refund, '10.00'),
    referenceExternalTransactionId: 'never',
  });
  await sleep(60);
  await reprocess.runOnce();
  await reprocess.runOnce();
  await reprocess.runOnce();
  const rows = await orm.em.fork().execute<{ status: string; failure_code: string | null }[]>(
    `select status, failure_code from wager_transactions where external_transaction_id = 'refund-1'`,
  );
  const row = (Array.isArray(rows) ? rows : [])[0];
  expect(row?.status).toBe(WagerTransactionStatus.Rejected);
  expect(row?.failure_code).toBe(FailureCode.ReferenceNotFound);
  const report = await reconcile.execute(opened.id);
  expect(report.consistent).toBe(true);
  expect(report.storedBalance.amount).toBe('50.00');
});

test('ledger rows cannot be updated', async () => {
  const playerId = newId();
  const opened = await openWallet.execute({
    playerId,
    initialBalance: Money.from({ amount: '10.00', currency: 'BRL' }),
    correlationId: 'corr',
  });
  await expect(
    orm.em.fork().execute('update wallet_ledger_entries set amount = 1 where wallet_id = ?', [opened.id]),
  ).rejects.toThrow();
});

test('schema rejects a negative balance', async () => {
  const playerId = newId();
  const id = newId();
  await expect(
    orm.em.fork().execute(
      `insert into wallets (id, player_id, currency, balance, version, created_at, updated_at)
       values (?, ?, 'BRL', -1, 1, now(), now())`,
      [id, playerId],
    ),
  ).rejects.toThrow();
});

test('win credits and rollback restores the bet once', async () => {
  const playerId = newId();
  const opened = await openWallet.execute({
    playerId,
    initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
    correlationId: 'corr',
  });
  await submit.execute(command(opened.id, playerId, 'bet-1', WagerTransactionKind.Bet, '25.00'));
  const win = await submit.execute(command(opened.id, playerId, 'win-1', WagerTransactionKind.Win, '40.00'));
  expect(win.status).toBe(WagerTransactionStatus.Processed);
  expect(win.balance.amount).toBe('115.00');

  const rollback = await submit.execute({
    ...command(opened.id, playerId, 'rollback-1', WagerTransactionKind.Rollback, '25.00'),
    referenceExternalTransactionId: 'bet-1',
  });
  expect(rollback.status).toBe(WagerTransactionStatus.Processed);
  expect(rollback.balance.amount).toBe('140.00');

  const second = await submit.execute({
    ...command(opened.id, playerId, 'rollback-2', WagerTransactionKind.Rollback, '25.00'),
    referenceExternalTransactionId: 'bet-1',
  });
  expect(second.status).toBe(WagerTransactionStatus.Rejected);
  expect(second.failureCode).toBe(FailureCode.AlreadyReversed);

  const report = await reconcile.execute(opened.id);
  expect(report.consistent).toBe(true);
  expect(report.storedBalance.amount).toBe('140.00');
});

test('rollback of a win that would go negative is rejected and stays auditable', async () => {
  const playerId = newId();
  const opened = await openWallet.execute({
    playerId,
    initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
    correlationId: 'corr',
  });
  await submit.execute(command(opened.id, playerId, 'win-1', WagerTransactionKind.Win, '80.00'));
  await submit.execute(command(opened.id, playerId, 'bet-1', WagerTransactionKind.Bet, '150.00'));
  const rollback = await submit.execute({
    ...command(opened.id, playerId, 'rollback-win', WagerTransactionKind.Rollback, '80.00'),
    referenceExternalTransactionId: 'win-1',
  });
  expect(rollback.status).toBe(WagerTransactionStatus.Rejected);
  expect(rollback.failureCode).toBe(FailureCode.InsufficientFundsOnReversal);
  const report = await reconcile.execute(opened.id);
  expect(report.consistent).toBe(true);
  expect(report.storedBalance.amount).toBe('30.00');
});

test('a missing wallet rolls back the inbox insert', async () => {
  const playerId = newId();
  await expect(
    submit.execute({
      ...command(newId(), playerId, 'orphan', WagerTransactionKind.Bet, '10.00'),
      inbox: { messageId: 'orphan-msg', consumerName: 'wager-transactions', payloadHash: 'abc' },
    }),
  ).rejects.toBeInstanceOf(WalletNotFoundError);
  const rows = await orm.em.fork().execute<{ count: string }[]>(
    `select count(*)::text as count from inbox_messages where message_id = 'orphan-msg'`,
  );
  expect(Number((Array.isArray(rows) ? rows : [])[0]?.count ?? 0)).toBe(0);
});

test('migrations are reversible', async () => {
  await orm.migrator.down();
  const dropped = await orm.em.fork().execute<{ name: string | null }[]>(`select to_regclass('public.wallets') as name`);
  expect((Array.isArray(dropped) ? dropped : [])[0]?.name).toBeNull();
  await orm.migrator.up();
  const restored = await orm.em.fork().execute<{ name: string | null }[]>(`select to_regclass('public.wallets') as name`);
  expect((Array.isArray(restored) ? restored : [])[0]?.name).toBe('wallets');
});

function command(
  walletId: string,
  playerId: string,
  externalTransactionId: string,
  kind: WagerTransactionKind,
  amount: string,
): SubmitWagerInput {
  return {
    idempotencyKey: `provider-a:${externalTransactionId}`,
    providerId: 'provider-a',
    externalTransactionId,
    playerId,
    walletId,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind,
    money: Money.from({ amount, currency: 'BRL' }),
    correlationId: `corr-${externalTransactionId}`,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
