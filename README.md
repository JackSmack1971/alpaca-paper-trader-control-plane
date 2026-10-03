# Alpaca/OpenRouter PAPER Trading — Codex Control Plane

A drop-in, repository-local Codex control plane derived from the attached ten-phase project charter. It is designed to move the project from an empty/brownfield repository through Phase 10 MVP qualification without turning one giant prompt into the workflow.

## What is included

- authoritative charter copy + ten exact phase goal files;
- concise root `AGENTS.md` behavioral policy;
- current project `.codex/config.toml` using native Goal mode, multi-agent support, live web search and permission profiles;
- SessionStart hook that surfaces active phase/provenance;
- conservative project Git execpolicy rules;
- nine declared custom agent roles, including task router, security auditor, and low-cost summarizer;
- ten reusable Skills, including risk-scaled task routing and bounded MCP calls;
- deterministic phase-state, source linking, optional runtime diagnostics, execution snapshots, candidate identity, PAPER endpoint scanning, worktree creation/ownership, result contracts, evidence reconciliation, and phase advancement scripts;
- isolated delegated/background worktrees under `.codex/worktrees/`, with deterministic command-status hooks and bounded MCP results;
- ADR, research and phase-report templates;
- compatibility notes for current Codex behavior as of 2026-10-03.

## First commands

```text
node scripts/control-plane/validate.mjs
node scripts/control-plane/show-phase.mjs
```

Then follow `docs/control-plane/START_HERE.md`.

## Security boundary

This package does not contain provider credentials and does not grant provider, filesystem, network, Git publication or deployment authority. Codex configuration and Skills shape behavior/capability exposure; the active runtime policy remains authoritative for effects. The eventual application must mechanically enforce PAPER-only behavior itself.
