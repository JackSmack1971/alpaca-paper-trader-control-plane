---
phase: 5
title: "JEV STRUCTURED DECISION LAYER"
source: docs/PROJECT_CHARTER.md
charter_sha256: cf9c8cd02da7b06e4042143c657cb7e069f42664b22c9e652381fb267391e003
---

# PHASE 5 — JEV STRUCTURED DECISION LAYER

/goal Integrate TypeSafe Jev through OpenRouter as the fast structured decision layer between LLM1 and LLM2.

Treat current official OpenRouter Decisions/Jev documentation as authoritative. Start with the pinned model `typesafe/jev-1.13` unless current authoritative documentation requires another identifier. Persist the resolved model version returned by the provider rather than assuming the requested identifier is the exact implementation version.

Resolve the currently documented Decisions endpoint empirically during authorized live qualification if official OpenRouter documentation remains inconsistent. Record the working endpoint and evidence under `docs/observed-responses/`; do not silently guess between conflicting documented paths.

Jev receives:
- deterministic Phase-3 context;
- the validated LLM1 thesis/analysis;
- bounded versioned instructions.

Ensure LLM1's thesis is included in Jev-visible `state`, not merely in application-side question IDs.

Define exactly two initial versioned questions per cycle:

1. a Choice question over the application's fixed outcome vocabulary, which must include `no_action`;
2. a Noul question evaluating whether the application-defined preconditions for the LLM1 hypothesis hold.

Respect each Jev primitive's actual response contract:
- Choice: choice + probabilities + distribution-derived confidence when returned;
- Score: score/legend + probabilities + distribution-derived confidence when used;
- Noul: Noul result only; do not invent a confidence field for primitives that do not expose one.

Do not describe Jev's returned confidence as probability of correctness. Treat it as a property of answer-distribution separation.

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

Any confidence threshold is an operational PAPER-mode guard, not a claim of calibrated outcome accuracy. Keep it configurable, versioned and explicitly marked uncalibrated until Phase 10 measures it.

Jev must never produce quantity, price, order type, time-in-force or other broker order parameters.

Complete only when Jev outputs become replayable typed decision records and safe no-action behavior is explicit for invalid, ambiguous or unavailable outcomes.

---
