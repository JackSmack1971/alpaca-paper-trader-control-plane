# Phase 01 report — FOUNDATION

- Phase status: COMPLETE
- Charter SHA-256: `8fff9dfd9423c22da6db234e5f7d45f0f6f4414e15c131ba865f3ef7ccc6de5f`
- Goal SHA-256: `22c88ea1b0723cd0b7673431186a94df1fc2f5f5f05a3b8c9c7fee0a7eb53e81`
- Snapshot ID: `86e288823b5f67adf8d5a940f6154d0f8f55ecf1e0e7669991c321753f0867f1`
- Candidate ID: `fe02735524ddb090e021f58eb38360054dc6b6e7f7a4991c73a87963c1542999`
- Task / bundle: `phase1-runtime-foundation` / `88e26fe33f47b4b0cdf5ab5f9a3a90efa4503841f4b111979d3be8981aa2cf75`
- Baseline ref/SHA: `codex/ci-control-plane-trust-checks` / `ea9a83e069f1be79c307fd8a9c4b9fca85977409`
- Highest verification rung actually reached: 1

## Functionality implemented

Established the PAPER-only TypeScript/Fastify application foundation, Zod configuration boundary, secret-safe config reporting, PostgreSQL migrations and correlated persistence, truthful health/status routes, a loopback-only ephemeral PostgreSQL development service, deterministic synthetic seed, read-only runtime observer, offline verification and runbook. Startup validates configuration and PAPER invariants, applies all migrations and prints an unmistakable PAPER banner. Health/status identifies the database and reports optional providers as not configured without claiming connectivity.

The runtime observer confirms credential-free startup, PAPER mode in response body/header, database connectivity, the required application tables, and PAPER mode columns on decision contexts, AI stage runs and cycle outcomes. A fresh reset/startup applied migrations 0001–0003. Repeated synthetic seeding remained idempotent. An upgrade simulation from the 0002 schema reapplied migration 0003 successfully.

## Files materially changed

Application and configuration: `package.json`, `pnpm-lock.yaml`, `tsconfig.json`, `vitest.config.ts`, `config/default.json`, `src/`, `scripts/config-check.ts`, `scripts/migrate.ts`, `scripts/migrate.mjs`, `scripts/seed-dev.ts`, `scripts/verify-no-live-routes.mjs`, `scripts/verify-runtime.ts`, `tests/`, `compose.yaml`, `docs/runbook.md`, `README.md`, `.gitignore`.

Persistence: `migrations/0001_initial.sql`, `migrations/0002_paper_mode_correlation.sql`, `migrations/0003_paper_mode_cycle_outcomes.sql`.

Control-plane/evidence support: `scripts/control-plane/post-diff-risk.mjs`, and candidate-bound task evidence under `verification/control-plane/tasks/phase1-runtime-foundation/`.

## Migrations introduced

- `0001_initial.sql` — initial correlated application schema and kill-switch state.
- `0002_paper_mode_correlation.sql` — adds PAPER mode constraints to decision-context and stage-run rows.
- `0003_paper_mode_cycle_outcomes.sql` — adds PAPER mode constraint to persisted cycle outcomes.

The latter migrations are append-only. Both fresh startup and the 0002-to-0003 upgrade path were exercised against the disposable local database.

## Verification evidence

| Command / procedure | Outcome / exit | Rung | Evidence / notes |
|---|---:|---:|---|
| `node scripts/control-plane/validate.mjs` | PASS / 0 | 1 | Control-plane sources linked successfully. |
| `node scripts/control-plane/preflight.mjs` | READY / 0 | 1 | Phase 1 active; baseline and charter digest coherent. |
| `corepack pnpm verify:offline` | PASS / 0 | 1 | Typecheck; 7 tests; redacted config check; PAPER-only and no-live-route guards. `checks/foundation-offline-cycle-mode-final.json`. |
| `corepack pnpm dev:db:reset`, then `DATABASE_URL=postgres://postgres@127.0.0.1:55432/alpaca_paper_dev corepack pnpm start` | PASS / 0 | 1 | Disposable tmpfs database reset; fresh app startup applied migrations 0001–0003 and printed PAPER banner. |
| `corepack pnpm verify:runtime` with loopback `DATABASE_URL` | PASS / 0 | 1 | Credential-free live app/database check; PAPER header; 11 tables; all three correlated decision mode columns. `checks/foundation-runtime-cycle-mode-final.json`. |
| `corepack pnpm db:seed` (run twice) | PASS / 0 | 1 | Synthetic SPY cycle/context/market fixture seeded idempotently; one seed cycle/context/market row remained. |
| `corepack pnpm db:migrate` after simulating migration-0002 state | PASS / 0 | 1 | Migration 0003 reapplied and restored `cycle_outcomes.mode`; migration ledger returned to three entries. |
| `node scripts/control-plane/validate-test-results.mjs --task-id phase1-runtime-foundation` | PASS / 0 | 1 | Five structured task criteria have candidate-bound check evidence. |
| `node scripts/control-plane/validate-closeout-cli.mjs --phase 1` | PASS / 0 | 1 | Closeout manifest, snapshot, candidate and independent lanes reconcile. |

No credentials were present. No credential-backed OpenRouter or Alpaca qualification was attempted. No live rung is claimed.

## Review, verifier and evaluator evidence

- Review: PASS for candidate `fe02735524ddb090e021f58eb38360054dc6b6e7f7a4991c73a87963c1542999`; `verification/control-plane/tasks/phase1-runtime-foundation/review.fe02735524ddb090e021f58eb38360054dc6b6e7f7a4991c73a87963c1542999.json`.
- Security review: PASS for the same candidate; `security-review.fe02735524ddb090e021f58eb38360054dc6b6e7f7a4991c73a87963c1542999.json`.
- Verifier: PASS, independent offline and live runtime checks; Rung 1; `verifier.fe02735524ddb090e021f58eb38360054dc6b6e7f7a4991c73a87963c1542999.json`.
- Evaluator: PASS for task criteria and phase criteria P01-C01/P01-C02; `evaluation.fe02735524ddb090e021f58eb38360054dc6b6e7f7a4991c73a87963c1542999.json`.

## Acceptance criteria

- **P01-C01 — PASS.** Fresh documented local setup, configuration validation, real schema initialization, PAPER startup identity, truthful health/status and absence of trading routes were observed. Evidence: runtime check, offline check and independent verifier record above.
- **P01-C02 — PASS.** Credential-free offline verification succeeded; Alpaca/OpenRouter remained `not_configured`, and no provider/live qualification was represented as successful. Evidence: offline check and independent verifier record above.

## ADRs / assumptions introduced

No ADR or charter change. The local database uses trust authentication only inside the disposable Compose container; its port is bound to loopback and its data directory is tmpfs. The synthetic fixture is explicitly labeled and makes no external provider calls.

## Known limitations and blockers

This phase delivers only the application foundation. The local service and database are running for observation. Credential-backed provider connectivity has not been qualified and remains `not_configured` in this environment.

## Deferred work

Subsequent phases must add broker/account and historical market fixtures, deterministic decision construction, AI decision stages, deterministic risk and simulated/Alpaca PAPER execution, bounded orchestration, positions/orders/exposure and trace inspection, controllable time, failure injection, historical replay and expected-versus-observed assertions. This report does not claim those requested runtime test-surface capabilities are complete.
