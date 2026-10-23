import { EntitySchema, MikroORM, RequestContext } from '@mikro-orm/core';
import { PostgreSqlDriver, SqlEntityManager } from '@mikro-orm/postgresql';
import type { Env } from '../../config/env';
import { Migration20261022220000 } from './migrations/Migration20261022220000';

export class WalletRecord {
  id!: string;
  playerId!: string;
  currency!: string;
  balance!: string;
  version!: number;
  createdAt!: Date;
  updatedAt!: Date;
}

export const WalletSchema = new EntitySchema<WalletRecord>({
  class: WalletRecord,
  tableName: 'wallets',
  properties: {
    id: { type: 'uuid', primary: true },
    playerId: { type: 'uuid', fieldName: 'player_id' },
    currency: { type: 'string', length: 3 },
    balance: { type: 'decimal', precision: 19, scale: 2 },
    version: { type: 'integer' },
    createdAt: { type: Date, fieldName: 'created_at' },
    updatedAt: { type: Date, fieldName: 'updated_at' },
  },
});

export class WagerTransactionRecord {
  id!: string;
  providerId!: string;
  externalTransactionId!: string;
  idempotencyKey!: string;
  payloadHash!: string;
  walletId!: string;
  playerId!: string;
  roundId!: string;
  gameId!: string;
  kind!: string;
  amount!: string;
  currency!: string;
  referenceExternalTransactionId?: string | null;
  referenceTransactionId?: string | null;
  status!: string;
  failureCode?: string | null;
  observedBalance!: string;
  attempts!: number;
  nextAttemptAt?: Date | null;
  createdAt!: Date;
  processedAt?: Date | null;
}

export const WagerTransactionSchema = new EntitySchema<WagerTransactionRecord>({
  class: WagerTransactionRecord,
  tableName: 'wager_transactions',
  properties: {
    id: { type: 'uuid', primary: true },
    providerId: { type: 'string', fieldName: 'provider_id' },
    externalTransactionId: { type: 'string', fieldName: 'external_transaction_id' },
    idempotencyKey: { type: 'string', fieldName: 'idempotency_key' },
    payloadHash: { type: 'string', fieldName: 'payload_hash' },
    walletId: { type: 'uuid', fieldName: 'wallet_id' },
    playerId: { type: 'uuid', fieldName: 'player_id' },
    roundId: { type: 'string', fieldName: 'round_id' },
    gameId: { type: 'string', fieldName: 'game_id' },
    kind: { type: 'string' },
    amount: { type: 'decimal', precision: 19, scale: 2 },
    currency: { type: 'string', length: 3 },
    referenceExternalTransactionId: {
      type: 'string',
      fieldName: 'reference_external_transaction_id',
      nullable: true,
    },
    referenceTransactionId: { type: 'uuid', fieldName: 'reference_transaction_id', nullable: true },
    status: { type: 'string' },
    failureCode: { type: 'string', fieldName: 'failure_code', nullable: true },
    observedBalance: { type: 'decimal', precision: 19, scale: 2, fieldName: 'observed_balance' },
    attempts: { type: 'integer' },
    nextAttemptAt: { type: Date, fieldName: 'next_attempt_at', nullable: true },
    createdAt: { type: Date, fieldName: 'created_at' },
    processedAt: { type: Date, fieldName: 'processed_at', nullable: true },
  },
});

export class LedgerRecord {
  id!: string;
  walletId!: string;
  transactionId!: string;
  direction!: string;
  amount!: string;
  currency!: string;
  balanceBefore!: string;
  balanceAfter!: string;
  createdAt!: Date;
}

export const LedgerSchema = new EntitySchema<LedgerRecord>({
  class: LedgerRecord,
  tableName: 'wallet_ledger_entries',
  properties: {
    id: { type: 'uuid', primary: true },
    walletId: { type: 'uuid', fieldName: 'wallet_id' },
    transactionId: { type: 'uuid', fieldName: 'transaction_id' },
    direction: { type: 'string' },
    amount: { type: 'decimal', precision: 19, scale: 2 },
    currency: { type: 'string', length: 3 },
    balanceBefore: { type: 'decimal', precision: 19, scale: 2, fieldName: 'balance_before' },
    balanceAfter: { type: 'decimal', precision: 19, scale: 2, fieldName: 'balance_after' },
    createdAt: { type: Date, fieldName: 'created_at' },
  },
});

export class InboxRecord {
  messageId!: string;
  consumerName!: string;
  payloadHash!: string;
  receivedAt!: Date;
  processedAt?: Date | null;
}

export const InboxSchema = new EntitySchema<InboxRecord>({
  class: InboxRecord,
  tableName: 'inbox_messages',
  properties: {
    messageId: { type: 'string', fieldName: 'message_id', primary: true },
    consumerName: { type: 'string', fieldName: 'consumer_name', primary: true },
    payloadHash: { type: 'string', fieldName: 'payload_hash' },
    receivedAt: { type: Date, fieldName: 'received_at' },
    processedAt: { type: Date, fieldName: 'processed_at', nullable: true },
  },
});

export class OutboxRecord {
  id!: string;
  aggregateId!: string;
  eventType!: string;
  payload!: Record<string, unknown>;
  occurredAt!: Date;
  attempts!: number;
  nextAttemptAt?: Date | null;
  publishedAt?: Date | null;
}

export const OutboxSchema = new EntitySchema<OutboxRecord>({
  class: OutboxRecord,
  tableName: 'outbox_messages',
  properties: {
    id: { type: 'uuid', primary: true },
    aggregateId: { type: 'string', fieldName: 'aggregate_id' },
    eventType: { type: 'string', fieldName: 'event_type' },
    payload: { type: 'json' },
    occurredAt: { type: Date, fieldName: 'occurred_at' },
    attempts: { type: 'integer' },
    nextAttemptAt: { type: Date, fieldName: 'next_attempt_at', nullable: true },
    publishedAt: { type: Date, fieldName: 'published_at', nullable: true },
  },
});

export const entitySchemas = [WalletSchema, WagerTransactionSchema, LedgerSchema, InboxSchema, OutboxSchema];

export function mikroOrmOptions(env: Pick<Env, 'databaseUrl'>) {
  return {
    driver: PostgreSqlDriver,
    clientUrl: env.databaseUrl,
    entities: entitySchemas,
    pool: { min: 1, max: 20 },
    debug: false,
    allowGlobalContext: false,
    migrations: {
      tableName: 'mikro_orm_migrations',
      path: 'src/infrastructure/persistence/migrations',
      pathTs: 'src/infrastructure/persistence/migrations',
      glob: '!(*.d).{js,ts}',
      snapshot: false,
      migrationsList: [{ name: 'Migration20261022220000', class: Migration20261022220000 }],
      transactional: true,
      disableForeignKeys: false,
      allOrNothing: true,
    },
  };
}

export async function initOrm(env: Pick<Env, 'databaseUrl'>): Promise<MikroORM<PostgreSqlDriver>> {
  return MikroORM.init<PostgreSqlDriver>(mikroOrmOptions(env));
}

export function currentEm(): SqlEntityManager {
  const em = RequestContext.getEntityManager();
  if (!em) {
    throw new Error('database operation requires a transaction');
  }
  return em as SqlEntityManager;
}
