import { FailureCode } from '../domain/failure-code';
import { LedgerDirection, WagerTransactionKind, WagerTransactionStatus } from '../domain/enums';
import { EventContext } from '../domain/events/wager-events';
import {
  WalletBalanceChanged,
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
} from '../domain/events/wager-events';
import { InsufficientFundsError, InvalidPayloadError } from '../domain/errors';
import { IntegrationEvent } from '../domain/events/integration-event';
import { WalletLedgerEntry } from '../domain/ledger/wallet-ledger-entry';
import { Wallet } from '../domain/wallet/wallet';
import { PolicyDecision } from '../domain/wager/wagering-policy';
import { WagerTransaction } from '../domain/wager/wager-transaction';

export interface AppliedWager {
  ledger?: WalletLedgerEntry;
  events: IntegrationEvent<unknown>[];
  walletChanged: boolean;
}

export function applyWagerDecision(input: {
  tx: WagerTransaction;
  wallet: Wallet;
  decision: PolicyDecision;
  now: Date;
  ctx: EventContext;
  firstDelayMs: number;
}): AppliedWager {
  const { tx, wallet, decision, now, ctx, firstDelayMs } = input;
  const balanceBefore = wallet.balance;

  if (decision.outcome === 'rejected' && decision.code === FailureCode.ReferenceRequired) {
    throw new InvalidPayloadError('referenceExternalTransactionId is required for REFUND and ROLLBACK');
  }

  if (decision.outcome === 'pending_reference') {
    if (tx.status === WagerTransactionStatus.Pending) {
      tx.markPendingReference(now, firstDelayMs, wallet.balance);
      return {
        events: [WagerTransactionPendingReference.from(tx, ctx)],
        walletChanged: false,
      };
    }
    return { events: [], walletChanged: false };
  }

  if (decision.outcome === 'rejected') {
    tx.reject(decision.code, now, balanceBefore);
    return {
      events: [WagerTransactionRejected.from(tx, ctx)],
      walletChanged: false,
    };
  }

  let ledger: WalletLedgerEntry | undefined;
  try {
    if (decision.direction === LedgerDirection.Debit) {
      ledger = wallet.debit(tx.id, tx.money, now);
    } else if (decision.direction === LedgerDirection.Credit) {
      ledger = wallet.credit(tx.id, tx.money, now);
    }
  } catch (error) {
    if (error instanceof InsufficientFundsError) {
      const code =
        tx.kind === WagerTransactionKind.Rollback
          ? FailureCode.InsufficientFundsOnReversal
          : FailureCode.InsufficientFunds;
      tx.reject(code, now, balanceBefore);
      return {
        events: [WagerTransactionRejected.from(tx, ctx)],
        walletChanged: false,
      };
    }
    throw error;
  }

  tx.markProcessed(decision.referenceTransactionId, now, wallet.balance);
  const events: IntegrationEvent<unknown>[] = [WagerTransactionProcessed.from(tx, ctx)];
  if (ledger) {
    events.push(WalletBalanceChanged.from(wallet, ledger, ctx));
  }
  return { ledger, events, walletChanged: ledger !== undefined };
}
