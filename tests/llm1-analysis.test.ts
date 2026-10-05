import { describe, expect, it } from 'vitest';
import { LocalTestHarness } from '../src/domain/local-test-harness.js';
import { buildDecisionContext, type DecisionContextInput } from '../src/domain/decision-context.js';
import { buildLlm1Input, LLM1_ACTION_HYPOTHESES, parseLlm1Analysis } from '../src/domain/llm1-analysis.js';
import { loadLocalFixtures } from '../src/infra/local-fixtures.js';

async function readyContextInput(): Promise<DecisionContextInput> {
  const harness = new LocalTestHarness(await loadLocalFixtures());
  harness.advance(3);
  const state = harness.state();
  const { freshness: _freshness, ...account } = state.account;
  const market = state.market.find((item) => item.symbol === 'AAPL')!;
  const asOf = new Date(Math.max(Date.parse(state.now), Date.parse(market.sourceEventTime))).toISOString();
  const input: DecisionContextInput = {
    cycleId: '00000000-0000-4000-8000-000000000101', symbol: 'AAPL', builtAt: asOf, asOf, market,
    marketHistory: Array.from({ length: 6 }, (_, index) => ({
      T: 't', i: 100 + index, S: 'AAPL', x: 'D', p: 190 + index, s: index + 1,
      t: new Date(Date.parse(asOf) - (5 - index) * 1_000).toISOString(),
    })),
    marketFreshnessMs: 30_000, account, accountFreshnessMs: 60_000,
    capabilities: { tradable: true, shortable: true, fractional: true },
    capabilityProvenance: { source: 'fixture', recordId: 'asset:AAPL', sourceTime: null, receivedAt: asOf }, recentCycleState: null,
  };
  return input;
}

describe('LLM1 market analysis contract', () => {
  it('builds repeatable bounded input from eligible PAPER context only', async () => {
    const built = buildDecisionContext(await readyContextInput());
    expect(built.context.eligible_for_inference).toBe(true);
    const first = buildLlm1Input(built);
    const second = buildLlm1Input(structuredClone(built));
    expect(first).toEqual(second);
    expect(first.normalized_input_ref).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(first.messages[1]!.content).toContain(built.context.decision_context_id);
    expect(first.messages[0]!.content).toContain('no_action');
    expect(first.messages[0]!.content).not.toMatch(/api[_ -]?key|bearer|authorization/i);
  });

  it('rejects blocked, non-PAPER, or oversized contexts before inference', async () => {
    const built = buildDecisionContext(await readyContextInput());
    expect(() => buildLlm1Input({ ...built, context: { ...built.context, blockers: ['stale'] } })).toThrow(/eligible PAPER/);
    expect(() => buildLlm1Input({ ...built, context: { ...built.context, mode: 'live' as 'paper' } })).toThrow(/eligible PAPER/);
    expect(() => buildLlm1Input({ ...built, context: { ...built.context, symbol: 'MSFT' } })).toThrow(/integrity/);
  });

  it('locally validates the closed versioned output schema and explicit no-action rationale', () => {
    const valid = {
      schema_version: 1, action_hypothesis: 'no_action', thesis: 'Evidence is mixed.',
      supporting_evidence: ['Recent return is positive.'], contradicting_evidence: ['Account history is limited.'],
      uncertainty: 'Short history limits confidence.', horizon: { value: 2, unit: 'hours' },
      blocking_preconditions: [], no_action_rationale: 'Wait for stronger evidence.',
    };
    expect(parseLlm1Analysis(valid)).toEqual(valid);
    expect(LLM1_ACTION_HYPOTHESES).toHaveLength(5);
    expect(() => parseLlm1Analysis({ ...valid, action_hypothesis: 'buy_market_order' })).toThrow();
    expect(() => parseLlm1Analysis({ ...valid, no_action_rationale: '' })).toThrow();
    expect(() => parseLlm1Analysis({ ...valid, extra: true })).toThrow();
  });
});
