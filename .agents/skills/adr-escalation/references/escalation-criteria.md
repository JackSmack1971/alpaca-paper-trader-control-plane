# Escalation Criteria

Load this reference only when it is unclear whether the current issue is ordinary implementation judgment or an authority gap.

## Escalate when

Escalation is warranted when proceeding requires a choice that the active authority chain does not already resolve and the choice can materially affect one or more of these dimensions:

- a protected charter, specification, acceptance criterion, or architectural invariant;
- public or cross-component interfaces and compatibility guarantees;
- persisted data, schema semantics, migrations, retention, or irreversible transformations;
- authentication, authorization, trust boundaries, secrets, privacy, or security posture;
- deployment topology, external side effects, production behavior, or operational blast radius;
- ownership, approval, policy, compliance, or other authority explicitly reserved to a human or external body;
- a dependency or platform commitment that is difficult or costly to reverse and is not already authorized.

A choice can also require escalation when authoritative artifacts conflict and no governing precedence resolves the conflict.

## Do not escalate when

Do not use ADR escalation merely because a choice is non-trivial. Continue with normal engineering judgment when the decision is already authorized and is reasonably reversible, bounded, and verifiable, for example:

- selecting among equivalent internal implementation techniques that preserve established contracts;
- choosing focused tests or inspection steps within repository policy;
- fixing a defect where the intended behavior is already specified;
- following an existing ADR, plan, issue, specification, or explicit user decision;
- gathering safe read-only evidence needed to determine whether escalation is actually necessary.

Do not use escalation as a substitute for research. A missing fact that can be resolved safely is an evidence gap, not automatically an authority gap.

## Boundary tests

Ask these questions in order:

1. **Authority:** Is there an existing authoritative decision that answers this?
2. **Permission:** Has the user or repository already authorized the consequential action?
3. **Contract:** Would the choice change a protected contract, invariant, security boundary, or durable compatibility behavior?
4. **Reversibility:** Can the choice be reversed cheaply and safely without migration or external consequence?
5. **Blast radius:** Could a wrong choice materially affect users, data, security, operations, or multiple components?
6. **Observability:** Can normal verification quickly reveal a wrong choice before harm occurs?

Escalate when authority or permission is missing **and** the unresolved choice is materially consequential. Do not escalate solely because uncertainty exists.

## Divergence handling

| Condition | Required response |
|---|---|
| Existing decision found | Follow it; ADR escalation is unnecessary unless the decision itself conflicts with higher authority. |
| Authorities conflict | Identify the exact conflict. Apply an explicit repository precedence rule if one exists; otherwise escalate the conflict. |
| Evidence is insufficient | Gather safe evidence. If a required evidence-gathering action itself needs permission, stop and request that permission. |
| Repository template/path absent | Do not invent one. Provide the decision packet in the final response. |
| Repository writes are not authorized | Do not write. Provide the packet and name the missing write authorization. |
| Pre-existing working-tree changes overlap the prospective ADR/state file | Preserve them; inspect ownership and avoid overwriting. If a safe merge is unclear, report the overlap as a blocker. |
| Multiple independent unresolved decisions | Separate them so one approval does not silently authorize another. |
| User already made the decision | Treat it as resolved unless it conflicts with a higher-priority active constraint; then surface that conflict. |
| Validation remains inconclusive after reasonable safe inspection | Report the uncertainty and missing evidence; do not manufacture balanced-looking options. |
