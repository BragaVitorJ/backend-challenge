import { loadEnv } from '../../src/config/env';
import { AppMetrics } from '../../src/infrastructure/observability/metrics';
import { JsonLogger, LogContext } from '../../src/infrastructure/observability/json-logger';
import { initOrm } from '../../src/infrastructure/persistence/orm';
import { TransactionRunner } from '../../src/infrastructure/persistence/transaction-runner';
import { WageringStore } from '../../src/infrastructure/persistence/wagering-store';
import { SubmitWager, type SubmitWagerInput } from '../../src/application/wagering';
import { Money } from '../../src/domain/money/money';

async function main(): Promise<void> {
  const source = process.argv[2] ?? '';
  const input = JSON.parse(source.endsWith('.json') ? await Bun.file(source).text() : source) as SubmitWagerInput;
  input.money = Money.from(input.money);
  const env = loadEnv();
  const orm = await initOrm(env);

  try {
    const submit = new SubmitWager(
      new TransactionRunner(orm, env),
      new WageringStore(),
      new AppMetrics(),
      new JsonLogger(new LogContext()),
      env,
    );
    const result = await submit.execute(input);
    process.stdout.write(`RESULT ${JSON.stringify(result)}\n`);
  } finally {
    await orm.close(true);
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
