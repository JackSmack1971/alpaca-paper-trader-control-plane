---
name: verification-ladder
description: >
  Execute and document the charter verification ladder without overstating evidence: hermetic offline checks, repository gates, then credential-backed OpenRouter/Alpaca/PAPER qualification only when actually available.
---

# Verification Ladder

Determine the highest verification rung that is both relevant and actually executable.

## Rung 0 — offline
Run the complete hermetic fixture-backed automated suite.

## Rung 1 — repository verification
Run type checking, linting, tests, migration/schema checks, PAPER-only guards, secret-leak guards and configuration verification. These two rungs must not require credentials.

## Rung 2 — OpenRouter
Only when `OPENROUTER_API_KEY` is genuinely present and use is authorized: one configured structured-output LLM request and one Jev Decisions request. Persist sanitized observed response evidence.

## Rung 3 — Alpaca 24/7 connectivity
Only with authorized paper credentials: paper account/clock plus the current documented test market-data stream when supported.

## Rung 4 — live market-data session
Only when credentials and an applicable session permit real configured market-data streaming.

## Rung 5 — end-to-end PAPER lifecycle
Only when credentials and market conditions permit the complete deterministic risk-governed PAPER lifecycle.

For every attempted check record the exact command/procedure, outcome/exit code, evidence path, and rung. Credential/session absence is `BLOCKED` or `SKIPPED`, not failure and not success. Mocks may support Rung 0 but may never be presented as a live rung.
