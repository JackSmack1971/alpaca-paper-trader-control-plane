---
name: paper-safety-audit
description: >
  Audit a proposed or completed code/configuration diff that touches trading mode, broker/model access, credentials, AI output or order authority, or PAPER enforcement. Check the charter's PAPER-only boundary and report evidence per invariant. Do not use for unrelated changes or as a substitute for implementation review or runtime qualification.
---

# PAPER Safety Audit

This is a development safeguard, not the application's final enforcement mechanism.

Use this audit when a change can affect PAPER-mode selection/enforcement, broker execution paths, model authority, provider credentials, browser/provider access, or secret handling. Skip it for diffs that cannot reach those surfaces. Review the charter and active phase before drawing conclusions; this skill does not grant permission to contact a provider or execute an order.

Check the charter's PAPER-only and authority invariants:

1. Alpaca trading base URL remains the paper endpoint constant and cannot be replaced by environment/runtime configuration.
2. Production `src/` contains no Alpaca live-trading endpoint or live trading-stream selector.
3. `assertPaperOnly()` (once implemented) remains on broker-client construction paths.
4. API/startup/dashboard/persisted records expose PAPER mode as required by the active phase.
5. Browser code never has Alpaca/OpenRouter credentials and never calls broker/model APIs directly.
6. AI stages do not receive order-submission tools or authority and never manufacture broker order parameters where prohibited.
7. Deterministic risk/application code remains final order authority.
8. Secrets are absent from persisted records, fixtures, responses, dashboard state, structured logs and exceptions.
9. Missing state causes no-action/blocking behavior, never a fallback trade.

Run `node scripts/control-plane/check-paper-only.mjs` when `src/` exists, plus the repository's real PAPER/secret guards once Phase 1 creates them. Record each command and its actual outcome. If a required source path or guard does not yet exist, mark the affected invariant `UNVERIFIED` and explain the phase/state that prevents verification; do not treat absence as proof of safety.

Trace changed execution or credential paths from configuration/input through validation and deterministic guards to the final side effect, including failure/no-action branches. Distinguish changed-path findings from repository-wide claims, and identify baseline failures when comparable baseline evidence exists. If necessary code, policy, or executed evidence is unavailable, report `UNVERIFIED`; if an invariant is violated, report `FAIL` and stop short of claiming the change is safe.

**Completion:** Report `PASS`, `FAIL`, or `UNVERIFIED` for every applicable invariant, with file/symbol or executed-command evidence and the scope inspected. State any omitted invariant and why it does not apply. A safety audit never proves runtime PAPER enforcement by inspection alone.
