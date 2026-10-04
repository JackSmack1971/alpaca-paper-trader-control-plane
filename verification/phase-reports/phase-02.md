# Phase 02 report — ALPACA DATA AND ACCOUNT STATE

- Phase status: COMPLETE
- Charter SHA-256: `8fff9dfd9423c22da6db234e5f7d45f0f6f4414e15c131ba865f3ef7ccc6de5f`
- Goal SHA-256: `5d0734fc88aa5a04ed67cb19a69e6140dd40620cc9b0a99feb8ec11399cc3533`
- Snapshot ID: `6011238f4f62f44b7c74527b6f53980246ac1b049a716b4098b2d5a6a4892e24`
- Candidate ID: `249ee98b44aab2c2d65a0a9430182035e9c080f98a2d5c37a282f5f449ce5d4e`
- Baseline ref/SHA: `codex/ci-control-plane-trust-checks` / `ea9a83e069f1be79c307fd8a9c4b9fca85977409`
- Highest verification rung actually reached: 1

## Functionality implemented

- Added a disposable PostgreSQL development service, migrations, idempotent synthetic seed data, and restart-persistent local runtime snapshots.
- Added credential-free PAPER account and market simulation, bounded reset/replay/virtual-clock controls, deterministic broker/network/rate-limit failure injection, state assertions, and log/trace inspection.
- Routed local historical market replay through an in-memory WebSocket-compatible transport and the production Alpaca market-stream handshake, frame decoder, and accumulator. The transport has a fixed URL/codec allowlist, uses simulation-only placeholder credentials, and cannot open an external connection.
- Preserved the read-only Alpaca PAPER account adapter and startup reconciliation path for credentialed operation. Trade updates remain observations and do not alter canonical account state.

## Files materially changed

`compose.yaml`, `config/default.json`, `fixtures/`, `migrations/`, `package.json`, `scripts/`, `src/api/app.ts`, `src/domain/`, `src/infra/`, `src/main.ts`, `tests/`, and `docs/runbook.md`.

## Migrations introduced

- `0001_initial.sql` — application state schema.
- `0002_paper_mode_correlation.sql` and `0003_paper_mode_cycle_outcomes.sql` — explicit PAPER correlation fields.
- `0004_local_runtime_snapshots.sql` and `0005_bound_local_runtime_snapshots.sql` — bounded, revisioned local restart snapshots.

## Verification evidence

| Command / procedure | Outcome / exit | Rung | Evidence / notes |
|---|---:|---:|---|
| `node scripts/control-plane/validate.mjs` | PASS / 0 | 1 | Source linking passed. |
| TypeScript `tsc --noEmit --project tsconfig.json` | PASS / 0 | 1 | Candidate-bound verifier check. |
| Full Vitest offline suite | PASS / 0 | 1 | 7 files, 74 tests passed. |
| `node scripts/verify-no-live-routes.mjs` | PASS / 0 | 1 | No live-trading route registered. |
| `node scripts/control-plane/check-paper-only.mjs` | PASS / 0 | 1 | PAPER guard scan passed. |
| `tsx scripts/config-check.ts` | PASS / 0 | 1 | PAPER mode reported; provider credentials absent. |
| Synthetic database seed against local PostgreSQL | PASS / 0 | 1 | Idempotent PAPER fixture seed succeeded. |
| `tsx scripts/verify-local-controls.ts` against the running loopback app | PASS / 0 | 1 | Scenario replacement, expected-state comparison, injected failures, logs/traces, and reset passed. |
| `tsx scripts/verify-local-restart.ts` against disposable PostgreSQL | PASS / 0 | 1 | Virtual time, replay cursor, normalized market state, and account state restored after restart. |

## Review, verifier and evaluator evidence

- Independent code review: PASS, candidate `249ee98b…`, record `verification/control-plane/tasks/phase2-local-market-stream-adapter/review.249ee98b44aab2c2d65a0a9430182035e9c080f98a2d5c37a282f5f449ce5d4e.json`.
- Independent security review: PASS, candidate `249ee98b…`, record `verification/control-plane/tasks/phase2-local-market-stream-adapter/security-review.249ee98b44aab2c2d65a0a9430182035e9c080f98a2d5c37a282f5f449ce5d4e.json`.
- Independent verifier: PASS, candidate `249ee98b…`, record `verification/control-plane/tasks/phase2-local-market-stream-adapter/verifier.249ee98b44aab2c2d65a0a9430182035e9c080f98a2d5c37a282f5f449ce5d4e.json`.
- Fresh evaluator: PASS, candidate `249ee98b…`, record `verification/control-plane/tasks/phase2-local-market-stream-adapter/evaluation.249ee98b44aab2c2d65a0a9430182035e9c080f98a2d5c37a282f5f449ce5d4e.json`.

## Acceptance criteria

- **P02-C01 — PASS.** The normalized account and market views, freshness/connection observations, deterministic restart restoration, and PAPER boundaries were exercised through the local runtime checks and candidate-bound offline suite. Credentialed Alpaca reconciliation is implemented but was not exercised without credentials.
- **P02-C02 — PASS.** Offline normalization/recovery and PAPER-only checks passed. No Alpaca credentials or live session were available; rung 1 is the highest authorized verification rung reached and no live qualification is claimed.

## ADRs / assumptions introduced

- No ADR introduced. Local simulated stream authentication is protocol-path simulation only and is not evidence of Alpaca credential authentication.

## Known limitations and blockers

- Alpaca and OpenRouter credentials are absent. No credential-backed account request, market stream, or live PAPER endpoint qualification was run.
- The local market/account fixtures provide deterministic development truth; live broker truth still comes from the credentialed read-only account reconciler.

## Deferred work

- Deterministic decision context, analyst/Jev/critic stages, deterministic risk governance and simulated PAPER order execution, bounded orchestration, dashboard, and hardening remain in later phases.

## Machine closeout manifest

See `phase-02.closeout.json`.
