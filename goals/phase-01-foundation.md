---
phase: 1
title: "FOUNDATION"
source: docs/PROJECT_CHARTER.md
charter_sha256: 8fff9dfd9423c22da6db234e5f7d45f0f6f4414e15c131ba865f3ef7ccc6de5f
---

# PHASE 1 — FOUNDATION

/goal Establish the production-shaped foundation for an Alpaca/OpenRouter AI PAPER-trading system while implementing the Project Charter above as durable repository policy. Do not implement autonomous trading.

Build the repository structure, configuration boundary, secret handling, database/migration foundation, API/server shell, health/status contracts, developer tooling and operator documentation required by every later phase.

Create real initial persistence rather than placeholder tables. At minimum establish versioned persistence for:

- decision cycles
- decision contexts
- individual AI stage runs
- Alpaca paper orders
- fills
- normalized market records needed for replay
- deterministic risk decisions
- health/connection samples
- kill-switch state
- configuration snapshots
- later cycle outcomes/calibration labels

Schemas must support correlation through `cycle_id`, `decision_context_id` and `stage_run_id`.

Implement PAPER-only enforcement as defined in the charter. Alpaca paper credentials and OpenRouter credentials must remain server-side. There must be no browser-accessible broker/model credential or direct broker/model client.

Configuration must support a future configurable asset universe, model selection, decision cadence, risk settings and non-secret provider settings without hardcoding them throughout production modules.

Application startup must:

1. validate configuration;
2. verify PAPER-only invariants;
3. initialize persistence;
4. expose health/status;
5. report configured external capabilities as connected, unavailable or not configured;
6. identify itself unmistakably as PAPER mode.

Create the verification commands required by the charter and make offline verification succeed without credentials.

Complete only when a fresh documented installation can configure and start the service, validate its environment, identify itself as PAPER mode, initialize the real schema, expose truthful health/status information, enforce the absence of live-trading routes, and report unavailable credential-backed checks rather than bypassing them.

---
