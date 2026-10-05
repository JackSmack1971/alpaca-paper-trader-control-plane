# Phase 4 report — OpenRouter LLM1 Market Analyst

- Phase status: COMPLETE
- Charter SHA-256: `8fff9dfd9423c22da6db234e5f7d45f0f6f4414e15c131ba865f3ef7ccc6de5f`
- Goal SHA-256: `77fd04ca7707e324502dc955fce0cfc0fab9a3abdd0c21f735d3961cc171b6e9`
- Snapshot ID: `4434967eefd29ceb268e253cf196293fb33591b22322378b99f93d333fb8c16f`
- Candidate ID: `650102a056c7b9dd2b2c12a0664b4e76497d0cbecd1109543bd2a54ec874ff97`
- Baseline ref/SHA: `codex/runtime-observation-bootstrap` / `6eb3a74b966d79c77ed64b1e5d16197f5f6c05be`
- Highest verification rung actually reached: 1

## Functionality implemented

LLM1 now accepts only a persisted Phase 3 context identified by cycle and decision-context IDs, replays and verifies that context before inference, and refuses ineligible input. The prompt and output are versioned and bounded. OpenRouter requests are pinned to the official HTTPS endpoint, require provider parameter support, request strict JSON Schema output, expose no tools, and use a bounded timeout with at most one retry. The adapter locally validates analysis, credential echoes, provider metadata, and an explicit `stop` finish reason. Failures become typed no-action outcomes.

Each attempt is persisted before another retry can begin. The additive stage-run migration and matching Drizzle schema preserve provider generation/model provenance, usage, cost, latency, normalized input reference, validated output or typed failure, and sanitized evidence. A loopback database check exercised injected fake success and HTTP 402 responses; it did not reset existing state. The database received two synthetic stage-run records.

## Files materially changed

- `config/default.json`, `package.json`
- `docs/research/phase-04/openrouter-llm1-chat-completions.md`
- `migrations/0006_llm1_stage_provenance.sql`
- `scripts/verify-llm1-stage.ts`
- `src/domain/config.ts`, `src/domain/llm1-analysis.ts`
- `src/infra/config.ts`, `src/infra/db/schema.ts`, `src/infra/openrouter-llm1.ts`, `src/infra/stage-run-store.ts`
- `src/services/llm1-stage.ts`
- `tests/config.test.ts`, `tests/llm1-analysis.test.ts`, `tests/llm1-stage.test.ts`, `tests/openrouter-llm1.test.ts`, `tests/stage-run-store.test.ts`

## Migrations introduced

`migrations/0006_llm1_stage_provenance.sql` additively extends `stage_runs`, backfills existing rows, and adds integrity constraints/indexes. The migration applied and reran successfully against the existing loopback PostgreSQL database without resetting it.

## Verification evidence

| Command / procedure | Outcome / exit | Rung | Evidence / notes |
|---|---:|---:|---|
| `node scripts/control-plane/validate.mjs`, `preflight.mjs`, and research artifact validator via structured `source-gates-final` | PASS / 0 | 1 | Source validation passed; preflight reported READY; external-contract artifact validated. See `verification/control-plane/tasks/p4-openrouter-llm1-integration/checks/source-gates-final.json`. |
| TypeScript `tsc --noEmit` via `typecheck-release` | PASS / 0 | 1 | `checks/typecheck-release.json`. |
| Full Vitest suite via `full-tests-release` | PASS / 0 | 1 | 12 files, 110 tests passed; `checks/full-tests-release.json`. |
| PAPER-only and no-live-route guards via `safety-guards-final` | PASS / 0 | 1 | `checks/safety-guards-final.json`. |
| Additive migration rerun with loopback `DATABASE_URL` | PASS / 0 | 1 | Existing schema current; `checks/additive-migration-rerun.json`. |
| Persisted runtime verification with loopback PostgreSQL and injected fake OpenRouter responses | PASS / 0 | 1 | Exactly two correlated attempts persisted: success and 402-to-no-action; no live provider call; `checks/persisted-runtime-release.json`. |
| Post-diff classification and all required lane records | PASS / 0 | 1 | High-risk classification matched; review, security-review, verifier, and evaluation records bind the same candidate; `checks/post-diff-classification.json`, `checks/required-lanes-verified.json`. |
| Task acceptance validation | PASS / 0 | 1 | All seven task criteria have valid evidence; `checks/acceptance-validation.json`. |
| Independent review, security review, verifier, and evaluation | PASS | 1 | Candidate-bound records are stored in the task bundle under candidate `650102a0…`. |

No credential-backed OpenRouter or Alpaca verification was run. The tests and synthetic database verification do not claim live provider compatibility or live qualification.

## Review, verifier and evaluator evidence

- Review: PASS — `verification/control-plane/tasks/p4-openrouter-llm1-integration/review.650102a056c7b9dd2b2c12a0664b4e76497d0cbecd1109543bd2a54ec874ff97.json`.
- Security review: PASS — `verification/control-plane/tasks/p4-openrouter-llm1-integration/security-review.650102a056c7b9dd2b2c12a0664b4e76497d0cbecd1109543bd2a54ec874ff97.json`.
- Verifier: PASS — `verification/control-plane/tasks/p4-openrouter-llm1-integration/verifier.650102a056c7b9dd2b2c12a0664b4e76497d0cbecd1109543bd2a54ec874ff97.json`.
- Evaluation: PASS for `P04-C01` and `P04-C02` — `verification/control-plane/tasks/p4-openrouter-llm1-integration/evaluation.650102a056c7b9dd2b2c12a0664b4e76497d0cbecd1109543bd2a54ec874ff97.json`.

## Acceptance criteria

| Criterion | Disposition | Evidence |
|---|---|---|
| P04-C01 | PASS | Candidate-bound verifier and evaluator confirm bounded eligible PAPER context, versioned locally validated analysis, persisted provenance/usage, and no order authority. |
| P04-C02 | PASS | Candidate-bound verifier and evaluator confirm deterministic timeout, retry, malformed/unsupported output, non-retryable failure, and terminal no-action coverage. |

## ADRs / assumptions introduced

No ADRs. The configured model identifier must use a bounded provider/model form, and the default analysis model remains unset until configured. Provider responses are screened for literal echoes of the configured OpenRouter key before parsed analysis or response metadata is returned or persisted.

## Known limitations and blockers

No Phase 4 blockers remain. Live OpenRouter model/provider compatibility is unqualified because no credential-backed request was run. The verifier used fake transport only and is not live qualification.

## Deferred work

Jev structured decisions, LLM2 review, deterministic risk and PAPER execution, orchestration, operator dashboard, and Phase 10 replay/calibration/qualification remain in later phases.

## Machine closeout manifest

See `verification/phase-reports/phase-04.closeout.json` (schema version 3).
