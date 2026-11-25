# Soroban Event Indexer Architecture

## Overview

The Soroban Event Indexer is a background service that keeps the off-chain database synchronized with on-chain Soroban contract states. It polls the Soroban RPC `getEvents` endpoint, decodes the `ScVal` data, and updates the local database accordingly. Horizon does not expose Soroban contract events.

### Architecture Diagram

```mermaid
graph TD
    A[Stellar Network] -->|Emits Events| B(Stellar RPC Node)
    B -->|getEvents RPC Call| C[Event Indexer Service]
    C -->|Checkpointing| D[(Database: Last Synced Ledger)]
    C -->|Decode ScVal| E[Event Processor]
    E -->|Update State| F[(Database: Application State)]
    E -->|Error Recovery| G[Retry Queue]
```

## Event Topic Structures

The indexer filters and listens to specific topics from various smart contracts.

The background indexer is started when `SOROBAN_INDEXER_CONTRACT_IDS` is set to
a comma-separated list of contract IDs. It paginates each RPC response and
stores each RPC event ID in `soroban_event_logs` and the RPC high-water ledger
in `soroban_indexer_checkpoints`, including ledgers without matching events.
Failed state updates remain unprocessed and are retried from their ledger on the next poll. Configure the
RPC endpoint with `STELLAR_RPC_URL` (or `SOROBAN_RPC_URL`).

### Investor events

The event topic name is the first decoded topic. Investor event values can be
encoded as named fields in the event data or as positional topics after the
topic name. The indexer accepts camelCase or snake_case field names:

- `OnboardingBonusClaimed`: `wallet`, `bonus_amount`, `invoice_id`, and
  optionally `claimed_at`. The timestamp falls back to the ledger close time.
- `AlertPreferenceUpdated`: `wallet` and preference booleans for
  `settlement`, `kyc_expiry`, `watchlist_change`, `auto_invest`, and `maturity`.
  Omitted settings remain enabled by default.
- Settlement events: `invoice_id`, `adjustment_bps`, `basis_rating`, and
  `adjusted_yield`. An omitted bps value is recorded as zero when rating/yield
  adjustment data is present.

The onboarding pool admin endpoint reads the persistent contract-data key
configured by `ONBOARDING_BONUS_POOL_STORAGE_KEY` (default `pool_balance`) from
`ONBOARDING_BONUS_CONTRACT_ID`. Alert dispatch posts one JSON request per opted-in
wallet to `NOTIFICATION_SERVICE_URL` with `wallet`, `event_type`, and event
metadata; each request includes an `idempotency-key`. A bearer token can be
configured with `NOTIFICATION_SERVICE_TOKEN`. Dispatch failures leave the event
unprocessed so the indexer can retry it.

Investor wallet endpoints are authenticated and only return data for the
authenticated wallet. Yield-adjustment reads are available without wallet
authentication:

- `GET /api/v1/investors/:wallet/onboarding-bonus`
- `GET /api/v1/investors/:wallet/alert-preferences`
- `GET /api/v1/invoices/:invoice_id/yield-adjustment`
- `GET /api/v1/invoices/:invoice_id/yield-adjustment/history`
- `GET /api/v1/admin/onboarding-bonus/pool-balance` (admin IP allowlist)

### 1. Invoice Escrow Contract (`invoice-escrow`)
Topics emitted during the escrow lifecycle:
- `["escrow", "initialized"]`: Triggered when a new invoice is escrowed.
  - Data: `Invoice ID`, `Amount`, `Payer`, `Payee`
- `["escrow", "released"]`: Triggered when funds are released to the payee.
  - Data: `Invoice ID`, `Transaction Hash`
- `["escrow", "refunded"]`: Triggered when funds are returned to the payer.
  - Data: `Invoice ID`, `Reason`

### 2. Invoice Token Contract (`invoice-token`)
Topics emitted for tokenized invoices:
- `["token", "minted"]`: Triggered when invoice tokens are minted.
  - Data: `Token ID`, `Amount`, `Owner`
- `["token", "transferred"]`: Triggered on token transfer.
  - Data: `Token ID`, `From`, `To`, `Amount`
