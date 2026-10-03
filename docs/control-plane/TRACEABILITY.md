# Charter -> control-plane traceability

| Charter concern | Control-plane mechanism | Actual enforcement owner |
|---|---|---|
| Fixed stack / repository boundaries | `AGENTS.md`, phase goal files | implementation + tests |
| PAPER-only invariant | `AGENTS.md`, `paper-safety-audit`, static scan | application constants/assertions/tests/runtime |
| Append-only migrations | `AGENTS.md`, `schema-migration` | Git review + migration tooling/tests |
| AI never owns order authority | `AGENTS.md`, reviewer/paper audit | application architecture + deterministic risk code |
| External contract freshness | `provider_researcher`, `research-external-contract` | source evidence + authorized runtime observation |
| Verification ladder | `verification-ladder`, verifier | executed commands/provider observations |
| Runtime observation | SessionStart observation + optional `qualify-control-plane.mjs` | diagnostic only; never an implementation/closeout gate |
| Execution provenance | `snapshot-control-plane.mjs` | immutable snapshot of checked-in project authority; no live runtime dependency |
| Work routing/isolation | `task-routing`, `route-task.mjs`, `create-worktree.mjs`, shared assignment registry | deterministic route record; delegated/background task runs under `.codex/worktrees/` |
| Tool-result bounds | MCP PreToolUse/PostToolUse hooks | bounded list/search inputs and 25,000-byte result ceiling |
| Verification status | `verify-command.mjs` + Bash PostToolUse hook | structured numeric exit status; missing status remains UNKNOWN |
| Candidate/evidence freshness | `candidate-id.mjs`, reviewer/verifier/evaluator IDs | Git delta + exact evidence binding |
| Phase reporting | `phase-closeout`, schema-v3 manifest, report template | repository evidence record + machine reconciliation |
| Charter conflicts | `adr-escalation`, ADR template | operator decision |
| Sequential phases | `phase-state.json`, exact goal files | phase-closeout + operator steering |
| Change scope | one-writer workflow, Git rules/policy | Git diff + runtime permissions |

Behavioral files can constrain what agents should do. They do not grant permission to use credentials, call providers, publish Git state, or create external side effects.
