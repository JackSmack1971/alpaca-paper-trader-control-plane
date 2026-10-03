---
name: paper-safety-audit
description: >
  Audit changes for the permanent PAPER-only boundary, broker/model credential isolation, AI non-authority, deterministic risk authority, secret leakage, live-endpoint strings, and unsafe direct browser/provider access.
---

# PAPER Safety Audit

This is a development safeguard, not the application's final enforcement mechanism.

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

Run `node scripts/control-plane/check-paper-only.mjs` when `src/` exists, plus the repository's real PAPER/secret guards once Phase 1 creates them.

Report `PASS`, `FAIL`, or `UNVERIFIED` per invariant with concrete evidence. Do not claim runtime PAPER enforcement from this audit alone.
