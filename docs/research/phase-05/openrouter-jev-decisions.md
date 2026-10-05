# External contract research: OpenRouter Jev Decisions API

- Date retrieved: 2026-10-04
- Active phase: 5
- Contract question: What endpoint, pinned model, request envelope, answer shapes, and provenance fields can implement Jev as a bounded structured second opinion?
- Live qualification: Not run. No credential was read or sent.

## Sources

| Source | Authority | Retrieved | Notes |
|---|---|---|---|
| https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-request | Official OpenRouter API reference | 2026-10-04 | Explicit HTTP method/path, request and response examples, error codes and fields. |
| https://openrouter.ai/blog/tutorials/how-to-use-jev/ | Official OpenRouter guide | 2026-10-04 | OpenRouter SDK and plain HTTP usage, primitive semantics, bounded state guidance. |
| https://openrouter.ai/blog/insights/what-is-jev/ | Official OpenRouter guide | 2026-10-04 | Confidence interpretation and primitive overview. |

## Findings

### CURRENT

- The current API reference and Jev-specific OpenRouter guide both specify `POST https://openrouter.ai/api/alpha/decisions` and the requested model `typesafe/jev-1.13`.
- The reference request contains `model`, `state`, and a keyed `questions` object. The state may be a string, JSON object, or array. Questions support Choice, Noul, and Score primitives.
- A successful example includes `answers`, provider-resolved `model`, optional provider-native `id` and `provider`, and `usage` with input/output tokens and cost.
- Choice answers include `choice`, `probabilities` keyed by option, and `confidence`. Noul answers contain `noul` only. OpenRouter describes Choice confidence as distribution-derived separation/concentration, not probability of correctness.
- The raw Decisions reference documents HTTP errors including 400, 401, 402, 403, 404, 413, 429, 500, 502, 503, 524, and 529.
- The API reference documents `session_id` (maximum 256 characters) and `trace.trace_id` for request grouping and observability.

### DERIVED

- The authoritative operation reference supports using `/api/alpha/decisions` as the request path. It does not establish that every account or model can access the operation.
- Because probabilities and provider metadata arrive as external input, local validation and sanitized persistence are needed before they can influence PAPER review.
- Reversing option order and comparing named probabilities can expose ordering sensitivity for one baseline/shadow pair; it cannot establish model-wide accuracy or calibration.
- A returned Choice confidence can be range-checked and retained, but cannot be deterministically recomputed from the inspected documentation.
- The documented 413 and 429 responses do not establish numeric request-size or account-rate limits.

### RECOMMENDED

- Use a fixed model, bounded provider-visible state, one versioned Choice and one Noul question, and local schema validation before producing advisory evidence.
- Run a bounded reversed-order shadow request and allow a candidate outcome only when both parsed answers agree on the selected outcome and named probabilities remain within the application-defined tolerance.
- Persist request roles, a shared comparison-group identifier, distinct invocation identities, per-attempt provider metadata, both typed answers, and the policy's baseline source.
- Keep unavailable, malformed, inconsistent, or unstable results fail-closed to `no_action`; keep the policy marked uncalibrated and advisory-only.

### SPECULATIVE

- Provider-specific enforcement of Choice/Noul semantics, output confidence behavior, account quota, and model availability is unverified without an authorized live request.
- The selected local probability tolerance, abstention thresholds, JSON-depth bound, and body-byte bound have not been empirically calibrated against a provider population.

### ENDPOINT RECONCILIATION

- Some OpenRouter catalog and System One descriptions use `/v1/systemone` as a contract-family label or SDK base-URL description. The Jev-specific HTTP tutorial, endpoint-specific API reference, and SDK example all map the Jev Decisions operation to `/api/alpha/decisions`.
- Therefore this phase uses the endpoint-specific, Jev-specific OpenRouter documentation as the authoritative HTTP route. The `/api/alpha/decisions` route is documented, not live-qualified. No claim of observed endpoint behavior is made.
- The phase goal's conditional empirical qualification is not triggered by the currently inspected OpenRouter documentation because the operation-specific primary sources agree on the route. If future official operation-specific sources conflict, do not silently switch paths; require authorized live qualification and record sanitized evidence under `docs/observed-responses/`.

