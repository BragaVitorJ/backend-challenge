import { Injectable } from '@nestjs/common';
import { LockMode } from '@mikro-orm/core';
import { FailureCode } from '../../domain/failure-code';
import { LedgerDirection, WagerTransactionKind, WagerTransactionStatus } from '../../domain/enums';
import { InboxMessage } from '../../domain/messaging/inbox-message';
import { OutboxMessage } from '../../domain/messaging/outbox-message';
import { Money } from '../../domain/money/money';
import { WalletLedgerEntry } from '../../domain/ledger/wallet-ledger-entry';
import { Wallet } from '../../domain/wallet/wallet';
import { WagerTransaction } from '../../domain/wager/wager-transaction';
import { asDate, fromDbDecimal, rowsOf } from './db-values';
import {
  InboxRecord,
  LedgerRecord,
  OutboxRecord,
  WalletRecord,
  WagerTransactionRecord,
  currentEm,
} from './orm';

export interface LedgerPage {
  entries: WalletLedgerEntry[];
  nextCursor: string | null;
}

export interface LedgerFold {
  balance: Money;
  count: number;
}

@Injectable()
export class WageringStore {
  async advisoryLock(key: string): Promise<void> {
    await currentEm().execute('select pg_advisory_xact_lock(hashtextextended(?, 0))', [key]);
  }

  async flush(): Promise<void> {
    await currentEm().flush();
  }

  async lockWallet(id: string): Promise<Wallet | null> {
    const row = await currentEm().findOne(
      WalletRecord,
      { id },
      { lockMode: LockMode.PESSIMISTIC_WRITE },
    );
    return row ? this.toWallet(row) : null;
  }

  async findWallet(id: string): Promise<Wallet | null> {
    const row = await currentEm().findOne(WalletRecord, { id });
    return row ? this.toWallet(row) : null;
  }

  async findWalletByPlayer(playerId: string, currency: string): Promise<Wallet | null> {
    const row = await currentEm().findOne(WalletRecord, { playerId, currency });
    return row ? this.toWallet(row) : null;
  }

  insertWallet(wallet: Wallet): void {
    const em = currentEm();
    em.persist(
      em.create(WalletRecord, {
        id: wallet.id,
        playerId: wallet.playerId,
        currency: wallet.currency,
        balance: wallet.balance.toJSON().amount,
        version: wallet.version,
        createdAt: wallet.createdAt,
        updatedAt: wallet.updatedAt,
      }),
    );
  }

  async saveWallet(wallet: Wallet): Promise<void> {
    const row = await currentEm().findOne(WalletRecord, { id: wallet.id });
    if (!row) {
      throw new Error(`wallet ${wallet.id} disappeared during the transaction`);
    }
    if (wallet.version !== row.version + 1) {
      throw new Error(`wallet ${wallet.id} version drifted inside the lock`);
    }
    row.balance = wallet.balance.toJSON().amount;
    row.version = wallet.version;
    row.updatedAt = wallet.updatedAt;
  }

  async findByIdempotency(key: string): Promise<WagerTransaction | null> {
    const row = await currentEm().findOne(WagerTransactionRecord, { idempotencyKey: key });
    return row ? this.toTransaction(row) : null;
  }

  async findTransaction(id: string): Promise<WagerTransaction | null> {
    const row = await currentEm().findOne(WagerTransactionRecord, { id });
    return row ? this.toTransaction(row) : null;
  }

  async lockTransaction(id: string): Promise<WagerTransaction | null> {
    const row = await currentEm().findOne(
      WagerTransactionRecord,
      { id },
      { lockMode: LockMode.PESSIMISTIC_WRITE },
    );
    return row ? this.toTransaction(row) : null;
  }

  async findByProviderExternal(providerId: string, externalTransactionId: string): Promise<WagerTransaction | null> {
    const row = await currentEm().findOne(WagerTransactionRecord, { providerId, externalTransactionId });
    return row ? this.toTransaction(row) : null;
  }

