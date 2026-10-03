---
name: phase-closeout
description: >
  Close an active project phase with an evidence-bound report, exact candidate identity, fresh evaluation, and controlled one-phase state transition.
---

# Phase Closeout

1. Re-read the active goal and `docs/control-plane/phase-contracts.json`. Every machine criterion for the active phase must receive exactly one disposition.
2. Recompute the current candidate with `node scripts/control-plane/candidate-id.mjs --snapshot <snapshot-artifact>`. If it differs from the candidate reviewed/verified, evidence is stale; rerun affected lanes.
3. Require independent reviewer and verifier evidence for the same `candidate_id`. Then invoke the fresh read-only `evaluator`; it inspects only the original goal/requirements, frozen candidate/source, and structured verification results and returns `PASS`, `FAIL`, or `INCONCLUSIVE` for that candidate. Never pass builder reasoning, transcripts, or raw logs.
4. Create/update `verification/phase-reports/phase-XX.md` from `TEMPLATE.md`. Record only commands that actually ran and their real outcomes, highest verification rung actually reached, materially changed files, migrations, ADRs/assumptions, limitations, blockers and deferred work.
5. Mark `Phase status: COMPLETE` only when the phase's own completion contract is satisfied, required available checks pass, all three evidence lanes bind the same candidate, and no blocker remains.
6. If complete, create `phase-XX.closeout.json` using schema version 3. It references the exact snapshot artifact and binds charter, goal, snapshot and candidate identities. Runtime qualification is optional and is not required for closeout.
7. Run `node scripts/control-plane/validate-closeout-cli.mjs --phase XX` before advancement. This command recalculates candidate identity and rejects stale evidence, missing/extra acceptance criteria, mismatched goal/charter provenance, or incomplete independent evidence.
8. Only after validation succeeds run `node scripts/control-plane/advance-phase.mjs --phase XX`. Never advance more than one phase per closeout.

The final handoff states only what changed, files changed, commands/checks actually executed with outcomes, and blockers/unverified behavior.