### NOT ESTABLISHED BY THE INSPECTED ENDPOINT REFERENCE

- Maximum Choice option count, JSON nesting depth, state/question token budget, request body size, and Decisions account rate ceiling are not stated in the inspected endpoint reference. It gives generic request/response shapes and shows 413/429 errors without numeric thresholds. The tutorial says question count is flexible, but does not publish a numeric ceiling or token/body limits.
- OpenRouter's key endpoint currently labels its `rate_limit` field deprecated and safe to ignore; it is not a current authoritative numeric ceiling for Jev Decisions.
- OpenRouter explains confidence qualitatively but the inspected source does not define a reproducible numerical formula. Application code must validate that the value is finite and in range, retain the supplied distribution, and leave deterministic recomputation marked unavailable until an authoritative formula is documented.
- No account-specific provider routing, model availability, latency, cost, or actual response behavior was qualified.

## Conflicts / unknowns

- The operation-specific API reference and Jev-specific guide agree on the POST route, so no route conflict remains in the inspected sources.
- Numeric request/body/token limits, the Decisions account-rate ceiling, Jev confidence formula, and account-specific model/provider availability remain undocumented or unqualified.

## Implementation consequences

- Construct the endpoint from the official origin plus the separately controlled full path `/api/alpha/decisions`, yielding `https://openrouter.ai/api/alpha/decisions`. Do not append it to the existing `/api/v1` chat-completions base URL, and do not send the request to Chat Completions.
- Keep the requested model pinned, then persist the exact resolved model returned by OpenRouter.
- Include the validated Phase 3 context and LLM1 thesis/evidence in Jev-visible state; ask exactly one fixed-vocabulary Choice and one independent Noul question.
- The application preflight fixes the question count at two, fixes Choice vocabulary at six options including `no_action` and `other`, uses no Score questions, caps serialized request bytes at 24,000 (also treated as a conservative byte-based token upper bound), caps JSON depth at 12, and enforces the documented 256-character session ID bound. These are local safeguards, not numeric OpenRouter Decisions maxima.
- Validate IDs, primitive types, option membership, complete named probability coverage, finite ranges and a local probability-sum tolerance. A Noul record has no confidence field. Do not invent an undocumented Choice confidence recomputation formula.
- Use application-owned conservative bounds where needed, but label them as application policy rather than documented provider limits until official numeric limits are available.
- The implementation uses a process-local minimum start spacing of 30 seconds (at most two starts/minute per process) as conservative application policy. This is not asserted to be below an account-level provider quota; that comparison cannot be proven from the currently inspected public documentation and must be revisited if OpenRouter publishes a Decisions-specific quota.
- A normal actionable Jev inference uses two provider requests: the baseline Choice option order and a reversed-order shadow request. Each request (including retries) is separately passed through the process-local start-spacing limiter, and each response's reported token usage/cost is persisted independently. This approximately doubles normal inference request count and provider usage versus a single request; the pair is bounded to two requests with at most two attempts each.
- The checked-in PAPER abstention policy has explicit confidence/top-probability/margin/Noul cutoffs marked `calibrated: false`. These are operational fail-closed defaults for PAPER review, not accuracy claims or borrowed vendor thresholds.
- Convert unavailable provider calls, invalid outputs, ambiguous policy results, and consistency failures to no-action/review. This is PAPER-only advisory evidence and confers no order authority.

## Qualification procedure if needed

No live qualification was run because the inspected operation-specific official sources agree on the route and provide the request/response shape needed for the implementation decision. If those sources later conflict, or account-specific behavior must be established, use an explicitly authorized credential-backed request with a sanitized PAPER fixture, no tools or orders, bounded request/timeout/retry policy, and record only sanitized status, typed response, provider/model identity, usage/cost, and request identifiers. Never claim provider quotas or numerical confidence correctness from that run alone.

## References

- OpenRouter API reference: https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-request
- OpenRouter Jev guide: https://openrouter.ai/blog/tutorials/how-to-use-jev/
- OpenRouter Jev overview: https://openrouter.ai/blog/insights/what-is-jev/
