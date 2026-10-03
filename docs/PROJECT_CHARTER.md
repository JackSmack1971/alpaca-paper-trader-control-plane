# PROJECT CHARTER

This charter applies to every `/goal` below. Do not re-decide these choices in later phases. If implementation requires changing a charter invariant, stop, document the required decision and consequences in an ADR, and surface it to the operator.

## Fixed stack

- TypeScript 5.x on Node.js 22 LTS.
- ESM and TypeScript strict mode.
- pnpm with committed lockfile.
- Zod for runtime validation of configuration, persisted records, AI outputs, and external payloads.
- PostgreSQL 16 with Drizzle ORM.
- Checked-in append-only migrations. Never edit an applied migration.
- Fastify for the application HTTP server.
- SSE for server-to-dashboard real-time updates unless later evidence requires otherwise.
- Vitest for unit/integration tests.
- Playwright only for dashboard/browser behavior.
- UTC for persisted timestamps and business logic.
- PostgreSQL `timestamptz` for timestamps.
- `NUMERIC`/decimal-safe handling for currency and quantities. Do not use binary floating-point arithmetic for money or P&L.

## Repository boundaries

- `src/domain/` — pure schemas, types, calculations, invariants, no network or database I/O.
- `src/infra/` — Alpaca, OpenRouter/Jev, PostgreSQL and other external-system adapters; the only layer allowed to directly access credentials.
- `src/services/` — orchestration, decision pipeline, deterministic risk governor and execution workflows.
- `src/api/` — Fastify routes, SSE, dashboard-facing contracts.
- `migrations/` — append-only Drizzle migrations.
- `fixtures/` — sanitized recorded external payloads.
- `config/` — versioned non-secret application configuration.
- `scripts/` — verification, replay and operational tooling.
- `docs/adr/` — architectural decision records.
- `docs/observed-responses/` — sanitized evidence from authorized live API qualification.
- `docs/runbook.md` — operator procedures.

Dependencies flow inward. Domain code must not depend on infrastructure.

## PAPER-ONLY invariant

PAPER TRADING ONLY is a compile/test/runtime invariant, not an operator-selectable mode.

- Define the Alpaca trading base URL as an application constant:
  `https://paper-api.alpaca.markets`.
- Do not expose an environment variable or runtime option capable of replacing it with a live trading endpoint.
- Implement `assertPaperOnly()` and execute it when constructing the Alpaca trading client.
- No code in `src/` may contain the Alpaca live-trading endpoint or a live trading-stream selector.
- Add a guard test that fails if prohibited live-trading endpoint strings appear in production code.
- Every application API response identifies PAPER mode, including an `X-Paper-Mode: true` header.
- Application startup prints an unambiguous PAPER-mode banner without secrets.
- Dashboard UI displays a persistent PAPER-mode indicator.
- Persisted trading/decision records carry `mode = 'paper'`.
- No phase may add live-trading support.

## Identity and correlation

Use stable correlated identities throughout the system:

- `cycle_id`: UUIDv7 for one symbol evaluation opportunity.
- `decision_context_id`: immutable reference to the deterministic context seen by AI.
- `stage_run_id`: one individual LLM1, Jev or LLM2 invocation.
- Persist provider-native IDs when available.
- Persist Alpaca `order_id` and deterministic `client_order_id`.
- Use `cycle_id` as the OpenRouter trace identifier where supported.
- Use one session identifier for related OpenRouter calls during a running application session.

Every downstream record must be traceable back to its cycle and decision context.

## Configuration

Create one Zod-validated configuration boundary.

Every tunable introduced by any phase must be represented there or in a versioned file under `config/`. Do not scatter tunable literals through production code.

A configuration verification command must:

1. validate configuration;
2. fail non-zero on invalid configuration;
3. print only redacted secret representations;
4. identify PAPER mode;
5. report optional credentials as present/missing without printing them.

Secrets must never be serialized into persisted records, API responses, fixture files, dashboard state, structured logs or exception messages.

## AI output contract

