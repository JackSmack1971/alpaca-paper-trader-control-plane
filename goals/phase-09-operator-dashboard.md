---
phase: 9
title: "OPERATOR DASHBOARD"
source: docs/PROJECT_CHARTER.md
charter_sha256: cf9c8cd02da7b06e4042143c657cb7e069f42664b22c9e652381fb267391e003
---

# PHASE 9 — OPERATOR DASHBOARD

/goal Build the real-time operator dashboard for the completed Alpaca/OpenRouter/Jev PAPER-trading system.

Browser code must never possess Alpaca or OpenRouter credentials and must never call broker/model APIs directly.

Serve dashboard state through the application API/SSE layer.

Display at minimum:
- permanent PAPER-mode banner;
- application health;
- Alpaca market-stream status;
- Alpaca trade/account-stream status;
- freshness/staleness;
- account equity;
- cash;
- buying power;
- realized/unrealized P&L;
- positions;
- exposure;
- open/recent orders;
- fills;
- configured universe;
- recent normalized market state;
- active/recent cycle states;
- LLM1 thesis/action hypothesis;
- Jev selected answer;
- Jev probabilities/distribution confidence where supplied;
- Jev latency;
- LLM2 verdict/constraints;
- deterministic governor rule results;
- completed PAPER trades;
- cumulative PAPER performance;
- OpenRouter token usage/cost;
- per-stage latency;
- warnings/errors;
- persistent kill-switch status.

Compute staleness server-side.

Initial truthfulness policy:
- market state LIVE when sufficiently recent, initially <5 seconds where the feed cadence supports it;
- account state LIVE when sufficiently recent, initially <30 seconds;
- between the live threshold and approximately 3× that threshold show STALE;
- beyond that or after disconnect show UNKNOWN/DISCONNECTED.

Make thresholds configurable because feed/session characteristics differ.

On SSE disconnect, immediately show `DISCONNECTED`; do not continue presenting the previous value as current.

Every real-time panel shows last-server-update information.

Expose the kill switch through a server-side authenticated/authorized application transition routed through the deterministic risk module. The browser never toggles a cosmetic flag. Require deliberate operator confirmation.

Create historical cycle drill-down, e.g. `/cycles/:cycle_id`, backed only by persisted records.

For one cycle an operator must be able to inspect:

decision context
→ LLM1 thesis/evidence
→ Jev questions and answer/probability distribution
→ LLM2 verdict/constraints
→ deterministic governor rules
→ resulting PAPER order/fill or terminal no-action reason.

The historical view must not require live provider calls.

Complete only when the dashboard accurately reflects a running PAPER session, truthfully exposes disconnect/stale/inactive/restart conditions, and can trace any PAPER execution back through all AI and deterministic stages.

---
