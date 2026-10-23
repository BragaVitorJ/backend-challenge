import { describe, expect, test } from 'bun:test';
import { CurrencyMismatchError, InvalidMoneyError, InvalidTransactionStateError } from '../../src/domain/errors';
import { FailureCode } from '../../src/domain/failure-code';
import { LedgerDirection, WagerTransactionKind, WagerTransactionStatus } from '../../src/domain/enums';
import { canonicalJson, hashBusinessPayload } from '../../src/domain/idempotency/payload-hash';
import { Money } from '../../src/domain/money/money';
import { Wallet } from '../../src/domain/wallet/wallet';
import { WageringPolicy } from '../../src/domain/wager/wagering-policy';
import { WagerTransaction } from '../../src/domain/wager/wager-transaction';

const now = new Date('2026-10-22T12:00:00.000Z');
const playerId = '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1';
const walletId = '0192f291-27dd-7d3f-8071-5f8685deef37';

function brl(amount: string): Money {
  return Money.from({ amount, currency: 'BRL' });
}

function wallet(amount = '100.00'): Wallet {
  return Wallet.open({ id: walletId, playerId, initialBalance: brl(amount), now });
}

function wager(overrides: Partial<Parameters<typeof WagerTransaction.create>[0]> = {}): WagerTransaction {
  return WagerTransaction.create({
    id: '0192f298-345e-7e38-af88-e43f851a819d',
    providerId: 'provider-a',
    externalTransactionId: 'transaction-123',
    idempotencyKey: 'provider-a:transaction-123',
    payloadHash: 'hash-a',
    walletId,
    playerId,
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    kind: WagerTransactionKind.Bet,
    money: brl('25.00'),
    createdAt: now,
    ...overrides,
  });
}

describe('Money', () => {
  test('keeps scale 2 and rejects invalid input', () => {
    expect(brl('10.10').add(brl('0.20')).toJSON()).toEqual({ amount: '10.30', currency: 'BRL' });
    expect(brl('0.10').add(brl('0.20')).toJSON().amount).toBe('0.30');
    expect(brl('80.00').toString()).toBe('80.00 BRL');
    for (const amount of ['1', '1.0', '1.000', '1e2', '', '-1.00', 'NaN', 'Infinity', '01.00']) {
      expect(() => Money.from({ amount, currency: 'BRL' })).toThrow(InvalidMoneyError);
    }
    expect(() => Money.from({ amount: '1.00', currency: 'brl' })).toThrow(InvalidMoneyError);
    expect(() => brl('1.00').add(Money.from({ amount: '1.00', currency: 'USD' }))).toThrow(CurrencyMismatchError);
  });

  test('is immutable', () => {
    const original = brl('10.00');
    original.add(brl('1.00'));
    original.negate();
    expect(original.toJSON().amount).toBe('10.00');
    expect(original.negate().isNegative()).toBe(true);
  });
});

describe('Wallet', () => {
  test('opens at version 1 and moves the ledger with the balance', () => {
    const account = wallet('100.00');
    expect(account.version).toBe(1);
    const debit = account.debit('tx-1', brl('80.00'), now);
    expect(account.balance.toJSON().amount).toBe('20.00');
    expect(account.version).toBe(2);
    expect(debit.direction).toBe(LedgerDirection.Debit);
    expect(debit.isBalanced()).toBe(true);
    expect(debit.balanceBefore.toJSON().amount).toBe('100.00');
    expect(debit.balanceAfter.toJSON().amount).toBe('20.00');
    expect(() => account.debit('tx-2', brl('80.00'), now)).toThrow();
    expect(account.balance.toJSON().amount).toBe('20.00');
    expect(account.version).toBe(2);
  });
});

describe('WagerTransaction', () => {
  test('terminal states do not transition again', () => {
    const tx = wager();
    tx.markProcessed(undefined, now, brl('75.00'));
    expect(tx.isTerminal()).toBe(true);
    expect(() => tx.reject(FailureCode.InsufficientFunds, now, brl('75.00'))).toThrow(InvalidTransactionStateError);
  });

  test('same idempotency key with another hash is not a replay', () => {
    const tx = wager({ payloadHash: 'aaa' });
    expect(tx.matchesPayload('aaa')).toBe(true);
    expect(tx.matchesPayload('bbb')).toBe(false);
  });

  test('rollback inverts the referenced direction', () => {
    const bet = wager({ kind: WagerTransactionKind.Bet });
    const rollback = wager({
      id: '0192f298-345e-7e38-af88-e43f851a819e',
      kind: WagerTransactionKind.Rollback,
      externalTransactionId: 'transaction-124',
      referenceExternalTransactionId: 'transaction-123',
    });
    expect(rollback.ledgerDirectionFor(bet)).toBe(LedgerDirection.Credit);
    expect(rollback.requiresReference()).toBe(true);
    expect(wager({ kind: WagerTransactionKind.Loss }).affectsBalance()).toBe(false);
  });
});

