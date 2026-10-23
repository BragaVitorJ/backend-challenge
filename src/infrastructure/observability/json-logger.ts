import { AsyncLocalStorage } from 'node:async_hooks';
import { Inject, Injectable, LoggerService } from '@nestjs/common';

const REDACTED = new Set([
  'amount',
  'money',
  'balance',
  'payload',
  'body',
  'authorization',
  'password',
  'secret',
  'initialBalance',
  'storedBalance',
  'calculatedBalance',
  'difference',
]);

export class LogContext {
  private readonly storage = new AsyncLocalStorage<Record<string, string>>();

  run<T>(bindings: Record<string, string | undefined>, fn: () => T): T {
    const parent = this.storage.getStore() ?? {};
    const next: Record<string, string> = { ...parent };
    for (const [key, value] of Object.entries(bindings)) {
      if (value) {
        next[key] = value;
      }
    }
    return this.storage.run(next, fn);
  }

  current(): Record<string, string> {
    return this.storage.getStore() ?? {};
  }
}

@Injectable()
export class JsonLogger implements LoggerService {
  constructor(@Inject(LogContext) private readonly context: LogContext) {}

  log(message: unknown, ...optionalParams: unknown[]): void {
    this.write('info', message, optionalParams);
  }

  info(message: string, extra?: Record<string, unknown>): void {
    this.write('info', message, extra ? [extra] : []);
  }

  error(message: unknown, ...optionalParams: unknown[]): void {
    this.write('error', message, optionalParams);
  }

  warn(message: unknown, ...optionalParams: unknown[]): void {
    this.write('warn', message, optionalParams);
  }

  debug(message: unknown, ...optionalParams: unknown[]): void {
    this.write('debug', message, optionalParams);
  }

  verbose(message: unknown, ...optionalParams: unknown[]): void {
    this.write('debug', message, optionalParams);
  }

  private write(level: string, message: unknown, optionalParams: unknown[]): void {
    const text = message instanceof Error ? message.message : typeof message === 'string' ? message : 'log';
    const entry = {
      time: new Date().toISOString(),
      level,
      message: text,
      ...this.context.current(),
      ...sanitize(optionalParams),
    };
    const stream = level === 'error' ? process.stderr : process.stdout;
    stream.write(`${JSON.stringify(entry)}\n`);
  }
}

function sanitize(optionalParams: unknown[]): Record<string, unknown> {
  const clean: Record<string, unknown> = {};
  for (const param of optionalParams) {
    if (!param || typeof param !== 'object' || Array.isArray(param)) {
      continue;
    }
    for (const [key, value] of Object.entries(param as Record<string, unknown>)) {
      if (REDACTED.has(key) || (value !== null && typeof value === 'object')) {
        continue;
      }
      clean[key] = value;
    }
  }
  return clean;
}
