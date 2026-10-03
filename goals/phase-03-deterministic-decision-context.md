---
phase: 3
title: "DETERMINISTIC DECISION CONTEXT"
source: docs/PROJECT_CHARTER.md
charter_sha256: 8fff9dfd9423c22da6db234e5f7d45f0f6f4414e15c131ba865f3ef7ccc6de5f
---

# PHASE 3 — DETERMINISTIC DECISION CONTEXT

/goal Build the deterministic market-state and decision-context layer for the Alpaca PAPER-trading bot.

Transform normalized Phase-2 market/account state into compact, immutable, timestamped and reproducible single-symbol decision contexts suitable for the later OpenRouter LLM → Jev → LLM pipeline.

This layer has no order authority and performs all arithmetic that should be deterministic application code rather than delegating calculations to a language model.

Include, when supported by available history:

- current/reference prices;
- deterministic returns over configured windows;
- trend features;
- volatility features;
- volume/liquidity features;
- spread where available;
- position and portfolio exposure;
- realized/unrealized P&L;
- outstanding-order state;
- cash and buying power;
- symbol capability/tradability state;
- market/session state;
- data age/freshness;
- recent relevant cycle/system state.

Never manufacture unavailable state.

Represent unavailable inputs as `null` and include a structured top-level list describing field path and reason such as:
- stale
- insufficient_history
- no_feed
- unsupported
- pre_market
- unavailable_account_state

Never use `0`, `0.0` or an empty collection as a substitute when those values would carry real meaning.

Every context must carry:
- `decision_context_id`
- `cycle_id`
- symbol
- semantic schema version
- `built_at`
- effective `as_of`
- deterministic transform version(s)
- ordered provenance sufficient to identify the source records/event times used to derive the context.

Define and document deterministic rounding/decimal rules. Identical recorded inputs plus identical transform versions must reproduce byte-equivalent canonical context output.

Keep a single-symbol serialized context bounded. Target no more than roughly 4,000 model tokens and enforce the selected token-budget methodology in automated tests so later schema growth cannot silently create enormous prompts.

Reject or mark stale/incomplete state before inference rather than allowing AI stages to decide whether corrupted context is acceptable.

Complete only when persisted inputs replay into the same versioned context, numerical calculations and freshness rules are tested, unavailable information remains explicit, and provenance can reconstruct what every later AI stage saw.

---
