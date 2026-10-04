# Codex Project Control Plane

Version: defined by [`policy.json`](policy.json).
Charter SHA-256: `8fff9dfd9423c22da6db234e5f7d45f0f6f4414e15c131ba865f3ef7ccc6de5f`

This repository-local control plane governs the ten-phase Alpaca/OpenRouter/Jev PAPER-trading charter. It does not implement the trading application.

## Mechanical guarantees

- one canonical Node 22 utility layer for identity, JSON, Git and line-ending normalization;
- static source validation and current-main worktree preflight gate implementation; live Codex qualification is optional diagnostics;
- SessionStart runtime observation without a live-runtime implementation gate;
- immutable execution snapshot before implementation;
- one writer by default, explicit worktree assignments for concurrent writers;
- deterministic candidate identity over Git delta and untracked engineering files;
- independent reviewer, verifier and fresh evaluator bound to the same candidate;
- policy-versioned closeout with exact machine acceptance criteria and stale-evidence rejection;
- project permission profiles plus `.rules` and synchronous PreToolUse repository guardrails;
- risk-scaled single-agent/delegation routing, worktree-local background tasks, and bounded MCP results;
- deterministic command-result records and PostToolUse status reporting;
- capability registry that treats registration, enablement, visibility and authorization as separate;
- executable PAPER-only static guard that later application tests must complement.
- isolated worktree creation defaults to `.codex/worktrees/`; lightweight intake keeps routine work single-agent;
- MCP collection calls require filters and page sizes, with oversized responses dropped before model context;
- verification uses numeric exit-code records, and evaluator context excludes builder logs.

Project-local policy remains a governance/default boundary, not a non-bypassable organization security boundary. Managed requirements or external controls are required for truly immutable restrictions.

Read `START_HERE.md` before Phase 1.