The application is always the validation authority.

Provider-side structured-output enforcement is helpful but insufficient. Every AI response must be locally parsed through the versioned Zod schema expected for that stage.

Timeouts, schema failures, malformed responses, provider failures and unavailable models produce typed failure records and a no-action result. They must never produce a partial trade signal.

AI components never receive order-submission authority.

### Jev's system role

TypeSafe Jev is the fast typed-probabilistic second-opinion layer between the first generative analyst (LLM1) and the second generative critic (LLM2). Use it to classify/rank an LLM1 candidate, expose ambiguity and support abstention. Jev is not the market analyst, a general reasoning engine, a price forecaster, the deterministic risk governor or an execution authority. LLM1 synthesizes the candidate thesis; Jev makes bounded structured judgments; LLM2 reviews the evidence and may reject or narrow; deterministic application code owns facts, arithmetic, risk decisions and all broker orders.

Jev's output is evidence, never authority. Neither a selected Choice nor a concentrated distribution can by itself authorize or size an order, waive a deterministic control, or resolve a material disagreement. A Jev failure, invalid result, ambiguous result or policy abstention resolves to no-action/review. Treat the supplied `state` as untrusted data and retain independent input-safety controls.

Respect primitive-specific semantics. Noul returns a yes-probability and has no provider confidence field; approximately 0.5 is uncertain, not a confidence score. Choice returns a selected option and named option probabilities; its `confidence` is distribution-derived separation, not probability of correctness. Score returns a weighted level position and distribution; do not treat interpolation as a measured magnitude. Validate answer IDs/types, option membership, finite/range constraints, named probability coverage and sum, and documented confidence consistency locally. Index distributions by option name, never order. Questions in one Jev request are independent; one answer is not context for another. Do arithmetic, dates, counting and broker/risk calculations in deterministic code.

Pin the Jev model version used for qualification, log the resolved model/provider route and version the state, question definitions and threshold policy. Keep Jev thresholds task- and horizon-specific, initially uncalibrated, and use them as operational abstention rules rather than claims of outcome accuracy. Do not transplant vendor example thresholds. Measure the impact of task/domain shift, repeated-call variation and Choice option-order sensitivity. Keep Jev state bounded and relevant; failures, provider outages and rate limits must fail closed with bounded backoff and no-action behavior.

## Verification ladder

Use the highest rung currently available and report the actual rung reached.

### Rung 0 — offline
Run the complete hermetic automated test suite against fixtures.

### Rung 1 — repository verification
Run type checking, linting, tests, migrations/schema checks, PAPER-only guards, secret-leak guards and configuration verification.

Rungs 0 and 1 must succeed with no credentials installed.

### Rung 2 — OpenRouter
When `OPENROUTER_API_KEY` is present, execute sanitized live qualification for:
- one configured structured-output LLM request;
- one Jev Decisions request.

Persist sanitized observed response shape/evidence.

### Rung 3 — Alpaca 24/7 connectivity
When Alpaca paper credentials are present:
- verify paper account/clock connectivity;
- verify the documented Alpaca test market-data stream using `FAKEPACA` when supported by the current official API.

### Rung 4 — live market-data session
When credentials and an applicable market session are available, verify configured real market-data streaming.

### Rung 5 — end-to-end paper lifecycle
When credentials and market conditions permit, qualify a complete risk-governed PAPER order lifecycle.

If credentials or market conditions prevent a rung, record it explicitly as skipped/blocked. Never replace a missing live verification with a mock and claim it was live-verified.

## Phase reporting

At the end of every phase create/update a phase report containing:

- functionality implemented;
- files materially changed;
- migrations introduced;
- commands actually executed;
- command exit codes/outcomes;
- highest verification rung actually reached;
- assumptions/ADRs introduced;
- known limitations and blockers.

Do not claim anything was tested, verified or observed unless that check actually ran.

Before every phase after Phase 1:
- read this charter;
- read the previous phase report;
- inspect current migrations/schema;
- inspect current repository status and relevant implementation;
- preserve existing user work;
- add a new migration if persistence requirements change rather than modifying an applied migration.