describe('WageringPolicy', () => {
  const policy = new WageringPolicy();

  test('one of two bets that do not fit is rejected', () => {
    const account = wallet('100.00');
    account.debit('already', brl('80.00'), now);
    const decision = policy.decide({
      transaction: wager({ money: brl('80.00') }),
      wallet: account,
      reference: null,
      reversalAlreadyClaimed: false,
    });
    expect(decision).toEqual({ outcome: 'rejected', code: FailureCode.InsufficientFunds });
  });

  test('refund waits when the bet has not arrived and rejects a second claim', () => {
    const account = wallet();
    const refund = wager({
      kind: WagerTransactionKind.Refund,
      referenceExternalTransactionId: 'transaction-123',
      externalTransactionId: 'refund-1',
    });
    expect(
      policy.decide({ transaction: refund, wallet: account, reference: null, reversalAlreadyClaimed: false }),
    ).toEqual({ outcome: 'pending_reference' });

    const bet = wager();
    bet.markProcessed(undefined, now, brl('75.00'));
    expect(
      policy.decide({ transaction: refund, wallet: account, reference: bet, reversalAlreadyClaimed: true }),
    ).toEqual({ outcome: 'rejected', code: FailureCode.AlreadyReversed });
  });

  test('rollback that would make the balance negative has its own code', () => {
    const account = wallet('10.00');
    const win = wager({ kind: WagerTransactionKind.Win, money: brl('50.00'), externalTransactionId: 'win-1' });
    win.markProcessed(undefined, now, brl('60.00'));
    const rollback = wager({
      kind: WagerTransactionKind.Rollback,
      money: brl('50.00'),
      externalTransactionId: 'rollback-1',
      referenceExternalTransactionId: 'win-1',
    });
    expect(
      policy.decide({ transaction: rollback, wallet: account, reference: win, reversalAlreadyClaimed: false }),
    ).toEqual({ outcome: 'rejected', code: FailureCode.InsufficientFundsOnReversal });
  });

  test('currency and payload scope mismatches are rejected', () => {
    const account = wallet();
    const usd = wager({ money: Money.from({ amount: '10.00', currency: 'USD' }) });
    expect(policy.decide({ transaction: usd, wallet: account, reference: null, reversalAlreadyClaimed: false })).toEqual({
      outcome: 'rejected',
      code: FailureCode.CurrencyMismatch,
    });
  });

  test('loss does not require a balance movement', () => {
    const decision = policy.decide({
      transaction: wager({ kind: WagerTransactionKind.Loss }),
      wallet: wallet('0.00'),
      reference: null,
      reversalAlreadyClaimed: false,
    });
    expect(decision).toEqual({ outcome: 'processed', direction: null, referenceTransactionId: undefined });
  });
});

describe('payload hash', () => {
  test('ignores key order and transport metadata', () => {
    const left = canonicalJson({ b: '2', a: { d: '4', c: '3' } });
    const right = canonicalJson({ a: { c: '3', d: '4' }, b: '2' });
    expect(left).toBe(right);
    const base = {
      providerId: 'provider-a',
      externalTransactionId: 'transaction-123',
      playerId,
      walletId,
      roundId: 'round-987',
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: { amount: '25.00', currency: 'BRL' },
    };
    expect(hashBusinessPayload(base)).toBe(hashBusinessPayload({ ...base }));
    expect(hashBusinessPayload({ ...base, referenceExternalTransactionId: 'other' })).not.toBe(hashBusinessPayload(base));
  });
});

describe('pending reference attempts', () => {
  test('expires after the configured attempts', () => {
    const tx = wager({
      kind: WagerTransactionKind.Refund,
      referenceExternalTransactionId: 'missing',
      externalTransactionId: 'refund-1',
    });
    tx.markPendingReference(now, 10, brl('100.00'));
    const policy = { maxAttempts: 2, baseDelayMs: 10, maxDelayMs: 50, ttlMs: 60_000 };
    expect(tx.recordMissingReference(new Date(now.getTime() + 20), policy)).toBe('wait');
    expect(tx.recordMissingReference(new Date(now.getTime() + 40), policy)).toBe('wait');
    expect(tx.recordMissingReference(new Date(now.getTime() + 80), policy)).toBe('reject');
    expect(tx.status).toBe(WagerTransactionStatus.PendingReference);
  });
});
