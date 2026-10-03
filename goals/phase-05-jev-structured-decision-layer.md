---
phase: 5
title: "JEV STRUCTURED DECISION LAYER"
source: docs/PROJECT_CHARTER.md
charter_sha256: 8fff9dfd9423c22da6db234e5f7d45f0f6f4414e15c131ba865f3ef7ccc6de5f
---

# PHASE 5 — JEV STRUCTURED DECISION LAYER

/goal Integrate TypeSafe Jev through OpenRouter as the fast, typed, probabilistic second-opinion layer between LLM1 and LLM2. Jev's role is to classify/rank the candidate thesis, expose ambiguity and support abstention cheaply; it is not a market analyst, reasoner, price forecaster, risk engine or trade executor. Keep the generative LLMs responsible for synthesis and explanation, and deterministic code responsible for facts, arithmetic, risk and orders.

Treat current official OpenRouter Decisions/Jev documentation as authoritative. Start with the pinned model `typesafe/jev-1.13` unless current authoritative documentation requires another identifier. Persist the resolved model version returned by the provider rather than assuming the requested identifier is the exact implementation version.

Resolve the currently documented Decisions endpoint empirically during authorized live qualification if official OpenRouter documentation remains inconsistent. Record the working endpoint and evidence under `docs/observed-responses/`; do not silently guess between conflicting documented paths.

Jev receives:
- deterministic Phase-3 context;
- the validated LLM1 thesis/analysis;
- bounded versioned instructions.

Ensure LLM1's thesis is included in Jev-visible `state`, not merely in application-side question IDs.

Define exactly two initial versioned questions per cycle, evaluated as independent judgments over the same state (neither answer may be treated as context for the other):

1. a Choice question over a small, fixed, versioned candidate-outcome vocabulary with plain-language descriptions and `no_action`/`other` coverage;
2. a single Noul question evaluating one directly stated, versioned set of necessary preconditions for the LLM1 hypothesis, phrased so high means the preconditions hold.

Include the candidate hypothesis and its supporting/contradicting evidence in Jev's actual `state`; do not expect it to infer the thesis from a question key or application metadata. Keep irrelevant market history out of state. If there is no actionable LLM1 candidate, skip Jev inference and persist the deterministic `no_action` reason. Do not use a large batch of Noul hazard checks as a probability product: independent Noul results have domain-dependent calibration and multi-label Noul batches can over-predict positives.

The Jev Choice can select only an application-level candidate outcome, never direction-specific quantities or execution instructions. LLM1 proposes; Jev independently classifies; LLM2 reviews both and may reject or narrow; the deterministic governor has final authority. A Jev selection or high distribution confidence alone cannot authorize an order or override disagreement, missing/stale state, portfolio constraints or policy.

Respect each Jev primitive's actual response contract:
- Choice: choice + probabilities + distribution-derived confidence when returned;
- Score: score/legend + probabilities + distribution-derived confidence when used;
- Noul: Noul result only; do not invent a confidence field for primitives that do not expose one.

Do not describe Jev's returned confidence as probability of correctness. Treat it as a property of answer-distribution separation.

Validate the full response contract locally: expected answer IDs/types, finite in-range Noul probability, exact Choice option membership, complete named probability map, probabilities summing to one within documented tolerance, and finite returned confidence. Index distributions by option name, never iteration order. Do not interpret Noul as having a provider confidence field. For high-impact route/action decisions, make option-order sensitivity measurable with controlled permutations/shadow comparisons; do not silently accept unstable classifications. Treat state as untrusted content and apply the system's independent prompt/injection controls.

For Choice/Score responses with probabilities and documented confidence calculation, recompute confidence deterministically from the probabilities and verify provider output within a documented numerical tolerance. A mismatch produces a failure/no-action record.

Implement client-side preflight validation for current documented Jev limits, including:
- maximum questions/request;
- Choice option count;
- Score level count;
- body size;
- JSON depth;
- state/question token limits;
- relevant request-rate ceilings.

Add boundary tests around each documented limit rather than relying on provider rejection.

Use a bounded application-side Jev rate limiter below the currently documented account ceiling.

Persist:
- `stage_run_id`;
- `cycle_id`;
- `decision_context_id`;
- Jev schema/question version;
- full sanitized Jev `state`;
- exact serialized question definitions;
- actual endpoint used;
- requested and resolved model;
- session/trace IDs;
- typed answers;
- probability distributions/confidence where the primitive supplies them;
- deterministic recomputation result;
- latency;
- provider usage/cost;
- failure state.

Distinguish terminal results such as:
- selected action;
- selected `no_action`;
- abstain due to operational confidence/ambiguity policy;
- invalid schema;
- unavailable provider;
- provider overload/rate limit;
- failed consistency check.

Any threshold is an operational PAPER-mode abstention guard, not a claim of calibrated outcome accuracy. Keep it configurable, versioned and explicitly marked uncalibrated until Phase 10 evaluates it on labeled outcomes. Do not transplant vendor/example thresholds. Calibrate/evaluate per Jev question family and relevant trading horizon; report confidence as a ranking/abstention feature alongside top probability, runner-up probability and ambiguity, never as P(correct). A low-confidence or inconsistent result must abstain to no-action/review, not be coerced into the nearest action.

Jev must never produce quantity, price, order type, time-in-force or other broker order parameters.

Complete only when Jev outputs become replayable typed decision records and safe no-action behavior is explicit for invalid, ambiguous or unavailable outcomes.

---
