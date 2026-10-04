---
name: schema-migration
description: >
  Create or review PostgreSQL/Drizzle schema and migration changes for a persistence requirement. Use when stored shape or migration history changes; skip for persistence-code edits that leave schema and stored contracts unchanged.
---

# Schema Migration

Use whenever the active slice changes a persisted schema, migration, or storage contract. Do not use for persistence-adapter code changes that preserve the existing stored shape; use the normal implementation/review workflow for those.

1. Inspect the active requirement, current schema definitions, migration history, relevant readers/writers, and working-tree changes before designing the delta. Establish which migrations are already applied when that fact affects the safe change.
2. Determine whether the requirement can be satisfied without a schema change. If not, create a new append-only migration; never modify an applied migration.
3. Preserve required correlation fields (`cycle_id`, `decision_context_id`, `stage_run_id`) and provenance links.
4. Use `timestamptz`/UTC for persisted time and decimal-safe PostgreSQL `NUMERIC` handling for money, quantities, P&L, prices and exposure.
5. Design constraints/indexes around real query and reconciliation behavior, not speculative future features.
6. Validate fresh-schema creation and upgrade-from-current behavior when repository tooling supports them. If either check is unavailable, name the missing tool/evidence and mark that result `UNVERIFIED`; do not infer a pass from the migration's presence.
7. Identify backfill, deployment ordering, rollback, and recovery consequences that apply to the change. A down migration is not a substitute for preserving applied migration history; do not execute destructive rollback or data transformation without explicit authorization.
8. Review the final diff for edits to previously applied migration files and reconcile schema, migration, and access paths. Preserve unrelated pre-existing changes; if ownership or migration state cannot be established safely, stop and report `BLOCKED`.

**Completion:** Return changed migration/schema files, the requirement and stored contract affected, checks actually executed with outcomes, unavailable checks as `UNVERIFIED`, and unresolved operational/recovery risks. The migration workflow is complete only when the changed contract is represented consistently and supported by executed evidence or an explicit limitation.
