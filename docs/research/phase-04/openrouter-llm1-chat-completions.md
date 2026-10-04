# External contract research: OpenRouter LLM1 chat completions

- Date retrieved: 2026-10-04
- Active phase: 4
- Contract question: Which OpenRouter request/response contract can implement LLM1 structured analysis while requiring compatible providers, capturing provenance/usage, and failing closed on provider errors?

## Sources

| Source | Authority | Retrieved | Notes |
|---|---|---|---|
| https://openrouter.ai/docs/api/api-reference/chat/create-a-chat-completion | Official API reference | 2026-10-04 | Chat Completions request, response and documented HTTP errors. |
| https://openrouter.ai/docs/guides/features/structured-outputs | Official feature documentation | 2026-10-04 | JSON Schema structured output and endpoint-specific support limitations. |
| https://openrouter.ai/docs/guides/routing/provider-selection | Official routing documentation | 2026-10-04 | `require_parameters` and `data_collection` provider-routing controls. |

## Findings

### CURRENT

- LLM chat completions use `POST https://openrouter.ai/api/v1/chat/completions` with Bearer authentication. A successful response includes an ID, resolved model, choices, optional system fingerprint, and usage. Usage may include prompt/completion token counts and reported cost.
- The current token-cap parameter is `max_completion_tokens`; `max_tokens` is documented as deprecated.
- Structured output uses `response_format.type = "json_schema"` with a named strict JSON Schema. Support varies by provider endpoint and can change. `provider.require_parameters = true` excludes providers that do not support all requested parameters.
- Provider routing supports `data_collection = "deny"`, which restricts routing to providers that do not collect user data under OpenRouter's provider metadata/policy classification.
- The API reference documents HTTP errors including 400, 401, 402, 403, 404, 408, 413, 422, 429, 500, 502, and 503. Current SDK references additionally identify 524 edge timeout and 529 provider overload.
- Provider routing metadata can be requested through `X-OpenRouter-Metadata: enabled`; the response may include selected endpoint/provider and generation metadata.
- Official request documentation describes `trace.trace_id` and `session_id` request fields for observability/grouping.

### DERIVED

- Local Zod validation remains necessary because structured-output guarantees differ by endpoint and strict mode may be advisory or translated by a provider.
- A compatible provider may not exist for a configured model. With `require_parameters`, this should produce a terminal typed no-action failure rather than silently dropping structured output.
- A returned provider/native generation identifier and resolved model should be captured when supplied; absence of optional metadata must not invalidate an otherwise locally valid result.
- 401/403 indicate authorization/configuration failures, 402 may indicate exhausted credits, and other non-retryable 4xx errors should not be retried. A single bounded retry may be applied to transport timeout, 408, 429, 5xx gateway/server errors, 524, and 529. The application does not parse `Retry-After`.

### RECOMMENDED

- Use native Node `fetch` behind an injectable transport so offline tests can deterministically simulate success, unsupported structured output, overload, timeout, malformed bodies, and exhausted credits without credentials.
- Send `temperature: 0`, a bounded `max_completion_tokens`, non-streaming `response_format` in strict JSON Schema mode, `provider.require_parameters: true`, and `provider.data_collection: "deny"`. Do not send tools or tool-choice fields.
- Include `cycle_id` as trace identity where supported and a process-session identifier in the request. Capture only sanitized response evidence and structured provenance; never store authorization headers or raw provider error bodies without explicit redaction.
- Enforce one overall bounded request timeout and at most one retry for the explicitly retryable classes. Convert every terminal provider, parsing, schema, unsupported-parameter, timeout, and credit failure into a typed no-action result.
- Apply process-local start spacing to every provider attempt, including retries. `LLM1_MINIMUM_INTERVAL_MS` defaults to 30 seconds and is bounded to 30–120 seconds. This is conservative application policy and does not claim compliance with any account/provider quota; no numeric OpenRouter chat-completions quota was established by this research.

### SPECULATIVE

- Availability of at least one provider for the configured model and complete requested parameter set is not established without live model/provider catalog inspection or an authorized request.
- Provider-specific adherence to JSON Schema and presence of every optional usage/provenance field are not established by the generic API contract.

## Conflicts / unknowns

- The API reference and current TypeScript/Go SDK documentation differ in how comprehensively they enumerate timeout/overload status classes. This does not change the contract: treat documented timeout/server/rate/overload classes as retryable once, while never retrying arbitrary 4xx errors. Exact endpoint behavior remains unobserved.
- This research did not inspect any account-specific provider configuration, model catalog entry, credentials, or live response.

## Implementation consequences

- Build the request against the OpenRouter chat completion endpoint and validate the response envelope with Zod before extracting `choices[0].message.content`.
- Persist requested/resolved model, provider metadata when supplied, native response ID, system fingerprint, normalized input hash/reference, parsed analysis, latency, usage, cost, and typed failure category using a new append-only migration if the existing `stage_runs` columns are insufficient.
- Tests should prove provider routing requests all required parameters and denies data-collecting endpoints; retry at most once for selected transient errors; never retry auth, billing, invalid-request, or schema errors; parse all provider output locally; and prevent secrets/provider error payloads from entering persistence or logs.
- No credential-backed qualification ran. Offline transport fakes can prove deterministic application behavior only and must not be reported as live provider verification.

## Qualification procedure if needed

When credentials are configured outside `LOCAL_TEST_MODE` and an authorized model is selected, issue one bounded no-tools structured-output request with a sanitized PAPER fixture context; capture status, shape, provider/model identity, fingerprint, usage/cost, and generation identifier while redacting all credentials and any sensitive prompt/result values. Do not retry manually beyond the application policy. No such request was run during this research.
