# Orchestration Contracts

Load only when handing work to a sibling skill/subagent or when a required dependency is unavailable.

## Shared handoff envelope

Pass only evidence needed for the delegated job:

- repository root and active phase id/goal path;
- charter path and the specific invariant/criterion in scope;
- baseline ref plus relevant dirty paths;
- intended slice or review target;
- relevant files/symbols and known pre-existing failures;
- exact question or acceptance evidence requested;
- explicit write/side-effect boundary.

Do not pass an implementer's success claim as fact. Distinguish observation from inference.

## Read-only discovery agents

### `phase_mapper`

Ask for repository facts that decide slice scope: execution path, current implementation status, relevant tests/migrations, and conflicts with the active goal. Return evidence with file/symbol references plus unresolved uncertainty. No edits and no implementation plan beyond boundary-relevant observations.

### `provider_researcher`

Use only when version-sensitive external behavior can change implementation correctness. Ask for current authoritative provider/framework evidence, exact contract details, source links/references, conflicts, and what remains unverified. Repository code remains untouched.

If either agent is unavailable, perform the read-only work in the primary agent; record that parallel/fresh-context discovery was unavailable only when that distinction matters.

## Writer agent

### `implementer`

Give one bounded slice, not an entire phase. Include exclusions and the acceptance checks the writer should run first. The implementer owns overlapping code changes until the slice is handed back. It may not broaden scope, change charter decisions, discard unrelated dirty state, or cross publication/deployment boundaries without separate authorization.

If `implementer` is unavailable after the user explicitly requested subagents, the primary agent may implement only if doing so still honors the user's requested workflow; otherwise report the missing capability. Never spawn a generic child and call it the configured implementer unless its actual applied role is verifiable.

## Independent challenge agents

### `reviewer`

Target: final candidate diff against the baseline plus relevant surrounding code.

Require:

- findings ordered by `BLOCKER`, `MAJOR`, `MINOR`, `NOTE`;
- requirement/invariant and file/symbol evidence for each finding;
- explicit coverage and limitations;
- verdict `PASS`, `PASS_WITH_NOTES`, `FAIL`, or `INCONCLUSIVE`.

A review is not independent if the same write owner performs it. If the configured reviewer is unavailable, the primary agent may self-review but must label the independence requirement unavailable.

### `verifier`

Target: active phase acceptance criteria and charter verification ladder.

Require:

- exact command/procedure;
- exit code/outcome;
- what requirement the evidence supports;
- introduced vs demonstrably pre-existing failure classification when possible;
- skipped/blocked credential-backed checks;
- highest rung actually completed;
- verdict `VERIFIED`, `FAILED`, or `INCONCLUSIVE`.

A verifier may create normal test/build artifacts but does not own production-source edits. If unavailable, existing executed evidence may still support a slice, but do not claim independent verification.

## Sibling skills

### `adr-escalation`

Mandatory at an authority gap. If unavailable, stop at `NEEDS_DECISION`, surface the exact blocked decision and controlling authority, and do not improvise the protected choice.

### `schema-migration`

Use for schema/migration changes. If unavailable, do not silently bypass repository migration policy. Proceed only if the same mandatory migration rules and verification are directly available from authoritative repository instructions; otherwise stop `BLOCKED`/`UNVERIFIED` as appropriate.

### `paper-safety-audit`

Use when the delta can affect PAPER-only enforcement, broker execution boundaries, credentials, or deterministic-vs-AI order authority. If unavailable, do not weaken the safety gate; use authoritative charter/AGENTS requirements only if they are sufficient to run equivalent checks, otherwise stop.

### `verification-ladder`

Owns repository-wide rung selection/execution. If unavailable, the charter itself may be used only when it fully specifies the applicable gates; record the missing workflow dependency and never infer an unexecuted rung.

### `phase-closeout`

Mandatory before phase advancement. If unavailable, leave phase state unchanged, report the slice result, and stop. Do not hand-edit phase advancement as a substitute.

## Freshness rule

Evidence is bound to the state it inspected. After a fix:

- rerun every failed or directly affected check;
- rerun reviewer coverage for materially changed code paths;
- rerun verifier evidence when the change can alter the checked behavior;
- broaden only if the fix changes the risk surface.

Never carry a PASS across a materially changed target without new evidence.