  async reversalAlreadyClaimed(input: {
    providerId: string;
    referenceExternalTransactionId: string;
    kind: WagerTransactionKind;
    exceptId?: string;
  }): Promise<boolean> {
    const params: unknown[] = [input.providerId, input.referenceExternalTransactionId, input.kind];
    let except = '';
    if (input.exceptId) {
      params.push(input.exceptId);
      except = 'and id <> ?';
    }
    const result = await currentEm().execute(
      `select 1 as found
       from wager_transactions
       where provider_id = ?
         and reference_external_transaction_id = ?
         and kind = ?
         and status in ('PENDING', 'PENDING_REFERENCE', 'PROCESSED')
         ${except}
       limit 1`,
      params,
    );
    return rowsOf<{ found: number }>(result).length > 0;
  }

  insertTransaction(tx: WagerTransaction): void {
    const em = currentEm();
    em.persist(em.create(WagerTransactionRecord, this.toTransactionRow(tx)));
  }

  async saveTransaction(tx: WagerTransaction): Promise<void> {
    const row = await currentEm().findOne(WagerTransactionRecord, { id: tx.id });
    if (!row) {
      throw new Error(`transaction ${tx.id} disappeared during the transaction`);
    }
    const next = this.toTransactionRow(tx);
    row.status = next.status;
    row.failureCode = next.failureCode;
    row.referenceTransactionId = next.referenceTransactionId;
    row.processedAt = next.processedAt;
    row.observedBalance = next.observedBalance;
    row.attempts = next.attempts;
    row.nextAttemptAt = next.nextAttemptAt;
  }

  insertLedger(entry: WalletLedgerEntry): void {
    const em = currentEm();
    em.persist(
      em.create(LedgerRecord, {
        id: entry.id,
        walletId: entry.walletId,
        transactionId: entry.transactionId,
        direction: entry.direction,
        amount: entry.money.toJSON().amount,
        currency: entry.money.currency,
        balanceBefore: entry.balanceBefore.toJSON().amount,
        balanceAfter: entry.balanceAfter.toJSON().amount,
        createdAt: entry.createdAt,
      }),
    );
  }

  async listLedger(walletId: string, cursor: { at: Date; id: string } | null, limit: number): Promise<LedgerPage> {
    const params: unknown[] = [walletId];
    let cursorSql = '';
    if (cursor) {
      params.push(cursor.at, cursor.id);
      cursorSql = 'and (created_at, id) > (?, ?::uuid)';
    }
    params.push(limit + 1);
    const result = await currentEm().execute(
      `select id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at
       from wallet_ledger_entries
       where wallet_id = ?
       ${cursorSql}
       order by created_at asc, id asc
       limit ?`,
      params,
    );
    const rows = rowsOf<LedgerRow>(result);
    const page = rows.slice(0, limit).map((row) => this.toLedger(row));
    const last = page[page.length - 1];
    const nextCursor =
      rows.length > limit && last
        ? Buffer.from(JSON.stringify({ t: last.createdAt.toISOString(), id: last.id })).toString('base64url')
        : null;
    return { entries: page, nextCursor };
  }

  async foldLedger(walletId: string, currency: string): Promise<LedgerFold> {
    const result = await currentEm().execute(
      `select coalesce(sum(case when direction = 'CREDIT' then amount else -amount end), 0) as balance,
              count(*)::int as entries
       from wallet_ledger_entries
       where wallet_id = ?`,
      [walletId],
    );
    const row = rowsOf<{ balance: unknown; entries: number }>(result)[0];
    return {
      balance: Money.rehydrate({ amount: fromDbDecimal(row?.balance ?? '0'), currency }),
      count: Number(row?.entries ?? 0),
    };
  }

  async insertInboxIfAbsent(message: InboxMessage): Promise<'inserted' | 'exists'> {
    const result = await currentEm().execute(
      `insert into inbox_messages (message_id, consumer_name, payload_hash, received_at)
       values (?, ?, ?, ?)
       on conflict (consumer_name, message_id) do nothing
       returning message_id`,
      [message.messageId, message.consumerName, message.payloadHash, message.receivedAt],
    );
    return rowsOf(result).length > 0 ? 'inserted' : 'exists';
  }

