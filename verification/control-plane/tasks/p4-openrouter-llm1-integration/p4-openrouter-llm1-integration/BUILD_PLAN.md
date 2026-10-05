# BUILD PLAN — Phase 4 OpenRouter LLM1 integration

## Acceptance scope

The default-fail task criteria are `P4-LLM1-REQ`, `P4-LLM1-FAIL`, `P4-LLM1-PERSIST`, `P4-LLM1-SECRET`, and `P4-LLM1-MIGRATION`. They implement Phase 4 P04-C01/P04-C02 and the active goal requirements for bounded validated context, locally validated structured analysis, durable provenance, no order authority, and failure-to-no-action behavior.

## Sequence

1. Keep `src/domain/llm1-analysis.ts` pure: versioned closed output vocabulary, strict local schema, eligible PAPER context validation, integrity hash, bounded deterministic prompt.
2. Add bounded request timeout, completion-token limit, and one-retry policy to the Zod configuration boundary and versioned defaults. Pin the configured credential-bearing endpoint to HTTPS `openrouter.ai` `/api/v1`; tests may inject transport but cannot redirect credentials to another host.
3. Implement `src/infra/openrouter-llm1.ts` with injectable fetch, strict JSON Schema request, provider `require_parameters`, data-collection denial, no tools, bounded AbortSignal timeout, at most one retry for the researched transient classes, sanitized typed errors, validated provider envelope, and local Zod analysis parsing.
4. Implement a service orchestration module to accept only persisted cycle/context IDs, reconstruct and verify the stored Phase 3 context, call the adapter, persist every attempt, and return a discriminated success or terminal no-action result. The model has no broker/order dependency.
5. Add `src/infra/stage-run-store.ts`, append-only migration `0006_llm1_stage_provenance.sql`, and matching Drizzle fields for stage version, requested/resolved model and provider, fingerprint, normalized input reference, latency, token counts, reported cost, attempt identity/state, output, and typed failure. Apply additively without resetting existing local data.
6. Add hermetic adapter/service and persistence tests. Exercise success, malformed envelopes and content, unsupported structured output, timeout, retry ceiling, non-retryable 4xx, exhausted credits, redaction, and stored success/failure provenance with injected transports and synthetic data only.

## Verification

Run targeted typecheck/tests first. Then use the task-scoped `verify-command.mjs`, update each criterion only from its numeric check record, run the repository offline suite/PAPER-only/no-live-route guards, and run the additive migration against the available local PostgreSQL state without resetting it. No credential-backed call is needed for this task; do not label fake-transport evidence as live qualification.

## Safety constraints and limits

- Preserve PAPER-only and secrets rules. Do not add tools, tool choice, broker calls, order parameters, or browser access.
- Never persist authorization headers, secrets, or unredacted provider error bodies. Only store bounded sanitized metadata and locally parsed output.
- Provider compatibility and live response shape remain unobserved; unsupported provider routing is a typed terminal no-action failure.
- The existing `verification/phase-reports` and `docs/runbook.md` are outside this assignment; the latter overlaps a preserved Phase 3 worktree assignment.