---

# PHASE 1 — FOUNDATION

/goal Establish the production-shaped foundation for an Alpaca/OpenRouter AI PAPER-trading system while implementing the Project Charter above as durable repository policy. Do not implement autonomous trading.

Build the repository structure, configuration boundary, secret handling, database/migration foundation, API/server shell, health/status contracts, developer tooling and operator documentation required by every later phase.

Create real initial persistence rather than placeholder tables. At minimum establish versioned persistence for:

- decision cycles
- decision contexts
- individual AI stage runs
- Alpaca paper orders
- fills
- normalized market records needed for replay
- deterministic risk decisions
- health/connection samples
- kill-switch state
- configuration snapshots
- later cycle outcomes/calibration labels

Schemas must support correlation through `cycle_id`, `decision_context_id` and `stage_run_id`.

Implement PAPER-only enforcement as defined in the charter. Alpaca paper credentials and OpenRouter credentials must remain server-side. There must be no browser-accessible broker/model credential or direct broker/model client.

Configuration must support a future configurable asset universe, model selection, decision cadence, risk settings and non-secret provider settings without hardcoding them throughout production modules.

Application startup must:

1. validate configuration;
2. verify PAPER-only invariants;
3. initialize persistence;
4. expose health/status;
5. report configured external capabilities as connected, unavailable or not configured;
6. identify itself unmistakably as PAPER mode.

Create the verification commands required by the charter and make offline verification succeed without credentials.

Complete only when a fresh documented installation can configure and start the service, validate its environment, identify itself as PAPER mode, initialize the real schema, expose truthful health/status information, enforce the absence of live-trading routes, and report unavailable credential-backed checks rather than bypassing them.

---

# PHASE 2 — ALPACA DATA AND ACCOUNT STATE

/goal Implement the Alpaca PAPER market-data and account-state integration required by the system. Treat current official Alpaca Trading API, Market Data API, paper-trading and streaming documentation as authoritative and preserve the permanent PAPER-only invariant.

Support a configurable universe of Alpaca-paper-tradable assets without assuming all symbols share identical sessions, shortability, fractional eligibility or trading capabilities.

One application process owns the multiplexed Alpaca market-data connection. Dashboard, orchestration and decision services consume normalized in-process state rather than opening independent Alpaca streams.

Account for the current plan's documented stream/subscription limits. Validate the configured universe against known limits before connecting, with an explicitly documented override only when the configured account capability supports it. Treat subscription-limit and connection-limit responses as distinct operational conditions rather than blindly reconnecting.

Normalize external data into application-owned schemas. At minimum provide:

`MarketState`
- symbol
- feed
- last trade
- bid/ask and sizes when available
- recent bar/session-derived state required downstream
- source event time
- receive time
- freshness/staleness state and reason

`AccountState`
- equity
- cash
- buying power
- positions
- open orders
- relevant account restrictions/status
- market clock/session state
- authoritative reconciliation timestamp
- source/provenance metadata

Consumers must not depend on Alpaca-specific wire payload types.

Handle:
- stream authentication;
- the actual frame encodings used by market and trade-update streams;
- array/batched market-data messages;
- control messages;
- disconnect/reconnect;
- authentication failure;
- slow-client conditions;
- malformed payloads;
- duplicated/out-of-order events;
- stale data;
- provider rate limiting;
- restart reconciliation.

Where Alpaca documentation and an official SDK exhibit incompatible authentication/frame behavior, qualify the live PAPER endpoint when credentials are available, record sanitized observed evidence, and implement the behavior supported by evidence rather than guessing.

Treat streaming trade updates as event hints. Periodic broker reconciliation remains authoritative for account/order truth. Make reconciliation cadence configurable, defaulting conservatively to approximately 60 seconds unless current API limits/evidence require otherwise.

Respect the Trading API's current account rate limits, inspect rate-limit headers where available, and use bounded retry/backoff instead of request storms.

