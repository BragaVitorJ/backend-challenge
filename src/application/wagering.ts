import { Inject, Injectable } from '@nestjs/common';
import { applyWagerDecision, type AppliedWager } from './apply-wager-decision';
import type { Env } from '../config/env';
import { WagerTransactionKind, WagerTransactionStatus } from '../domain/enums';
import { LedgerDirection } from '../domain/enums';
import {
  WalletBalanceChanged,
  WagerTransactionProcessed,
  WagerTransactionRejected,
} from '../domain/events/wager-events';
import {
  DuplicateWalletError,
  IdempotencyConflictError,
  InvalidPayloadError,
  TransactionNotFoundError,
  TransientInfrastructureError,
  WalletNotFoundError,
  isTransientError,
  isUniqueViolation,
} from '../domain/errors';
import { BusinessPayload, hashBusinessPayload } from '../domain/idempotency/payload-hash';
import { newId } from '../domain/ids';
import { InboxMessage } from '../domain/messaging/inbox-message';
import { OutboxMessage } from '../domain/messaging/outbox-message';
import { Money, MoneyProps } from '../domain/money/money';
import { WalletLedgerEntry } from '../domain/ledger/wallet-ledger-entry';
import { FailureCode } from '../domain/failure-code';
import { Wallet } from '../domain/wallet/wallet';
import { WageringPolicy } from '../domain/wager/wagering-policy';
import { WagerTransaction } from '../domain/wager/wager-transaction';
import { AppMetrics } from '../infrastructure/observability/metrics';
import { JsonLogger } from '../infrastructure/observability/json-logger';
import { TransactionRunner } from '../infrastructure/persistence/transaction-runner';
import { WageringStore } from '../infrastructure/persistence/wagering-store';

const INTERNAL_PROVIDER_ID = 'internal';

export interface OpenWalletInput {
  playerId: string;
  initialBalance: Money;
  correlationId: string;
}

export interface WalletView {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
}

export interface SubmitWagerInput {
  idempotencyKey: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  correlationId: string;
  causationId?: string;
  inbox?: { messageId: string; consumerName: string; payloadHash: string };
}

export interface WagerResult {
  transactionId: string;
  status: WagerTransactionStatus;
  balance: MoneyProps;
  idempotentReplay: boolean;
  failureCode?: FailureCode;
}

export interface LedgerEntryView {
  id: string;
  transactionId: string;
  direction: string;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  createdAt: string;
}

export interface ReconciliationView {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
}

@Injectable()
export class OpenWallet {
  constructor(
    @Inject(TransactionRunner) private readonly runner: TransactionRunner,
    @Inject(WageringStore) private readonly store: WageringStore,
    @Inject(JsonLogger) private readonly logger: JsonLogger,
  ) {}

  async execute(input: OpenWalletInput): Promise<WalletView> {
    try {
      return await this.runner.run(() => this.once(input));
    } catch (error) {
      if (isUniqueViolation(error, 'wallets_player_currency_unique')) {
        throw new DuplicateWalletError('wallet already exists for this player and currency');
      }
      throw error;
    }
  }

  private async once(input: OpenWalletInput): Promise<WalletView> {
    await this.store.advisoryLock(`wallet:${input.playerId}:${input.initialBalance.currency}`);
    const existing = await this.store.findWalletByPlayer(input.playerId, input.initialBalance.currency);
    if (existing) {
      throw new DuplicateWalletError('wallet already exists for this player and currency');
    }
    const now = new Date();
    const wallet = Wallet.open({
      id: newId(),
      playerId: input.playerId,
      initialBalance: input.initialBalance,
      now,
    });
    this.store.insertWallet(wallet);
    if (input.initialBalance.isPositive()) {
      const tx = WagerTransaction.open({
        id: newId(),
        providerId: INTERNAL_PROVIDER_ID,
        externalTransactionId: `opening:${wallet.id}`,
        idempotencyKey: `opening:${wallet.id}`,
        payloadHash: hashBusinessPayload({
          providerId: INTERNAL_PROVIDER_ID,
          externalTransactionId: `opening:${wallet.id}`,
          playerId: wallet.playerId,
          walletId: wallet.id,
          roundId: 'opening',
          gameId: 'opening',
          kind: WagerTransactionKind.Opening,
          money: input.initialBalance.toJSON(),
        }),
        walletId: wallet.id,
        playerId: wallet.playerId,
        roundId: 'opening',
        gameId: 'opening',
        kind: WagerTransactionKind.Opening,
        money: input.initialBalance,
        createdAt: now,
        observedBalance: input.initialBalance,
      });
      const entry = WalletLedgerEntry.create({
        walletId: wallet.id,
        transactionId: tx.id,
        direction: LedgerDirection.Credit,
        money: input.initialBalance,
        balanceBefore: Money.zero(input.initialBalance.currency),
        balanceAfter: input.initialBalance,
        createdAt: now,
      });
      this.store.insertTransaction(tx);
      this.store.insertLedger(entry);
      const ctx = { correlationId: input.correlationId, occurredAt: now };
      this.store.insertOutbox(OutboxMessage.enqueue(WagerTransactionProcessed.from(tx, ctx)));
      this.store.insertOutbox(OutboxMessage.enqueue(WalletBalanceChanged.from(wallet, entry, ctx)));
    }
    await this.store.flush();
    this.logger.info('wallet opened', { walletId: wallet.id, playerId: wallet.playerId });
    return toWalletView(wallet);
  }
}

