---
phase: 10
title: "HARDENING, REPLAY, CALIBRATION AND QUALIFICATION"
source: docs/PROJECT_CHARTER.md
charter_sha256: cf9c8cd02da7b06e4042143c657cb7e069f42664b22c9e652381fb267391e003
---

# PHASE 10 — HARDENING, REPLAY, CALIBRATION AND QUALIFICATION

/goal Harden and qualify the complete Alpaca/OpenRouter/Jev PAPER-trading system. Remain permanently PAPER TRADING ONLY. Do not add live-trading support.

Build deterministic replay/evaluation from persisted historical evidence so decision contexts, LLM1 analyses, Jev answers, LLM2 reviews, deterministic vetoes, execution behavior, timing, usage/cost and realized PAPER outcomes can be inspected without mutating original historical records.

Historical evidence is immutable. Replay creates new evaluation records referencing historical inputs rather than rewriting what happened.

Exercise at minimum:
- Alpaca disconnect/reconnect;
- market-data staleness;
- account-state staleness;
- malformed external events;
- duplicate/out-of-order events;
- stream subscription/connection limits;
- API rate limits;
- ambiguous/timed-out PAPER order submission;
- duplicate client-order IDs;
- restart reconciliation;
- conflicting open orders;
- OpenRouter timeout;
- malformed LLM output;
- unsupported structured-output behavior;
- Jev schema/limit violations;
- Jev overload/rate limit;
- confidence-consistency failure;
- exhausted/unavailable model service;
- kill-switch activation and restart persistence.

Define the outcome-label schema before using results for calibration.

For every completed decision cycle suitable for evaluation, record a realized forward outcome over the horizon associated with the decision. Include the reference price methodology, horizon, timestamps and whether a PAPER fill occurred.

Do not claim a Jev confidence threshold is universally valid.

Before publishing/calibrating an operational threshold for a relevant horizon, require at least 100 labeled PAPER cycles for that horizon or clearly state that the sample requirement has not been met.

Any calibrated threshold report must include:
- sample size;
- horizon;
- base rate;
- outcome definition;
- measured performance;
- uncertainty/confidence interval;
- limitations.

Measure Jev's marginal contribution using replay/ablation:

Condition A:
LLM1 → Jev → LLM2

Condition B:
a documented Jev-disabled comparison using equivalent historical context and otherwise controlled downstream inputs.

Report differences in:
- decision/outcome quality;
- abstention/veto behavior;
- latency;
- token usage;
- cost.

Do not rewrite historical production/paper records to manufacture the comparison.

Primary qualification must be reproducible through the deterministic replay harness and offline failure tests.

When credentials and market conditions are available, additionally perform an authorized end-to-end live PAPER qualification showing:

real Alpaca market state
→ deterministic context
→ LLM1
→ Jev
→ LLM2
→ deterministic risk governor
→ PAPER order/no-action result
→ broker reconciliation
→ real-time dashboard update.

A live market-session qualification is supplementary evidence when the environment permits it; inability to be present during an applicable market session must not cause fabricated verification claims.

Where a qualification criterion cannot currently be executed, record:
- exact blocker;
- supporting evidence;
- exact command/procedure that would satisfy it once unblocked.

An evidenced blocker is an acceptable reported outcome. A silently skipped criterion is not.

Project completion requires:
- relevant offline automated checks passing;
- replay/failure qualification passing;
- secrets remaining protected;
- PAPER-only guards passing;
- no live-order route existing;
- every actually executed verification rung documented;
- outstanding external/runtime blockers explicitly recorded;
- operator/developer/runbook documentation accurately matching the resulting implementation.

Do not call the project fully live-qualified unless the corresponding credential-backed verification rung actually ran successfully.

A particularly important change is that PAPER-only is now mechanically enforced instead of remaining a prose requirement, while live verification is a graded evidence ladder rather than a binary “verified/not verified” claim. The Jev stage also now respects primitive-specific output semantics and treats its confidence value as distribution separation rather than outcome accuracy. Pasted text

I’d use this charter once at the top of your project specification and feed the ten `/goal` prompts to your control plane sequentially rather than pasting the whole document into one implementation session.
