---
name: schema-migration
description: >
  Create or review PostgreSQL/Drizzle persistence changes while preserving append-only migration history, correlation identities, UTC timestamps, decimal-safe money fields, and replay/audit requirements.
---

# Schema Migration

Use whenever the active slice changes persistence.

1. Inspect all existing schema definitions and migration history before designing the delta.
2. Determine whether the requirement can be satisfied without a schema change. If not, create a new append-only migration; never modify an applied migration.
3. Preserve required correlation fields (`cycle_id`, `decision_context_id`, `stage_run_id`) and provenance links.
4. Use `timestamptz`/UTC for persisted time and decimal-safe PostgreSQL `NUMERIC` handling for money, quantities, P&L, prices and exposure.
5. Design constraints/indexes around real query and reconciliation behavior, not speculative future features.
6. Validate both fresh-schema creation and upgrade-from-current behavior when the repository tooling supports it.
7. Include rollback/recovery consequences in the phase report. A down migration is not a substitute for preserving applied migration history.
8. Review the final diff for accidental edits to old migration files.

Return changed migration files, schema changes, executed checks and unresolved operational risk.
