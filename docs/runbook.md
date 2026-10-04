# Local development runbook

This service is PAPER-only. Credential-free default startup does not construct broker or model clients; local-test mode exposes synthetic provider responses. Outside local-test mode, Alpaca account and market adapters start only when both PAPER credentials are present. Never add secrets to fixtures, config files, logs or committed environment files.

## Requirements

- Node.js 22
- Corepack with pnpm 10.18.1
- PostgreSQL 16

Start the isolated, ephemeral PostgreSQL 16 service. Its data directory is a container tmpfs, and its trust-authenticated port is bound only to loopback. Do not expose it to a LAN or point the application at a shared or production database. Optional `ALPACA_KEY_ID`, `ALPACA_SECRET_KEY` and `OPENROUTER_API_KEY` are not needed for offline verification or startup.

```powershell
corepack pnpm install --frozen-lockfile
corepack pnpm dev:db:up
$env:DATABASE_URL = 'postgres://postgres@127.0.0.1:55432/alpaca_paper_dev'
corepack pnpm config:check
corepack pnpm start
```

Startup applies the checked-in initial migration and prints a PAPER-mode banner. `GET /health` reports database connectivity and each provider as `not_configured` or `unavailable`; its credential field says only `present` or `missing`. Credentials alone never imply connectivity. A response with `status: degraded` or HTTP 503 means the database is not reachable; it is not a successful simulated connection.

When both Alpaca credentials are configured outside local test mode, the process starts one server-owned stock market WebSocket for the configured universe. The client sends message authentication after the stream welcome control, then subscribes to trades and quotes. `ALPACA_MARKET_DATA_CODEC` selects the documented `json` (default) or binary `msgpack` frame format; the opening `Content-Type` header and decoder use the same setting. Both formats use the same bounded control/data validation. This local support does not qualify live MessagePack negotiation, SDK compatibility, or compression behavior. `GET /market`, `/status` and `/health` expose sanitized connection status/counters and normalized application market states. Basic is the default plan and limits the equity universe to 30 symbols. Set `ALPACA_MARKET_DATA_PLAN=algo_trader_plus` only when that account's entitlement is confirmed; the app still caps its in-memory state at 100 symbols. Feed is restricted to `iex`, `sip`, or `delayed_sip`. Authentication, entitlement, symbol-limit and connection-limit failures stay degraded and do not trigger reconnect loops; transient disconnects use bounded configured backoff.

In another terminal, verify a running credential-free service and its initialized schema without changing state:

```powershell
$env:DATABASE_URL = 'postgres://postgres@127.0.0.1:55432/alpaca_paper_dev'
corepack pnpm verify:runtime
```

This checks `/health`, `/status`, the PAPER-mode response header, absent provider credentials, truthful `not_configured` capabilities and the required correlated persistence tables. It fails if credentials are present so the result is unambiguously credential-free.

Seed a deterministic synthetic cycle/context/market record after startup with `corepack pnpm db:seed`. Seeding refuses non-loopback database hosts and does not call a broker or market provider. Reset all local DB state by running `corepack pnpm dev:db:reset`, then restart the app and seed again. The Compose database has no persistent volume, so removing it discards the database contents.

## Offline checks

```powershell
corepack pnpm verify:offline
```

The offline checks do not contact Alpaca or OpenRouter. Configuration validation uses a local placeholder database URL only when `DATABASE_URL` is unset; that placeholder is never used to connect. Credential-backed qualification remains unverified until later authorized phases and credentials are available. Local mode exposes fixture replay, account/market state, simulated provider responses, and synthetic trade-update event hints; order submission and orchestrator-cycle controls are not yet exposed.

## Deterministic market fixture replay

Phase 2 adds an offline market-event normalizer and `MarketReplay` domain utility. The checked-in `fixtures/market/replay-sample.json` contains synthetic Alpaca-shaped trade and quote messages. The loader reads at most 4 MiB for market fixtures and 1 MiB for account fixtures, rejects unknown fixture fields, and bounds event and record counts before the harness starts. Simulated market responses expose normalized state rather than replay wire records. Replay takes an injected clock, advances one event at a time, produces application-owned snapshots and computes freshness when `snapshot()` is read. It does not open a socket or require credentials. Malformed, duplicate trade, and out-of-order events throw before the replay cursor advances. Run `corepack pnpm test -- tests/market-state.test.ts` to verify the behavior. Loopback local mode exposes this replay and simulated provider responses over HTTP.