Malformed external messages must fail schema validation, increment observability counters, and be discarded or quarantined rather than silently coerced into valid state.

Complete only when downstream modules consume normalized timestamped market/account snapshots, freshness and connection health are independently observable, restart reconciliation restores broker truth, and PAPER-only protections remain intact.

Verify with offline normalization/recovery fixtures plus the highest authorized Alpaca verification rung, including the 24/7 test stream where currently supported.

---

# PHASE 3 — DETERMINISTIC DECISION CONTEXT

/goal Build the deterministic market-state and decision-context layer for the Alpaca PAPER-trading bot.

Transform normalized Phase-2 market/account state into compact, immutable, timestamped and reproducible single-symbol decision contexts suitable for the later OpenRouter LLM → Jev → LLM pipeline.

This layer has no order authority and performs all arithmetic that should be deterministic application code rather than delegating calculations to a language model.

Include, when supported by available history:

- current/reference prices;
- deterministic returns over configured windows;
- trend features;
- volatility features;
- volume/liquidity features;
- spread where available;
- position and portfolio exposure;
- realized/unrealized P&L;
- outstanding-order state;
- cash and buying power;
- symbol capability/tradability state;
- market/session state;
- data age/freshness;
- recent relevant cycle/system state.

Never manufacture unavailable state.

Represent unavailable inputs as `null` and include a structured top-level list describing field path and reason such as:
- stale
- insufficient_history
- no_feed
- unsupported
- pre_market
- unavailable_account_state

Never use `0`, `0.0` or an empty collection as a substitute when those values would carry real meaning.

Every context must carry:
- `decision_context_id`
- `cycle_id`
- symbol
- semantic schema version
- `built_at`
- effective `as_of`
- deterministic transform version(s)
- ordered provenance sufficient to identify the source records/event times used to derive the context.

Define and document deterministic rounding/decimal rules. Identical recorded inputs plus identical transform versions must reproduce byte-equivalent canonical context output.

Keep a single-symbol serialized context bounded. Target no more than roughly 4,000 model tokens and enforce the selected token-budget methodology in automated tests so later schema growth cannot silently create enormous prompts.

Reject or mark stale/incomplete state before inference rather than allowing AI stages to decide whether corrupted context is acceptable.

Complete only when persisted inputs replay into the same versioned context, numerical calculations and freshness rules are tested, unavailable information remains explicit, and provenance can reconstruct what every later AI stage saw.

---

# PHASE 4 — OPENROUTER LLM1 MARKET ANALYST

/goal Implement the first OpenRouter generative stage as the deliberate market-analysis component of the PAPER-trading decision pipeline.

Treat current official OpenRouter documentation as authoritative.

The model is configurable and receives only the bounded Phase-3 decision context plus versioned application instructions. It has no tools or order-submission authority.

Use provider-supported structured-output controls and require parameter support where the current OpenRouter API permits it, but always perform local Zod validation.

Use conservative deterministic inference defaults unless current model/provider requirements dictate otherwise:
- temperature 0 where supported;
- bounded output tokens;
- bounded request timeout;
- at most one controlled retry for retryable server/overload/timeout failures;
- no blind retry for non-retryable 4xx responses.

Define a versioned closed action-hypothesis vocabulary. It must express intent rather than broker order parameters, for example directional/risk outcomes such as:
- bullish/increase-long candidate
- bearish/increase-short candidate where legally eligible
- reduce-risk candidate
- exit-position candidate
- no-action

The exact enum becomes an application contract and is versioned.

The validated response schema must include at least:
- action hypothesis;
- concise thesis;
- supporting evidence;
- contradicting evidence;
- uncertainty;
- relevant horizon in machine-readable form;
- blocking/precondition failures;
- any explicit no-action rationale.

Persist:
- stage identity/version;
- `stage_run_id`;
- `cycle_id`;
- `decision_context_id`;
- requested model;
- resolved model/provider identity returned by OpenRouter when available;
- provider-native generation ID;
- relevant fingerprint/version metadata when provided;
- normalized input reference;
- sanitized raw response/evidence where policy permits;
- parsed structured result;
- latency;
- prompt/completion token usage;
- reported cost;
- failure/error classification.

