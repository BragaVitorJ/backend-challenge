export interface EnqueueableEvent {
  eventId: string;
  aggregateId: string;
  eventType: string;
  occurredAt: Date;
  toJSON(): object;
}

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt?: Date;
  publishedAt?: Date;
}

export class OutboxMessage {
  private constructor(
    public readonly id: string,
    public readonly aggregateId: string,
    public readonly eventType: string,
    public readonly payload: Readonly<Record<string, unknown>>,
    public readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt?: Date,
    private _publishedAt?: Date,
  ) {}

  static enqueue(event: EnqueueableEvent): OutboxMessage {
    const json = event.toJSON() as Record<string, unknown>;
    return new OutboxMessage(
      event.eventId,
      event.aggregateId,
      event.eventType,
      json,
      event.occurredAt,
      0,
    );
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(
      state.id,
      state.aggregateId,
      state.eventType,
      state.payload,
      state.occurredAt,
      state.attempts,
      state.nextAttemptAt,
      state.publishedAt,
    );
  }

  get attempts(): number {
    return this._attempts;
  }

  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }

  get publishedAt(): Date | undefined {
    return this._publishedAt;
  }

  isPending(): boolean {
    return this._publishedAt === undefined;
  }

  isDue(now: Date): boolean {
    return this.isPending() && (this._nextAttemptAt === undefined || this._nextAttemptAt <= now);
  }

  markPublished(at: Date): void {
    if (this._publishedAt) {
      throw new Error('outbox message is already published');
    }
    this._publishedAt = at;
  }

  scheduleRetry(now: Date, baseDelayMs: number, maxDelayMs: number): void {
    if (this._publishedAt) {
      throw new Error('published outbox message cannot be retried');
    }
    this._attempts += 1;
    const delay = Math.min(maxDelayMs, baseDelayMs * 2 ** Math.min(this._attempts, 8));
    this._nextAttemptAt = new Date(now.getTime() + delay);
  }
}