  async lockInbox(consumerName: string, messageId: string): Promise<InboxMessage | null> {
    const row = await currentEm().findOne(
      InboxRecord,
      { consumerName, messageId },
      { lockMode: LockMode.PESSIMISTIC_WRITE },
    );
    if (!row) {
      return null;
    }
    return InboxMessage.rehydrate({
      messageId: row.messageId,
      consumerName: row.consumerName,
      payloadHash: row.payloadHash,
      receivedAt: asDate(row.receivedAt),
      processedAt: row.processedAt ? asDate(row.processedAt) : undefined,
    });
  }

  async markInboxProcessed(consumerName: string, messageId: string, at: Date): Promise<void> {
    const row = await currentEm().findOne(InboxRecord, { consumerName, messageId });
    if (!row) {
      throw new Error('inbox row missing');
    }
    row.processedAt = at;
  }

  insertOutbox(message: OutboxMessage): void {
    const em = currentEm();
    em.persist(
      em.create(OutboxRecord, {
        id: message.id,
        aggregateId: message.aggregateId,
        eventType: message.eventType,
        payload: message.payload as Record<string, unknown>,
        occurredAt: message.occurredAt,
        attempts: message.attempts,
        nextAttemptAt: message.nextAttemptAt ?? null,
        publishedAt: message.publishedAt ?? null,
      }),
    );
  }

  async claimOutbox(now: Date, limit: number, leaseMs: number): Promise<OutboxMessage[]> {
    const leaseUntil = new Date(now.getTime() + leaseMs);
    const result = await currentEm().execute(
      `with due as (
         select id
         from outbox_messages
         where published_at is null
           and (next_attempt_at is null or next_attempt_at <= ?)
         order by occurred_at
         limit ?
         for update skip locked
       )
       update outbox_messages as outbox
       set next_attempt_at = ?
       from due
       where outbox.id = due.id
       returning outbox.id, outbox.aggregate_id, outbox.event_type, outbox.payload,
                 outbox.occurred_at, outbox.attempts, outbox.next_attempt_at, outbox.published_at`,
      [now, limit, leaseUntil],
    );
    return rowsOf<OutboxRow>(result).map((row) => this.toOutbox(row));
  }

  async markOutboxPublished(id: string, at: Date): Promise<void> {
    await currentEm().nativeUpdate(OutboxRecord, { id }, { publishedAt: at });
  }

  async saveOutboxRetry(message: OutboxMessage): Promise<void> {
    await currentEm().nativeUpdate(
      OutboxRecord,
      { id: message.id },
      { attempts: message.attempts, nextAttemptAt: message.nextAttemptAt ?? null },
    );
  }

  async outboxLagMs(now: Date): Promise<number> {
    const result = await currentEm().execute(
      `select coalesce(extract(epoch from (?::timestamptz - min(occurred_at))) * 1000, 0) as lag_ms
       from outbox_messages
       where published_at is null`,
      [now],
    );
    const row = rowsOf<{ lag_ms: unknown }>(result)[0];
    const lag = Number(row?.lag_ms ?? 0);
    return Number.isFinite(lag) ? Math.max(0, Math.round(lag)) : 0;
  }

  async claimPendingReferences(now: Date, limit: number, leaseMs: number): Promise<string[]> {
    const leaseUntil = new Date(now.getTime() + leaseMs);
    const result = await currentEm().execute(
      `with due as (
         select id
         from wager_transactions
         where status = 'PENDING_REFERENCE'
           and (next_attempt_at is null or next_attempt_at <= ?)
         order by next_attempt_at nulls first
         limit ?
         for update skip locked
       )
       update wager_transactions as wager
       set next_attempt_at = ?
       from due
       where wager.id = due.id
       returning wager.id`,
      [now, limit, leaseUntil],
    );
    return rowsOf<{ id: string }>(result).map((row) => row.id);
  }

  private toWallet(row: WalletRecord): Wallet {
    return Wallet.rehydrate({
      id: row.id,
      playerId: row.playerId,
      currency: row.currency.trim(),
      balance: Money.rehydrate({ amount: fromDbDecimal(row.balance), currency: row.currency.trim() }),
      version: row.version,
      createdAt: asDate(row.createdAt),
      updatedAt: asDate(row.updatedAt),
    });
  }