@Injectable()
export class SubmitWager {
  private readonly policy = new WageringPolicy();

  constructor(
    @Inject(TransactionRunner) private readonly runner: TransactionRunner,
    @Inject(WageringStore) private readonly store: WageringStore,
    @Inject(AppMetrics) private readonly metrics: AppMetrics,
    @Inject(JsonLogger) private readonly logger: JsonLogger,
    @Inject('ENV') private readonly env: Env,
  ) {}

  async execute(input: SubmitWagerInput): Promise<WagerResult> {
    const started = Date.now();
    try {
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          return await this.runner.run(() => this.once(input));
        } catch (error) {
          if (attempt < 3 && (isTransientError(error) || isUniqueViolation(error))) {
            this.metrics.addLockConflict();
            continue;
          }
          throw error;
        }
      }
      throw new TransientInfrastructureError('concurrent conflict');
    } finally {
      this.metrics.observeLatency(Date.now() - started);
    }
  }

  private async once(input: SubmitWagerInput): Promise<WagerResult> {
    const payload = businessPayload(input);
    const payloadHash = hashBusinessPayload(payload);
    await this.store.advisoryLock(`idem:${input.idempotencyKey}`);

    if (input.inbox) {
      const inbox = InboxMessage.receive({
        messageId: input.inbox.messageId,
        consumerName: input.inbox.consumerName,
        payloadHash: input.inbox.payloadHash,
        receivedAt: new Date(),
      });
      const inserted = await this.store.insertInboxIfAbsent(inbox);
      if (inserted === 'exists') {
        const existingInbox = await this.store.lockInbox(input.inbox.consumerName, input.inbox.messageId);
        if (!existingInbox) {
          throw new TransientInfrastructureError('inbox row missing after conflict');
        }
        if (existingInbox.payloadHash !== input.inbox.payloadHash) {
          throw new IdempotencyConflictError('inbox message id reused with a different payload');
        }
        if (existingInbox.isProcessed()) {
          const existing = await this.store.findByIdempotency(input.idempotencyKey);
          if (!existing) {
            throw new TransientInfrastructureError('processed inbox has no transaction');
          }
          if (!existing.matchesPayload(payloadHash)) {
            throw new IdempotencyConflictError('idempotency key reused with a different payload');
          }
          this.metrics.addDuplicate();
          return toWagerResult(existing, true);
        }
      }
    }

    const existing = await this.store.findByIdempotency(input.idempotencyKey);
    if (existing) {
      if (!existing.matchesPayload(payloadHash)) {
        throw new IdempotencyConflictError('idempotency key reused with a different payload');
      }
      this.metrics.addDuplicate();
      return toWagerResult(existing, true);
    }

    const byExternal = await this.store.findByProviderExternal(input.providerId, input.externalTransactionId);
    if (byExternal) {
      throw new IdempotencyConflictError('external transaction id already used');
    }

    if (input.kind === WagerTransactionKind.Opening) {
      throw new InvalidPayloadError('OPENING cannot be submitted');
    }

    const wallet = await this.store.lockWallet(input.walletId);
    if (!wallet) {
      throw new WalletNotFoundError(`wallet ${input.walletId} was not found`);
    }

    const now = new Date();
    const tx = WagerTransaction.create({
      id: newId(),
      providerId: input.providerId,
      externalTransactionId: input.externalTransactionId,
      idempotencyKey: input.idempotencyKey,
      payloadHash,
      walletId: input.walletId,
      playerId: input.playerId,
      roundId: input.roundId,
      gameId: input.gameId,
      kind: input.kind,
      money: input.money,
      referenceExternalTransactionId: input.referenceExternalTransactionId,
      createdAt: now,
    });

    const reference = tx.referenceExternalTransactionId
      ? await this.store.findByProviderExternal(tx.providerId, tx.referenceExternalTransactionId)
      : null;
    const reversalAlreadyClaimed =
      tx.requiresReference() && tx.referenceExternalTransactionId
        ? await this.store.reversalAlreadyClaimed({
            providerId: tx.providerId,
            referenceExternalTransactionId: tx.referenceExternalTransactionId,
            kind: tx.kind,
          })
        : false;
    const decision = this.policy.decide({ transaction: tx, wallet, reference, reversalAlreadyClaimed });
    const applied = applyWagerDecision({
      tx,
      wallet,
      decision,
      now,
      firstDelayMs: this.env.pendingBaseDelayMs,
      ctx: { correlationId: input.correlationId, causationId: input.causationId, occurredAt: now },
    });
    await this.persistOutcome(tx, wallet, applied, input.inbox, now);
    this.metrics.addTransaction(tx.status);
    this.logger.info('wager decided', {
      transactionId: tx.id,
      walletId: tx.walletId,
      providerId: tx.providerId,
      status: tx.status,
      failureCode: tx.failureCode,
      correlationId: input.correlationId,
      messageId: input.inbox?.messageId,
    });
    return toWagerResult(tx, false);
  }

  private async persistOutcome(
    tx: WagerTransaction,
    wallet: Wallet,
    applied: AppliedWager,
    inbox: SubmitWagerInput['inbox'],
    now: Date,
  ): Promise<void> {
    this.store.insertTransaction(tx);
    if (applied.ledger) {
      this.store.insertLedger(applied.ledger);
    }
    if (applied.walletChanged) {
      await this.store.saveWallet(wallet);
    }
    for (const event of applied.events) {
      this.store.insertOutbox(OutboxMessage.enqueue(event));
    }
    if (inbox) {
      await this.store.markInboxProcessed(inbox.consumerName, inbox.messageId, now);
    }
    await this.store.flush();
  }
}

