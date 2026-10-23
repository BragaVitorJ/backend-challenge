export const FailureCode = {
  InsufficientFunds: 'INSUFFICIENT_FUNDS',
  InsufficientFundsOnReversal: 'INSUFFICIENT_FUNDS_ON_REVERSAL',
  ReferenceRequired: 'REFERENCE_REQUIRED',
  ReferenceNotFound: 'REFERENCE_NOT_FOUND',
  ReferenceNotEligible: 'REFERENCE_NOT_ELIGIBLE',
  ReferenceMismatch: 'REFERENCE_MISMATCH',
  ReferenceNotAllowed: 'REFERENCE_NOT_ALLOWED',
  InvalidReferenceKind: 'INVALID_REFERENCE_KIND',
  AmountMismatch: 'AMOUNT_MISMATCH',
  AlreadyReversed: 'ALREADY_REVERSED',
  CurrencyMismatch: 'CURRENCY_MISMATCH',
  WalletPlayerMismatch: 'WALLET_PLAYER_MISMATCH',
  InvalidKind: 'INVALID_KIND',
} as const;

export type FailureCode = (typeof FailureCode)[keyof typeof FailureCode];

export const FAILURE_CODES: readonly FailureCode[] = Object.values(FailureCode);
