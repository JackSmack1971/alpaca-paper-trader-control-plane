# Development workflow

## Governed lifecycle

```text
intent
  -> static validation + clean preflight
  -> immutable execution snapshot
  -> map/research
  -> synthesis barrier
  -> one implementation owner
  -> candidate freeze
  -> deterministic verification
  -> reviewer + verifier
  -> fresh evaluator
  -> evidence-bound closeout
  -> one phase transition
```

Fine-grained session states may be tracked conversationally; `phase-state.json` records only durable phase state.

## Start gate

Run, in order:

```text
node scripts/control-plane/validate.mjs
node scripts/control-plane/preflight.mjs
node scripts/control-plane/snapshot-control-plane.mjs
```

Static validation proves repository source coherence. Preflight requires a coherent active phase and clean non-evidence Git baseline. The execution snapshot is generated from checked-in project authority and does not require a running Codex executable or live runtime probes. Runtime qualification remains an optional diagnostic.

## Execution

Apply `$task-routing` before work. For non-routine tasks, save the fast router's intake JSON and run `route-task.mjs`; its decision records the selected roles and creates a default-fail `test-results.json` for high-complexity/high-radius work. Keep ordinary edits single-agent. When delegation or background execution is selected, create a separate worktree beneath `.codex/worktrees/` using `create-worktree.mjs`, launch the task there, and give each writer a non-overlapping scope. `worktree-assignment.mjs` checks the shared registry; release finished ownership with `--release <assignment-id>`. Read-only research returns a structured `RESEARCH.md` handoff before a builder starts.

## Candidate freeze

After implementation and primary checks stabilize:

```text
node scripts/control-plane/candidate-id.mjs --snapshot verification/control-plane/snapshots/<id>.json --out verification/control-plane/candidates/current.json
```

Candidate identity binds the snapshot baseline, current HEAD, binary tracked diff, and non-evidence untracked file content. Review, verification, evaluation and closeout must name this same ID. Evidence artifacts under `verification/control-plane/` and `verification/phase-reports/` are excluded from engineering candidate identity so recording runtime, review, and closeout evidence does not recursively mutate the candidate. Those artifacts are validated independently by their own identities and schemas.

## Independent evidence

Reviewer and verifier run against the frozen candidate. A fresh evaluator then answers only whether that exact candidate satisfies that exact goal under that exact snapshot using admissible evidence. A material engineering change invalidates the candidate ID and stale lanes must be rerun.

## Closeout

`phase-closeout` produces the human report and schema-v3 machine manifest. `validate-closeout-cli.mjs` recomputes candidate identity, reconciles snapshot/goal/charter provenance, requires the exact machine criteria in `phase-contracts.json`, and requires PASS evidence from reviewer, verifier and evaluator. Only then can `advance-phase.mjs` move one phase.

## Bounded tool results

For MCP calls, use a selective filter and an explicit page size/cursor for list, search, database, and log operations. The synchronous hooks reject unbounded list/search requests where pagination/filter arguments are absent and replace oversized MCP results with a deterministic bounded notice. The output cap is 25,000 UTF-8 bytes, a conservative hard ceiling below 25,000 tokens. Never use MCP to dump an entire database or log stream.

Run builds and other verification commands through `verify-command.mjs`; it stores raw logs outside evaluator context and emits only a bounded tail with a structured numeric result. The PostToolUse Bash hook accepts only the wrapper's structured result or an explicit numeric exit-code field; absent status is `UNKNOWN`, never a model-inferred pass. Use `set-test-result.mjs` to mark a criterion only from a completed check record, then run `validate-test-results.mjs` before evaluation.

## Decision boundary

Use `NEEDS_DECISION` when implementation would change a charter invariant. The agent may recommend; only the operator supplies missing authority.

## Source control

Git diff is authoritative. Commit, push, PR, merge and release are separate external boundaries and never implied by phase completion.