@Injectable()
export class ReprocessPendingReferences {
  private readonly policy = new WageringPolicy();

  constructor(
    @Inject(TransactionRunner) private readonly runner: TransactionRunner,
    @Inject(WageringStore) private readonly store: WageringStore,
    @Inject(AppMetrics) private readonly metrics: AppMetrics,
    @Inject(JsonLogger) private readonly logger: JsonLogger,
    @Inject('ENV') private readonly env: Env,
  ) {}

  async runOnce(limit = 20): Promise<number> {
    const now = new Date();
    const ids = await this.runner.run(() =>
      this.store.claimPendingReferences(now, limit, Math.max(this.env.pendingBaseDelayMs, 5_000)),
    );
    let finished = 0;
    for (const id of ids) {
      try {
        const changed = await this.runner.run(() => this.one(id));
        if (changed) {
          finished += 1;
        }
      } catch (error) {
        this.metrics.addRetry();
        this.logger.warn('pending reference retry failed', { transactionId: id });
        if (!isTransientError(error)) {
          this.logger.error('pending reference retry stopped', { transactionId: id });
        }
      }
    }
    return finished;
  }

  private async one(id: string): Promise<boolean> {
    const tx = await this.store.lockTransaction(id);
    if (!tx || tx.status !== WagerTransactionStatus.PendingReference) {
      return false;
    }
    const wallet = await this.store.lockWallet(tx.walletId);
    if (!wallet) {
      throw new WalletNotFoundError(`wallet ${tx.walletId} was not found`);
    }
    const now = new Date();
    const reference = tx.referenceExternalTransactionId
      ? await this.store.findByProviderExternal(tx.providerId, tx.referenceExternalTransactionId)
      : null;
    const reversalAlreadyClaimed = tx.referenceExternalTransactionId
      ? await this.store.reversalAlreadyClaimed({
          providerId: tx.providerId,
          referenceExternalTransactionId: tx.referenceExternalTransactionId,
          kind: tx.kind,
          exceptId: tx.id,
        })
      : false;
    const decision = this.policy.decide({ transaction: tx, wallet, reference, reversalAlreadyClaimed });
    if (decision.outcome === 'pending_reference') {
      const wait = tx.recordMissingReference(now, {
        maxAttempts: this.env.pendingMaxAttempts,
        baseDelayMs: this.env.pendingBaseDelayMs,
        maxDelayMs: this.env.pendingMaxDelayMs,
        ttlMs: this.env.pendingTtlMs,
      });
      if (wait === 'reject') {
        tx.reject(FailureCode.ReferenceNotFound, now, wallet.balance);
        const event = WagerTransactionRejected.from(tx, {
          correlationId: tx.id,
          occurredAt: now,
        });
        this.store.insertOutbox(OutboxMessage.enqueue(event));
        await this.store.saveTransaction(tx);
        await this.store.flush();
        this.metrics.addTransaction(tx.status);
        this.logger.info('pending reference expired', {
          transactionId: tx.id,
          walletId: tx.walletId,
          providerId: tx.providerId,
          failureCode: tx.failureCode,
        });
        return true;
      }
      await this.store.saveTransaction(tx);
      await this.store.flush();
      this.metrics.addRetry();
      return false;
    }

    const applied = applyWagerDecision({
      tx,
      wallet,
      decision,
      now,
      firstDelayMs: this.env.pendingBaseDelayMs,
      ctx: { correlationId: tx.id, occurredAt: now },
    });
    if (applied.ledger) {
      this.store.insertLedger(applied.ledger);
    }
    if (applied.walletChanged) {
      await this.store.saveWallet(wallet);
    }
    for (const event of applied.events) {
      this.store.insertOutbox(OutboxMessage.enqueue(event));
    }
    await this.store.saveTransaction(tx);
    await this.store.flush();
    this.metrics.addTransaction(tx.status);
    this.logger.info('pending reference resolved', {
      transactionId: tx.id,
      walletId: tx.walletId,
      providerId: tx.providerId,
      status: tx.status,
      failureCode: tx.failureCode,
    });
    return true;
  }
}

