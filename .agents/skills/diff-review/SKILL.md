---
name: diff-review
description: Review an implementation Git diff against the active phase or goal and repository invariants, producing evidence-backed findings before phase closeout. Use after a coherent implementation slice or when asked to review the current, staged, or commit diff. Not for fixes, phase closeout, or independent verification.
---

# Diff Review

Review the implementation delta, not the implementer's narrative. Treat Git evidence and current repository authority as the source of truth.

## Boundary

Operate read-only. Do not edit, stage, commit, push, advance phase state, or repair findings during this review. If the user also wants fixes, finish and report the review first; implementation is a separate action boundary.

This skill owns implementation-diff adjudication. It does not replace `verification-ladder`, `phase-closeout`, `research-external-contract`, or `adr-escalation`. Use evidence from those workflows when available and route unresolved issues to them rather than silently absorbing their work.

## 1. Establish authority and exact scope

1. Read the applicable `AGENTS.md` instruction chain and the repository artifacts that define the requested implementation target. In this control plane, use `docs/PROJECT_CHARTER.md`, `docs/control-plane/phase-state.json`, the active phase goal, and the previous phase report when it materially constrains the change.
2. Determine the review baseline from explicit task/phase evidence. Prefer an explicit user ref, then a recorded implementation baseline. For a pure working-tree review with no other baseline, `HEAD` is the baseline. Never invent a baseline for already-committed work.
3. Resolve the target diff mechanically. Use `scripts/collect-review-scope.mjs` relative to this `SKILL.md` when available; if it is unavailable, use equivalent read-only Git commands and record the exact refs/paths inspected:
   - `node <skill-dir>/scripts/collect-review-scope.mjs --worktree`
   - `node <skill-dir>/scripts/collect-review-scope.mjs --base <ref> [--head <ref>]`
   - add `--worktree` with `--base <ref>` to include the current tracked/untracked working tree.
4. Inspect the actual patch for every changed path. Every path in scope must be reviewed or explicitly excluded with a reason.

Completion criterion: the authority chain, baseline, target delta, changed paths, and any unrelated dirty state are explicit. If the resolved scope contains no implementation delta, report `UNVERIFIED` with no reviewable delta rather than inferring success. If the baseline is ambiguous, required authority is missing, or unrelated changes cannot be isolated safely, stop with `NEEDS_DECISION` or `BLOCKED` rather than reviewing a guessed scope.

## 2. Build the obligation map

Map the diff to:

- the user's requested behavior;
- active phase acceptance criteria;
- applicable charter and `AGENTS.md` invariants;
- changed public contracts, persisted state, migrations, recovery semantics, and tests.

Load only the applicable sections of `references/review-lenses.md`; use its trigger labels to avoid irrelevant checklist review.

Completion criterion: every acceptance criterion and every materially changed behavior has either review evidence or an explicit `UNVERIFIED` limitation.

## 3. Review behavior, not style

Read enough surrounding code, callers, tests, schemas, and state transitions to decide whether the patch behaves correctly. Prefer concrete failure paths over hypothetical style concerns.

A finding requires all four:

1. a violated obligation or incorrect behavioral claim;
2. precise file plus line/symbol evidence;
3. a realistic consequence or failing scenario;
4. a correction direction narrow enough to be actionable without implementing it.

Classify only supported findings:

- `BLOCKER`: violates an architectural/safety invariant, enables forbidden effects, risks secret/data corruption, changes the wrong phase, or makes acceptance unsafe.
- `MAJOR`: materially incorrect or incomplete behavior, recovery, persistence, contract handling, or test coverage likely to invalidate an acceptance criterion.
- `MINOR`: bounded correctness/maintainability defect with limited impact that does not invalidate phase acceptance by itself.
- `NOTE`: non-blocking observation or evidence limitation; not a disguised style preference.

Do not promote uncertainty into a defect. Mark material uncertainty `UNVERIFIED` and state what evidence would resolve it.

## 4. Adjudicate evidence

Treat tests present in the diff as code, not execution evidence. Credit a check only when its command and outcome are actually available from the current run or trustworthy implementation evidence. A previously failing check remains failed until the exact relevant check is shown passing.

Do not broaden the review into the repository verification ladder. Run a narrow, non-mutating command only when it is necessary to resolve a specific review ambiguity and runtime policy permits it; otherwise hand the unresolved claim to the verifier as `UNVERIFIED`.

For pre-existing failures, require comparable baseline evidence before concluding the diff introduced or fixed them. Missing credentials, live market conditions, provider access, or other unavailable prerequisites never become simulated success.

Completion criterion: each material conclusion is tied to inspected diff/code evidence or explicitly identified execution evidence, and missing evidence is visible.

## 5. Return the review

Order findings by severity, then provide coverage and status. Use this shape:

```text
Findings
- [SEVERITY] path:line-or-symbol — concise defect
  Obligation: ...
  Evidence: ...
  Consequence: ...
  Direction: ...

Coverage
- baseline / target
- changed paths reviewed; exclusions with reasons
- acceptance criteria assessed
- tests or verification evidence actually observed

Review status: COMPLETE | FAILED | BLOCKED | UNVERIFIED | NEEDS_DECISION
Reason: ...
```

Status rules:

- `FAILED`: at least one confirmed `BLOCKER` or `MAJOR` finding remains.
- `BLOCKED`: required repository evidence/tooling cannot be accessed, so the review itself cannot be completed.
- `UNVERIFIED`: review work is complete, but material correctness/acceptance depends on missing evidence.
- `NEEDS_DECISION`: the baseline, authority, architecture, or requested behavior has a consequential unresolved conflict.
- `COMPLETE`: every in-scope path and material obligation was reviewed, no `BLOCKER`/`MAJOR` remains, and no material evidence gap prevents adjudication. `COMPLETE` means the diff review is complete, not that the phase is closed or a higher verification rung passed.

If there are no findings, say so explicitly; do not manufacture low-value notes to fill the report.
