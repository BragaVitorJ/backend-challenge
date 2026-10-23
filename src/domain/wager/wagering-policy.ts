import { FailureCode } from '../failure-code';
import { LedgerDirection, WagerTransactionKind, WagerTransactionStatus } from '../enums';
import { Wallet } from '../wallet/wallet';
import { WagerTransaction } from './wager-transaction';

export type PolicyDecision =
  | { outcome: 'pending_reference' }
  | { outcome: 'rejected'; code: FailureCode }
  | { outcome: 'processed'; direction: LedgerDirection | null; referenceTransactionId?: string };

export class WageringPolicy {
  decide(input: {
    transaction: WagerTransaction;
    wallet: Wallet;
    reference: WagerTransaction | null;
    reversalAlreadyClaimed: boolean;
  }): PolicyDecision {
    const { transaction: tx, wallet, reference, reversalAlreadyClaimed } = input;

    if (tx.kind === WagerTransactionKind.Opening) {
      return { outcome: 'rejected', code: FailureCode.InvalidKind };
    }
    if (wallet.playerId !== tx.playerId) {
      return { outcome: 'rejected', code: FailureCode.WalletPlayerMismatch };
    }
    if (wallet.currency !== tx.money.currency) {
      return { outcome: 'rejected', code: FailureCode.CurrencyMismatch };
    }
    if (
      (tx.kind === WagerTransactionKind.Bet || tx.kind === WagerTransactionKind.Loss) &&
      tx.referenceExternalTransactionId
    ) {
      return { outcome: 'rejected', code: FailureCode.ReferenceNotAllowed };
    }
    if (tx.requiresReference() && !tx.referenceExternalTransactionId) {
      return { outcome: 'rejected', code: FailureCode.ReferenceRequired };
    }

    if (tx.referenceExternalTransactionId) {
      const referenceDecision = this.inspectReference(tx, reference, reversalAlreadyClaimed);
      if (referenceDecision) {
        return referenceDecision;
      }
    }

    const direction = tx.ledgerDirectionFor(
      tx.kind === WagerTransactionKind.Rollback ? reference ?? undefined : undefined,
    );
    if (direction === LedgerDirection.Debit && wallet.balance.isLessThan(tx.money)) {
      return {
        outcome: 'rejected',
        code:
          tx.kind === WagerTransactionKind.Rollback
            ? FailureCode.InsufficientFundsOnReversal
            : FailureCode.InsufficientFunds,
      };
    }

    return {
      outcome: 'processed',
      direction,
      referenceTransactionId: reference?.id,
    };
  }

  private inspectReference(
    tx: WagerTransaction,
    reference: WagerTransaction | null,
    reversalAlreadyClaimed: boolean,
  ): PolicyDecision | null {
    if (!reference) {
      return { outcome: 'pending_reference' };
    }
    const sameScope =
      reference.providerId === tx.providerId &&
      reference.playerId === tx.playerId &&
      reference.walletId === tx.walletId &&
      reference.money.currency === tx.money.currency &&
      reference.roundId === tx.roundId;
    if (!sameScope) {
      return { outcome: 'rejected', code: FailureCode.ReferenceMismatch };
    }
    if (
      reference.status === WagerTransactionStatus.Pending ||
      reference.status === WagerTransactionStatus.PendingReference
    ) {
      return { outcome: 'pending_reference' };
    }
    if (reference.status !== WagerTransactionStatus.Processed) {
      return { outcome: 'rejected', code: FailureCode.ReferenceNotEligible };
    }
    if (tx.kind === WagerTransactionKind.Refund && reference.kind !== WagerTransactionKind.Bet) {
      return { outcome: 'rejected', code: FailureCode.InvalidReferenceKind };
    }
    if (tx.kind === WagerTransactionKind.Rollback) {
      const allowed =
        reference.kind === WagerTransactionKind.Bet ||
        reference.kind === WagerTransactionKind.Win ||
        reference.kind === WagerTransactionKind.Refund;
      if (!allowed) {
        return { outcome: 'rejected', code: FailureCode.InvalidReferenceKind };
      }
    }
    if (tx.kind === WagerTransactionKind.Win && reference.kind !== WagerTransactionKind.Bet) {
      return { outcome: 'rejected', code: FailureCode.InvalidReferenceKind };
    }
    if (tx.kind === WagerTransactionKind.Refund || tx.kind === WagerTransactionKind.Rollback) {
      if (!tx.money.equals(reference.money)) {
        return { outcome: 'rejected', code: FailureCode.AmountMismatch };
      }
      if (reversalAlreadyClaimed) {
        return { outcome: 'rejected', code: FailureCode.AlreadyReversed };
      }
    }
    return null;
  }
}
