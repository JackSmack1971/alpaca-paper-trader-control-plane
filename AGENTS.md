# Repository authority and workflow

`docs/PROJECT_CHARTER.md` is the architectural authority. Do not reinterpret or weaken its invariants. If a requested change needs a charter decision, stop the affected work and follow `.agents/skills/adr-escalation/SKILL.md`.

## Immutable safety and authority

- This repository is PAPER-only. No phase may add live trading or a live-order route.
- AI components are advisory and never receive broker order-submission authority; deterministic application code owns PAPER-order decisions.
- Instructions do not grant filesystem, shell, network, credential, broker, provider, Git publication, or deployment authority. Runtime permission controls remain independent.
- Never expose credentials in persistence, fixtures, API responses, logs, or exceptions.

## Project state and workflow

Durable phase state is in `docs/control-plane/phase-state.json`; phase requirements are in `goals/` and `docs/control-plane/phase-contracts.json`; execution snapshots, task evidence, and reports live under `verification/`. The active phase and charter determine scope.

Start with `docs/control-plane/START_HERE.md`. For implementation, use `.agents/skills/execute-phase/SKILL.md`, which selects the smallest active-phase slice and points to the supporting skills. Use `.agents/skills/task-routing/SKILL.md` for workflow selection. The start gate is `validate.mjs`, `preflight.mjs`, then `snapshot-control-plane.mjs`; invoke scripts from the project root. Use `verify-command.mjs` for structured verification records and `.agents/skills/verification-ladder/SKILL.md` to report only checks actually run.

For MCP calls, follow `.agents/skills/mcp-bounds/SKILL.md`. Exact per-tool collection semantics live in `docs/control-plane/capabilities.json`; unknown collection-like operations fail closed. The policy-defined `maximum_page_size` and global `maximum_result_utf8_bytes` bounds live in `docs/control-plane/policy.json` (24,000 UTF-8 bytes maximum).

## Source control and completion

Preserve existing user changes. Git diff defines engineering scope. Do not commit, push, create a PR, merge, release, rewrite history, deploy, or discard changes unless explicitly authorized.

Use `.agents/skills/phase-closeout/SKILL.md` before declaring a phase complete or advancing it. Completion requires evidence-bound reconciliation and successful closeout validation; advance at most one phase. Report `COMPLETE`, `BLOCKED`, `UNVERIFIED`, `NEEDS_DECISION`, or `FAILED` according to evidence. Missing evidence is never a pass.
