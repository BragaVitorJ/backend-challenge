export function fromDbDecimal(value: unknown): string {
  if (typeof value === 'number') {
    throw new Error('money column was decoded as a JavaScript number');
  }
  const raw =
    typeof value === 'string'
      ? value
      : value && typeof value === 'object' && 'toFixed' in value
        ? (value as { toFixed: (scale: number) => string }).toFixed(2)
        : String(value);
  const match = raw.match(/^(-?)(0|[1-9]\d*)(?:\.(\d+))?$/);
  if (!match) {
    throw new Error(`invalid decimal from database: ${raw}`);
  }
  const sign = match[1] ?? '';
  const ints = match[2] ?? '0';
  const frac = match[3] ?? '';
  if (frac.length > 2 && /[1-9]/.test(frac.slice(2))) {
    throw new Error(`decimal scale exceeded 2: ${raw}`);
  }
  return `${sign}${ints}.${(frac + '00').slice(0, 2)}`;
}

export function asDate(value: unknown): Date {
  if (value instanceof Date) {
    return value;
  }
  if (typeof value === 'string' || typeof value === 'number') {
    return new Date(value);
  }
  throw new Error('expected a timestamp');
}

export function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) {
    return result as T[];
  }
  if (result && typeof result === 'object' && Array.isArray((result as { rows?: unknown }).rows)) {
    return (result as { rows: T[] }).rows;
  }
  return [];
}
