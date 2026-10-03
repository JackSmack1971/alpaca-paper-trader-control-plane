---
phase: 6
title: "OPENROUTER LLM2 TRADING CRITIC"
source: docs/PROJECT_CHARTER.md
charter_sha256: 8fff9dfd9423c22da6db234e5f7d45f0f6f4414e15c131ba865f3ef7ccc6de5f
---

# PHASE 6 — OPENROUTER LLM2 TRADING CRITIC

/goal Implement the second OpenRouter generative stage as the post-Jev trading critic and risk-aware verifier, completing the LLM → Jev → LLM sandwich.

LLM2 receives only:
- deterministic decision context;
- LLM1 structured analysis;
- Jev selected outcome;
- Jev probabilities/distribution information where available;
- Jev's explicit abstention/consistency status and the versioned interpretation policy (so absent or invalid Jev output cannot be mistaken for approval);
- current portfolio/open-order state;
- versioned critic instructions.

It has no broker tools, no order-submission function and no direct infrastructure authority.

Require a locally validated structured result with a closed verdict enum of exactly:
- `confirm`
- `reject`
- `constrain`

`reject` terminates the AI proposal as no-action.

`confirm` forwards the proposal unchanged to deterministic risk evaluation.

`constrain` may only narrow risk. It carries a versioned application-defined constraints object using fields already understood by deterministic code, such as:
- lower maximum notional/exposure;
- require a safer order policy already supported by the governor;
- tighter liquidity/spread limit;
- shorter validity horizon.

LLM2 must never widen an existing limit, override the governor, create arbitrary order parameters or introduce a new execution capability.

The response must explain:
- material agreement with LLM1/Jev;
- contradictions;
- uncertainty;
- relevant portfolio/risk concerns;
- rationale for confirmation/rejection/constraining.

Treat Jev output as evidence to inspect, not as a correctness guarantee or a command. LLM2 must explicitly address material LLM1/Jev disagreement and may not resolve it by deferring automatically to Jev confidence. Missing/invalid Jev data, unresolved disagreement or ambiguous interpretation means `reject`/no-action under the existing fail-closed rule.

Use the same structured-output, local-validation, timeout/retry, persistence, cost and secret-handling discipline as Phase 4.

Persist references to every upstream stage, including the Jev `stage_run_id`.

Any disagreement requiring unresolved interpretation, malformed output, timeout, unavailable model or provider failure resolves to no-action rather than approval.

Complete only when every actionable AI proposal has a traceable LLM1 analysis, Jev typed decision and LLM2 critic record ready for independent deterministic policy evaluation.

---
