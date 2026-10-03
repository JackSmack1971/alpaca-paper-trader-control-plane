---
phase: 7
title: "DETERMINISTIC RISK GOVERNOR AND PAPER EXECUTION"
source: docs/PROJECT_CHARTER.md
charter_sha256: 8fff9dfd9423c22da6db234e5f7d45f0f6f4414e15c131ba865f3ef7ccc6de5f
---

# PHASE 7 — DETERMINISTIC RISK GOVERNOR AND PAPER EXECUTION

/goal Implement the deterministic risk governor and Alpaca PAPER execution engine for the completed AI sandwich.

AI output is advisory. Ordinary deterministic application code remains the final authority over whether any PAPER order is legal.

Implement configurable deterministic controls covering at minimum:
- symbol eligibility;
- asset tradability;
- long/short eligibility where applicable;
- fractional-share policy;
- session restrictions;
- buying power;
- cash;
- maximum per-position exposure;
- maximum portfolio exposure;
- maximum order notional;
- concentration limits;
- stale-data rejection;
- stale-account-state rejection;
- AI-stage completeness;
- Jev/critic acceptance;
- agreement/abstention policy for the versioned Jev decision (Jev alone can never satisfy policy or waive a deterministic rule);
- outstanding-order conflicts;
- duplicate cycle/order protection;
- configurable spread/liquidity restrictions where data exists;
- operator kill switch.

Sizing is deterministic application code, not AI arithmetic. Define and document the sizing formula, its rounding rules, and its interaction with LLM2 constraints. Default to a conservative percentage-of-equity/buying-power formulation and whole shares unless fractional execution is explicitly enabled and the asset/account supports it.

Never derive price, quantity, notional, stop levels or sizing arithmetic from Jev probabilities or Score interpolation. They may support an explicitly versioned abstention or candidate-ranking policy only after Phase-10 evidence; every such policy remains subordinate to all deterministic controls.

Start with an explicit versioned order policy such as PAPER market/day orders unless configuration and verified Alpaca capability permit another supported policy.

The governor must persist every rule evaluated, not merely the first failure:

`rule_id`
`verdict`
`observed_value`
`limit_value`
`reason`

No missing required state produces a fallback trade.

Implement the kill switch as persistent server-side risk state. By default activation must:
1. block all new decision cycles/exposure;
2. cancel open PAPER orders where safely possible.

Flattening positions is a separate explicit operator policy and must never occur merely because the kill switch was activated unless specifically configured/confirmed.

Kill-switch state survives restart.

Implement Alpaca `client_order_id` idempotency around cycle identity.

Required submission sequence:

1. derive deterministic `client_order_id` from the cycle/order intent;
2. persist execution intent before network submission;
3. submit once;
4. if submission times out or outcome is ambiguous, query Alpaca by `client_order_id` before any retry;
5. treat a duplicate-active-client-ID response as evidence requiring lookup/reconciliation, not permission to submit another order.

Do not assume Alpaca supports a generic order `Idempotency-Key` header.

Track and persist:
- submitted;
- accepted;
- partial fill;
- fill;
- cancel;
- reject;
- expired/other documented terminal states.

After reconnect/restart, broker reconciliation wins over stale local assumptions.

No code path may target Alpaca live trading.

Complete only when a candidate can reach PAPER execution solely after all required AI and deterministic gates pass, unsafe candidates are observably vetoed, ambiguous submissions are safely reconciled, and local order/account state converges to Alpaca PAPER truth.

---
