import { createHash } from 'node:crypto';
import { Money } from '../money/money';

export interface BusinessPayload {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: { amount: string; currency: string };
  referenceExternalTransactionId?: string;
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`;
}

export function hashBusinessPayload(payload: BusinessPayload): string {
  const body: Record<string, unknown> = {
    externalTransactionId: payload.externalTransactionId,
    gameId: payload.gameId,
    kind: payload.kind,
    money: {
      amount: payload.money.amount,
      currency: payload.money.currency,
    },
    playerId: payload.playerId,
    providerId: payload.providerId,
    roundId: payload.roundId,
    walletId: payload.walletId,
  };
  if (payload.referenceExternalTransactionId !== undefined) {
    body.referenceExternalTransactionId = payload.referenceExternalTransactionId;
  }
  return createHash('sha256').update(canonicalJson(body)).digest('hex');
}

export function moneyPayload(money: Money): { amount: string; currency: string } {
  return money.toJSON();
}