- `["token", "burned"]`: Triggered when tokens are burned upon settlement.
  - Data: `Token ID`, `Amount`

### 3. Payment Distributor Contract (`payment-distributor`)
Topics related to distributing yields or payments:
- `["payment", "distributed"]`: Triggered when a batch of payments is distributed.
  - Data: `Batch ID`, `Total Amount`, `Recipients Count`
- `["payment", "failed"]`: Triggered when a specific payment fails.
  - Data: `Recipient`, `Amount`, `Error Code`

### 4. Integration ACL, creator keys, curve migrations and atomic swaps

Topics consumed by the read models exposed under `/api/v1/keys`, `/api/v1/swaps` and
`/api/v1/admin/acl`. Each topic is handled by a `ContractEventHandler` registered on
`ContractEventBus` (see `src/services/contract-event-bus.service.ts`), which
`EventIndexerService` dispatches to after the event is logged. A handler failure is
logged and skipped, so one bad projection never blocks the rest of the pipeline.

- `["key_config_updated", key_id]`: new per-key buy caps and supply. Updates
  `creator_keys` and invalidates the 60s buy-limit cache.
- `["acl_updated", contract_address]`: whitelists (`action: "add"`, with
  `permitted_functions`) or removes (`action: "remove"`) an integration contract.
  Upserts `contract_acls`, appends to `contract_acl_logs`, and invalidates the 5m
  ACL cache.
- `["curve_migration_proposed", key_id, proposal_id]`: a bonding-curve migration
  proposal with its parameters and timelock. Recorded as `pending` until the
  matching execution event arrives.
- `["curve_migration_executed", proposal_id]`: applies the migration, stamps
  `executed_at` and applied parameters, and emits an admin notification.
- `["atomic_swap_executed", buyer, seller, swap_id]`: a direct invoice-for-invoice
  exchange. Records both sides, both amounts, and the fee, indexed by buyer and by
  seller.

Projections are idempotent on their on-chain identifier, so replaying a ledger range
cannot create duplicate rows.

## Last-Synced Ledger Checkpointing

To ensure no events are missed and to prevent processing duplicate events, the indexer relies on a checkpointing mechanism:

1. **Polling**: The indexer queries the Soroban RPC `getEvents` endpoint with configured contract IDs and follows its cursor through full pages.
2. **Event log**: Each event is retained in `soroban_event_logs`, keyed by contract and RPC event ID. Successfully processed entries are marked processed; failed entries remain retryable.
3. **Checkpointing**: After every returned page has been handled, the indexer stores the latest observed ledger in `soroban_indexer_checkpoints`, including when a ledger contains no matching events. Workers acquire a renewable lease for the stream; each claim increments its fencing token, and checkpoint writes are accepted only from the current token owner. An expired lease can be reclaimed by another worker without allowing the former owner to advance the checkpoint.
4. **Resume**: On restart, polling resumes at `last_synced_ledger + 1`. Duplicate event delivery is skipped using the unique contract/event key.

### Checkpoint Identity and Backfill Policy

Each indexer stream derives a deterministic, order-independent checkpoint key from the normalized (trimmed, deduplicated, sorted) contract set and explicit Stellar network identifier:

`soroban:<network>:<sha256(network + "\0" + sortedContractIds.join(","))>`

- **Order independence**: Reordering the same contract IDs resolves to the same checkpoint key.
- **Stream isolation**: Different contract sets (even when sharing their first contract ID) use independent checkpoint rows.
- **Network isolation**: `testnet`, `mainnet`, and `futurenet` streams cannot consume each other's checkpoints.
- **Legacy migration & backfill policy (`newStreamBackfillPolicy`)**:
  - When a single-contract stream has no canonical checkpoint yet, any existing legacy checkpoint keyed by that contract ID is migrated to the canonical key and resumed (`action: "migrated_legacy_checkpoint"`).
  - When a multi-contract (expanded) stream encounters a legacy single-contract checkpoint, the default policy `backfill_from_genesis` starts from ledger `0` (`action: "backfill_expanded_stream"`) so historical events for newly added contracts are preserved while already-indexed events are deduplicated via `soroban_event_logs`.
  - Operators may explicitly opt into `resume_from_legacy` to migrate and resume from the legacy ledger instead. The resolved decision is logged and inspectable via `getLastResumeDecision()`.