OpenRouter/model failure, malformed structured output, timeout, unsupported schema behavior or exhausted credits must yield a typed stage failure and terminal no-action path, never a trade recommendation.

Complete only when persisted decision contexts can be submitted through the versioned interface and downstream code receives a validated typed analysis rather than free-form prose.

---

# PHASE 5 — JEV STRUCTURED DECISION LAYER

/goal Integrate TypeSafe Jev through OpenRouter as the fast, typed, probabilistic second-opinion layer between LLM1 and LLM2. Jev classifies/ranks an analyst candidate, exposes ambiguity and supports abstention; it does not synthesize market analysis, forecast prices, decide risk or execute trades.

Treat current official OpenRouter Decisions/Jev documentation as authoritative. Start with the pinned model `typesafe/jev-1.13` unless current authoritative documentation requires another identifier. Persist the resolved model version returned by the provider rather than assuming the requested identifier is the exact implementation version.

Resolve the currently documented Decisions endpoint empirically during authorized live qualification if official OpenRouter documentation remains inconsistent. Record the working endpoint and evidence under `docs/observed-responses/`; do not silently guess between conflicting documented paths.

Jev receives:
- deterministic Phase-3 context;
- the validated LLM1 thesis/analysis;
- bounded versioned instructions.

Ensure LLM1's thesis is included in Jev-visible `state`, not merely in application-side question IDs.

Define exactly two initial versioned questions per cycle, evaluated independently against the same state:

1. a Choice question over a small fixed, versioned candidate-outcome vocabulary with plain-language descriptions and `no_action`/`other` coverage;
2. a single Noul question evaluating one directly stated set of necessary preconditions for the LLM1 hypothesis, phrased so high means the preconditions hold.

Include the LLM1 candidate thesis and relevant supporting/contradicting evidence in Jev's actual state. Do not expect sibling answers to inform each other. Keep irrelevant history out of state. Skip Jev inference and persist the deterministic no-action reason when LLM1 has no actionable candidate. Do not multiply a batch of independent Noul hazard scores into a joint probability.

Respect each Jev primitive's actual response contract:
- Choice: choice + probabilities + distribution-derived confidence when returned;
- Score: score/legend + probabilities + distribution-derived confidence when used;
- Noul: Noul result only; do not invent a confidence field for primitives that do not expose one.

Do not describe Jev's returned confidence as probability of correctness. Treat it as a property of answer-distribution separation.

Validate complete answer IDs/types, finite in-range Noul probability, exact Choice option membership, complete named distributions, probability sums and finite confidence. For high-impact classifications, measure option-order sensitivity with controlled permutation/shadow comparisons. Unstable results must be treated as ambiguity, not silently accepted.

For Choice/Score responses with probabilities and documented confidence calculation, recompute confidence deterministically from the probabilities and verify provider output within a documented numerical tolerance. A mismatch produces a failure/no-action record.

Implement client-side preflight validation for current documented Jev limits, including:
- maximum questions/request;
- Choice option count;
- Score level count;
- body size;
- JSON depth;
- state/question token limits;
- relevant request-rate ceilings.

Add boundary tests around each documented limit rather than relying on provider rejection.

Use a bounded application-side Jev rate limiter below the currently documented account ceiling.

Persist:
- `stage_run_id`;
- `cycle_id`;
- `decision_context_id`;
- Jev schema/question version;
- full sanitized Jev `state`;
- exact serialized question definitions;
- actual endpoint used;
- requested and resolved model;
- session/trace IDs;
- typed answers;
- probability distributions/confidence where the primitive supplies them;
- deterministic recomputation result;
- latency;
- provider usage/cost;
- failure state.

Distinguish terminal results such as:
- selected action;
- selected `no_action`;
- abstain due to operational confidence/ambiguity policy;
- invalid schema;
- unavailable provider;
- provider overload/rate limit;
- failed consistency check.

