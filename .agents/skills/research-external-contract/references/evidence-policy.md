# Evidence policy for external contracts

Read this reference only when documentary sources conflict, applicability is ambiguous, prior research may be stale, or observed qualification may be needed.

## Applicability beats nominal authority

Prefer the source that directly governs the contract being implemented. Evaluate evidence by:

1. **Authority** — official specification/docs, changelog, SDK/source/schema, then authorized observation.
2. **Applicability** — exact API/product/endpoint/model/SDK version, account tier, transport, environment, and date range.
3. **Directness** — explicit contract statement beats an example from which behavior must be inferred.
4. **Temporal fit** — later authoritative changes supersede earlier behavior when they apply to the same contract.
5. **Observed scope** — an observation proves only the surface, environment, account capability, and time actually exercised.

Do not use a fixed freshness TTL. Revalidate when the active implementation targets a newer version, a relevant changelog/change exists after retrieval, the provider is known to change the surface, or the previous artifact did not establish applicability to the current task.

## Conflict handling

A conflict is implementation-relevant when competing interpretations could change a schema, endpoint, authentication method, framing/parser behavior, limit, retry policy, error handling, safety boundary, or test oracle.

When that happens:

- record each source and the competing claims;
- identify whether version, account tier, environment, transport, or publication date explains the discrepancy;
- do not average, merge, or silently choose between incompatible contracts;
- use `DERIVED` only for conclusions that follow from compatible `CURRENT` facts;
- use `RECOMMENDED` only after the evidence supports a project choice;
- keep the result `BLOCKED` if a remaining conflict could alter implementation correctness.

A lower-authority source may identify a contradiction worth investigating, but it does not override applicable official evidence by itself.

## Qualification decision

Qualification is justified only when all are true:

- the unresolved contract can materially change implementation;
- documentary evidence cannot resolve it;
- the repository charter/policy permits the relevant observation;
- runtime authorization, credentials, and conditions exist;
- a minimal discriminating observation is possible without exceeding the allowed effect boundary.

Prefer a read-only or otherwise non-mutating observation. If the contract concerns an allowed PAPER execution lifecycle or a bounded provider request, keep the action to the minimum expressly authorized by repository policy. Never cross into live trading or another production-effect surface merely to obtain evidence.

If any prerequisite is missing, document the exact blocker and the smallest future procedure that would resolve it. This is a valid `BLOCKED` result.

## Observed-evidence record

For an executed qualification, preserve enough sanitized detail for another engineer to understand what was actually observed:

- UTC observation time;
- target environment/surface and applicable version/model when available;
- request method/path or operation class;
- contract-relevant request shape without credentials;
- response status/control frame and contract-relevant payload shape;
- relevant limit/rate/error headers when necessary;
- provider-native request/generation identifiers only when repository policy permits persistence;
- interpretation and remaining limitations.

Store sanitized raw/shape evidence under the repository's designated observed-response path when policy requires it, and link that evidence from the research artifact. Never copy secrets, bearer tokens, private keys, or sensitive account data into research files.

## Sufficient evidence to stop

`RESOLVED` requires all of the following:

- the precise contract question has an answer applicable to the active task;
- every implementation-changing claim traces to `CURRENT` evidence or a valid `DERIVED` conclusion;
- no unresolved contradiction could change the implementation choice;
- the `RECOMMENDED` project choice is distinguishable from provider fact;
- any live/observed claim is backed by an observation that actually ran;
- limitations are explicit rather than hidden in confident prose.

Otherwise return `BLOCKED` or `NOT_NEEDED` as defined by the root skill.