The fixture format follows the documented stock stream trade and quote field shapes; it is synthetic and is not live market evidence. The parser accepts at most 100 data messages per batch, a replay fixture is limited to 10,000 events, and a replay can hold at most 100 distinct symbol states so persisted snapshots remain restorable. Restoring a larger replay cursor validates in bounded chunks. In loopback `LOCAL_TEST_MODE`, replay also sends those fixture frames through the production `AlpacaMarketStream` connect/authenticate/subscribe/frame pipeline using a fixed in-memory WebSocket transport; `/market` and `/__local/state.market` expose the production accumulator output. The transport accepts only the configured fixed Alpaca stock stream URL, never constructs a real WebSocket, and uses fixed local-only auth placeholders that are not read from environment or config. Simulated handshake success is not live authentication evidence. See [Alpaca market-data streaming](https://docs.alpaca.markets/us/docs/streaming-market-data) for provider wire-format details.

## Loopback runtime controls

To expose deterministic in-process controls, start with `LOCAL_TEST_MODE=true`, no Alpaca/OpenRouter credentials, and `HOST=127.0.0.1` (or `localhost`/`::1`). Startup rejects other bind hosts and any configured provider credential while this mode is enabled. The controls are not registered by default. The HTTP controls load only the checked-in synthetic fixtures; they make no network calls.

```powershell
$env:HOST = '127.0.0.1'
$env:PORT = '3001'
$env:LOCAL_TEST_MODE = 'true'
$env:DATABASE_URL = 'postgres://postgres@127.0.0.1:55432/alpaca_paper_dev'
Remove-Item Env:ALPACA_KEY_ID,Env:ALPACA_SECRET_KEY,Env:OPENROUTER_API_KEY -ErrorAction SilentlyContinue
corepack pnpm start
```

In another terminal, set `LOCAL_CONTROL_URL='http://127.0.0.1:3001'` and run `corepack pnpm verify:local-controls`. The verifier resets the in-memory scenario before and after its bounded replay/failure checks.

- `POST /__local/reset` with `{}` restores the scenario and replay cursor.
- `POST /__local/clock` with `{ "now": "2025-01-02T14:31:00.000Z" }` sets virtual time.
- `POST /__local/market/replay` with `{ "steps": 2 }` replays 1–100 events.
- `POST /__local/scenario/account` accepts the provider-shaped snapshot from `fixtures/account/reconciliation-sample.json`, replacing only the in-memory simulated PAPER response after normalization; reset restores the checked-in seed.
- `POST /__local/account/reconcile` with `{}` calls the production read-only `AlpacaPaperAccountClient` and normalizer through a strict in-memory PAPER transport. It reads the four simulated account, positions, open-orders, and clock resources at current virtual time. The transport accepts only GETs to the fixed Alpaca PAPER origin and these four resources; it never calls global `fetch`. `/__local/state.account.provenance.source` is `alpaca_paper` after reconciliation. This exercises the adapter against synthetic provider-shaped fixtures and does not qualify live Alpaca behavior.
- `/__local/state.account.freshness` reports `fresh` or `stale` and `ageMs`; `accountStateStaleAfterSeconds` defaults to 60 and is configurable with `ACCOUNT_STATE_STALE_AFTER_SECONDS` (1–3600). Advancing virtual time ages account state without changing its reconciliation timestamp. A failed reconciliation preserves the last successful normalized account snapshot and marks account provider health degraded; the next successful reconciliation replaces it and restores health.
- `GET /__local/state` returns normalized market/account state, positions, open orders, exposure, freshness and cursor.
- `POST /__local/trade-updates` accepts `{ "updates": [{ "stream": "trade_updates", "data": { "event": "partial_fill", "timestamp": "2025-01-02T14:30:01.000Z", "price": "190.25", "qty": "2", "position_qty": "2", "order": { "id": "order-123", "client_order_id": "local-order-123", "symbol": "AAPL", "side": "buy", "type": "limit", "status": "partially_filled", "qty": "4", "filled_qty": "2", "filled_avg_price": "190.25" } } }] }`. This is a bounded synthetic HTTP fixture contract, not a WebSocket/frame/authentication implementation. Batches contain 1–20 strict provider-shaped messages; malformed batches are rejected atomically. Accepted records become sanitized application-owned event hints stamped with virtual `receivedAt` and retained to the newest 100 observations.
- `GET /__local/trade-updates` and `/__local/state.tradeUpdates` inspect those hints. They carry simulated PAPER markers and never update account positions, open orders, or the persisted local broker snapshot. `POST /__local/reset` clears the observations; `POST /__local/clock` controls their receive timestamp. `/__local/assert-state` can compare the `tradeUpdates` projection.
- `POST /__local/assert-state` accepts `{ "expected": { ... } }` and compares the supplied object projection with current state. Expected objects may specify a subset of fields; expected arrays must have the same length and order as observed arrays. It returns `matched`, a bounded list of mismatch paths, and no state values. Request size, depth, node count, array length and string length are bounded; mismatches are results (`matched: false`), while malformed or oversized expectations return HTTP 400.
- `GET /__local/provider/account|positions|orders|clock|market` returns synthetic Alpaca-shaped PAPER responses with a `simulated: true` marker. Account resources use the current local scenario; other responses use checked-in fixtures/replay. These are local emulator responses and never open a provider connection.
- `GET /__local/provider/health` reports independent market and account provider health, including failure and recovery timestamps.
- `POST /__local/failures` with `{ "target": "account", "kind": "rate_limit", "count": 1 }` arms one to ten one-shot failures. Targets are `account` or `market`; kinds are `network` (503), `rate_limit` (429) and `broker` (403). A market failure is injected into the local production stream transport: network closure and rate-limit errors use the adapter's bounded reconnect path, while broker authentication rejection is terminal until reset/recovery. Each provider queue holds at most 100 pending failures; an enqueue that would exceed the cap is rejected without changing the queue. Reset clears pending failures and reinitializes the simulated stream session.

For an adapter failure and recovery, arm one failure with `POST /__local/failures` using `{ "target": "account", "kind": "rate_limit", "count": 1 }`, call `POST /__local/account/reconcile` (429), inspect `/__local/provider/health` and `/__local/logs`, then call reconciliation again to restore the normalized account state. Adapter logs include only resource names and sanitized error kinds; they do not include authorization headers or provider payloads.
- `GET /__local/traces?after=0&limit=100` returns at most 100 route-template records, capped at 200 retained entries. Query values and bodies are not recorded.
- `GET /__local/logs?after=0&limit=100` exposes bounded structured application events, including sanitized request completion and provider failure records. Fastify's wall-clock request logger is disabled in this mode; application logs use virtual time and omit request bodies, query values, and headers.

The scenario's virtual time and market replay cursor/state are persisted in the disposable local PostgreSQL database. Startup reports `reconciliation.status` and the snapshot revision in `/__local/state`; an initialized snapshot is sourced from checked-in fixtures, and later process starts restore the PostgreSQL snapshot. Startup validates the persisted replay prefix and restores the production stream accumulator with the persisted receive timestamps, so virtual-time freshness is stable across restart. Reset persists the checked-in initial scenario and reinitializes the in-memory stream session. Injected failures, logs and traces remain process-local and reset on restart. `corepack pnpm verify:local-controls` exercises provider responses and injected failures against an already-running loopback test-mode application.

To prove process restart restoration end to end, with Docker PostgreSQL running and no provider credentials configured, run:

```powershell
$env:DATABASE_URL = 'postgres://postgres@127.0.0.1:55432/alpaca_paper_dev'
Remove-Item Env:ALPACA_KEY_ID,Env:ALPACA_SECRET_KEY,Env:OPENROUTER_API_KEY -ErrorAction SilentlyContinue
corepack pnpm verify:local-restart
```

This starts and stops two real application processes, advances replay, sets a fixed virtual timestamp, and compares normalized market/account state after restart. It uses only loopback HTTP and PostgreSQL and resets the scenario before exiting. This verifies the local deterministic simulator's restart behavior; it is not evidence of live broker reconciliation.

## Deterministic decision context

With the loopback application and disposable PostgreSQL running, set `LOCAL_CONTROL_URL` and run `corepack pnpm verify:decision-context`. The bounded verifier resets the fixture, replays three historical events, persists one versioned context, verifies repeat-call idempotence and canonical hash replay, then confirms changed inputs conflict with that immutable cycle. It requires no provider credentials or live market connection.

`POST /__local/decision-context` accepts a cycle UUID and one symbol. Its source input stores the normalized market/account snapshots, replayed fixture records, virtual `as_of`, and transform parameters. `GET /__local/decision-context/:cycleId/replay` rebuilds the context from those stored inputs and checks the canonical SHA-256 digest. Context output uses sorted-key canonical JSON; decimal calculations use integer-scaled arithmetic with half-even rounding to eight decimal places, and the spread is reported in basis points rounded to two decimals. The selected conservative bound is UTF-8 serialized bytes (one byte counted as one token), capped at 4,000; unavailable fields remain null with path-specific reasons and ordered source provenance. Normalized market and account snapshots are schema-validated before any derived value is copied; market freshness requires a fresh producer marker, no producer stale reason, and both receive-time and source-event ages within the configured threshold. If symbol capabilities are supplied, their source, record ID, optional source time, and receive time are required and retained in ordered provenance. Historical fixtures do not retain a receive time per event, so event-level `received_at` is null rather than copied from the latest snapshot. Inference eligibility is false when market/account state is stale or absent, the price is missing, any required market-return/trend/variance history is incomplete, portfolio exposure is incomplete, the market is closed, or symbol tradability is unknown/false. The checked-in three-event fixture is intentionally too sparse for inference and produces explicit blockers; a fully populated six-trade context is covered by domain tests. Alpaca trade corrections replace the referenced trade, and both cancel/error actions remove the referenced trade, following the [stock stream event contract](https://docs.alpaca.markets/us/v1.4.2/docs/real-time-stock-pricing-data).

## LLM1 stage request spacing

LLM1 provider attempts use process-local minimum start spacing configured by `LLM1_MINIMUM_INTERVAL_MS` (default 30 seconds, accepted range 30–120 seconds). Every attempt, including its single bounded retry, passes through the limiter before fetch. This is conservative application policy only; it does not establish OpenRouter quota compliance. The adapter does not parse `Retry-After` values.

## Jev persisted-stage verification

With the disposable loopback PostgreSQL running, the schema migrated, and no provider credentials configured, run `corepack pnpm verify:jev-stage`. Set `DATABASE_URL` to the loopback Compose database if it is not already configured. This credential-free verifier inserts a new synthetic PAPER decision context and stage records on each run without resetting or deleting database state. Fake LLM1 and Jev transports verify stable baseline/shadow provenance, distinct per-request invocation IDs, their shared comparison group, paired typed answers, and terminal provider-failure evidence that resolves to `no_action`. It makes no live provider calls and does not qualify OpenRouter behavior.

## Deterministic account reconciliation fixture

The account-state domain normalizer accepts provider-shaped account, open-position, open-order and market-clock groups and returns only application-owned `AccountState` fields. `fixtures/account/reconciliation-sample.json` is synthetic. The normalizer takes an explicit reconciliation timestamp and source label; it makes no request and does not use wall-clock time. Exposure uses decimal-string arithmetic. If a position has neither reported market value nor a current price, its symbol is listed as unpriced and `exposure.complete` is false so missing value is not treated as zero. Run `corepack pnpm test` for the offline fixture assertions. Local mode exposes this normalized fixture account via `/__local/state` and simulated provider endpoints; it does not perform live broker reconciliation.

The local snapshot migration adds one versioned JSONB row for the checked-in scenario, with a monotonically increasing revision and UTC update time. There is no backfill because prior state existed only in process memory. Keep the migration append-only; recovery is to reset the local scenario or recreate the disposable database, not roll back or rewrite an applied migration.

The fields align with the documented PAPER Trading API account, positions, orders and market-clock resources: [account](https://docs.alpaca.markets/us/docs/working-with-account), [positions](https://docs.alpaca.markets/us/reference/getallopenpositions), [orders](https://docs.alpaca.markets/us/reference/getallorders-1), and [clock](https://docs.alpaca.markets/us/reference/clock-1). Alpaca may return null current pricing for some supported assets; the normalizer preserves that uncertainty in its exposure completeness flag.

When PAPER credentials are configured outside local test mode, one in-process read-only reconciler requests `/v2/account`, `/v2/positions`, `/v2/orders?status=open&limit=500`, and `/v2/clock` from the fixed `https://paper-api.alpaca.markets` host. It uses only the `APCA-API-KEY-ID` and `APCA-API-SECRET-KEY` headers. A snapshot publishes only after all four validated responses normalize successfully; failures retain the last good account state. A response containing 500 open orders is treated as potentially truncated and rejected as incomplete. `/account` exposes the sanitized snapshot and reconciliation state; `/health.accountReconciliation` exposes freshness/connection status without account values. Local mode never constructs the broker client and continues to use the deterministic fixture simulator.

Account polling defaults to every 60 seconds. Failure retries use bounded exponential delay, capped by the configured polling interval and `ACCOUNT_RETRY_MAX_SECONDS`; `Retry-After` is honored when present, up to a one-hour safety bound. `ACCOUNT_REQUEST_TIMEOUT_MS` defaults to 10 seconds. `X-RateLimit-*` values are exposed only when returned; exact Trading API quotas are not inferred from Broker API documentation. No credential-backed account request has been run in this environment.
