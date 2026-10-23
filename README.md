# Wagering Processor

Serviço financeiro que processa apostas de vários provedores com saldo, ledger imutável, idempotência persistente e publicação de eventos depois do commit.

O enunciado original está em [CHALLENGE.md](CHALLENGE.md). As decisões estão em [ARCHITECTURE.md](ARCHITECTURE.md).

## Pré-requisitos

- [Bun](https://bun.sh) 1.x
- Docker Compose, com PostgreSQL 16 e LocalStack

## Subir

```bash
docker compose up --build
```

A API escuta em `http://localhost:3000`. As migrations rodam na subida.

Filas criadas pelo LocalStack:

- `wager-transactions.fifo`
- `wager-transactions-dlq.fifo`
- `wager-events.fifo`

Para rodar a API na máquina, com o banco e a fila no Compose:

```bash
docker compose up postgres localstack
copy .env.example .env
bun install
bun run start
```

## Comandos

```bash
bun test                  # unidade
bun run test:integration  # PostgreSQL e LocalStack
bun run test:concurrency  # corridas reais, inclusive 3 processos
bun run test:all
bun run migration:up
bun run migration:down
```

## Fluxo mínimo

```bash
curl -s -X POST http://localhost:3000/wallets ^
  -H "content-type: application/json" ^
  -d "{\"playerId\":\"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1\",\"initialBalance\":{\"amount\":\"100.00\",\"currency\":\"BRL\"}}"

curl -s -X POST http://localhost:3000/wagering/transactions ^
  -H "content-type: application/json" ^
  -H "Idempotency-Key: provider-a:transaction-123" ^
  -d "{\"providerId\":\"provider-a\",\"externalTransactionId\":\"transaction-123\",\"playerId\":\"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1\",\"walletId\":\"WALLET_ID\",\"roundId\":\"round-987\",\"gameId\":\"fortune-chimp\",\"kind\":\"BET\",\"money\":{\"amount\":\"25.00\",\"currency\":\"BRL\"}}"
```

Health: `GET /health/live` e `GET /health/ready`. Métricas: `GET /metrics`.

Três instâncias da API compartilham o mesmo Postgres. O teste `three operating-system processes` sobe 3 processos Bun contra o mesmo banco, que é a unidade que segura o lock da carteira.