  private toTransaction(row: WagerTransactionRecord): WagerTransaction {
    const currency = row.currency.trim();
    return WagerTransaction.rehydrate({
      id: row.id,
      providerId: row.providerId,
      externalTransactionId: row.externalTransactionId,
      idempotencyKey: row.idempotencyKey,
      payloadHash: row.payloadHash,
      walletId: row.walletId,
      playerId: row.playerId,
      roundId: row.roundId,
      gameId: row.gameId,
      kind: row.kind as WagerTransactionKind,
      money: Money.rehydrate({ amount: fromDbDecimal(row.amount), currency }),
      referenceExternalTransactionId: row.referenceExternalTransactionId ?? undefined,
      createdAt: asDate(row.createdAt),
      status: row.status as WagerTransactionStatus,
      referenceTransactionId: row.referenceTransactionId ?? undefined,
      failureCode: (row.failureCode ?? undefined) as FailureCode | undefined,
      processedAt: row.processedAt ? asDate(row.processedAt) : undefined,
      observedBalance: Money.rehydrate({ amount: fromDbDecimal(row.observedBalance), currency }),
      attempts: row.attempts,
      nextAttemptAt: row.nextAttemptAt ? asDate(row.nextAttemptAt) : undefined,
    });
  }

  private toTransactionRow(tx: WagerTransaction): WagerTransactionRecord {
    return {
      id: tx.id,
      providerId: tx.providerId,
      externalTransactionId: tx.externalTransactionId,
      idempotencyKey: tx.idempotencyKey,
      payloadHash: tx.payloadHash,
      walletId: tx.walletId,
      playerId: tx.playerId,
      roundId: tx.roundId,
      gameId: tx.gameId,
      kind: tx.kind,
      amount: tx.money.toJSON().amount,
      currency: tx.money.currency,
      referenceExternalTransactionId: tx.referenceExternalTransactionId ?? null,
      referenceTransactionId: tx.referenceTransactionId ?? null,
      status: tx.status,
      failureCode: tx.failureCode ?? null,
      observedBalance: tx.observedBalance.toJSON().amount,
      attempts: tx.attempts,
      nextAttemptAt: tx.nextAttemptAt ?? null,
      createdAt: tx.createdAt,
      processedAt: tx.processedAt ?? null,
    };
  }

  private toLedger(row: LedgerRow): WalletLedgerEntry {
    const currency = row.currency.trim();
    return WalletLedgerEntry.rehydrate({
      id: row.id,
      walletId: row.wallet_id,
      transactionId: row.transaction_id,
      direction: row.direction as LedgerDirection,
      money: Money.rehydrate({ amount: fromDbDecimal(row.amount), currency }),
      balanceBefore: Money.rehydrate({ amount: fromDbDecimal(row.balance_before), currency }),
      balanceAfter: Money.rehydrate({ amount: fromDbDecimal(row.balance_after), currency }),
      createdAt: asDate(row.created_at),
    });
  }

  private toOutbox(row: OutboxRow): OutboxMessage {
    const payload = typeof row.payload === 'string' ? (JSON.parse(row.payload) as Record<string, unknown>) : row.payload;
    return OutboxMessage.rehydrate({
      id: row.id,
      aggregateId: row.aggregate_id,
      eventType: row.event_type,
      payload,
      occurredAt: asDate(row.occurred_at),
      attempts: row.attempts,
      nextAttemptAt: row.next_attempt_at ? asDate(row.next_attempt_at) : undefined,
      publishedAt: row.published_at ? asDate(row.published_at) : undefined,
    });
  }
}

interface LedgerRow {
  id: string;
  wallet_id: string;
  transaction_id: string;
  direction: string;
  amount: unknown;
  currency: string;
  balance_before: unknown;
  balance_after: unknown;
  created_at: Date | string;
}

interface OutboxRow {
  id: string;
  aggregate_id: string;
  event_type: string;
  payload: Record<string, unknown> | string;
  occurred_at: Date | string;
  attempts: number;
  next_attempt_at: Date | string | null;
  published_at: Date | string | null;
}
