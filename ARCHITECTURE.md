# Arquitetura

O processador é um monolito NestJS. O domínio não conhece MikroORM, HTTP nem SQS. A borda HTTP e o consumidor da fila chamam o mesmo caso de uso `SubmitWager`.

## Dinheiro

`Money` guarda um `Decimal` e uma moeda ISO-4217. A entrada externa só aceita string não negativa com escala exata de 2, no formato `25.00`. `number`, notação científica e mais de duas casas são rejeitados. A coluna no Postgres é `numeric(19,2)`. O driver devolve string; se vier `number`, o mapeamento estoura em vez de seguir com float.

O desafio opera em BRL. O tipo continua multi-moeda: operação entre moedas diferentes é erro, e cada jogador tem no máximo uma carteira por moeda.

## Carteira, ledger e concorrência

A unidade de concorrência é a linha da carteira. Cada transação financeira faz `SELECT … FOR UPDATE` nessa linha. Carteiras diferentes seguem em paralelo. Não existe lock global de todas as carteiras.

O `version` começa em 1 na abertura, inclusive quando o saldo inicial já vem preenchido, e só aumenta quando o saldo muda. `LOSS` e rejeição não mexem em versão nem em ledger.

Todo crédito ou débito grava um `wallet_ledger_entries` na mesma transação SQL, com `balance_before`, `amount` e `balance_after`. O `CHECK` do banco exige a aritmética e saldo não negativo. Um trigger recusa `UPDATE` e `DELETE` no ledger. A restrição única em `transaction_id` impede dois lançamentos para a mesma transação.

A abertura com saldo positivo grava, ainda nessa transação, uma transação interna `OPENING` e o crédito correspondente. `OPENING` não entra pela API nem pela fila.

Estratégia escolhida: lock pessimista por carteira, mais `pg_advisory_xact_lock` na chave de idempotência. O lock de idempotência serializa dois requests com a mesma chave antes de qualquer um gravar. O lock da carteira serializa apostas diferentes no mesmo saldo. Optimistic locking sozinho exigiria mais retries no cenário de hot wallet; o `FOR UPDATE` deixa o perdedor esperar o commit e então ver o saldo real. O `CHECK (balance >= 0)` é a última barreira se o código errar.

`lock_timeout` de 5 segundos devolve 503 em vez de segurar o request. Deadlock (`40P01`) e violação única inesperada são retentados até 3 vezes.

## Idempotência

O header `Idempotency-Key` é obrigatório e é a identidade da operação. A sugestão para o cliente é `{providerId}:{externalTransactionId}`.

`payloadHash` é SHA-256 hex de um JSON canônico do payload de negócio:

- chaves ordenadas em todos os níveis
- sem espaço
- campos: `providerId`, `externalTransactionId`, `playerId`, `walletId`, `roundId`, `gameId`, `kind`, `money.amount`, `money.currency`
- `referenceExternalTransactionId` entra somente quando o cliente envia
- header, `messageId` e `occurredAt` ficam de fora

A mesma chave com o mesmo hash devolve o resultado original, com o saldo observado naquele momento (`idempotentReplay: true`). Chave igual com hash diferente responde `409 IDEMPOTENCY_CONFLICT` e não reaplica o efeito. A unicidade está em `idempotency_key` e em `(provider_id, external_transaction_id)`.

## Regras e códigos de falha

| Código | Quando | O provedor deve |
|---|---|---|
| `INSUFFICIENT_FUNDS` | `BET` sem saldo | não repetir o mesmo débito sem crédito novo |
| `INSUFFICIENT_FUNDS_ON_REVERSAL` | `ROLLBACK` de crédito que deixaria saldo negativo | distinto de aposta sem saldo; pode tentar de novo se o saldo voltar |
| `REFERENCE_REQUIRED` | `REFUND` ou `ROLLBACK` sem referência | corrigir o payload; a API responde 400 e não grava |
| `REFERENCE_NOT_FOUND` | referência não chegou até o TTL | desistir ou reenviar depois; a rejeição libera a trava |
| `REFERENCE_NOT_ELIGIBLE` | referência `REJECTED` ou `FAILED` | não repetir contra essa referência |
| `REFERENCE_MISMATCH` | provider, player, wallet, moeda ou rodada diferentes | corrigir o payload |
| `REFERENCE_NOT_ALLOWED` | `BET` ou `LOSS` com referência | corrigir o payload |
| `INVALID_REFERENCE_KIND` | `REFUND` fora de `BET`, `ROLLBACK` fora de `BET`/`WIN`/`REFUND`, `WIN` apontando para algo que não é `BET` | corrigir o payload |
| `AMOUNT_MISMATCH` | valor diferente da referência | correção parcial está fora de escopo |
| `ALREADY_REVERSED` | já existe `REFUND` ou `ROLLBACK` pendente ou processado para essa referência | não reenviar |
| `CURRENCY_MISMATCH` | moeda da operação diferente da carteira | corrigir o payload |
| `WALLET_PLAYER_MISMATCH` | `playerId` não é o dono da carteira | corrigir o payload |
| `INVALID_KIND` | `OPENING` vindo de fora | não enviar |

