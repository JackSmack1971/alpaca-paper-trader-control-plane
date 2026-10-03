# Decision Packet

Use this structure only after an ADR escalation has been confirmed. Map the content into the repository's established ADR template when one exists; do not replace that template with this one.

## Required decision content

### Decision required
State one concrete question the operator can answer. Prefer an explicit choice or authorization request over a broad request for guidance.

### Blocked implementation point
Identify the exact implementation path that cannot proceed without the decision. Distinguish blocked work from unrelated work that may continue.

### Controlling authority
Cite the repository artifact, instruction, invariant, contract, or missing permission that makes the choice non-delegable. If authoritative artifacts conflict, show the conflict directly.

### Context and evidence
Include only evidence that materially changes the choice. Separate observed repository facts from inference. State material unknowns.

### Supported options
For each genuinely viable option, record:

- what changes;
- compatibility or migration impact;
- security, authorization, privacy, or trust-boundary impact when applicable;
- reversibility and operational blast radius;
- downstream implementation consequences;
- evidence supporting feasibility.

Do not add weak options merely to make the record look balanced.

### Recommendation
Optional. If one option is better supported, recommend it and state the decision criterion. Keep recommendation and approval visibly separate.

### Exact operator action
State what the operator must decide, approve, reject, or clarify.

### Resume condition
State the observable condition that permits implementation to continue, such as an accepted ADR, an explicit operator choice recorded in the active task, or newly discovered authoritative evidence.

## Completion check

Before reporting the escalation as prepared, verify:

- every option listed is feasible under known evidence;
- no existing authoritative decision was overlooked;
- the recommendation is not phrased as approval;
- repository-specific paths, statuses, and templates were discovered rather than invented;
- the final response makes the blocked path and resume condition explicit.
