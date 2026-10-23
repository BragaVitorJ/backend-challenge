import { InsufficientFundsError, InvalidMoneyError } from '../errors';
import { LedgerDirection } from '../enums';
import { WalletLedgerEntry } from '../ledger/wallet-ledger-entry';
import { Money } from '../money/money';

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static open(props: { id: string; playerId: string; initialBalance: Money; now: Date }): Wallet {
    if (props.initialBalance.isNegative()) {
      throw new InvalidMoneyError('initial balance cannot be negative');
    }
    return new Wallet(
      props.id,
      props.playerId,
      props.initialBalance.currency,
      props.initialBalance,
      1,
      props.now,
      props.now,
    );
  }

  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  debit(transactionId: string, money: Money, at: Date): WalletLedgerEntry {
    this.assertMovement(money);
    if (this._balance.isLessThan(money)) {
      throw new InsufficientFundsError('insufficient funds');
    }
    return this.move(transactionId, money, LedgerDirection.Debit, at);
  }

  credit(transactionId: string, money: Money, at: Date): WalletLedgerEntry {
    this.assertMovement(money);
    return this.move(transactionId, money, LedgerDirection.Credit, at);
  }

  private move(
    transactionId: string,
    money: Money,
    direction: LedgerDirection,
    at: Date,
  ): WalletLedgerEntry {
    const balanceBefore = this._balance;
    const balanceAfter =
      direction === LedgerDirection.Credit ? balanceBefore.add(money) : balanceBefore.subtract(money);
    this._balance = balanceAfter;
    this._version += 1;
    this._updatedAt = at;
    return WalletLedgerEntry.create({
      walletId: this.id,
      transactionId,
      direction,
      money,
      balanceBefore,
      balanceAfter,
      createdAt: at,
    });
  }

  private assertMovement(money: Money): void {
    this.assertSameCurrency(money);
    if (!money.isPositive()) {
      throw new InvalidMoneyError('movement amount must be positive');
    }
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new InvalidMoneyError(`wallet currency is ${this.currency}`);
    }
  }
}
