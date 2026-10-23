import Decimal from 'decimal.js';
import { CurrencyMismatchError, InvalidMoneyError } from '../errors';

export interface MoneyProps {
  amount: string;
  currency: string;
}

const AMOUNT_PATTERN = /^(0|[1-9]\d*)\.\d{2}$/;
const STORED_AMOUNT_PATTERN = /^-?(0|[1-9]\d*)\.\d{2}$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {}

  static from(props: MoneyProps): Money {
    if (!props || typeof props.amount !== 'string' || typeof props.currency !== 'string') {
      throw new InvalidMoneyError('amount and currency must be strings');
    }
    if (!CURRENCY_PATTERN.test(props.currency)) {
      throw new InvalidMoneyError('currency must be an ISO-4217 code');
    }
    if (!AMOUNT_PATTERN.test(props.amount)) {
      throw new InvalidMoneyError('amount must be a non-negative decimal string with scale 2');
    }
    const value = new Decimal(props.amount);
    if (!value.isFinite()) {
      throw new InvalidMoneyError('amount must be finite');
    }
    return new Money(value, props.currency);
  }

  static rehydrate(props: MoneyProps): Money {
    if (!props || typeof props.amount !== 'string' || typeof props.currency !== 'string') {
      throw new InvalidMoneyError('amount and currency must be strings');
    }
    if (!CURRENCY_PATTERN.test(props.currency)) {
      throw new InvalidMoneyError('currency must be an ISO-4217 code');
    }
    if (!STORED_AMOUNT_PATTERN.test(props.amount)) {
      throw new InvalidMoneyError('stored amount must be a decimal string with scale 2');
    }
    return new Money(new Decimal(props.amount), props.currency);
  }

  static zero(currency: string): Money {
    if (!CURRENCY_PATTERN.test(currency)) {
      throw new InvalidMoneyError('currency must be an ISO-4217 code');
    }
    return new Money(new Decimal(0), currency);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.plus(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.minus(other.value), this.currency);
  }

  negate(): Money {
    return new Money(this.value.negated(), this.currency);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.greaterThan(0);
  }

  isNegative(): boolean {
    return this.value.lessThan(0);
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThan(other.value);
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.value.equals(other.value);
  }

  toJSON(): MoneyProps {
    return {
      amount: this.value.toFixed(2),
      currency: this.currency,
    };
  }

  toString(): string {
    return `${this.value.toFixed(2)} ${this.currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(`currency mismatch: ${this.currency} and ${other.currency}`);
    }
  }
}
