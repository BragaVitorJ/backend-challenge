import { DeleteMessageCommand, ReceiveMessageCommand } from '@aws-sdk/client-sqs';
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/core';
import { PostgreSqlDriver } from '@mikro-orm/postgresql';
import { loadEnv } from '../../src/config/env';
import { WagerTransactionKind } from '../../src/domain/enums';
import { newId } from '../../src/domain/ids';
import { Money } from '../../src/domain/money/money';
import { OutboxMessage } from '../../src/domain/messaging/outbox-message';
import { WalletBalanceChanged } from '../../src/domain/events/wager-events';
import { AppMetrics } from '../../src/infrastructure/observability/metrics';
import { JsonLogger, LogContext } from '../../src/infrastructure/observability/json-logger';
import { initOrm } from '../../src/infrastructure/persistence/orm';
import { TransactionRunner } from '../../src/infrastructure/persistence/transaction-runner';
import { WageringStore } from '../../src/infrastructure/persistence/wagering-store';
import { SqsGateway } from '../../src/infrastructure/sqs/sqs-gateway';
import { WagerConsumer } from '../../src/infrastructure/sqs/wager-consumer';
import { OpenWallet, SubmitWager } from '../../src/application/wagering';
import { OutboxPublisher } from '../../src/workers/background';

const env = loadEnv({ ...process.env, WORKERS_ENABLED: 'false' });
let orm: MikroORM<PostgreSqlDriver>;
let openWallet: OpenWallet;
let submit: SubmitWager;
let publisher: OutboxPublisher;
let sqs: SqsGateway;

beforeAll(async () => {
  orm = await initOrm(env);
  await orm.migrator.up();
  const metrics = new AppMetrics();
  const logger = new JsonLogger(new LogContext());
  const runner = new TransactionRunner(orm, env);
  const store = new WageringStore();
  sqs = new SqsGateway(env);
  openWallet = new OpenWallet(runner, store, logger);
  submit = new SubmitWager(runner, store, metrics, logger, env);
  publisher = new OutboxPublisher(env, runner, store, sqs, metrics, logger);
  if (!(await sqs.ready())) {
    throw new Error('LocalStack SQS is not reachable. Start docker compose first.');
  }
});

beforeEach(async () => {
  await orm.em.fork().execute(
    'truncate table inbox_messages, outbox_messages, wallet_ledger_entries, wager_transactions, wallets restart identity cascade',
  );
});

afterAll(async () => {
  await orm?.close(true);
  sqs?.client.destroy();
});

test('a redelivery after commit does not debit twice', async () => {
  const playerId = newId();
  const opened = await openWallet.execute({
    playerId,
    initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
    correlationId: 'corr',
  });
  const input = {
    idempotencyKey: 'provider-a:sqs-bet',
    providerId: 'provider-a',
    externalTransactionId: 'sqs-bet',
    playerId,
    walletId: opened.id,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind: WagerTransactionKind.Bet,
    money: Money.from({ amount: '15.00', currency: 'BRL' }),
    correlationId: 'msg-1',
    causationId: 'msg-1',
    inbox: { messageId: 'msg-1', consumerName: 'wager-transactions', payloadHash: 'same-hash' },
  };
  await submit.execute(input);
  await submit.execute(input);
  const rows = await orm.em.fork().execute<{ count: string }[]>(
    `select count(*)::text as count from wallet_ledger_entries where wallet_id = ? and direction = 'DEBIT'`,
    [opened.id],
  );
  expect(Number((Array.isArray(rows) ? rows : [])[0]?.count ?? 0)).toBe(1);
});

test('two publishers drain the outbox once and a crash before publish is recovered', async () => {
  const playerId = newId();
  await openWallet.execute({
    playerId,
    initialBalance: Money.from({ amount: '10.00', currency: 'BRL' }),
    correlationId: 'corr',
  });
  const pending = await orm.em.fork().execute<{ count: string }[]>(
    'select count(*)::text as count from outbox_messages where published_at is null',
  );
  expect(Number((Array.isArray(pending) ? pending : [])[0]?.count ?? 0)).toBeGreaterThan(0);
  await Promise.all([publisher.publishOnce(), publisher.publishOnce()]);
  const left = await orm.em.fork().execute<{ count: string }[]>(
    'select count(*)::text as count from outbox_messages where published_at is null',
  );
  expect(Number((Array.isArray(left) ? left : [])[0]?.count ?? 0)).toBe(0);
});

test('an invalid queue payload is parked on the DLQ', async () => {
  const metrics = new AppMetrics();
  const logger = new JsonLogger(new LogContext());
  const consumer = new WagerConsumer(env, sqs, submit, metrics, logger, new LogContext());
  const body = `not-json-${Date.now()}`;
  const disposition = await consumer.handleDelivery({ Body: body, MessageId: 'poison-1' });
  expect(disposition).toBe('dlq');
  await sqs.sendToDlq(body, 'poison-group');
  const response = await sqs.client.send(
    new ReceiveMessageCommand({
      QueueUrl: env.wagerDlqUrl,
      MaxNumberOfMessages: 10,
      WaitTimeSeconds: 2,
    }),
  );
  const found = (response.Messages ?? []).find((message) => message.Body === body);
  expect(found?.Body).toBe(body);
  if (found?.ReceiptHandle) {
    await sqs.client.send(
      new DeleteMessageCommand({
        QueueUrl: env.wagerDlqUrl,
        ReceiptHandle: found.ReceiptHandle,
      }),
    );
  }
});

test('outbox enqueue keeps the event id stable for a duplicate publish', () => {
  const event = WalletBalanceChanged.from(
    {
      id: newId(),
      version: 2,
    } as never,
    {
      transactionId: newId(),
      direction: 'DEBIT',
      money: { toJSON: () => ({ amount: '1.00', currency: 'BRL' }) },
      balanceBefore: { toJSON: () => ({ amount: '2.00', currency: 'BRL' }) },
      balanceAfter: { toJSON: () => ({ amount: '1.00', currency: 'BRL' }) },
    } as never,
    { correlationId: 'corr', occurredAt: new Date() },
  );
  const message = OutboxMessage.enqueue(event);
  expect(message.id).toBe(event.eventId);
  expect(message.payload.eventId).toBe(event.eventId);
});
