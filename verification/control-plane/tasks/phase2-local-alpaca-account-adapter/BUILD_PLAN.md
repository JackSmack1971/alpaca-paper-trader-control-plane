# Build plan — local Alpaca account adapter

## Scope and authority

Implement only task phase2-local-alpaca-account-adapter while Phase 2 is active. Preserve the charter's fixed https://paper-api.alpaca.markets base URL, read-only PAPER behavior, production credential path, and permanent no-live-route invariant. Local simulation is loopback-only and must not alter the production endpoint or adapter defaults.

## Current seam and gap

- src/infra/alpaca-account.ts already owns AlpacaPaperAccountClient: it constructs requests against the constant PAPER base URL, performs only the account, positions, open-orders, and clock GETs, bounds response bodies, validates/normalizes the complete response, and sanitizes typed errors.
- src/api/app.ts currently implements POST /__local/account/reconcile by asking LocalTestHarness.providerResponse('account') once, then calling reconcileAccount(). That path updates fixture-derived freshness and returns harness-normalized state; it does not call AlpacaPaperAccountClient.
- LocalTestHarness.providerResponse(resource) already has resettable account scenarios, clock derivation, failure queues, provider health, and sanitized logs. Resource-level access is currently a route for observing synthetic API shapes, not a fetch transport.
- Existing tests cover adapter endpoint construction and general local harness failure/health/log behavior separately. Add an integration assertion that ties them together through the reconcile endpoint.

## Smallest design

1. Add a local-only transport factory, preferably src/infra/local-alpaca-account-transport.ts. It accepts a narrow resource callback from the harness and returns an injected fetchImpl.
   - Accept only origin exactly https://paper-api.alpaca.markets, method GET, and these exact path/query combinations:
     - /v2/account → account
     - /v2/positions → positions
     - /v2/orders?status=open&limit=500 → orders
     - /v2/clock → clock
   - Reject any other origin, method, path, or query before accessing fixture state. Never delegate to global fetch; unexpected calls must fail closed.
   - Convert the harness's raw provider-shaped data to Response.json(data). Do not include simulation envelopes in adapter input.
   - Keep the factory local-only and unexported from any production construction path if possible. No configurable base URL.

2. Construct one local reconciler for the local app path in src/api/app.ts (or its existing local initialization seam), using the existing AlpacaPaperAccountClient with the transport above and inert, fixed in-process placeholder header values. The client constructor requires non-empty strings; these must never be sourced from config/environment, emitted, persisted, returned, or logged. Keep this reconciler separate from the production reconciler passed to createApp; production main.ts must continue constructing its reconciler only from configured Alpaca credentials and the same adapter defaults.
   - Inject () => new Date(localHarness.state().now) as the reconciler clock and use bounded valid timing parameters; make no real timer/start call. The endpoint explicitly invokes reconcileOnce() so all timestamps use virtual time deterministically.
   - On success, expose snapshot.account as the normalized adapter AccountState in the existing PAPER/simulated response envelope. Avoid returning API keys, headers, request internals, or raw errors.
   - On typed failure, map only AlpacaAccountError.kind to stable simulated status/error output; preserve fail-closed response behavior.

3. Extend LocalTestHarness with a narrow way to observe completion/failure of adapter reconciliation. Reuse the existing account provider-health state and log buffer, but record one adapter-level result after the complete four-resource transaction: success marks account ready and logs a sanitized success event; failure marks it degraded and logs a sanitized error kind. Keep per-resource fetches from incorrectly restoring readiness midway through a failed reconciliation. The existing one-shot account failure queue should trigger on the first account adapter request; a later reconciliation should consume no queued failure and recover. Preserve reset semantics and virtual timestamps. Existing /__local/provider/:resource behavior should remain unchanged.

4. In tests/local-test-harness.test.ts, add endpoint integration checks proving:
   - success invokes the adapter transport exactly for all four fixed PAPER GET resources (through a narrow test spy/factory seam or observable sanitized transport calls) and returns its normalized state/provenance, including fixture positions, orders, exposure, and clock-derived reconciliation timestamp;
   - an injected network, rate-limit, and broker failure returns the expected simulated status, degrades account provider health and emits sanitized logs/traces; the next call succeeds, returns normalized state, and restores health;
   - unexpected host/route/method are rejected without global network access (unit-test the transport factory directly);
   - local mode obtains no credentials from environment/config and the production client still uses the fixed PAPER constant.
   Reuse tests/alpaca-account.test.ts fixture/normalization contracts where appropriate; do not duplicate broad adapter coverage.

5. Update docs/runbook.md only with concise route semantics and an example local reconcile/failure/recovery flow if it currently documents local controls. State clearly that the route uses in-memory PAPER-shaped fixtures and does not establish live Alpaca qualification.

## Likely files

- src/api/app.ts — local endpoint invokes the local adapter/reconciler; production route construction remains untouched.
- src/domain/local-test-harness.ts — success/failure observation and health/log semantics around complete reconciliation.
- src/infra/local-alpaca-account-transport.ts — strict in-memory allowlisted transport.
- tests/local-test-harness.test.ts — end-to-end route, health, recovery and sanitized observation coverage.
- docs/runbook.md — operator instructions and simulation boundary.
- Possibly tests/local-alpaca-account-transport.test.ts if separating URL/method allowlist tests keeps the integration test focused.

## Determinism, isolation, and safety risks

- No external I/O: the injected transport must never fall back to global fetch; unexpected hosts/routes/methods must reject synchronously/as a typed sanitized failure. Tests should stub global fetch to throw and prove it is not called.
- Preserve fixed URL: do not add a base-URL option, env variable, or test-only URL override to AlpacaPaperAccountClient. Assert all constructed request origins equal the production PAPER constant.
- Credential boundary: local mode must not load or copy real Alpaca credentials into the transport. The existing client requires non-empty auth header values, so use inert in-memory placeholders only; ensure neither response/error/log nor transport observation stores headers.
- Health atomicity: avoid marking health ready for each successful resource: a failure on positions/orders/clock after account succeeded must leave the whole reconciliation degraded. A single completion callback should update health once.
- Virtual time: both request observation and normalized reconciledAt must derive from the harness clock; do not use wall-clock dates or start periodic timers.
- Production isolation: keep all local-only construction guarded by config.localTestMode; do not change src/main.ts production setup or normal Alpaca client behavior.
- Failure semantics: use typed adapter errors and bounded status mapping, never echo fixture payloads, response bodies, error messages, or credentials. Ensure failure queues reset deterministically.
- PAPER-only proof: rerun existing PAPER/no-live-route checks and ensure no live endpoint string is introduced in src/.

## Acceptance evidence

The three task criteria are proven only by the route-level test and structured verification showing: (a) all four requests passed through AlpacaPaperAccountClient and its normalizer; (b) no real credential lookup/network path and strict host/route rejection with fixed PAPER origin; and (c) success, injected failure, recovery, health, and sanitized log/trace observations. Mock-shaped payloads prove adapter behavior against the fixture contract, not live Alpaca correctness.

