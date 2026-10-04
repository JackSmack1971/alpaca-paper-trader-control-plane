---
name: task-routing
description: >
  Route non-routine engineering work by uncertainty, structural complexity, and blast radius to the smallest sufficient set of isolated roles. Keep routine reversible edits with the primary agent; include required independent evidence roles when a task may close a phase. Not for product prioritization or permission decisions.
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
| High complexity and high radius, or an explicit critical-path trigger | Planner (`phase_mapper`) → one `implementer` → read-only reviewer/security auditor/verifier → fresh read-only evaluator. Create the task-scoped `verification/control-plane/tasks/<task-id>/test-results.json` in default `FAIL` state with acceptance criteria before code generation. |

Any high-radius intake or route that selects an independent reviewer, security auditor, verifier, or evaluator must provide task-scoped acceptance criteria before implementation starts, including low-complexity work. Routine routes without those review/adjudication roles keep the lightweight path and do not receive a task acceptance contract.

### Phase-closeout evidence route

When a task invokes `phase-closeout` or intends to declare an active phase complete, schedule independent `reviewer` and `verifier` roles plus a fresh `evaluator` for the frozen candidate, regardless of whether the implementation slice's initial `route-task` result selected them. Treat this as a mandatory closeout evidence lane after the candidate is frozen, not optional review selected by change-size heuristics; do not weaken or rewrite the recorded implementation intake to obtain it. Give each role only its defined read-only/evaluation inputs. If a role or its required isolation is unavailable, keep closeout `BLOCKED`/`INCONCLUSIVE` and identify the missing lane; never recast a primary-agent self-check as independent evidence. Do not schedule these roles for an ordinary slice that is not attempting phase closeout unless normal risk routing calls for them.

Do not delegate routine syntax corrections, documentation additions, dependency updates, or strictly sequential edits in one file. Enablement of multi-agent tools does not imply that every task should use them.

## Escalation triggers

Request isolated independent review when any applies:

- authentication, authorization, secrets, security boundaries, database schemas/migrations, or cloud infrastructure changes;
- expected code lines exceed the canonical threshold;
- architectural file count exceeds the canonical threshold;
- correctness is difficult to verify deterministically, such as visual behavior or race conditions.

Use `docs/control-plane/policy.json` as the source for routine task kinds, critical areas, complexity thresholds, and routing roles. These are routing signals, not proof that the work is high risk. State the evidence behind the classification and use the smallest sufficient number of roles.

## Isolation and handoffs

- Any delegated or background task must run from a separate Git worktree under `.codex/worktrees/`, created with `node scripts/control-plane/create-worktree.mjs`.
- Do not let delegated writers share a checkout. Keep one writer per overlapping scope and use the shared worktree-assignment registry for coordination.
- Researchers, reviewers, security auditors, verifiers, and evaluators use fresh contexts and read-only permissions. They must independently inspect repository artifacts rather than trust builder claims.
- Evaluators receive only original requirements, the active goal/charter, frozen candidate/source, and structured result records such as `test-results.json`. Never include builder reasoning, transcripts, or raw logs.
- Use structured files (`RESEARCH.md`, `BUILD_PLAN.md`, `test-results.json`) as handoffs. Summarize logs and research before they reach the primary context.

## Model and token budget

Use the lowest-cost currently configured model that can perform the selected role reliably. Reserve higher-capability models for difficult, bounded planning or evaluation where the task's uncertainty and consequence justify them; do not assume model names, prices, or capability rankings remain stable. Prefer summaries and bounded evidence over copied transcripts.

## Verification contract

For high-radius or independently reviewed/adjudicated work, `route-task.mjs` requires criteria and creates a task-scoped evidence bundle and default-fail acceptance results before implementation. Routine routes without those roles remain lightweight. A stable task ID may only be reused for the same intake; a completed historical bundle never blocks a different task:

```text
node scripts/control-plane/init-test-results.mjs --task-id <task-id> --criteria <criteria.json>
```

Update each criterion only from executed deterministic evidence using `set-test-result.mjs --task-id <task-id> --criterion <id> --check-id <unique-id>`. Run builds and checks using `node scripts/control-plane/verify-command.mjs --task-id <task-id> --id <unique-id> -- <executable> <args...>`, then run `validate-test-results.mjs --task-id <task-id>` before evaluation. A missing numeric exit status remains `UNKNOWN`; prose or logs cannot turn it into PASS.
