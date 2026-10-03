---
name: task-routing
description: >
  Route engineering tasks by uncertainty, structural complexity, and blast radius so routine work stays single-agent and consequential work gets isolated planning, review, and verification.
---

# Task Routing

At task intake, classify the requested work before editing. Routine syntax corrections, documentation additions, dependency updates, and sequential same-file edits stay with the primary agent. For other work, use the configured fast, read-only `task_router`, inspect the relevant AST/file map, and save its structured intake as `verification/control-plane/task-routing/<id>.intake.json`. Run `node scripts/control-plane/route-task.mjs --intake verification/control-plane/task-routing/<id>.intake.json` and follow its deterministic role/worktree decision. When the result says `worktree_required: true`, launch every selected role from the returned `execution_root`; route-task has already created and registered that worktree. The Codex app-managed Worktree Root is a user setting and should point to this repository's `.codex/worktrees/` when using app-managed background tasks.

- **Uncertainty:** are the target files and behavior known, or is discovery/research needed?
- **Complexity:** how many modules/files need structural edits and coordination?
- **Blast radius:** does the change touch authentication, security boundaries, persistence/schema, cloud infrastructure, or functional correctness?

## Routing

| Signals | Route |
|---|---|
| Low uncertainty, low complexity, low radius | One strong primary builder; no subagent. Use a focused diff. |
| High uncertainty, low radius | Fresh read-only `phase_mapper` or `provider_researcher` in an isolated worktree; return concise `RESEARCH.md` content for the primary to persist; synthesize before one builder starts. |
| High complexity and high radius, or an explicit critical-path trigger | Planner (`phase_mapper`) → one `implementer` → read-only reviewer/security auditor/verifier → fresh read-only evaluator. Create `verification/test-results.json` in default `FAIL` state with acceptance criteria before code generation. |

Do not delegate routine syntax corrections, documentation additions, dependency updates, or strictly sequential edits in one file. Enablement of multi-agent tools does not imply that every task should use them.

## Escalation triggers

Request isolated independent review when any applies:

- authentication, authorization, secrets, security boundaries, database schemas/migrations, or cloud infrastructure changes;
- more than 50 lines of code change is expected;
- more than three architectural files/modules are involved;
- correctness is difficult to verify deterministically, such as visual behavior or race conditions.

These are routing signals, not proof that the work is high risk. State the evidence behind the classification and use the smallest sufficient number of roles.

## Isolation and handoffs

- Any delegated or background task must run from a separate Git worktree under `.codex/worktrees/`, created with `node scripts/control-plane/create-worktree.mjs`.
- Do not let delegated writers share a checkout. Keep one writer per overlapping scope and use the shared worktree-assignment registry for coordination.
- Researchers, reviewers, security auditors, verifiers, and evaluators use fresh contexts and read-only permissions. They must independently inspect repository artifacts rather than trust builder claims.
- Evaluators receive only original requirements, the active goal/charter, frozen candidate/source, and structured result records such as `test-results.json`. Never include builder reasoning, transcripts, or raw logs.
- Use structured files (`RESEARCH.md`, `BUILD_PLAN.md`, `test-results.json`) as handoffs. Summarize logs and research before they reach the primary context.

## Model and token budget

Use a fast, low-cost model such as GPT-6 Luna for routing, repository maps, research summaries, logs, state-file generation, and simple lint triage. Reserve a strong builder/planner for implementation and use a fresh strong evaluator only for the high-complexity routes above. Use GPT-6 Astra only for an unusually difficult, bounded architectural evaluation; never make it the default for long-running work. Prefer summaries and bounded evidence over copied transcripts.

## Verification contract

For complex/high-radius work, `route-task.mjs` creates `verification/test-results.json` in default `FAIL` state before implementation. It requires acceptance criteria in the intake and refuses to continue if a prior task contract would be overwritten. Update criteria only from executed deterministic evidence:

```text
node scripts/control-plane/init-test-results.mjs --criteria <criteria.json> --out verification/test-results.json
```

Update each criterion only from executed deterministic evidence using `set-test-result.mjs --criterion <id> --check-id <unique-id>`. Run builds and checks using `node scripts/control-plane/verify-command.mjs --id <unique-id> -- <executable> <args...>`, then run `validate-test-results.mjs` before evaluation. A missing numeric exit status remains `UNKNOWN`; prose or logs cannot turn it into PASS.
