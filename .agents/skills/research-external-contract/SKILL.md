---
name: research-external-contract
description: >
  Research and record a version-sensitive external contract when current provider, API, SDK, or framework behavior can change implementation. Use for uncertain or conflicting endpoints, schemas, limits, authentication, streaming, retries, or errors. Not for repository-owned contracts or general technology research.
---

# Research External Contract

Resolve one consequential external-contract uncertainty with current evidence. Research the contract only; do not implement the downstream change.

## 1. Bound the question

- Check existing `docs/research/` first. Reuse prior research only when its source/version applicability still covers the active task.
- State one precise contract question and the implementation decision it can change.
- Limit research to the active phase/task. Consult repository policy or the charter only where it affects this contract or a qualification boundary.
- If no version-sensitive external uncertainty could materially change implementation, return `NOT_NEEDED`.

**Complete when:** the question is answerable from evidence and the affected implementation decision is explicit.

## 2. Establish current evidence

Prefer, in order:

1. current official documentation/specification;
2. official changelog/release notes when version or time matters;
3. official SDK/source/schema when documentation is incomplete or ambiguous;
4. authorized observed behavior only when documentary evidence is insufficient or contradictory.

Record source identity/URL, authority class, retrieval date, and version/applicability when known. Examples, search snippets, community material, model memory, and model confidence are not contract evidence.

If sources conflict, applicability is unclear, prior evidence may be stale, or qualification may be needed, read [`references/evidence-policy.md`](references/evidence-policy.md) before deciding what the evidence supports.

**Complete when:** every implementation-changing conclusion has direct evidence or is explicitly unresolved.

## 3. Record the contract

For material findings, create `docs/research/phase-XX/<topic>.md` from `docs/research/TEMPLATE.md` and complete every section.

Keep the template classes distinct: `CURRENT` is documented/observed fact; `DERIVED` follows from current evidence; `RECOMMENDED` is the project choice; `SPECULATIVE` is unverified and never a contract.

If the evidence cannot establish the contract, record the exact unknown and return `BLOCKED`. Implementation consequences must name only evidence-supported schemas, endpoints, limits, authentication/frame behavior, retries, error classes, persistence/evidence needs, tests, and remaining blockers.

## 4. Resolve conflict without guessing

For a correctness-relevant conflict, follow the adjudication and qualification rules in [`references/evidence-policy.md`](references/evidence-policy.md). Execute observed qualification only when repository policy and runtime conditions authorize it; otherwise keep the conflict unresolved and return `BLOCKED`. Never report an unexecuted procedure or mock as observed evidence.

## 5. Verify and stop

Execute this skill's `scripts/validate-research-artifact.mjs` with Node, passing the research artifact path, then inspect semantic accuracy the script cannot prove.

Return exactly one terminal state:

- `RESOLVED` — evidence is sufficient for the affected implementation decision.
- `BLOCKED` — a material unknown/conflict remains and implementation would require guessing.
- `NOT_NEEDED` — the workflow was not necessary.

Claim `RESOLVED` only when required research is persisted, deterministic validation passes, no unresolved conflict can change implementation, and every claimed observation actually ran.