Any threshold is an operational PAPER-mode abstention guard, not a claim of calibrated outcome accuracy. Keep it configurable, versioned and explicitly marked uncalibrated until Phase 10 evaluates labeled outcomes. Do not use Jev confidence as P(correct); evaluate per question family and relevant trading horizon, including top and runner-up probabilities, abstention coverage and domain limitations. Ambiguous/unstable results abstain to no-action/review.

Jev must never produce quantity, price, order type, time-in-force or other broker order parameters.

Complete only when Jev outputs become replayable typed decision records and safe no-action behavior is explicit for invalid, ambiguous or unavailable outcomes.

---

# PHASE 6 — OPENROUTER LLM2 TRADING CRITIC

/goal Implement the second OpenRouter generative stage as the post-Jev trading critic and risk-aware verifier, completing the LLM → Jev → LLM sandwich.

LLM2 receives only:
- deterministic decision context;
- LLM1 structured analysis;
- Jev selected outcome;
- Jev probabilities/distribution information where available;
- Jev abstention/consistency status and its versioned interpretation policy;
- current portfolio/open-order state;
- versioned critic instructions.

It has no broker tools, no order-submission function and no direct infrastructure authority.

Require a locally validated structured result with a closed verdict enum of exactly:
- `confirm`
- `reject`
- `constrain`

`reject` terminates the AI proposal as no-action.

`confirm` forwards the proposal unchanged to deterministic risk evaluation.

`constrain` may only narrow risk. It carries a versioned application-defined constraints object using fields already understood by deterministic code, such as:
- lower maximum notional/exposure;
- require a safer order policy already supported by the governor;
- tighter liquidity/spread limit;
- shorter validity horizon.

LLM2 must never widen an existing limit, override the governor, create arbitrary order parameters or introduce a new execution capability.

The response must explain:
- material agreement with LLM1/Jev;
- contradictions;
- uncertainty;
- relevant portfolio/risk concerns;
- rationale for confirmation/rejection/constraining.

Treat Jev output as evidence, not a correctness guarantee or command. LLM2 must address material LLM1/Jev disagreement and must not defer automatically to Jev confidence. Missing/invalid Jev data or unresolved disagreement resolves to reject/no-action.

Use the same structured-output, local-validation, timeout/retry, persistence, cost and secret-handling discipline as Phase 4.

Persist references to every upstream stage, including the Jev `stage_run_id`.

Any disagreement requiring unresolved interpretation, malformed output, timeout, unavailable model or provider failure resolves to no-action rather than approval.

Complete only when every actionable AI proposal has a traceable LLM1 analysis, Jev typed decision and LLM2 critic record ready for independent deterministic policy evaluation.

---

# PHASE 7 — DETERMINISTIC RISK GOVERNOR AND PAPER EXECUTION

/goal Implement the deterministic risk governor and Alpaca PAPER execution engine for the completed AI sandwich.

AI output is advisory. Ordinary deterministic application code remains the final authority over whether any PAPER order is legal.

Implement configurable deterministic controls covering at minimum:
- symbol eligibility;
- asset tradability;
- long/short eligibility where applicable;
- fractional-share policy;
- session restrictions;
- buying power;
- cash;
- maximum per-position exposure;
- maximum portfolio exposure;
- maximum order notional;
- concentration limits;
- stale-data rejection;
- stale-account-state rejection;
- AI-stage completeness;
- Jev/critic acceptance;
- explicit Jev agreement/abstention policy; Jev alone can never satisfy policy or waive deterministic rules;
- outstanding-order conflicts;
- duplicate cycle/order protection;
- configurable spread/liquidity restrictions where data exists;
- operator kill switch.

Sizing is deterministic application code, not AI arithmetic. Define and document the sizing formula, its rounding rules, and its interaction with LLM2 constraints. Default to a conservative percentage-of-equity/buying-power formulation and whole shares unless fractional execution is explicitly enabled and the asset/account supports it.

