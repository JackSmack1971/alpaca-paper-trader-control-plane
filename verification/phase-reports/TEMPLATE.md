# Phase XX report — <title>

- Phase status: COMPLETE | BLOCKED | UNVERIFIED | NEEDS_DECISION | FAILED
- Charter SHA-256: <digest>
- Goal SHA-256: <digest>
- Qualification ID: <identity>
- Snapshot ID: <identity>
- Candidate ID: <identity>
- Baseline ref/SHA: <observed baseline>
- Highest verification rung actually reached: 0 | 1 | 2 | 3 | 4 | 5 | none

## Functionality implemented

## Files materially changed

## Migrations introduced

## Verification evidence

| Command / procedure | Outcome / exit | Rung | Evidence / notes |
|---|---:|---:|---|

## Review, verifier and evaluator evidence

## Acceptance criteria

Use the stable criterion IDs from `docs/control-plane/phase-contracts.json` for the active phase. Do not invent, omit, or merge IDs.

## ADRs / assumptions introduced

## Known limitations and blockers

## Deferred work

Only work belonging to later phases should appear here; do not pre-implement it.

## Machine closeout manifest

Before phase advancement, create `phase-XX.closeout.json` beside this report using schema version 2. The manifest references durable control-plane evidence artifacts and must bind the current candidate exactly.

```json
{
  "schema_version": 2,
  "phase": 1,
  "charter_digest": "<canonical SHA-256>",
  "goal_digest": "<canonical SHA-256>",
  "qualification_id": "<qualification identity>",
  "qualification_artifact": "verification/control-plane/qualification.json",
  "snapshot_id": "<execution snapshot identity>",
  "snapshot_artifact": "verification/control-plane/snapshots/<snapshot-id>.json",
  "candidate_id": "<candidate identity>",
  "acceptance": [{"criterion_id": "P01-C01", "disposition": "PASS", "evidence": "<observed evidence>"}],
  "verification": [{"command": "<exact command>", "exit_code": 0, "evidence": "<observed result>"}],
  "review": {"verdict": "PASS", "candidate_id": "<candidate identity>", "evidence": "<review artifact>"},
  "verifier": {"verdict": "PASS", "candidate_id": "<candidate identity>", "evidence": "<verification artifact>"},
  "evaluation": {"verdict": "PASS", "candidate_id": "<candidate identity>", "evidence": "<evaluation artifact>"},
  "unresolved_blockers": [],
  "phase_status": "COMPLETE"
}
```