@Injectable()
export class GetWallet {
  constructor(
    @Inject(TransactionRunner) private readonly runner: TransactionRunner,
    @Inject(WageringStore) private readonly store: WageringStore,
  ) {}

  execute(walletId: string): Promise<WalletView> {
    return this.runner.run(async () => {
      const wallet = await this.store.findWallet(walletId);
      if (!wallet) {
        throw new WalletNotFoundError(`wallet ${walletId} was not found`);
      }
      return toWalletView(wallet);
    });
  }
}

@Injectable()
export class ListLedger {
  constructor(
    @Inject(TransactionRunner) private readonly runner: TransactionRunner,
    @Inject(WageringStore) private readonly store: WageringStore,
  ) {}

  execute(walletId: string, cursor: string | undefined, limit: number): Promise<{ entries: LedgerEntryView[]; nextCursor: string | null }> {
    return this.runner.run(async () => {
      const wallet = await this.store.findWallet(walletId);
      if (!wallet) {
        throw new WalletNotFoundError(`wallet ${walletId} was not found`);
      }
      const page = await this.store.listLedger(walletId, decodeCursor(cursor), limit);
      return {
        entries: page.entries.map((entry) => ({
          id: entry.id,
          transactionId: entry.transactionId,
          direction: entry.direction,
          money: entry.money.toJSON(),
          balanceBefore: entry.balanceBefore.toJSON(),
          balanceAfter: entry.balanceAfter.toJSON(),
          createdAt: entry.createdAt.toISOString(),
        })),
        nextCursor: page.nextCursor,
      };
    });
  }
}

@Injectable()
export class GetWager {
  constructor(
    @Inject(TransactionRunner) private readonly runner: TransactionRunner,
    @Inject(WageringStore) private readonly store: WageringStore,
  ) {}

  byId(id: string): Promise<WagerDetails> {
    return this.runner.run(async () => {
      const tx = await this.store.findTransaction(id);
      if (!tx) {
        throw new TransactionNotFoundError(`transaction ${id} was not found`);
      }
      return toDetails(tx);
    });
  }

