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

Static validation proves repository source coherence. Preflight requires a coherent active phase and records the current `main` worktree state, including pre-existing edits, as the baseline; it never asks operators to discard those edits. The execution snapshot binds both `HEAD` and a content digest of current non-evidence tracked/untracked changes. A missing deleted-worktree path is historical Git metadata and is not execution baseline state. Runtime qualification remains an optional diagnostic.

## Execution

Apply `$task-routing` before work. For non-routine tasks, save the fast router's intake JSON and run `route-task.mjs`; it creates a stable `verification/control-plane/tasks/<task-id>/` evidence bundle. Each bundle owns its intake, route, candidate, acceptance results, checks, review, verification, and evaluation artifacts. Completed bundles remain historical records and never block another task. Keep ordinary edits single-agent. When delegation or background execution is selected, create a separate worktree beneath `.codex/worktrees/` using `create-worktree.mjs`, launch the task there, and give each writer a non-overlapping scope. `worktree-assignment.mjs` checks the shared registry; release finished ownership with `--release <assignment-id>`. Read-only research returns a structured `RESEARCH.md` handoff before a builder starts.

Migrate an existing singleton result and its referenced check records with `node scripts/control-plane/migrate-test-results.mjs --task-id <task-id>`. The migration copies legacy evidence into that task's bundle and leaves the original singleton and check records intact.

## Candidate freeze

After implementation and primary checks stabilize:

```text
node scripts/control-plane/candidate-id.mjs --snapshot verification/control-plane/snapshots/<id>.json --task-id <task-id>
```

Candidate identity binds the snapshot baseline, current HEAD, binary tracked diff, non-evidence untracked file content, and the selected task and bundle identity. It is written into that task's bundle. Review, verification, evaluation and closeout must name this candidate and task bundle. Evidence artifacts under `verification/control-plane/` and `verification/phase-reports/` are excluded from engineering candidate identity so recording evidence does not recursively mutate the candidate.

Candidate freeze first runs deterministic post-diff risk reclassification over the actual Git delta and non-evidence untracked files. It considers changed-file count and line magnitude, migrations, permissions/configuration, security-sensitive paths, public API, dependencies, tests, safeguard deletions, and control-plane/charter sources. The bundle route is updated monotonically: observed risk can add reviewer, security-auditor, verifier and evaluator lanes but cannot remove intake-required roles. Required default-fail acceptance criteria and effective roles are written before the candidate record. The candidate embeds the classification digest; closeout must reconcile it against current source and collect each required lane.

Keep candidate and role evidence immutable by candidate ID. Save review, security-review, verifier, verification, and evaluation records with `record-task-evidence.mjs --task-id <task-id> --kind <kind> --record <record.json>`. Closeout reconciles every lane required by the candidate's post-diff risk record and the acceptance results from that same bundle.

## Independent evidence

Reviewer and verifier run against the frozen candidate. A fresh evaluator then answers only whether that exact candidate satisfies that exact goal under that exact snapshot using admissible evidence. A material engineering change invalidates the candidate ID and stale lanes must be rerun.

## Closeout

`phase-closeout` produces the human report and the machine manifest at the version in `policy.json`. `validate-closeout-cli.mjs` recomputes candidate identity, reconciles snapshot/goal/charter provenance, requires the exact machine criteria in `phase-contracts.json`, and requires PASS evidence from reviewer, verifier and evaluator. Only then can `advance-phase.mjs` move one phase.

## Bounded tool results

For MCP calls, `capabilities.json` provides the exact per-tool collection schema: required scope fields, pagination field and maximum, and optional result-size bound. The pre-tool hook applies those declared semantics regardless of operation name. A name heuristic only fails closed for unregistered collection-like operations; it does not classify registered tools. Registered, enabled, visible, and authorized remain distinct capability states. The post-tool hook applies the stricter of the per-tool result-size bound and canonical global bound. The output cap is the `maximum_result_utf8_bytes` value in `policy.json` (24,000 UTF-8 bytes). Never use MCP to dump an entire database or log stream.

Run builds and other verification commands through `verify-command.mjs --task-id <task-id>`; it stores checks and raw logs inside that task's bundle and emits only a bounded tail with a structured numeric result. The PostToolUse Bash hook accepts only the wrapper's structured result or an explicit numeric exit-code field; absent status is `UNKNOWN`, never a model-inferred pass. Use `set-test-result.mjs --task-id <task-id>` to mark a criterion only from a completed check record, then run `validate-test-results.mjs --task-id <task-id>` before evaluation.

## Decision boundary

Use `NEEDS_DECISION` when implementation would change a charter invariant. The agent may recommend; only the operator supplies missing authority.

## Source control

Git diff is authoritative. Commit, push, PR, merge and release are separate external boundaries and never implied by phase completion.
