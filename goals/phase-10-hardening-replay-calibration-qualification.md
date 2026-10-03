---
phase: 10
title: "HARDENING, REPLAY, CALIBRATION AND QUALIFICATION"
source: docs/PROJECT_CHARTER.md
charter_sha256: 8fff9dfd9423c22da6db234e5f7d45f0f6f4414e15c131ba865f3ef7ccc6de5f
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

Evaluate Jev as a component with task-specific limits, not as a generic accuracy oracle. Keep outcomes split by question family, action class, decision horizon and materially different market/regime or asset groups where sample size permits. Report pooled and per-slice results so a good pooled score cannot hide weak domains. Separate threshold-fitting data from held-out evaluation data, prevent future/outcome leakage into inference state, and record Jev requested/resolved model version, question/state version and threshold-policy version for every result. Re-run shadow evaluation and review drift after any Jev model, provider route, question wording, outcome vocabulary or threshold change. Identical-input repeatability and option-order sensitivity should be measured for the deployed questions; disagreement across repeats is evidence for abstention analysis, not a reason to average probabilities blindly.

Before publishing/calibrating an operational threshold for a relevant horizon, require at least 100 labeled PAPER cycles for that horizon or clearly state that the sample requirement has not been met.

Any calibrated threshold report must include:
- sample size;
- horizon;
- base rate;
- outcome definition;
- measured performance;
- uncertainty/confidence interval;
- limitations.

Report discrimination/ranking and calibration separately. For Choice, retain per-option probabilities and measure per-option reliability plus multiclass metrics; for Noul, assess reliability and threshold precision/recall on that specific binary question. Include abstention coverage and the outcomes of abstained cycles. Do not use returned Choice/Score `confidence` as empirical probability of correctness without separate evidence. Thresholds tuned on the qualification sample remain exploratory unless confirmed on held-out or later forward data.

Measure Jev's marginal contribution using replay/ablation:

Condition A:
LLM1 → Jev → LLM2

Condition B:
a documented Jev-disabled comparison using equivalent historical context and otherwise controlled downstream inputs.

Also retain a clearly specified LLM1-only/no-Jev baseline when feasible, and distinguish Jev's standalone classification quality from its incremental effect on the full pipeline. Avoid replay leakage: freeze historical upstream inputs and downstream policy for paired comparisons, disclose where LLM2 was rerun versus held fixed, and do not imply causal benefit from uncontrolled comparisons.

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
