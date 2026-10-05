import { describe, expect, it } from 'vitest';
import { LocalTestHarness } from '../src/domain/local-test-harness.js';
import { buildDecisionContext } from '../src/domain/decision-context.js';
import { applyJevAbstentionPolicy, assertJevRequestWithinBound, buildJevOptionOrderShadow, buildJevStagePlan, compareJevOptionOrder, JEV_MAX_REQUEST_BYTES, JEV_OUTCOMES, parseJevResponse, type JevOutcome, type JevRequest } from '../src/domain/jev-decision.js';
import { parseLlm1Analysis } from '../src/domain/llm1-analysis.js';
import { loadLocalFixtures } from '../src/infra/local-fixtures.js';

const llm1 = parseLlm1Analysis({
  schema_version: 1,
  action_hypothesis: 'bullish_increase_long_candidate',
  thesis: 'Recent validated movement supports a bounded bullish candidate.',
  supporting_evidence: ['The deterministic trend is up.'],
  contradicting_evidence: ['The horizon remains short.'],
  uncertainty: 'Short history limits confidence.',
  horizon: { value: 30, unit: 'minutes' },
  blocking_preconditions: ['Market remains fresh.'],
  no_action_rationale: '',
});

async function eligibleContext() {
  const harness = new LocalTestHarness(await loadLocalFixtures());
  harness.advance(3);
  const snapshot = harness.state();
  const { freshness: _freshness, ...account } = snapshot.account;
  const market = snapshot.market.find((item) => item.symbol === 'AAPL')!;
  const asOf = new Date(Math.max(Date.parse(snapshot.now), Date.parse(market.sourceEventTime))).toISOString();
  const history: unknown[] = [];
  for (let index = 0; index < 6; index += 1) history.push({ T: 't', i: 100 + index, S: 'AAPL', x: 'D', p: 190 + index, s: index + 1, t: new Date(Date.parse(asOf) - (5 - index) * 1_000).toISOString() });
  return buildDecisionContext({
    cycleId: '00000000-0000-4000-8000-000000000101', symbol: 'AAPL', builtAt: asOf, asOf,
    market: { ...market, sourceEventTime: asOf, receivedAt: asOf, lastTrade: { id: 105, price: 195, size: 6, sourceTime: asOf } },
    marketHistory: history, marketFreshnessMs: 30_000, account, accountFreshnessMs: 60_000,
    capabilities: { tradable: true, shortable: true, fractional: true },
    capabilityProvenance: { source: 'fixture', recordId: 'asset:AAPL', sourceTime: null, receivedAt: asOf }, recentCycleState: null,
  });
}

function validResponse() {
  const probabilities = Object.fromEntries(JEV_OUTCOMES.map((option, index) => [option, index === 0 ? 0.78 : 0.22 / (JEV_OUTCOMES.length - 1)])) as Record<JevOutcome, number>;
  return {
    answers: {
      candidate_outcome: { type: 'choice', choice: 'bullish_candidate', probabilities, confidence: 0.75 },
      necessary_preconditions: { type: 'noul', noul: 0.61 },
    },
    model: 'typesafe/jev-1.13-20260917', provider: 'TypeSafe', id: 'gen-dec-example',
    usage: { input_tokens: 100, output_tokens: 10, cost: 0.00001 },
  };
}

