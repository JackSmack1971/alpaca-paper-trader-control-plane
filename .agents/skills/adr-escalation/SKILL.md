---
name: adr-escalation
description: >
  Escalate an implementation-blocking architecture, security, governance, compatibility, or invariant decision into an operator-ready ADR when repository authority does not authorize a choice. Use when proceeding would change or interpret a protected invariant, establish a materially consequential behavior without an existing decision, or require authority not already granted. Do not use for ordinary reversible implementation judgment, questions already answered by authoritative repository evidence, or choices the user has already made.
---

# ADR Escalation

Turn an implementation-blocking **authority gap** into one decision-ready escalation without silently choosing for the operator.

## 1. Classify before escalating

Inspect the applicable user request, repository instructions, current plans/specifications, existing ADRs, and relevant implementation evidence just far enough to classify the issue.

- **Already decided:** authoritative evidence resolves the choice. Follow it; do not escalate.
- **Judgment within authority:** the choice is reversible, low-blast-radius, and inside established architecture/policy. Decide normally and verify the result.
- **Authority gap:** every viable path would reinterpret or change a protected invariant, establish a materially consequential unresolved architecture/security/data/compatibility behavior, or require permission not already granted. Escalate.

When that boundary is ambiguous, read [`references/escalation-criteria.md`](references/escalation-criteria.md) before deciding.

Do not turn a missing fact into an operator decision. If safe repository inspection can resolve the issue, inspect first.

## 2. Freeze only the affected path

Stop implementation **at the decision boundary**, not the whole task by default.

Continue only low-risk, reversible investigation needed to make the decision legible. Preserve unrelated work and pre-existing user changes. Do not implement multiple competing alternatives merely to discover which policy the operator prefers.

## 3. Build the minimum decision evidence

Identify:

- the exact unresolved decision;
- the controlling invariant, policy, requirement, or missing authority and where it is evidenced;
- the implementation point currently blocked;
- only the options genuinely supported by repository or authoritative evidence;
- material consequences for compatibility, migration, security/authorization, reversibility, operational blast radius, and downstream work;
- evidence gaps that remain material to the decision.

If this evidence shows that an existing authority actually mandates one option, follow that authority instead of escalating.

Do not perform an irreversible, destructive, externally consequential, privacy-sensitive, or security-sensitive action merely to gather decision evidence without the authorization that action itself requires.

## 4. Produce the escalation record

Once escalation is confirmed, read [`references/decision-packet.md`](references/decision-packet.md).

Use the repository's established ADR or decision-record convention when one exists. Locate the actual template, directory, naming convention, and status vocabulary before writing.

- If a repository ADR template or equivalent decision mechanism exists, use it.
- If no decision-record convention exists, do **not** invent `docs/adr/`, a template, a status token, or a governance schema. Present the decision packet in the final response and state that no established repository record location was found.
- If the task does not authorize repository writes, provide the packet without claiming an ADR was created.
- Keep independent decisions separate unless they are inseparable consequences of one choice.

A recommendation is allowed when evidence supports one, but label it as a recommendation. It is not approval.

## 5. Represent the blocked state truthfully

If the repository already has an active phase/change/plan state and defines a decision-blocked status, update that authoritative record when the current task permits it. Use the repository's actual vocabulary.

If no such state mechanism exists, do not create one merely for this skill. The final report must still identify the blocked implementation path and the exact resume condition.

## 6. Completion and resume gate

The escalation is complete only when all applicable evidence exists:

- the affected implementation path is stopped before the unauthorized choice;
- the controlling authority or authority gap is identified;
- the exact operator decision is stated as a concrete choice or authorization request;
- options and consequences are evidence-backed rather than speculative filler;
- the repository-supported ADR/state record is written or updated when authorized, **or** its absence/write restriction is explicitly reported;
- the condition for resuming implementation is explicit.

Report the implementation as **blocked on decision**, not implemented or verified.

Resume only after the missing decision or authority is supplied or discovered in authoritative repository evidence. Reconcile that decision against the active instruction chain before implementing it; if a conflict remains, stay blocked and surface the conflict.

## Hard guardrails

- Model confidence, agent consensus, a skill, or tool availability never grants authority.
- Do not weaken, reinterpret, or route around a protected invariant to preserve momentum.
- Do not invent repository policy, ADR paths, templates, statuses, approvals, or decision history.
- Do not present a recommendation as an operator decision.
- Do not erase or overwrite unrelated pre-existing work while creating the escalation record.
