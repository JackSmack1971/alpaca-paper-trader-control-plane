# Start here

This control plane assumes the package is at the Git repository root and the repository is trusted in Codex so project `.codex/` config, hooks and rules can load.

## 1. Static validation and clean baseline

```text
node scripts/control-plane/validate.mjs
node scripts/control-plane/preflight.mjs
```

`validate.mjs` is a source linker, not runtime proof. `preflight.mjs` requires a coherent active phase and clean non-evidence worktree.

Delegated and background tasks use isolated Git worktrees beneath `.codex/worktrees/`. Run `node scripts/control-plane/create-worktree.mjs --name <slug> --owner <role> --unit <task> --scope <paths>` and launch the task from that returned path. When using Codex app-managed background chats, set the app's Worktree Root to this project's `.codex/worktrees` directory in Worktree settings; project config cannot set that user-level location.

## 2. Record runtime observations (optional)

Review and trust the project hooks with `/hooks`. SessionStart records a sanitized runtime observation in `verification/control-plane/runtime/current.json`. `node scripts/control-plane/qualify-control-plane.mjs` remains available for optional diagnostics; neither Codex availability nor a `QUALIFIED` result gates implementation or closeout. Static source validation and clean-baseline preflight remain required.

## 3. Compile the execution snapshot

```text
node scripts/control-plane/snapshot-control-plane.mjs
```

Record the emitted `snapshot_id` and artifact path. Authority-source changes require a new snapshot.

## 4. Plan and execute the active phase

```text
/plan Read AGENTS.md, docs/PROJECT_CHARTER.md, docs/control-plane/phase-state.json, docs/control-plane/phase-contracts.json and the active goal. Use $execute-phase. Map/research read-only, synthesize, then define the smallest coherent active-phase slice.
```

After the plan is sound:

```text
/goal Execute only the active phase using $execute-phase. Preserve the execution snapshot, use one implementation owner, freeze a candidate identity before independent evidence, and do not advance until $phase-closeout validates the evidence-bound closeout.
```

## 5. Resume safely

On resume, SessionStart may emit a new runtime observation. Re-read the active goal, Git status/diff, current snapshot and executed evidence rather than relying on memory.

## 6. Advance

Only `phase-closeout` should create a COMPLETE report/manifest. Validate then advance exactly one phase:

```text
node scripts/control-plane/validate-closeout-cli.mjs --phase N
node scripts/control-plane/advance-phase.mjs --phase N
```