Never derive price, quantity, notional, stop levels or sizing arithmetic from Jev probabilities or Score interpolation. Jev may support only an explicitly versioned abstention or candidate-ranking policy after Phase-10 evidence, always subordinate to deterministic controls.

Start with an explicit versioned order policy such as PAPER market/day orders unless configuration and verified Alpaca capability permit another supported policy.

The governor must persist every rule evaluated, not merely the first failure:

`rule_id`
`verdict`
`observed_value`
`limit_value`
`reason`

No missing required state produces a fallback trade.

Implement the kill switch as persistent server-side risk state. By default activation must:
1. block all new decision cycles/exposure;
2. cancel open PAPER orders where safely possible.

Flattening positions is a separate explicit operator policy and must never occur merely because the kill switch was activated unless specifically configured/confirmed.

Kill-switch state survives restart.

Implement Alpaca `client_order_id` idempotency around cycle identity.

Required submission sequence:

1. derive deterministic `client_order_id` from the cycle/order intent;
2. persist execution intent before network submission;
3. submit once;
4. if submission times out or outcome is ambiguous, query Alpaca by `client_order_id` before any retry;
5. treat a duplicate-active-client-ID response as evidence requiring lookup/reconciliation, not permission to submit another order.

Do not assume Alpaca supports a generic order `Idempotency-Key` header.

Track and persist:
- submitted;
- accepted;
- partial fill;
- fill;
- cancel;
- reject;
- expired/other documented terminal states.

After reconnect/restart, broker reconciliation wins over stale local assumptions.

No code path may target Alpaca live trading.

Complete only when a candidate can reach PAPER execution solely after all required AI and deterministic gates pass, unsafe candidates are observably vetoed, ambiguous submissions are safely reconciled, and local order/account state converges to Alpaca PAPER truth.

---

# PHASE 8 — AUTONOMOUS ORCHESTRATOR

/goal Build the autonomous PAPER-trading orchestrator around the completed market state, deterministic context, OpenRouter LLM1 → Jev → LLM2 pipeline, deterministic risk governor and Alpaca PAPER execution engine.

Do not couple inference to every raw market tick.

Support bounded configurable triggers and cadence.

Initial concurrency policy:
- maximum one in-flight cycle per symbol;
- configurable minimum interval between cycles for the same symbol, initially approximately 60 seconds;
- configurable global in-flight cap, initially 2;
- Jev request token/rate bucket set conservatively below the documented provider account limit;
- configurable event coalescing/debounce window.

Define the deduplication identity around symbol + trigger class + deterministic time bucket/opportunity identity.

Persist an explicit cycle state machine. At minimum:

`snapshot_built`
→ `llm1_analyzed`
→ `jev_decided`
→ `llm2_reviewed`
→ `risk_evaluated`
→ `executed | no_action | blocked`

Also represent failure/reconciliation-required states explicitly rather than overloading normal states.

Every transition records:
- `cycle_id`;
- timestamp;
- trigger;
- prior/new state;
- structured reason;
- stage correlation IDs;
- per-stage latency;
- cumulative end-to-end latency.

Measure at least:
- LLM1 latency;
- Jev latency;
- LLM2 latency;
- risk latency;
- execution latency;
- complete cycle latency.

On application restart:
1. restore persistent kill-switch state;
2. re-establish/reconcile Alpaca account/order truth;
3. restore required market/data state;
4. inspect persisted in-flight cycles;
5. mark cycles that may have crossed an execution boundary as reconciliation-required;
6. never blindly resume an uncertain order submission.

Failure of any AI stage, stale market data, stale/unavailable account state, unresolved execution state or active kill switch blocks new exposure while preserving observability.

Complete only when the application can run unattended against Alpaca PAPER trading and every opportunity follows a bounded, persisted, traceable lifecycle to executed/no-action/blocked outcome without overlapping duplicate decisions.

---

# PHASE 9 — OPERATOR DASHBOARD

/goal Build the real-time operator dashboard for the completed Alpaca/OpenRouter/Jev PAPER-trading system.

