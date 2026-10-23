export class DomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class InvalidMoneyError extends DomainError {}

export class CurrencyMismatchError extends DomainError {}

export class InvalidTransactionStateError extends DomainError {}

export class InsufficientFundsError extends DomainError {}

export class UnbalancedLedgerError extends DomainError {}

export class InvalidPayloadError extends DomainError {}

export class IdempotencyConflictError extends DomainError {}

export class WalletNotFoundError extends DomainError {}

export class TransactionNotFoundError extends DomainError {}

export class DuplicateWalletError extends DomainError {}

export class TransientInfrastructureError extends DomainError {}

export function isTransientError(error: unknown): boolean {
  if (error instanceof TransientInfrastructureError) {
    return true;
  }
  const codes = collectCodes(error);
  const transient = new Set(['40001', '40P01', '55P03', '08000', '08001', '08003', '08006', '57P01', '53300']);
  if ([...codes].some((code) => transient.has(code))) {
    return true;
  }
  const message = collectMessages(error).join(' ').toLowerCase();
  return (
    message.includes('econnrefused') ||
    message.includes('econnreset') ||
    message.includes('etimedout') ||
    message.includes('connection terminated') ||
    message.includes('timeout') ||
    message.includes('socket hang up')
  );
}

export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  const nodes = walk(error);
  return nodes.some((node) => {
    const code = readString(node, 'code');
    const name = node instanceof Error ? node.name : '';
    const unique = code === '23505' || name === 'UniqueConstraintViolationException';
    if (!unique) {
      return false;
    }
    if (!constraint) {
      return true;
    }
    const constraintName = readString(node, 'constraint') ?? '';
    const message = node instanceof Error ? node.message : '';
    return constraintName.includes(constraint) || message.includes(constraint);
  });
}

function collectCodes(error: unknown): Set<string> {
  const codes = new Set<string>();
  for (const node of walk(error)) {
    const code = readString(node, 'code');
    if (code) {
      codes.add(code);
    }
  }
  return codes;
}

function collectMessages(error: unknown): string[] {
  return walk(error)
    .filter((node): node is Error => node instanceof Error)
    .map((node) => node.message);
}

function walk(error: unknown): unknown[] {
  const found: unknown[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    found.push(current);
    const record = current as { cause?: unknown; driverException?: unknown };
    current = record.cause ?? record.driverException;
  }
  return found;
}

function readString(node: unknown, key: string): string | undefined {
  if (!node || typeof node !== 'object') {
    return undefined;
  }
  const value = (node as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}
