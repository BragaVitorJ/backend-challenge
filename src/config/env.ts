export interface Env {
  port: number;
  databaseUrl: string;
  awsRegion: string;
  awsAccessKeyId: string;
  awsSecretAccessKey: string;
  sqsEndpoint: string;
  wagerQueueUrl: string;
  wagerDlqUrl: string;
  eventsQueueUrl: string;
  consumerName: string;
  workersEnabled: boolean;
  pendingMaxAttempts: number;
  pendingBaseDelayMs: number;
  pendingMaxDelayMs: number;
  pendingTtlMs: number;
  outboxPollMs: number;
  pendingPollMs: number;
  sqsMaxReceiveCount: number;
  sqsVisibilityTimeoutSeconds: number;
  lockTimeoutMs: number;
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  return {
    port: int(source.PORT, 3000),
    databaseUrl: source.DATABASE_URL ?? 'postgres://wager:wager@localhost:5432/wager',
    awsRegion: source.AWS_REGION ?? 'us-east-1',
    awsAccessKeyId: source.AWS_ACCESS_KEY_ID ?? 'test',
    awsSecretAccessKey: source.AWS_SECRET_ACCESS_KEY ?? 'test',
    sqsEndpoint: source.SQS_ENDPOINT ?? 'http://localhost:4566',
    wagerQueueUrl:
      source.SQS_WAGER_QUEUE_URL ?? 'http://localhost:4566/000000000000/wager-transactions.fifo',
    wagerDlqUrl:
      source.SQS_WAGER_DLQ_URL ?? 'http://localhost:4566/000000000000/wager-transactions-dlq.fifo',
    eventsQueueUrl:
      source.SQS_EVENTS_QUEUE_URL ?? 'http://localhost:4566/000000000000/wager-events.fifo',
    consumerName: source.CONSUMER_NAME ?? 'wager-transactions',
    workersEnabled: (source.WORKERS_ENABLED ?? 'true') !== 'false',
    pendingMaxAttempts: int(source.PENDING_REFERENCE_MAX_ATTEMPTS, 10),
    pendingBaseDelayMs: int(source.PENDING_REFERENCE_BASE_DELAY_MS, 1000),
    pendingMaxDelayMs: int(source.PENDING_REFERENCE_MAX_DELAY_MS, 60_000),
    pendingTtlMs: int(source.PENDING_REFERENCE_TTL_MS, 300_000),
    outboxPollMs: int(source.OUTBOX_POLL_MS, 500),
    pendingPollMs: int(source.PENDING_POLL_MS, 500),
    sqsMaxReceiveCount: int(source.SQS_MAX_RECEIVE_COUNT, 5),
    sqsVisibilityTimeoutSeconds: int(source.SQS_VISIBILITY_TIMEOUT_SECONDS, 30),
    lockTimeoutMs: int(source.LOCK_TIMEOUT_MS, 5000),
  };
}

function int(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return parsed;
}
