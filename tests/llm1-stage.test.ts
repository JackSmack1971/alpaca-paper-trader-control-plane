import { describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { buildDecisionContext, type BuiltDecisionContext, type DecisionContextInput } from '../src/domain/decision-context.js';
import { LocalTestHarness } from '../src/domain/local-test-harness.js';
import { loadConfig } from '../src/infra/config.js';
import { loadLocalFixtures } from '../src/infra/local-fixtures.js';
import { runPersistedLlm1 } from '../src/services/llm1-stage.js';
import { Llm1RequestRateLimiter } from '../src/services/llm1-rate-limiter.js';

const validAnalysis = {
  schema_version: 1, action_hypothesis: 'no_action', thesis: 'No directional candidate is supported.',
  supporting_evidence: ['The snapshot is recent.'], contradicting_evidence: ['The trend is short.'],
  uncertainty: 'More history is needed.', horizon: { value: 2, unit: 'hours' },
  blocking_preconditions: [], no_action_rationale: 'Wait for a stronger signal.',
};

async function buildContext(eligible = true): Promise<BuiltDecisionContext> {
  const harness = new LocalTestHarness(await loadLocalFixtures());
  harness.advance(3);
  const state = harness.state();
  const { freshness: _freshness, ...account } = state.account;
  const market = state.market.find((item) => item.symbol === 'AAPL')!;
  const asOf = new Date(Math.max(Date.parse(state.now), Date.parse(market.sourceEventTime))).toISOString();
  const input: DecisionContextInput = {
    cycleId: '0199d69b-426b-7d8b-a284-4868d23e3b2f', symbol: 'AAPL', builtAt: asOf, asOf, market,
    marketHistory: eligible ? Array.from({ length: 6 }, (_, index) => ({ T: 't', i: 100 + index, S: 'AAPL', x: 'D', p: 190 + index, s: index + 1, t: new Date(Date.parse(asOf) - (5 - index) * 1_000).toISOString() })) : [],
    marketFreshnessMs: 30_000, account, accountFreshnessMs: 60_000,
    capabilities: { tradable: true, shortable: true, fractional: true },
    capabilityProvenance: { source: 'fixture', recordId: 'asset:AAPL', sourceTime: null, receivedAt: asOf }, recentCycleState: null,
  };
  return buildDecisionContext(input);
}

function fakePool(built: BuiltDecisionContext) {
  const insertValues: unknown[][] = [];
  const pool = {
    query: async () => ({
      rowCount: 1,
      rows: [{
        content_hash: built.contentHash,
        payload: { canonical_json: built.canonicalJson, source_input_sha256: built.context.provenance.input_sha256, source_input_id: built.context.decision_context_id },
        source_payload: { input: built.sourceInput, input_sha256: built.context.provenance.input_sha256 },
      }],
    }),
    connect: async () => ({
      query: async (_sql: string, values: unknown[]) => { insertValues.push(values); return { rowCount: 1, rows: [{ stage_run_id: values[0] }] }; },
      release: () => undefined,
    }),
  } as unknown as Pool;
  return { pool, insertValues };
}

function providerSuccess() {
  return new Response(JSON.stringify({
    id: 'generation-456', model: 'provider/model', system_fingerprint: 'fp-9',
    choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(validAnalysis) } }],
    usage: { prompt_tokens: 80, completion_tokens: 40, cost: '0.0005' },
  }), { status: 200 });
}

function fakeRateLimiter() {
  let current = 0;
  return new Llm1RequestRateLimiter(() => current, async (ms) => { current += ms; });
}

describe('persisted LLM1 stage service', () => {
  it('replays a persisted context, calls injected transport, and persists typed analysis', async () => {
    const built = await buildContext();
    expect(built.context.eligible_for_inference).toBe(true);
    const { pool, insertValues } = fakePool(built);
    const config = await loadConfig({ DATABASE_URL: 'postgres://postgres@127.0.0.1/test', LOCAL_TEST_MODE: 'true', ANALYSIS_MODEL: 'provider/model' });
    let calls = 0;
    const result = await runPersistedLlm1({
      pool, config, cycleId: built.context.cycle_id, decisionContextId: built.context.decision_context_id,
      sessionId: 'local-session', rateLimiter: fakeRateLimiter(), fetchImpl: async (_url, init) => {
        calls += 1;
        expect((init?.headers as Record<string, string>).authorization).toBe('Bearer local-simulation-only');
        return providerSuccess();
      },
    });
    expect(calls).toBe(1);
    expect(result).toMatchObject({ status: 'succeeded', analysis: validAnalysis });
    expect(insertValues).toHaveLength(1);
    expect(insertValues[0]![2]).toBe(built.context.decision_context_id);
    expect(insertValues[0]![13]).toBe(`sha256:${built.contentHash}`);
    expect(JSON.stringify(insertValues)).not.toContain('local-simulation-only');
  });

  it('persists exhausted-credit failure and returns terminal no-action', async () => {
    const built = await buildContext();
    const { pool, insertValues } = fakePool(built);
    const config = await loadConfig({ DATABASE_URL: 'postgres://postgres@127.0.0.1/test', LOCAL_TEST_MODE: 'true', ANALYSIS_MODEL: 'provider/model' });
    const result = await runPersistedLlm1({
      pool, config, cycleId: built.context.cycle_id, decisionContextId: built.context.decision_context_id,
      sessionId: 'local-session', rateLimiter: fakeRateLimiter(), fetchImpl: async () => new Response(JSON.stringify({ error: { code: 'credits_exhausted' } }), { status: 402 }),
    });
    expect(result).toMatchObject({ status: 'failed', outcome: 'no_action', failure_code: 'provider_credits_exhausted' });
    expect(insertValues).toHaveLength(1);
    expect(JSON.parse(String(insertValues[0]![20]))).toMatchObject({ status: 'failed', outcome: 'no_action', failure_code: 'provider_credits_exhausted' });
  });

  it('blocks an ineligible persisted context without calling the provider and persists no-action evidence', async () => {
    const built = await buildContext(false);
    expect(built.context.eligible_for_inference).toBe(false);
    const { pool, insertValues } = fakePool(built);
    const config = await loadConfig({ DATABASE_URL: 'postgres://postgres@127.0.0.1/test', LOCAL_TEST_MODE: 'true', ANALYSIS_MODEL: 'provider/model' });
    let calls = 0;
    const result = await runPersistedLlm1({
      pool, config, cycleId: built.context.cycle_id, decisionContextId: built.context.decision_context_id,
      sessionId: 'local-session', rateLimiter: fakeRateLimiter(), fetchImpl: async () => { calls += 1; return providerSuccess(); },
    });
    expect(calls).toBe(0);
    expect(result).toMatchObject({ status: 'failed', outcome: 'no_action', failure_code: 'decision_context_unavailable' });
    expect(insertValues).toHaveLength(1);
  });

  it('does not contact OpenRouter in local mode when no fake transport is injected', async () => {
    const built = await buildContext();
    const { pool, insertValues } = fakePool(built);
    const config = await loadConfig({ DATABASE_URL: 'postgres://postgres@127.0.0.1/test', LOCAL_TEST_MODE: 'true', ANALYSIS_MODEL: 'provider/model' });
    const result = await runPersistedLlm1({ pool, config, cycleId: built.context.cycle_id, decisionContextId: built.context.decision_context_id, sessionId: 'local-session', rateLimiter: fakeRateLimiter() });
    expect(result).toMatchObject({ status: 'failed', outcome: 'no_action', failure_code: 'provider_authentication_failed' });
    expect(insertValues).toHaveLength(1);
  });
});
