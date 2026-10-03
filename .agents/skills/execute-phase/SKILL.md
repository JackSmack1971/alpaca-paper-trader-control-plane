---
name: execute-phase
description: >
  Advance exactly the currently active charter phase through one bounded, independently verifiable implementation slice, with control-plane reconciliation, single-writer ownership, risk-scaled verification, fresh review when explicitly requested, and truthful closeout. Use when implementing or continuing the active phase. Do not use for ADR-only decisions, closeout-only work, later-phase preimplementation, or unrelated one-off edits.
---

# Execute Active Phase

Advance the phase named by `docs/control-plane/phase-state.json` by **one smallest coherent slice**. A successful slice is not automatically a completed phase.

## 1. Reconcile authority and baseline

Read the active instruction chain, `docs/PROJECT_CHARTER.md`, phase state, the active goal, the previous phase report when present, then relevant Git status/diff, migrations/schema, code, and tests.

Run `node scripts/control-plane/preflight.mjs`. Stop on a charter-digest mismatch, malformed phase state, multiple/no active phases, missing active goal, or non-evidence dirty state whose ownership is unsafe. The Node preflight uses the same canonical utility layer as every lifecycle command.

Run `node scripts/control-plane/snapshot-control-plane.mjs` and retain the emitted snapshot artifact path for candidate freezing and closeout. This snapshot is project-source provenance and does not depend on live Codex qualification. Runtime qualification is optional diagnostics. The snapshot is immutable for that execution attempt; changing a control-plane authority source requires a new snapshot.

Record the baseline ref and dirty paths. Preserve unrelated user work. If prospective edits overlap pre-existing changes and ownership cannot be established safely, return `BLOCKED` rather than absorbing or reverting them.

**Done:** active authority, baseline, dirty state, and relevant current implementation are established from repository evidence.

## 2. Select one independently verifiable slice

Reconcile what is already complete, partial, blocked, or stale. Finish an authoritative partial slice before downstream work.

Choose the smallest delta that advances an active-phase completion criterion, has observable verification, preserves charter invariants, and does not pre-implement a later phase.

Use `$task-routing` to choose single-agent or delegated work. Parallelize independent read-heavy work only; stay within repository concurrency limits and wait for discovery before writing. Every delegated/background task runs from a separate `.codex/worktrees/` checkout; otherwise do discovery in the primary agent.

**Done:** one intended delta and its acceptance evidence are explicit, with no unresolved discovery conflict changing the boundary.

## 3. Gate authority, then assign one writer

Proceed with bounded engineering judgment only when existing authority permits the choice. If implementation would change/reinterpret a protected invariant, establish a materially consequential unresolved architecture/security/data/compatibility behavior, or require authority not granted, use `adr-escalation` and stop the affected path at `NEEDS_DECISION`. Missing facts require safe evidence gathering, not automatic escalation.

There is one writer for overlapping code: `implementer` when subagents were explicitly requested; otherwise the primary agent. Give the writer the baseline, intended delta, acceptance criterion, protected invariants, dirty-path exclusions, and focused checks.

Use branch-specific sibling skills instead of restating their policy:

- persistence/schema delta -> `schema-migration`;
- PAPER-safety/execution-authority delta -> `paper-safety-audit`.

Read `references/orchestration-contracts.md` only when handing work to a sibling/subagent or handling an unavailable dependency.

Delegation never authorizes commit, push, PR, merge, release, deployment, destructive cleanup, or another external boundary.

**Done:** the diff is owned by one writer, remains inside the selected slice, and preserves unrelated work.

## 4. Build falsifiable verification evidence

Run the narrowest checks that can disprove the changed behavior first. A failed check stays failed until the relevant check is rerun successfully.

Then use `verification-ladder` for the highest charter rung actually available. Distinguish passing evidence, introduced failures, demonstrably pre-existing unrelated failures, blockers, and unexecuted checks. Never replace unavailable live qualification with a mock or expose credentials.

If a pre-existing failure blocks attribution, establish a safe baseline when possible. Continue only if the slice can still be verified independently; otherwise return `UNVERIFIED` or `BLOCKED` according to the evidence.

**Done:** the delta has executed evidence and the highest reached verification rung is known without inference.

## 5. Independently challenge stable evidence

Freeze the candidate first with `node scripts/control-plane/candidate-id.mjs --snapshot <snapshot-artifact> --out verification/control-plane/candidates/current.json`. Then, when subagents were explicitly requested, spawn `reviewer` and `verifier` only after the candidate diff and primary evidence are stable. They may run in parallel because neither owns production-code changes. The reviewer inspects the actual diff and surrounding code; the verifier independently executes acceptance evidence. Neither may treat the implementer's summary as proof.

Require reviewer and verifier outputs to name the exact `candidate_id`. Adjudicate findings against source, diff, and executed evidence. Route fixes through the one writer. A material post-review change invalidates affected review/verification evidence; rerun the smallest stale lane, broadening only if the risk surface changed.

If an isolated reviewer, verifier, or evaluator is required but unavailable, follow the fallback contract and do not label a primary-agent self-check as independent review/verification. Evaluators receive the requirements, candidate/source, and structured verification records only; do not pass builder transcripts, reasoning, or raw logs.

**Done:** no unresolved finding or stale evidence contradicts the slice completion claim.

## 6. Close the phase only when the phase is actually complete

Invoke `phase-closeout` only when repository evidence shows the **phase**, not merely this slice, satisfies its completion contract. That skill owns the evidence report and controlled one-phase advancement.

If the phase is not complete, leave durable phase state unchanged and stop after the slice. Never pre-implement the next phase to extend the session.

Report separately:

- **Session result:** exactly one of `COMPLETE`, `BLOCKED`, `UNVERIFIED`, `NEEDS_DECISION`, `FAILED`.
- **Durable phase state:** the state actually observed after the run. `COMPLETE` means this slice succeeded; it means phase completion only when `phase-closeout` recorded the transition.

Final handoff contains only: what changed/determined; files changed; commands/checks actually executed with outcomes; blockers, unresolved decisions, or unverified behavior.

## Mandatory stops

Stop the affected path rather than improvise when control-plane state is inconsistent; protected authority is missing; material external behavior remains unresolved; work belongs to a later phase; dirty-state ownership is unsafe; a required check cannot be resolved inside the slice; a required verification/closeout dependency is unavailable without equivalent authoritative evidence; or an irreversible/external action lacks explicit authorization.