`WIN` pode citar a `BET` da mesma rodada. Se citar e a aposta ainda não chegou, fica `PENDING_REFERENCE`. Sem referência, o crédito entra direto. `gameId` não precisa coincidir; o enunciado pede provider, player, wallet, moeda e rodada.

Uma reversão rejeitada não consome a chance: o índice único parcial só cobre `PENDING`, `PENDING_REFERENCE` e `PROCESSED`. Duas reversões do mesmo tipo não passam juntas porque a carteira está lockada e o índice segura a corrida.

Referência ausente fica `PENDING_REFERENCE`. Um worker reprocessa com backoff. Limite: 10 tentativas, base 1s, teto 60s, TTL de 5 minutos. Provedor que manda o estorno antes da aposta costuma entregar a aposta em segundos; cinco minutos cobrem uma falha curta sem prender a referência para sempre. Esgotado o limite, a transação vai para `REJECTED` com `REFERENCE_NOT_FOUND` e o evento correspondente entra na outbox.

## HTTP

| Situação | Status |
|---|---|
| payload inválido | 400 |
| carteira ou transação inexistente | 404 |
| carteira duplicada ou idempotency key com outro payload | 409 |
| `PROCESSED`, `REJECTED` ou `FAILED` gravados | 200 |
| `PENDING_REFERENCE` | 202 |
| Postgres ou lock indisponível | 503 |

Rejeição de negócio gravada volta 200 com `status` e `failureCode`. O provedor não precisa ler texto livre para saber se pode reenviar. O corpo traz o código estável.

## Inbox, outbox e falhas

Inbox, alteração de saldo, ledger e outbox acontecem na mesma transação. O `ack` da SQS só ocorre depois do commit. Redelivery encontra a inbox por `(consumer_name, message_id)` e devolve o resultado sem novo lançamento.

Erros de negócio gravados dão `ack`. Payload inválido e conflito de idempotência vão para a DLQ: repetir não resolve. Carteira ainda inexistente e erro de infraestrutura mudam a visibilidade com backoff e, após 5 recebimentos, vão para a DLQ. A fila também tem redrive policy com `maxReceiveCount` 5. No `SIGTERM` o consumidor termina a mensagem em curso ou devolve a visibilidade.

O publisher lê a outbox com `FOR UPDATE SKIP LOCKED`, publica em `wager-events.fifo` e só então marca `published_at`. Dois publishers não pegam a mesma linha. Se o processo morre depois do commit financeiro e antes do publish, outra instância publica. Se morre depois do `SendMessage` e antes de marcar, o evento pode sair duas vezes: o `eventId` é estável e o `MessageDeduplicationId` da FIFO usa esse id. Deduplicação do broker é otimização. O consumidor do evento deve tratar `eventId` como idempotente.

Eventos: `WagerTransactionProcessed` (também em `LOSS`), `WagerTransactionRejected`, `WalletBalanceChanged` só quando o saldo muda, `WagerTransactionPendingReference` na primeira espera.

## Observabilidade

Log JSON em stdout com `correlationId`, `messageId`, `transactionId`, `walletId` e `providerId`. Valor, saldo e payload não entram no log. `GET /metrics` expõe contagem por status, duplicatas, retries, DLQ, conflitos de lock, divergência de reconciliação, lag da outbox e latência. As métricas vivem no processo; com várias instâncias, cada uma expõe a sua. Health de readiness testa Postgres e a fila. Liveness só diz que o processo responde. Nenhum dos dois exige autenticação.

## Autenticação

Não há IdP neste entrega. `AuthGuard` deixa passar e o ponto de troca está marcado no código. A implementação prevista é OIDC com Keycloak ou Zitadel na frente da API, validando o bearer token e o `providerId` do token contra o corpo. A fila continua sendo canal interno. Health fica `@Public()`. Trocar o guard não mexe no caso de uso financeiro.

## Limitações

- Estorno parcial não existe.
- Métricas não são agregadas entre instâncias.
- `FAILED` existe no modelo para erro permanente auditável; o caminho comum de poison message é a DLQ, com rollback da transação SQL.
- O teste de carga não foi feito.
- Partidas dobradas ficaram de fora. O ledger é de um lançamento por efeito, com saldo antes e depois.
