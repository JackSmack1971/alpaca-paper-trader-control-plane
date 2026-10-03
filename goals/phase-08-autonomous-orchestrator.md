---
phase: 8
title: "AUTONOMOUS ORCHESTRATOR"
source: docs/PROJECT_CHARTER.md
charter_sha256: cf9c8cd02da7b06e4042143c657cb7e069f42664b22c9e652381fb267391e003
---

# PHASE 8 — AUTONOMOUS ORCHESTRATOR

/goal Build the autonomous PAPER-trading orchestrator around the completed market state, deterministic context, OpenRouter LLM1 → Jev → LLM2 pipeline, deterministic risk governor and Alpaca PAPER execution engine.

Do not couple inference to every raw market tick.

Support bounded configurable triggers and cadence.

Initial concurrency policy:
- maximum one in-flight cycle per symbol;
- configurable minimum interval between cycles for the same symbol, initially approximately 60 seconds;
- configurable global in-flight cap, initially 2;
- Jev request token/rate bucket set conservatively below the documented provider account limit;
- configurable event coalescing/debounce window.

Define the deduplication identity around symbol + trigger class + deterministic time bucket/opportunity identity.

Persist an explicit cycle state machine. At minimum:

`snapshot_built`
→ `llm1_analyzed`
→ `jev_decided`
→ `llm2_reviewed`
→ `risk_evaluated`
→ `executed | no_action | blocked`

Also represent failure/reconciliation-required states explicitly rather than overloading normal states.

Every transition records:
- `cycle_id`;
- timestamp;
- trigger;
- prior/new state;
- structured reason;
- stage correlation IDs;
- per-stage latency;
- cumulative end-to-end latency.

Measure at least:
- LLM1 latency;
- Jev latency;
- LLM2 latency;
- risk latency;
- execution latency;
- complete cycle latency.

On application restart:
1. restore persistent kill-switch state;
2. re-establish/reconcile Alpaca account/order truth;
3. restore required market/data state;
4. inspect persisted in-flight cycles;
5. mark cycles that may have crossed an execution boundary as reconciliation-required;
6. never blindly resume an uncertain order submission.

Failure of any AI stage, stale market data, stale/unavailable account state, unresolved execution state or active kill switch blocks new exposure while preserving observability.

Complete only when the application can run unattended against Alpaca PAPER trading and every opportunity follows a bounded, persisted, traceable lifecycle to executed/no-action/blocked outcome without overlapping duplicate decisions.

---
