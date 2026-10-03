# Development workflow

## Governed lifecycle

```text
intent
  -> live qualification
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
node scripts/control-plane/qualify-control-plane.mjs
node scripts/control-plane/snapshot-control-plane.mjs
```

Static validation proves repository source coherence. Qualification is a different gate: it requires a trusted SessionStart runtime observation in the default project permission mode, the actual Codex executable/version, a clean non-evidence Git baseline, current config/hook/rule identities, strict-config acceptance, a resolvable `project-implement` permission profile, and executable rules parsing. Missing or contradictory runtime evidence is `UNVERIFIED`, never success.

## Execution

Use 2–4 read-only mapping/research workers only when useful, synthesize before writing, and assign exactly one writer for overlapping code. Parallel writers require distinct worktrees and non-overlapping declared scopes. `worktree-assignment.mjs` writes a local evidence mirror and checks a registry stored in Git's shared common directory, so sibling worktrees can actually see one another. Release finished ownership with `--release <assignment-id>`.

## Candidate freeze

After implementation and primary checks stabilize:

```text
node scripts/control-plane/candidate-id.mjs --snapshot verification/control-plane/snapshots/<id>.json --out verification/control-plane/candidates/current.json
```

Candidate identity binds the snapshot baseline, current HEAD, binary tracked diff, and non-evidence untracked file content. Review, verification, evaluation and closeout must name this same ID. Evidence artifacts under `verification/control-plane/` and `verification/phase-reports/` are excluded from engineering candidate identity so recording runtime, review, and closeout evidence does not recursively mutate the candidate. Those artifacts are validated independently by their own identities and schemas.

## Independent evidence

Reviewer and verifier run against the frozen candidate. A fresh evaluator then answers only whether that exact candidate satisfies that exact goal under that exact snapshot using admissible evidence. A material engineering change invalidates the candidate ID and stale lanes must be rerun.

## Closeout

`phase-closeout` produces the human report and schema-v2 machine manifest. `validate-closeout-cli.mjs` recomputes candidate identity, reconciles qualification/snapshot/goal/charter provenance, requires the exact machine criteria in `phase-contracts.json`, and requires PASS evidence from reviewer, verifier and evaluator. Only then can `advance-phase.mjs` move one phase.

## Decision boundary

Use `NEEDS_DECISION` when implementation would change a charter invariant. The agent may recommend; only the operator supplies missing authority.

## Source control

Git diff is authoritative. Commit, push, PR, merge and release are separate external boundaries and never implied by phase completion.
