import { Migration } from '@mikro-orm/migrations';

export class Migration20261022220000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create table wallets (
        id uuid primary key,
        player_id uuid not null,
        currency char(3) not null,
        balance numeric(19,2) not null,
        version integer not null,
        created_at timestamptz not null,
        updated_at timestamptz not null,
        constraint wallets_balance_non_negative check (balance >= 0),
        constraint wallets_version_positive check (version >= 1),
        constraint wallets_player_currency_unique unique (player_id, currency)
      );
    `);

    this.addSql(`
      create table wager_transactions (
        id uuid primary key,
        provider_id text not null,
        external_transaction_id text not null,
        idempotency_key text not null,
        payload_hash text not null,
        wallet_id uuid not null references wallets (id) deferrable initially deferred,
        player_id uuid not null,
        round_id text not null,
        game_id text not null,
        kind text not null,
        amount numeric(19,2) not null,
        currency char(3) not null,
        reference_external_transaction_id text null,
        reference_transaction_id uuid null,
        status text not null,
        failure_code text null,
        observed_balance numeric(19,2) not null,
        attempts integer not null default 0,
        next_attempt_at timestamptz null,
        created_at timestamptz not null,
        processed_at timestamptz null,
        constraint wager_amount_positive check (amount > 0),
        constraint wager_observed_non_negative check (observed_balance >= 0),
        constraint wager_kind_check check (kind in ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
        constraint wager_status_check check (status in ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')),
        constraint wager_reference_required check (
          (kind in ('REFUND', 'ROLLBACK') and reference_external_transaction_id is not null)
          or (kind not in ('REFUND', 'ROLLBACK'))
        ),
        constraint wager_terminal_timestamp check (
          (status in ('PROCESSED', 'REJECTED', 'FAILED') and processed_at is not null)
          or (status in ('PENDING', 'PENDING_REFERENCE') and processed_at is null)
        ),
        constraint wager_failure_code_check check (
          (status in ('REJECTED', 'FAILED') and failure_code is not null)
          or (status not in ('REJECTED', 'FAILED') and failure_code is null)
        ),
        constraint wager_processed_reference check (
          (status = 'PROCESSED' and kind in ('REFUND', 'ROLLBACK') and reference_transaction_id is not null)
          or not (status = 'PROCESSED' and kind in ('REFUND', 'ROLLBACK'))
        ),
        constraint wager_idempotency_unique unique (idempotency_key),
        constraint wager_provider_external_unique unique (provider_id, external_transaction_id)
      );
    `);

    this.addSql(`
      alter table wager_transactions
        add constraint wager_reference_fk
        foreign key (reference_transaction_id) references wager_transactions (id)
        deferrable initially deferred;
    `);

    this.addSql(`
      create unique index wager_reversal_once
        on wager_transactions (provider_id, reference_external_transaction_id, kind)
        where kind in ('REFUND', 'ROLLBACK')
          and status in ('PENDING', 'PENDING_REFERENCE', 'PROCESSED');
    `);

    this.addSql(`
      create index wager_pending_reference_due
        on wager_transactions (next_attempt_at)
        where status = 'PENDING_REFERENCE';
    `);

    this.addSql(`
      create index wager_wallet_idx on wager_transactions (wallet_id);
    `);

    this.addSql(`
      create table wallet_ledger_entries (
        id uuid primary key,
        wallet_id uuid not null references wallets (id) deferrable initially deferred,
        transaction_id uuid not null references wager_transactions (id) deferrable initially deferred,
        direction text not null,
        amount numeric(19,2) not null,
        currency char(3) not null,
        balance_before numeric(19,2) not null,
        balance_after numeric(19,2) not null,
        created_at timestamptz not null,
        constraint ledger_direction_check check (direction in ('DEBIT', 'CREDIT')),
        constraint ledger_amount_positive check (amount > 0),
        constraint ledger_balances_non_negative check (balance_before >= 0 and balance_after >= 0),
        constraint ledger_balanced check (
          (direction = 'CREDIT' and balance_after = balance_before + amount)
          or (direction = 'DEBIT' and balance_after = balance_before - amount)
        ),
        constraint ledger_one_entry_per_transaction unique (transaction_id)
      );
    `);

    this.addSql(`
      create index ledger_wallet_order_idx
        on wallet_ledger_entries (wallet_id, created_at, id);
    `);

    this.addSql(`
      create or replace function prevent_ledger_mutation()
      returns trigger
      language plpgsql
      as $$
      begin
        raise exception 'ledger entries are immutable';
      end;
      $$;
    `);

    this.addSql(`
      create trigger wallet_ledger_entries_immutable
      before update or delete on wallet_ledger_entries
      for each row execute function prevent_ledger_mutation();
    `);

    this.addSql(`
      create table inbox_messages (
        message_id text not null,
        consumer_name text not null,
        payload_hash text not null,
        received_at timestamptz not null,
        processed_at timestamptz null,
        primary key (consumer_name, message_id)
      );
    `);

    this.addSql(`
      create table outbox_messages (
        id uuid primary key,
        aggregate_id text not null,
        event_type text not null,
        payload jsonb not null,
        occurred_at timestamptz not null,
        attempts integer not null default 0,
        next_attempt_at timestamptz null,
        published_at timestamptz null
      );
    `);

    this.addSql(`
      create index outbox_pending_idx
        on outbox_messages (occurred_at)
        where published_at is null;
    `);
  }

  override async down(): Promise<void> {
    this.addSql('drop table if exists outbox_messages;');
    this.addSql('drop table if exists inbox_messages;');
    this.addSql('drop trigger if exists wallet_ledger_entries_immutable on wallet_ledger_entries;');
    this.addSql('drop function if exists prevent_ledger_mutation();');
    this.addSql('drop table if exists wallet_ledger_entries;');
    this.addSql('drop table if exists wager_transactions;');
    this.addSql('drop table if exists wallets;');
  }
}
