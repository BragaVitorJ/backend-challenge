import { Injectable } from '@nestjs/common';

@Injectable()
export class AppMetrics {
  private readonly byStatus = new Map<string, number>();
  private duplicates = 0;
  private retries = 0;
  private dlq = 0;
  private lockConflicts = 0;
  private reconciliationMismatches = 0;
  private outboxLagMs = 0;
  private latencyCount = 0;
  private latencySumMs = 0;
  private readonly latencySamples: number[] = [];

  addTransaction(status: string): void {
    this.byStatus.set(status, (this.byStatus.get(status) ?? 0) + 1);
  }

  addDuplicate(): void {
    this.duplicates += 1;
  }

  addRetry(): void {
    this.retries += 1;
  }

  addDlq(): void {
    this.dlq += 1;
  }

  addLockConflict(): void {
    this.lockConflicts += 1;
  }

  addReconciliationMismatch(): void {
    this.reconciliationMismatches += 1;
  }

  setOutboxLag(ms: number): void {
    this.outboxLagMs = ms;
  }

  observeLatency(ms: number): void {
    this.latencyCount += 1;
    this.latencySumMs += ms;
    this.latencySamples.push(ms);
    if (this.latencySamples.length > 1024) {
      this.latencySamples.shift();
    }
  }

  render(): string {
    const lines = [
      '# HELP wager_transactions_total Wager transactions recorded by terminal or pending status',
      '# TYPE wager_transactions_total counter',
    ];
    for (const [status, count] of this.byStatus) {
      lines.push(`wager_transactions_total{status="${status}"} ${count}`);
    }
    lines.push(
      '# HELP wager_duplicates_total Idempotent replays detected',
      '# TYPE wager_duplicates_total counter',
      `wager_duplicates_total ${this.duplicates}`,
      '# HELP wager_retries_total Transient retries',
      '# TYPE wager_retries_total counter',
      `wager_retries_total ${this.retries}`,
      '# HELP wager_dlq_total Messages sent to the DLQ',
      '# TYPE wager_dlq_total counter',
      `wager_dlq_total ${this.dlq}`,
      '# HELP wager_lock_conflicts_total Lock or uniqueness conflicts that were retried',
      '# TYPE wager_lock_conflicts_total counter',
      `wager_lock_conflicts_total ${this.lockConflicts}`,
      '# HELP wager_reconciliation_mismatches_total Wallets whose balance diverged from the ledger',
      '# TYPE wager_reconciliation_mismatches_total counter',
      `wager_reconciliation_mismatches_total ${this.reconciliationMismatches}`,
      '# HELP wager_outbox_lag_ms Age of the oldest unpublished outbox row',
      '# TYPE wager_outbox_lag_ms gauge',
      `wager_outbox_lag_ms ${this.outboxLagMs}`,
      '# HELP wager_processing_latency_ms Processing latency of wager submission',
      '# TYPE wager_processing_latency_ms summary',
      `wager_processing_latency_ms_sum ${this.latencySumMs}`,
      `wager_processing_latency_ms_count ${this.latencyCount}`,
      `wager_processing_latency_ms{quantile="0.5"} ${this.quantile(0.5)}`,
      `wager_processing_latency_ms{quantile="0.95"} ${this.quantile(0.95)}`,
    );
    return `${lines.join('\n')}\n`;
  }

  private quantile(q: number): number {
    if (this.latencySamples.length === 0) {
      return 0;
    }
    const sorted = [...this.latencySamples].sort((a, b) => a - b);
    const index = Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1);
    return sorted[Math.max(0, index)] ?? 0;
  }
}