  byExternal(providerId: string, externalTransactionId: string): Promise<WagerDetails> {
    return this.runner.run(async () => {
      const tx = await this.store.findByProviderExternal(providerId, externalTransactionId);
      if (!tx) {
        throw new TransactionNotFoundError('transaction was not found');
      }
      return toDetails(tx);
    });
  }
}

@Injectable()
export class ReconcileWallet {
  constructor(
    @Inject(TransactionRunner) private readonly runner: TransactionRunner,
    @Inject(WageringStore) private readonly store: WageringStore,
    @Inject(AppMetrics) private readonly metrics: AppMetrics,
    @Inject(JsonLogger) private readonly logger: JsonLogger,
  ) {}

  execute(walletId: string): Promise<ReconciliationView> {
    return this.runner.run(async () => {
      const wallet = await this.store.lockWallet(walletId);
      if (!wallet) {
        throw new WalletNotFoundError(`wallet ${walletId} was not found`);
      }
      const fold = await this.store.foldLedger(walletId, wallet.currency);
      const difference = wallet.balance.subtract(fold.balance);
      const consistent = difference.isZero() && fold.balance.currency === wallet.currency;
      if (!consistent) {
        this.metrics.addReconciliationMismatch();
        this.logger.error('wallet reconciliation mismatch', {
          walletId: wallet.id,
          checkedEntries: fold.count,
        });
      }
      return {
        walletId: wallet.id,
        storedBalance: wallet.balance.toJSON(),
        calculatedBalance: fold.balance.toJSON(),
        difference: difference.toJSON(),
        consistent,
        checkedEntries: fold.count,
      };
    });
  }
}

export interface WagerDetails {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: string;
  status: WagerTransactionStatus;
  failureCode?: FailureCode;
  money: MoneyProps;
  balance: MoneyProps;
  referenceExternalTransactionId?: string;
  createdAt: string;
  processedAt?: string;
}

function toWalletView(wallet: Wallet): WalletView {
  return {
    id: wallet.id,
    playerId: wallet.playerId,
    balance: wallet.balance.toJSON(),
    version: wallet.version,
  };
}

function toWagerResult(tx: WagerTransaction, idempotentReplay: boolean): WagerResult {
  return {
    transactionId: tx.id,
    status: tx.status,
    balance: tx.observedBalance.toJSON(),
    idempotentReplay,
    ...(tx.failureCode ? { failureCode: tx.failureCode } : {}),
  };
}

function toDetails(tx: WagerTransaction): WagerDetails {
  return {
    transactionId: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    walletId: tx.walletId,
    playerId: tx.playerId,
    roundId: tx.roundId,
    gameId: tx.gameId,
    kind: tx.kind,
    status: tx.status,
    ...(tx.failureCode ? { failureCode: tx.failureCode } : {}),
    money: tx.money.toJSON(),
    balance: tx.observedBalance.toJSON(),
    ...(tx.referenceExternalTransactionId
      ? { referenceExternalTransactionId: tx.referenceExternalTransactionId }
      : {}),
    createdAt: tx.createdAt.toISOString(),
    ...(tx.processedAt ? { processedAt: tx.processedAt.toISOString() } : {}),
  };
}

function businessPayload(input: SubmitWagerInput): BusinessPayload {
  return {
    providerId: input.providerId,
    externalTransactionId: input.externalTransactionId,
    playerId: input.playerId,
    walletId: input.walletId,
    roundId: input.roundId,
    gameId: input.gameId,
    kind: input.kind,
    money: input.money.toJSON(),
    ...(input.referenceExternalTransactionId
      ? { referenceExternalTransactionId: input.referenceExternalTransactionId }
      : {}),
  };
}

export function decodeCursor(cursor: string | undefined): { at: Date; id: string } | null {
  if (!cursor) {
    return null;
  }
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { t?: unknown; id?: unknown };
    if (typeof parsed.t !== 'string' || typeof parsed.id !== 'string') {
      throw new Error('shape');
    }
    const at = new Date(parsed.t);
    if (Number.isNaN(at.getTime())) {
      throw new Error('date');
    }
    return { at, id: parsed.id };
  } catch {
    throw new InvalidPayloadError('cursor is invalid');
  }
}
