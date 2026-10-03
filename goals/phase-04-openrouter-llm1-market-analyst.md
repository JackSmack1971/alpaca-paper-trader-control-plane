---
phase: 4
title: "OPENROUTER LLM1 MARKET ANALYST"
source: docs/PROJECT_CHARTER.md
charter_sha256: cf9c8cd02da7b06e4042143c657cb7e069f42664b22c9e652381fb267391e003
---

# PHASE 4 — OPENROUTER LLM1 MARKET ANALYST

/goal Implement the first OpenRouter generative stage as the deliberate market-analysis component of the PAPER-trading decision pipeline.

Treat current official OpenRouter documentation as authoritative.

The model is configurable and receives only the bounded Phase-3 decision context plus versioned application instructions. It has no tools or order-submission authority.

Use provider-supported structured-output controls and require parameter support where the current OpenRouter API permits it, but always perform local Zod validation.

Use conservative deterministic inference defaults unless current model/provider requirements dictate otherwise:
- temperature 0 where supported;
- bounded output tokens;
- bounded request timeout;
- at most one controlled retry for retryable server/overload/timeout failures;
- no blind retry for non-retryable 4xx responses.

Define a versioned closed action-hypothesis vocabulary. It must express intent rather than broker order parameters, for example directional/risk outcomes such as:
- bullish/increase-long candidate
- bearish/increase-short candidate where legally eligible
- reduce-risk candidate
- exit-position candidate
- no-action

The exact enum becomes an application contract and is versioned.

The validated response schema must include at least:
- action hypothesis;
- concise thesis;
- supporting evidence;
- contradicting evidence;
- uncertainty;
- relevant horizon in machine-readable form;
- blocking/precondition failures;
- any explicit no-action rationale.

Persist:
- stage identity/version;
- `stage_run_id`;
- `cycle_id`;
- `decision_context_id`;
- requested model;
- resolved model/provider identity returned by OpenRouter when available;
- provider-native generation ID;
- relevant fingerprint/version metadata when provided;
- normalized input reference;
- sanitized raw response/evidence where policy permits;
- parsed structured result;
- latency;
- prompt/completion token usage;
- reported cost;
- failure/error classification.

OpenRouter/model failure, malformed structured output, timeout, unsupported schema behavior or exhausted credits must yield a typed stage failure and terminal no-action path, never a trade recommendation.

Complete only when persisted decision contexts can be submitted through the versioned interface and downstream code receives a validated typed analysis rather than free-form prose.

---
