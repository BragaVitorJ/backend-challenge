import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/core';
import { PostgreSqlDriver } from '@mikro-orm/postgresql';
import { loadEnv } from '../../src/config/env';
import { WagerTransactionKind, WagerTransactionStatus } from '../../src/domain/enums';
import { FailureCode } from '../../src/domain/failure-code';
import { newId } from '../../src/domain/ids';
import { Money } from '../../src/domain/money/money';
import { AppMetrics } from '../../src/infrastructure/observability/metrics';
import { JsonLogger, LogContext } from '../../src/infrastructure/observability/json-logger';
import { initOrm } from '../../src/infrastructure/persistence/orm';
import { TransactionRunner } from '../../src/infrastructure/persistence/transaction-runner';
import { WageringStore } from '../../src/infrastructure/persistence/wagering-store';
import { OpenWallet, SubmitWager } from '../../src/application/wagering';

const env = loadEnv();
let orm: MikroORM<PostgreSqlDriver>;
let openWallet: OpenWallet;
let submit: SubmitWager;

beforeAll(async () => {
  orm = await initOrm(env);
  await orm.migrator.up();
  const metrics = new AppMetrics();
  const logger = new JsonLogger(new LogContext());
  const runner = new TransactionRunner(orm, env);
  const store = new WageringStore();
  openWallet = new OpenWallet(runner, store, logger);
  submit = new SubmitWager(runner, store, metrics, logger, env);
});

beforeEach(async () => {
  await orm.em.fork().execute(
    'truncate table inbox_messages, outbox_messages, wallet_ledger_entries, wager_transactions, wallets restart identity cascade',
  );
});

afterAll(async () => {
  await orm?.close(true);
});

test('fifty parallel deliveries of the same bet produce one debit', async () => {
  const playerId = newId();
  const opened = await openWallet.execute({
    playerId,
    initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
    correlationId: 'corr',
  });
  const input = {
    idempotencyKey: 'provider-a:same-bet',
    providerId: 'provider-a',
    externalTransactionId: 'same-bet',
    playerId,
    walletId: opened.id,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind: WagerTransactionKind.Bet,
    money: Money.from({ amount: '80.00', currency: 'BRL' }),
    correlationId: 'corr-race',
  };
  const results = await Promise.all(Array.from({ length: 50 }, () => submit.execute(input)));
  expect(results.every((result) => result.transactionId === results[0]?.transactionId)).toBe(true);
  expect(results.filter((result) => !result.idempotentReplay)).toHaveLength(1);
  const balance = await balanceOf(opened.id);
  expect(balance).toBe('20.00');
  expect(await debitCount(opened.id)).toBe(1);
});

test('two simultaneous 80 bets on a 100 balance leave 20 and one rejection', async () => {
  const playerId = newId();
  const opened = await openWallet.execute({
    playerId,
    initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
    correlationId: 'corr',
  });
  const [first, second] = await Promise.all([
    submit.execute(bet(opened.id, playerId, 'bet-a')),
    submit.execute(bet(opened.id, playerId, 'bet-b')),
  ]);
  const statuses = [first.status, second.status].sort();
  expect(statuses).toEqual([WagerTransactionStatus.Processed, WagerTransactionStatus.Rejected]);
  const rejected = [first, second].find((result) => result.status === WagerTransactionStatus.Rejected);
  expect(rejected?.failureCode).toBe(FailureCode.InsufficientFunds);
  expect(await balanceOf(opened.id)).toBe('20.00');
  expect(await debitCount(opened.id)).toBe(1);
  const entries = await orm.em.fork().execute<{ direction: string }[]>(
    `select direction from wallet_ledger_entries where wallet_id = ? and direction = 'DEBIT'`,
    [opened.id],
  );
  expect((Array.isArray(entries) ? entries : []).length).toBe(1);
});

test('distinct wallets are debited in parallel', async () => {
  const opens = await Promise.all(
    Array.from({ length: 5 }, async () => {
      const playerId = newId();
      const opened = await openWallet.execute({
        playerId,
        initialBalance: Money.from({ amount: '30.00', currency: 'BRL' }),
        correlationId: playerId,
      });
      return { playerId, walletId: opened.id };
    }),
  );
  await Promise.all(
    opens.map((opened) =>
      submit.execute({
        idempotencyKey: `provider-a:${opened.walletId}`,
        providerId: 'provider-a',
        externalTransactionId: opened.walletId,
        playerId: opened.playerId,
        walletId: opened.walletId,
        roundId: 'round-1',
        gameId: 'fortune-chimp',
        kind: WagerTransactionKind.Bet,
        money: Money.from({ amount: '10.00', currency: 'BRL' }),
        correlationId: opened.walletId,
      }),
    ),
  );
  for (const opened of opens) {
    expect(await balanceOf(opened.walletId)).toBe('20.00');
  }
});

test('three operating-system processes share one wallet without a lost update', async () => {
  const playerId = newId();
  const opened = await openWallet.execute({
    playerId,
    initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
    correlationId: 'corr-procs',
  });
  const results = await Promise.all(
    ['proc-a', 'proc-b', 'proc-c'].map((name) => spawnBet(opened.id, playerId, name)),
  );
  const processed = results.filter((result) => result.status === WagerTransactionStatus.Processed);
  const rejected = results.filter((result) => result.status === WagerTransactionStatus.Rejected);
  expect(processed).toHaveLength(1);
  expect(rejected).toHaveLength(2);
  expect(rejected.every((result) => result.failureCode === FailureCode.InsufficientFunds)).toBe(true);
  expect(await balanceOf(opened.id)).toBe('20.00');
  expect(await debitCount(opened.id)).toBe(1);
});

async function spawnBet(walletId: string, playerId: string, externalTransactionId: string) {
  const file = `data/worker-${externalTransactionId}.json`;
  await Bun.write(file, JSON.stringify(bet(walletId, playerId, externalTransactionId)));
  const proc = Bun.spawn(['bun', 'test/concurrency/instance-worker.ts', file], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: process.env,
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(stderr || stdout || `worker exited ${code}`);
  }
  const line = stdout.split('\n').find((row) => row.startsWith('RESULT '));
  if (!line) {
    throw new Error(stdout || 'worker produced no result');
  }
  return JSON.parse(line.slice('RESULT '.length)) as {
    status: WagerTransactionStatus;
    failureCode?: FailureCode;
  };
}

function bet(walletId: string, playerId: string, externalTransactionId: string) {
  return {
    idempotencyKey: `provider-a:${externalTransactionId}`,
    providerId: 'provider-a',
    externalTransactionId,
    playerId,
    walletId,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind: WagerTransactionKind.Bet,
    money: Money.from({ amount: '80.00', currency: 'BRL' }),
    correlationId: externalTransactionId,
  };
}

async function balanceOf(walletId: string): Promise<string> {
  const rows = await orm.em.fork().execute<{ balance: string }[]>('select balance from wallets where id = ?', [walletId]);
  const row = (Array.isArray(rows) ? rows : [])[0];
  return String(row?.balance);
}

async function debitCount(walletId: string): Promise<number> {
  const rows = await orm.em.fork().execute<{ count: string }[]>(
    `select count(*)::text as count from wallet_ledger_entries where wallet_id = ? and direction = 'DEBIT'`,
    [walletId],
  );
  return Number((Array.isArray(rows) ? rows : [])[0]?.count ?? 0);
}
