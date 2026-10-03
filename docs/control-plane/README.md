# Codex Project Control Plane

Version: **1.1.0**
Charter SHA-256: `cf9c8cd02da7b06e4042143c657cb7e069f42664b22c9e652381fb267391e003`

This repository-local control plane governs the ten-phase Alpaca/OpenRouter/Jev PAPER-trading charter. It does not implement the trading application.

## Mechanical guarantees

- one canonical Node 22 utility layer for identity, JSON, Git and line-ending normalization;
- source validation is separate from live Codex qualification;
- SessionStart runtime observation + fail-closed qualification;
- immutable execution snapshot before implementation;
- one writer by default, explicit worktree assignments for concurrent writers;
- deterministic candidate identity over Git delta and untracked engineering files;
- independent reviewer, verifier and fresh evaluator bound to the same candidate;
- schema-v2 closeout with exact machine acceptance criteria and stale-evidence rejection;
- project permission profiles plus `.rules` and synchronous PreToolUse repository guardrails;
- capability registry that treats registration, enablement, visibility and authorization as separate;
- executable PAPER-only static guard that later application tests must complement.

Project-local policy remains a governance/default boundary, not a non-bypassable organization security boundary. Managed requirements or external controls are required for truly immutable restrictions.

Read `START_HERE.md` before Phase 1.
