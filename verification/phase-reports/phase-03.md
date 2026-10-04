# Phase 3 report — Deterministic Decision Context

- Phase status: COMPLETE
- Charter SHA-256: `8fff9dfd9423c22da6db234e5f7d45f0f6f4414e15c131ba865f3ef7ccc6de5f`
- Goal SHA-256: `6994c477d06bb54944d4079803cb59b335e68da698fc164cd864609f6424ccbb`
- Snapshot ID: `2adc274e8e44b88c588480d92a8efbb234633151f7fe729c207a37393ac08b7b`
- Candidate ID: `fea16c92c49b389d4e2f9b3e269b52b49f8ad887ca9843dce227f8f2cfcdf2d9`
- Baseline ref/SHA: `codex/runtime-observation-bootstrap` / `d46ebbaa4a50e757354b5e568401f2fea906db87`
- Highest verification rung actually reached: 1

## Functionality implemented

Phase 3 now builds deterministic, bounded single-symbol decision contexts from validated normalized market and account snapshots. Market freshness accounts for producer stale markers, receive age, and source-event age. Derived prices and trend comparisons use scale-aware integer decimal arithmetic. Missing inputs stay null with structured reasons; supplied capability data carries source provenance. Contexts are immutable by cycle identity, persisted source inputs replay to the same canonical hash, and output stays within the tested 4,000-byte upper bound. Local scenario mutation routes enforce loopback Host and same-origin checks for browser requests.

PAPER-only restrictions remain in force. The context layer has no order authority, AI invocation, or live-order route.

## Files materially changed

- `docs/runbook.md`
- `src/api/app.ts`
- `src/domain/decision-context.ts`
- `tests/decision-context.test.ts`
- `tests/local-test-harness.test.ts`

## Migrations introduced

None.

## Verification evidence

| Command / procedure | Outcome / exit | Rung | Evidence / notes |
|---|---:|---:|---|
| `node scripts/control-plane/validate.mjs` | PASS / 0 | 1 | Control-plane source validation passed. |
| `node scripts/control-plane/preflight.mjs` | READY / 0 | 1 | Active phase 3, HEAD `d46ebba`, no dirty non-evidence paths. |
| `node scripts/control-plane/snapshot-control-plane.mjs` | PASS / 0 | 1 | Snapshot `2adc274e8e44b88c588480d92a8efbb234633151f7fe729c207a37393ac08b7b`. |
| `node scripts/control-plane/candidate-id.mjs --snapshot verification/control-plane/snapshots/2adc274e8e44b88c588480d92a8efbb234633151f7fe729c207a37393ac08b7b.json --task-id phase3-decision-context` | PASS / 0 | 1 | Structured check `candidate-freeze-fea16`; candidate ID matched. |
| `corepack.cmd pnpm verify:offline` | PASS / 0 | 1 | Typecheck, 89 tests across 8 files, config check, PAPER-only guard, and no-live-route checks passed; `checks/verifier-fea16-offline-junction.json`. |
| `corepack.cmd pnpm verify:decision-context` | PASS / 0 | 1 | Loopback app with existing healthy loopback PostgreSQL; 3 synthetic events replayed, canonical hash matched, repeat persistence was idempotent, missing data stayed explicit, changed input conflicted with 409; `checks/verifier-fea16-persisted-replay.json`. The verifier's documented reset applied only to its synthetic local fixture scenario. The app process was stopped and the PostgreSQL container was left running. |
| Independent review, security review, verification, and evaluation | PASS | 1 | All four role records bind candidate `fea16c92…`, task `phase3-decision-context`, and bundle `ad722e27…`; see candidate-specific task artifacts. |
| `node scripts/control-plane/validate-test-results.mjs --task-id phase3-decision-context` | PASS / 0 | 1 | All 7 task acceptance records have successful structured evidence. |
| `node scripts/control-plane/validate-closeout-cli.mjs --phase 3` | PASS / 0 | 1 | Closeout manifest reconciles with the current candidate and evidence. |

Initial verifier attempts in isolated worktrees recorded missing-dependency and unavailable-local-app failures. Those records remain preserved; the dependency junction, full offline suite, and PostgreSQL-backed replay were subsequently rerun successfully. No credential-backed OpenRouter or Alpaca check was run; those checks are not required for Phase 3.

## Review, verifier and evaluator evidence

- Review: PASS, `verification/control-plane/tasks/phase3-decision-context/review.fea16c92c49b389d4e2f9b3e269b52b49f8ad887ca9843dce227f8f2cfcdf2d9.json`.
- Security review: PASS, `verification/control-plane/tasks/phase3-decision-context/security-review.fea16c92c49b389d4e2f9b3e269b52b49f8ad887ca9843dce227f8f2cfcdf2d9.json`.
- Verifier: PASS, `verification/control-plane/tasks/phase3-decision-context/verifier.fea16c92c49b389d4e2f9b3e269b52b49f8ad887ca9843dce227f8f2cfcdf2d9.json`.
- Evaluation: PASS for `P03-C01`, `verification/control-plane/tasks/phase3-decision-context/evaluation.fea16c92c49b389d4e2f9b3e269b52b49f8ad887ca9843dce227f8f2cfcdf2d9.json`.

## Acceptance criteria

| Criterion | Disposition | Evidence |
|---|---|---|
| P03-C01 | PASS | Independent evaluation and candidate-bound verifier record: persisted replay matched, numeric/freshness/missingness checks passed, provenance was reconstructable, the context stayed bounded, and PAPER/no-order-authority safeguards passed. |

## ADRs / assumptions introduced

No ADRs. Local test mode continues to trust direct local processes and originless non-browser loopback clients. It is constrained to loopback hosts and rejects configured Alpaca/OpenRouter credentials; the security review treats this as the intended local developer trust boundary.

## Known limitations and blockers

No Phase 3 blockers remain. No credential-backed provider qualification was performed, and no live qualification is claimed.

## Deferred work

OpenRouter model stages, Jev integration, deterministic risk, execution, orchestration, and dashboard work remain in their later charter phases.

## Machine closeout manifest

See `verification/phase-reports/phase-03.closeout.json` (schema version 3).
