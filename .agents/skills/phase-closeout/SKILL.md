---
name: phase-closeout
description: >
  Close out a phase by reconciling its acceptance evidence into a candidate-bound report and manifest, validating them, and advancing exactly one phase when authorized. Use for requested phase closeout; do not use to report an implementation slice or to bypass a missing evidence lane.
---

# Phase Closeout

Use this workflow when phase closeout is requested or the task explicitly seeks a phase completion determination. A completed slice alone is not phase closeout. Before writing, inspect the active phase, goal, contract, snapshot, candidate and current status; preserve existing reports and evidence. Phase advancement still requires successful validation and explicit task authorization.

1. Re-read the active goal and `docs/control-plane/phase-contracts.json`. Every machine criterion for the active phase must receive exactly one supported disposition. Missing, extra, or ambiguous criteria are blockers to completion.
2. Require an immutable execution snapshot for the current authority state. Recompute the candidate with `node scripts/control-plane/candidate-id.mjs --snapshot <snapshot-artifact>`. If its identity differs from the candidate reviewed or verified, those lanes are stale and must be rerun against the frozen candidate.
3. Obtain independent reviewer and verifier evidence for the same `candidate_id`, then a fresh read-only evaluator result (`PASS`, `FAIL`, or `INCONCLUSIVE`). The evaluator receives only the original goal/requirements, frozen candidate/source, and structured verification records. Never provide builder reasoning, transcripts, or raw logs. A primary-only implementation route does not waive closeout evidence: select these closeout roles through `task-routing` even when they were not needed for the implementation slice. If an independent role is unavailable, report `BLOCKED` or `INCONCLUSIVE`; do not substitute a self-review or self-verification as independent evidence.
4. Create/update `verification/phase-reports/phase-XX.md` from `verification/phase-reports/TEMPLATE.md`. Preserve unrelated report content. Record only commands that ran and their real outcomes, highest verification rung reached, materially changed files, migrations, ADRs/assumptions, limitations, blockers and deferred work.
5. Mark `Phase status: COMPLETE` only when the phase completion contract is satisfied, required checks pass, reviewer/verifier/evaluator bind the same candidate, every criterion has an evidence-backed disposition, and no blocker remains. Otherwise use the repository's truthful status vocabulary and state the resume condition.
6. Only for a fully satisfied phase, create `phase-XX.closeout.json` using schema version 3. It must reference the exact snapshot artifact and bind charter, goal, snapshot and candidate identities. Do not manufacture evidence or mark incomplete criteria PASS.
7. Run `node scripts/control-plane/validate-closeout-cli.mjs --phase XX` before advancement. It recalculates candidate identity and checks criteria, provenance and independent evidence. On failure, retain the failure, repair only the identified cause, and rerun the validator; do not advance.
8. Only after validation succeeds, and when phase advancement is authorized by the task, run `node scripts/control-plane/advance-phase.mjs --phase XX`. Never advance more than one phase per closeout. If authorization is absent, prepare and validate the closeout package but leave phase state unchanged.

**Completion:** The report and manifest reconcile with the active contract, the validator succeeds, and exactly one authorized phase transition is recorded—or the final handoff clearly states why advancement remains blocked or unauthorized. Report the commands/checks actually executed and their outcomes; do not claim phase completion from attempted actions.