## Runtime Configuration

- `SOROBAN_EVENT_INDEXER_ENABLED`: enable the background poller (default `false`).
- `SOROBAN_EVENT_INDEXER_INTERVAL_MS`: poll interval in milliseconds (default `10000`).
- `SOROBAN_EVENT_INDEXER_LAG_THRESHOLD_LEDGERS`: log a warning at or above this ledger lag (default `1000`).
- `SOROBAN_ESCROW_CONTRACT_ID` and `SOROBAN_RPC_URL`: contract and Soroban RPC endpoint; both are required to start the poller.

## Failure Recovery Procedures

The indexer is designed to handle temporary failures and RPC limits:

- **RPC Rate Limiting**: If a `429 Too Many Requests` error occurs, the indexer applies exponential backoff before retrying the `getEvents` call.
- **Ledger Gap Recovery**: If the `startLedger` is too far behind (e.g., beyond the RPC node's retention window), the system alerts administrators for manual intervention or falls back to an archive node.
- **Processing Failures**: If event decoding or database updates fail for a specific event, the indexer logs the error, places the event in a Dead Letter Queue (DLQ) for manual inspection, and continues processing subsequent events to avoid blocking the pipeline.

## Event Timestamps

Each indexed event carries three timestamps, and they are never substituted
for one another:

| Timestamp      | Column                                  | Meaning                                                      | Changes on replay?         |
| -------------- | --------------------------------------- | ------------------------------------------------------------ | -------------------------- |
| Ledger time    | `soroban_event_logs.ledger_closed_at`   | When the ledger containing the event closed. Authoritative.  | Never                      |
| Ingestion time | `soroban_event_logs.created_at`         | When the indexer first saw the event.                        | Never                      |
| Processing time| `soroban_event_logs.processed_at`       | When the event was first processed successfully.             | Set once, on success       |

**Processing lag** is `processed_at - ledger_closed_at`. The indexer logs it
at debug level (`processingLagMs`).

### Replays and retries

The first valid ledger time stored for an event wins:

- If a retry carries a **different** ledger time, the stored value is kept.
  The indexer logs a warning (`Replayed event carried a different ledger
  time`) and increments `stellarsettle_indexer_ledger_time_conflicts`.
- If a retry carries **no** ledger time, the stored value is used. Processing
  time is never used in its place.
- Projections always receive the stored ledger time, both as
  `ledgerClosedAt` and as `occurredAt`.

Ledger times are parsed strictly by `parseLedgerTime` (`src/lib/ledger-time.ts`).
The value must be an ISO-8601 date-time with an explicit zone and a real
calendar date. It must not be before 2015, and not more than 5 minutes in the
future.

### Quarantine

An event whose ledger time fails validation is **quarantined**, not
processed:

- Its row is kept with `processed = false`, `ledger_closed_at = NULL`, and
  `quarantine_reason`/`quarantined_at` set. For example, a quarantined row
  might have `quarantine_reason = 'invalid_ledger_time:unparseable'`.
- No projection runs for it.
- The indexer continues with the rest of the batch and moves the checkpoint
  past the event, so one bad event cannot stall indexing.
- Retention never archives a quarantined row, because only processed rows
  are eligible.
- If the same event is replayed later with a valid ledger time, it is
  released: it is processed, and its quarantine fields are cleared.
- Each quarantine increments `stellarsettle_indexer_events_quarantined`.

To list quarantined events:

```sql
SELECT event_id, topic, ledger_sequence, quarantine_reason, payload->>'ledgerClosedAt'
FROM soroban_event_logs WHERE quarantined_at IS NOT NULL ORDER BY ledger_sequence;
```

### Settlement history

`yield_adjustments.settled_at` is the settlement event's ledger time.
`processed_at` is when the settlement was first projected. Both keep their
first values on upsert. Settlement history is ordered by `settled_at DESC`,
then `settlement_event_id DESC`. Soroban event ids sort in ledger order, so
settlements that close in the same second still have a stable order.
Responses include `processed_at` and `processing_lag_ms`.

Rows written before this change have `processed_at = NULL`, so their lag is
reported as `null`.