Browser code must never possess Alpaca or OpenRouter credentials and must never call broker/model APIs directly.

Serve dashboard state through the application API/SSE layer.

Display at minimum:
- permanent PAPER-mode banner;
- application health;
- Alpaca market-stream status;
- Alpaca trade/account-stream status;
- freshness/staleness;
- account equity;
- cash;
- buying power;
- realized/unrealized P&L;
- positions;
- exposure;
- open/recent orders;
- fills;
- configured universe;
- recent normalized market state;
- active/recent cycle states;
- LLM1 thesis/action hypothesis;
- Jev selected answer;
- Jev probabilities/distribution confidence where supplied;
- clear labeling that Jev confidence describes answer-distribution concentration/separation, not probability of correctness; show abstentions and validation/consistency failures;
- Jev latency;
- LLM2 verdict/constraints;
- deterministic governor rule results;
- completed PAPER trades;
- cumulative PAPER performance;
- OpenRouter token usage/cost;
- per-stage latency;
- warnings/errors;
- persistent kill-switch status.

Compute staleness server-side.

Initial truthfulness policy:
- market state LIVE when sufficiently recent, initially <5 seconds where the feed cadence supports it;
- account state LIVE when sufficiently recent, initially <30 seconds;
- between the live threshold and approximately 3× that threshold show STALE;
- beyond that or after disconnect show UNKNOWN/DISCONNECTED.

Make thresholds configurable because feed/session characteristics differ.

On SSE disconnect, immediately show `DISCONNECTED`; do not continue presenting the previous value as current.

Every real-time panel shows last-server-update information.

Expose the kill switch through a server-side authenticated/authorized application transition routed through the deterministic risk module. The browser never toggles a cosmetic flag. Require deliberate operator confirmation.

Create historical cycle drill-down, e.g. `/cycles/:cycle_id`, backed only by persisted records.

For one cycle an operator must be able to inspect:

decision context
→ LLM1 thesis/evidence
→ Jev questions and answer/probability distribution
→ LLM2 verdict/constraints
→ deterministic governor rules
→ resulting PAPER order/fill or terminal no-action reason.

The historical view must not require live provider calls.

Complete only when the dashboard accurately reflects a running PAPER session, truthfully exposes disconnect/stale/inactive/restart conditions, and can trace any PAPER execution back through all AI and deterministic stages.

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

Evaluate Jev with task-specific limits rather than as a generic accuracy oracle. Where data permits, report pooled and per-slice results by question family, action class, horizon and materially different asset/market regimes. Separate threshold-fitting data from held-out evaluation; prevent outcome/future-data leakage; record requested/resolved model version and question/state/threshold-policy versions. Re-evaluate after changes to model, provider route, wording, vocabulary or policy. Measure repeat-call variation and option-order sensitivity for deployed Choice questions; do not average repeated probabilities blindly.

Before publishing/calibrating an operational threshold for a relevant horizon, require at least 100 labeled PAPER cycles for that horizon or clearly state that the sample requirement has not been met.

Any calibrated threshold report must include:
- sample size;
- horizon;
- base rate;
- outcome definition;
- measured performance;
- uncertainty/confidence interval;
- limitations.

Report ranking/discrimination separately from calibration. For Choice, retain per-option probabilities and report multiclass and per-option reliability measures. For Noul, report reliability and threshold precision/recall for that specific binary question. Include abstention coverage and abstained-cycle outcomes. Thresholds fit on qualification data remain exploratory until confirmed on held-out or later forward data.

Measure Jev's marginal contribution using replay/ablation:

Condition A:
LLM1 → Jev → LLM2

Condition B:
a documented Jev-disabled comparison using equivalent historical context and otherwise controlled downstream inputs.

Also retain an LLM1-only/no-Jev baseline when feasible. Separate Jev's standalone classification quality from its incremental effect on the pipeline. Freeze historical upstream inputs and downstream policy in paired comparisons; disclose whether LLM2 was rerun or held fixed, and do not imply causal benefit from uncontrolled replay.

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
