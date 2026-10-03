# Diff Review Lenses

Load only sections whose trigger matches the actual diff. Repository authority (`AGENTS.md`, charter, active goal, current research/ADR records) defines the rule; these lenses define what to interrogate.

## Safety and execution authority

**Trigger:** broker/execution routes, order construction/submission, AI outputs, risk gates, endpoint selection, credentials, or provider configuration.

Check whether the changed path can bypass the repository's execution-authority boundary, weaken PAPER-only enforcement, let advisory/model output become final order authority, expose secrets, or create an unreviewed effect path. Trace from input through deterministic guards to the final side effect, including failure/no-action branches.

## External contracts

**Trigger:** provider SDK/API behavior, remote schemas, authentication, rate limits, transport semantics, or framework behavior that may change outside the repository.

Check whether the implementation relies on a contract supported by current authoritative research or observed qualification evidence. Distinguish repository assumptions from verified provider behavior. If correctness depends on stale, conflicting, or absent evidence, report `UNVERIFIED` and route the contract question to `research-external-contract`; do not guess.

## Persistence and migrations

**Trigger:** database schema, migrations, persisted records, event/state stores, P&L/exposure values, recovery metadata, or serialization.

Check source/schema/accessor consistency, migration ordering and append-only constraints, backwards/forwards compatibility expected by the phase, decimal/time semantics, transaction boundaries, uniqueness, idempotency, replay/recovery behavior, and failure atomicity. Inspect both write and read/reconciliation paths.

## Configuration and validation

**Trigger:** environment/config parsing, persisted/external/model payloads, defaults, optional fields, feature flags, or runtime mode selection.

Check that validation occurs at the correct boundary, invalid states fail safely, defaults do not silently broaden capability, and secrets cannot flow into persistence, fixtures, responses, logs, or exceptions. Verify that configuration changes cannot introduce an unauthorized live/external mode.

## Domain and architecture boundaries

**Trigger:** imports or changes spanning `src/domain/`, `src/infra/`, `src/services/`, `src/api/`, or equivalent architecture boundaries.

Check direction of dependency and responsibility against the current charter/AGENTS authority. Flag only concrete boundary violations that create coupling, I/O leakage, duplicated authority, or bypass orchestration/risk—not harmless file placement preferences. Architecture conflicts requiring a policy choice are `NEEDS_DECISION` and route to `adr-escalation`.

## Reconciliation, concurrency, and retries

**Trigger:** background loops, schedulers, event handling, reconnects, retries, startup recovery, duplicate suppression, locks, or concurrent writes.

Check duplicate delivery, partial failure, restart, stale state, race/interleaving, retry exhaustion, and no-op behavior. Look for stable identities/idempotency keys where the surrounding design requires them. Confirm that recovery preserves the same safety invariants as the happy path.

## HTTP, SSE, and public contracts

**Trigger:** API routes, request/response schemas, SSE events, public types, client/server boundaries, or dashboard-facing contracts.

Check validation, status/error semantics, compatibility, event identity/order/reconnect behavior as applicable, data minimization, and whether public responses can expose secrets or inconsistent persisted state. Follow contract changes into consumers and tests.

## Tests and verification evidence

**Trigger:** any behavioral change; focus more deeply when tests, harnesses, fixtures, guards, or phase acceptance checks change.

Check whether tests exercise the changed behavior and meaningful failure branches rather than only implementation details. Verify that test edits did not weaken assertions, skip relevant coverage, or convert a required integration/live qualification into a fixture-backed imitation. Distinguish hermetic Rung 0/1 evidence from credential- or condition-dependent higher-rung qualification. Test files existing in the diff are not proof they ran.

## Generated or derived artifacts

**Trigger:** generated schemas/types/docs, build outputs, snapshots, manifests, lock-derived files, or any file with a declared source of truth.

Identify the authoritative source and generation path. Review whether source and derived output agree. Do not recommend hand-editing generated output when repository policy requires regeneration. If source/generated consistency cannot be established, mark the affected claim `UNVERIFIED`.

## Scope integrity

**Trigger:** always when the working tree contains paths outside the intended slice, large renames, vendored/generated changes, or a diff that spans multiple phase concerns.

Separate in-scope implementation from unrelated pre-existing changes. Check that the phase did not pull later-phase behavior forward. If the delta cannot be isolated without attributing unrelated user work to the implementation, stop with `NEEDS_DECISION` rather than giving a misleading verdict.
