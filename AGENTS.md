# Repository engineering policy

This repository is governed by `docs/PROJECT_CHARTER.md`. The charter is the architectural authority for the application. Do not reinterpret or weaken a charter invariant during implementation. If a requested change conflicts with it, stop the affected implementation, use the `adr-escalation` workflow, and surface the operator decision required.

## Ownership and authority

- Instructions influence engineering behavior; they do not grant filesystem, shell, network, credential, broker, model-provider, Git publication, or deployment authority.
- Runtime permission and approval controls remain independent of this file.
- AI components in the application are advisory. They never receive broker order-submission authority. Deterministic application code is the final PAPER-order authority.
- PAPER trading is permanent. No phase may add a live-trading mode, endpoint selector, or live-order route.

## Before editing

At task intake, treat requests to fix an existing failure, regression, or error trace as debugging tasks and register them before editing source. Follow `docs/control-plane/causal-debugging.md`: reproduce the exact reported error before source edits, keep each causal change scoped, and rerun reproduction before another edit. Hook enforcement is bounded by the Codex PreToolUse payload and is not an OS filesystem sandbox.

For every implementation task:

0. Run the control-plane start gate from `docs/control-plane/START_HERE.md`; implementation requires passing static validation, a clean preflight, and an immutable execution snapshot. Live Codex runtime qualification is optional diagnostics, not an implementation or closeout gate.
1. Read `docs/PROJECT_CHARTER.md`.
2. Read `docs/control-plane/phase-state.json` and only work on the active phase unless the user explicitly changes scope.
3. Read the active `goals/phase-XX-*.md` file and the previous phase report when one exists.
4. Inspect `git status --short`, the relevant diff, current migrations/schema, and nearby implementation/tests.
5. Preserve all pre-existing user changes. Never absorb unrelated dirty state.
6. Identify the smallest coherent change that advances the active phase.

## Fixed engineering constraints

- TypeScript 5.x, Node.js 22 LTS, ESM, strict mode, pnpm with committed lockfile.
- Zod validates configuration, persisted records, AI outputs, and external payloads.
- PostgreSQL 16 + Drizzle ORM; applied migrations are append-only and must never be edited.
- Fastify is the HTTP server. SSE is the default dashboard realtime transport unless evidence requires an ADR.
- Vitest covers unit/integration behavior. Playwright is reserved for dashboard/browser behavior.
- Persist timestamps in UTC/`timestamptz`. Use decimal-safe/`NUMERIC` handling for money, quantities, P&L, and exposure.
- Keep `src/domain/` pure. External I/O and credentials belong in `src/infra/`; orchestration/risk/execution in `src/services/`; HTTP/SSE contracts in `src/api/`.
- Never serialize secrets into persistence, fixtures, API responses, dashboard state, logs, or exceptions.

## Unit of work

Treat one active phase as the outer unit of work and implement it through small coherent slices. Do not start later-phase features early merely because they are easy. A slice must have an immutable execution snapshot, known clean Git baseline, intended delta, frozen candidate identity, executed verification evidence, and an explicit completion/blocker state.

Before task execution, apply `$task-routing` to select the smallest sufficient workflow. Routine syntax corrections, documentation additions, dependency updates, and sequential same-file edits stay single-agent. Do not use a fixed multi-agent count. Use `$mcp-bounds` for MCP calls; list/search/database/log calls require a filter and page size no greater than the policy-defined `maximum_page_size`, and MCP result payloads are capped at the policy-defined `maximum_result_utf8_bytes` (24,000 UTF-8 bytes) in `docs/control-plane/policy.json`. For delegated/background work, create a dedicated Git worktree under `.codex/worktrees/` with `node scripts/control-plane/create-worktree.mjs`; do not run those tasks in the user's active checkout. Preserve existing local changes and do not silently copy them into a new worktree.

When routing selects subagents, use the project roles and the `execute-phase` Skill:

read-only mapping/research -> synthesis barrier -> one implementation owner -> candidate freeze -> deterministic validation -> fresh reviewer + verifier -> fresh evaluator -> primary adjudication.

Parallelize independent reasoning, not overlapping writes. Child agents should not recursively create a worker tree. Evaluators receive only the original requirements, frozen candidate/source, and structured verification records; never provide builder transcripts, reasoning, or raw builder logs. Reviewer, verifier, and security-auditor roles are read-only. Security-sensitive, architectural, or functional-correctness reviews must use isolated contexts and read-only permission profiles.

## External contracts and research

For provider/framework behavior that can change, verify the current official documentation before coding. Prefer official API documentation, official SDK/changelog evidence, and authorized observed behavior over recollection. Record materially important findings under `docs/research/`. If official sources conflict and the contract affects correctness, do not guess; record the conflict and qualify the authorized PAPER endpoint when the charter permits it.

Provider credentials may be used only through the authorized runtime and application infrastructure. Never commit or echo them.

## Verification

Use the charter's verification ladder and report only checks that actually ran.

- Rung 0: complete hermetic fixture-backed automated tests.
- Rung 1: typecheck, lint, tests, migrations/schema checks, PAPER-only guards, secret-leak guards, configuration verification.
- Rung 2+: credential-backed OpenRouter/Alpaca/live PAPER qualification only when the required credentials and conditions actually exist.

Rungs 0 and 1 must not require credentials. Missing credentials or market conditions are `BLOCKED`/`SKIPPED`, never simulated live success.

A failed check stays failed until the exact relevant check is rerun and passes. Do not weaken tests to obtain a green result.

## Source control

Git diff is authoritative for engineering change scope. Stage deliberately. Do not commit, push, create a PR, merge, release, rewrite history, or discard user changes unless the active task explicitly authorizes that boundary. Prefer separate worktrees for genuinely independent concurrent implementation; otherwise use one writer.

## Phase closeout

Before declaring a phase complete, use the `phase-closeout` Skill. Closeout must bind the current snapshot, goal and candidate identities and pass machine reconciliation before advancement. Live Codex qualification is optional evidence, not a gate. The report must record functionality, materially changed files, migrations, commands actually executed and outcomes, the highest verification rung actually reached, ADRs/assumptions, and blockers/limitations. Only then may `docs/control-plane/phase-state.json` advance to the next phase.

## Completion language

Distinguish `COMPLETE`, `BLOCKED`, `UNVERIFIED`, `NEEDS_DECISION`, and `FAILED`. Never turn missing evidence into a pass.