describe('Jev domain contract', () => {
  it('builds exactly two independent questions and includes the LLM1 thesis in bounded state', async () => {
    const plan = buildJevStagePlan(await eligibleContext(), llm1, 'session-test');
    expect(plan.status).toBe('ready');
    if (plan.status !== 'ready') return;
    expect(Object.keys(plan.request.questions)).toEqual(['candidate_outcome', 'necessary_preconditions']);
    expect(plan.request.state.llm1_candidate).toMatchObject({ thesis: llm1.thesis, supporting_evidence: llm1.supporting_evidence, contradicting_evidence: llm1.contradicting_evidence, necessary_preconditions: { version: 'jev-necessary-preconditions-v1' } });
    expect(plan.request.state.llm1_candidate.necessary_preconditions.all_must_hold).toHaveLength(2);
    expect(JSON.stringify(plan.request.state.llm1_candidate.necessary_preconditions)).not.toContain('Market remains fresh.');
    expect(plan.request.state.mode).toBe('paper');
    expect(plan.request.model).toBe('typesafe/jev-1.13');
    expect(plan.request_bytes).toBeLessThanOrEqual(24_000);
    expect(plan.request.questions.candidate_outcome.criteria).toHaveProperty('no_action');
    expect(plan.request.questions.candidate_outcome.criteria).toHaveProperty('other');
  });

  it('skips inference deterministically for LLM1 no_action', async () => {
    const noAction = parseLlm1Analysis({ ...llm1, action_hypothesis: 'no_action', no_action_rationale: 'Evidence unavailable.' });
    const plan = buildJevStagePlan(await eligibleContext(), noAction, 'session-test');
    expect(plan).toEqual({ status: 'skipped', outcome: 'no_action', reason: 'llm1_no_action', stage_version: '1.0.0' });
  });

  it('enforces the serialized Decisions body limit on both sides of the byte boundary', async () => {
    const plan = buildJevStagePlan(await eligibleContext(), llm1, 'session-test');
    if (plan.status !== 'ready') throw new Error('expected ready plan');
    const below = { ...plan.request, state: { ...plan.request.state, padding: 'x'.repeat(JEV_MAX_REQUEST_BYTES - plan.request_bytes - 100) } } as unknown as JevRequest;
    expect(assertJevRequestWithinBound(below)).toBeLessThanOrEqual(JEV_MAX_REQUEST_BYTES);
    const above = { ...plan.request, state: { ...plan.request.state, padding: 'x'.repeat(JEV_MAX_REQUEST_BYTES) } } as unknown as JevRequest;
    expect(() => assertJevRequestWithinBound(above)).toThrow(/application byte bound/);
  });

  it('enforces fixed question/option vocabularies, documented session length, and application JSON depth', async () => {
    const plan = buildJevStagePlan(await eligibleContext(), llm1, 'session-test');
    if (plan.status !== 'ready') throw new Error('expected ready plan');
    const extraQuestion = { ...plan.request, questions: { ...plan.request.questions, extra: {} } } as unknown as typeof plan.request;
    expect(() => assertJevRequestWithinBound(extraQuestion)).toThrow(/exactly the versioned Choice and Noul/);
    const extraOption = { ...plan.request, questions: { ...plan.request.questions, candidate_outcome: { ...plan.request.questions.candidate_outcome, criteria: { ...plan.request.questions.candidate_outcome.criteria, extra: 'unsupported' } } } } as unknown as typeof plan.request;
    expect(() => assertJevRequestWithinBound(extraOption)).toThrow(/fixed versioned outcomes/);
    expect(() => assertJevRequestWithinBound({ ...plan.request, session_id: 's'.repeat(257) })).toThrow(/documented character bound/);
    let nested: unknown = 'leaf';
    for (let index = 0; index < 20; index += 1) nested = { child: nested };
    const deepRequest = { ...plan.request, state: { ...plan.request.state, nested } } as unknown as typeof plan.request;
    expect(() => assertJevRequestWithinBound(deepRequest)).toThrow(/JSON depth bound/);
  });

  it('parses named Choice probabilities, surfaces top and runner-up, and keeps Noul free of confidence', () => {
    const parsed = parseJevResponse(validResponse());
    expect(parsed.answers.candidate_outcome).toMatchObject({ choice: 'bullish_candidate', top_probability: 0.78, confidence: 0.75, confidence_recomputed: null });
    expect(parsed.answers.candidate_outcome.runner_up_probability).toBeCloseTo(0.044);
    expect(parsed.answers.candidate_outcome.probabilities.no_action).toBeCloseTo(0.044);
    expect(parsed.answers.necessary_preconditions).toEqual({ type: 'noul', noul: 0.61 });
    expect(parsed.resolved_model).toBe('typesafe/jev-1.13-20260917');
  });

  it('compares a reversed option-order shadow by named outcome and fails closed on a changed classification', async () => {
    const baseline = parseJevResponse(validResponse());
    const plan = buildJevStagePlan(await eligibleContext(), llm1, 'session-test');
    expect(plan.status).toBe('ready');
    if (plan.status !== 'ready') return;
    expect(Object.keys(buildJevOptionOrderShadow(plan.request).questions.candidate_outcome.criteria)).toEqual([...JEV_OUTCOMES].reverse());
    const changed = validResponse();
    changed.answers.candidate_outcome.choice = 'bearish_candidate';
    const stability = compareJevOptionOrder(baseline, parseJevResponse(changed));
    expect(stability.status).toBe('unstable');
    expect(applyJevAbstentionPolicy(baseline, llm1, { version: 'paper-jev-abstention-v1', calibrated: false, minChoiceConfidence: 0.3, minChoiceTopProbability: 0.55, minChoiceMargin: 0.15, minNecessaryPreconditionsProbability: 0.5 }, stability)).toMatchObject({ status: 'abstained', reason: 'option_order_instability' });
  });

  it('rejects missing/extra answer IDs, malformed probability maps, sums, and fabricated Noul confidence', () => {
    const cases = [
      (body: ReturnType<typeof validResponse>) => { delete (body.answers as Record<string, unknown>).necessary_preconditions; },
      (body: ReturnType<typeof validResponse>) => { (body.answers as Record<string, unknown>).extra = {}; },
      (body: ReturnType<typeof validResponse>) => { (body.answers.candidate_outcome.probabilities as Record<string, number>).unexpected = 0; },
      (body: ReturnType<typeof validResponse>) => { body.answers.candidate_outcome.probabilities.bullish_candidate = 0.1; },
      (body: ReturnType<typeof validResponse>) => { (body.answers.necessary_preconditions as Record<string, unknown>).confidence = 0.9; },
    ];
    for (const mutate of cases) {
      const body = validResponse();
      mutate(body);
      expect(() => parseJevResponse(body)).toThrow();
    }
  });

  it('abstains on configured ambiguity and LLM1/Jev disagreement, with an explicitly uncalibrated policy', () => {
    const parsed = parseJevResponse({
      answers: {
        candidate_outcome: { type: 'choice', choice: 'bullish_candidate', probabilities: Object.fromEntries(JEV_OUTCOMES.map((option) => [option, option === 'bullish_candidate' ? 0.42 : 0.116])), confidence: 0.21 },
        necessary_preconditions: { type: 'noul', noul: 0.9 },
      }, model: 'typesafe/jev-1.13-20260917', usage: {},
    });
    const policy = { version: 'paper-jev-abstention-v1', calibrated: false as const, minChoiceConfidence: 0.3, minChoiceTopProbability: 0.55, minChoiceMargin: 0.15, minNecessaryPreconditionsProbability: 0.7 };
    expect(applyJevAbstentionPolicy(parsed, llm1, policy)).toMatchObject({ status: 'abstained', outcome: 'no_action', reason: 'low_choice_confidence', calibrated: false });
    const confident = parseJevResponse({ ...validResponse(), answers: { candidate_outcome: { type: 'choice', choice: 'bearish_candidate', probabilities: Object.fromEntries(JEV_OUTCOMES.map((option) => [option, option === 'bearish_candidate' ? 0.8 : 0.04])), confidence: 0.7 }, necessary_preconditions: { type: 'noul', noul: 0.9 } } });
    expect(applyJevAbstentionPolicy(confident, llm1, policy)).toMatchObject({ status: 'abstained', reason: 'llm1_jev_disagreement' });
    const positive = validResponse();
    (positive.answers.necessary_preconditions as Record<string, unknown>).noul = 0.9;
    const stable = { version: 'jev-choice-option-order-v1' as const, status: 'stable' as const, baseline_choice: 'bullish_candidate' as const, shadow_choice: 'bullish_candidate' as const, maximum_named_probability_delta: 0, maximum_allowed_delta: 0.05 as const };
    expect(applyJevAbstentionPolicy(parseJevResponse(positive), llm1, policy, stable)).toMatchObject({ status: 'selected_candidate', selected_outcome: 'bullish_candidate', option_order_stability: stable });
  });
});
