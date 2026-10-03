# Start here

This control plane assumes the package is at the Git repository root and the repository is trusted in Codex so project `.codex/` config, hooks and rules can load.

## 1. Static validation and clean baseline

```text
node scripts/control-plane/validate.mjs
node scripts/control-plane/preflight.mjs
```

`validate.mjs` is a source linker, not runtime proof. `preflight.mjs` requires a coherent active phase and clean non-evidence worktree.

## 2. Start Codex and qualify the live project layer

Review/trust the project hooks with `/hooks`. SessionStart records a sanitized runtime observation in `verification/control-plane/runtime/current.json`. Then run:

```text
node scripts/control-plane/qualify-control-plane.mjs
```

The result must be `QUALIFIED`. Qualification also runs Codex `--strict-config`, resolves the `project-implement` permission profile through `codex sandbox`, and parses the project rules through `codex execpolicy check`. The SessionStart observation must report the default project permission mode. If Codex is unavailable, the hook did not run, project config is stale, a runtime/profile/rules probe fails, the permission posture is overridden, or the engineering baseline is dirty, the result is `UNVERIFIED` and phase execution stops.

## 3. Compile the execution snapshot

```text
node scripts/control-plane/snapshot-control-plane.mjs
```

Record the emitted `snapshot_id` and artifact path. Authority-source changes require a new qualification and snapshot.

## 4. Plan and execute the active phase

```text
/plan Read AGENTS.md, docs/PROJECT_CHARTER.md, docs/control-plane/phase-state.json, docs/control-plane/phase-contracts.json and the active goal. Use $execute-phase. Map/research read-only, synthesize, then define the smallest coherent active-phase slice.
```

After the plan is sound:

```text
/goal Execute only the active phase using $execute-phase. Preserve the qualified snapshot, use one implementation owner, freeze a candidate identity before independent evidence, and do not advance until $phase-closeout validates schema-v2 closeout evidence.
```

## 5. Resume safely

On resume, SessionStart emits a new runtime observation. Requalify if runtime/config changed. Re-read the active goal, Git status/diff, current snapshot and executed evidence rather than relying on memory.

## 6. Advance

Only `phase-closeout` should create a COMPLETE report/manifest. Validate then advance exactly one phase:

```text
node scripts/control-plane/validate-closeout-cli.mjs --phase N
node scripts/control-plane/advance-phase.mjs --phase N
```
