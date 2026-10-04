import { describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { LocalTestHarness } from '../src/domain/local-test-harness.js';
import { buildDecisionContext } from '../src/domain/decision-context.js';
import { JEV_OUTCOMES, type JevOutcome } from '../src/domain/jev-decision.js';
import { parseLlm1Analysis, type Llm1Analysis } from '../src/domain/llm1-analysis.js';
import { loadConfig } from '../src/infra/config.js';
import { JevRequestRateLimiter } from '../src/services/jev-rate-limiter.js';
import { runPersistedJev } from '../src/services/jev-stage.js';
import { loadLocalFixtures } from '../src/infra/local-fixtures.js';

const analysis: Llm1Analysis = parseLlm1Analysis({
  schema_version: 1, action_hypothesis: 'bullish_increase_long_candidate', thesis: 'Fixture candidate thesis.',
  supporting_evidence: ['The trend is up.'], contradicting_evidence: ['The observation horizon is short.'],
  uncertainty: 'Fixture uncertainty.', horizon: { value: 10, unit: 'minutes' },
  blocking_preconditions: ['Current market state remains fresh.'], no_action_rationale: '',
});

async function makeContext() {
  const harness = new LocalTestHarness(await loadLocalFixtures());
  harness.advance(3);
  const snapshot = harness.state();
  const { freshness: _freshness, ...account } = snapshot.account;
  const market = snapshot.market.find((item) => item.symbol === 'AAPL')!;
  const asOf = new Date(Math.max(Date.parse(snapshot.now), Date.parse(market.sourceEventTime))).toISOString();
  const marketHistory = Array.from({ length: 6 }, (_, index) => ({ T: 't', i: 100 + index, S: 'AAPL', x: 'D', p: 190 + index, s: index + 1, t: new Date(Date.parse(asOf) - (5 - index) * 1_000).toISOString() }));
  const built = buildDecisionContext({
    cycleId: '0199d69b-426b-7d8b-a284-4868d23e3b2f', symbol: 'AAPL', builtAt: asOf, asOf,
    market: { ...market, sourceEventTime: asOf, receivedAt: asOf, lastTrade: { id: 105, price: 195, size: 6, sourceTime: asOf } },
    marketHistory, marketFreshnessMs: 30_000, account, accountFreshnessMs: 60_000,
    capabilities: { tradable: true, shortable: true, fractional: true }, capabilityProvenance: { source: 'fixture', recordId: 'asset:AAPL', sourceTime: null, receivedAt: asOf }, recentCycleState: null,
  });
  if (!built.context.eligible_for_inference) throw new Error('test context must be eligible');
  return built;
}

function response(noul = 0.9) {
  const probabilities = Object.fromEntries(JEV_OUTCOMES.map((option) => [option, option === 'bullish_candidate' ? 0.82 : 0.036])) as Record<JevOutcome, number>;
  return {
    answers: {
      candidate_outcome: { type: 'choice', choice: 'bullish_candidate', probabilities, confidence: 0.73 },
      necessary_preconditions: { type: 'noul', noul },
    },
    model: 'typesafe/jev-1.13-20260917', provider: 'TypeSafe', id: 'gen-dec-jev-1',
    usage: { input_tokens: 280, output_tokens: 18, cost: 0.00001 },
  };
}

function makePool(built: Awaited<ReturnType<typeof makeContext>>, llm1Analysis: Llm1Analysis = analysis) {
  const selects: Array<{ sql: string; values: unknown[] }> = [];
  const inserts: Array<{ sql: string; values: unknown[] }> = [];
  const pool = {
    query: async (sql: string, values: unknown[]) => {
      selects.push({ sql, values });
      if (sql.includes('JOIN normalized_market_records')) return { rowCount: 1, rows: [{
        content_hash: built.contentHash,
        payload: { canonical_json: built.canonicalJson, source_input_sha256: built.context.provenance.input_sha256, source_input_id: built.context.decision_context_id },
        source_payload: { input: built.sourceInput, input_sha256: built.context.provenance.input_sha256 },
      }] };
      return { rowCount: 1, rows: [{ cycle_id: built.context.cycle_id, decision_context_id: built.context.decision_context_id, mode: 'paper', output: { status: 'succeeded', analysis: llm1Analysis } }] };
    },
    connect: async () => ({ query: async (sql: string, values: unknown[]) => { inserts.push({ sql, values }); return { rowCount: 1, rows: [{ stage_run_id: values[0] }] }; }, release: () => undefined }),
  } as unknown as Pool;
  return { pool, selects, inserts };
}

function fakeRateLimiter() {
  let current = 0;
  return new JevRequestRateLimiter(() => current, async (ms) => { current += ms; });
}

describe('persisted Jev stage service', () => {
  it('replays context, loads the exact successful LLM1 output, calls Decisions, and persists policy evidence', async () => {
    const built = await makeContext();
    const { pool, inserts, selects } = makePool(built);
    const config = await loadConfig({ DATABASE_URL: 'postgres://postgres@127.0.0.1/test', LOCAL_TEST_MODE: 'true' });
    let calls = 0;
    const result = await runPersistedJev({
      pool, config, cycleId: built.context.cycle_id, decisionContextId: built.context.decision_context_id,
      llm1StageRunId: '0199d69b-426b-7d8b-a284-4868d23e3b31', sessionId: 'paper-session', rateLimiter: fakeRateLimiter(),
      fetchImpl: async (url, init) => {
        calls += 1;
        expect(new URL(String(url)).pathname).toBe('/api/alpha/decisions');
        expect(JSON.parse(String(init?.body)).state.llm1_candidate.thesis).toBe(analysis.thesis);
        expect((init?.headers as Record<string, string>).authorization).toBe('Bearer local-simulation-only');
        return new Response(JSON.stringify(response()), { status: 200 });
      },
    });
    expect(calls).toBe(2);
    expect(selects).toHaveLength(2);
    expect(result).toMatchObject({ status: 'completed', authority: 'advisory_only', policy: { status: 'selected_candidate', selected_outcome: 'bullish_candidate', calibrated: false } });
    expect(inserts).toHaveLength(2);
    const baselineInput = JSON.parse(String(inserts[0]!.values[19]));
    const baselineOutput = JSON.parse(String(inserts[0]!.values[20]));
    const shadowInput = JSON.parse(String(inserts[1]!.values[19]));
    const shadowOutput = JSON.parse(String(inserts[1]!.values[20]));
    expect(inserts[0]!.sql).toContain("upstream.stage = 'llm1_market_analyst'");
    expect(baselineInput).toMatchObject({ request_role: 'baseline' });
    expect(shadowInput).toMatchObject({ request_role: 'shadow', comparison_group_id: baselineInput.comparison_group_id });
    expect(inserts[0]!.values[8]).not.toBe(inserts[1]!.values[8]);
    expect(baselineOutput).toMatchObject({ status: 'shadow_pending', policy: null, answer_pair: null });
    expect(shadowOutput).toMatchObject({
      status: 'selected_candidate', answers: { necessary_preconditions: { type: 'noul', noul: 0.9 } },
      policy: { calibrated: false, option_order_stability: { status: 'stable' } },
      answer_pair: { policy_source: 'baseline', baseline: { necessary_preconditions: { type: 'noul', noul: 0.9 } }, shadow: { necessary_preconditions: { type: 'noul', noul: 0.9 } } },
    });
    expect(JSON.stringify(inserts)).not.toContain('local-simulation-only');
  });

  it('skips provider inference and persists deterministic no-action when LLM1 selected no_action', async () => {
    const built = await makeContext();
    const noAction = parseLlm1Analysis({ ...analysis, action_hypothesis: 'no_action', no_action_rationale: 'Insufficient setup.' });
    const { pool, inserts } = makePool(built, noAction);
    const config = await loadConfig({ DATABASE_URL: 'postgres://postgres@127.0.0.1/test', LOCAL_TEST_MODE: 'true' });
    let calls = 0;
    const result = await runPersistedJev({
      pool, config, cycleId: built.context.cycle_id, decisionContextId: built.context.decision_context_id,
      llm1StageRunId: '0199d69b-426b-7d8b-a284-4868d23e3b31', sessionId: 'paper-session', rateLimiter: fakeRateLimiter(),
      fetchImpl: async () => { calls += 1; return new Response('{}', { status: 200 }); },
    });
    expect(calls).toBe(0);
    expect(result).toMatchObject({ status: 'skipped', outcome: 'no_action', reason: 'llm1_no_action' });
    expect(inserts[0]!.values[4]).toBeNull();
    expect(JSON.parse(String(inserts[0]!.values[20]))).toMatchObject({ status: 'selected_no_action', policy: { selected_outcome: 'no_action' } });
  });

  it('stores each bounded provider retry and returns no-action after terminal overload', async () => {
    const built = await makeContext();
    const { pool, inserts } = makePool(built);
    const config = await loadConfig({ DATABASE_URL: 'postgres://postgres@127.0.0.1/test', LOCAL_TEST_MODE: 'true' });
    let calls = 0;
    const result = await runPersistedJev({
      pool, config, cycleId: built.context.cycle_id, decisionContextId: built.context.decision_context_id,
      llm1StageRunId: '0199d69b-426b-7d8b-a284-4868d23e3b31', sessionId: 'paper-session', rateLimiter: fakeRateLimiter(), delay: async () => undefined,
      fetchImpl: async () => { calls += 1; return new Response('{}', { status: 529 }); },
    });
    expect(calls).toBe(2);
    expect(inserts).toHaveLength(2);
    expect(result).toMatchObject({ status: 'failed', outcome: 'no_action', failure_code: 'provider_unavailable' });
    expect(inserts.map((item) => item.values[9])).toEqual([1, 2]);
    expect(inserts.map((item) => item.values[3])).toEqual(['retryable_failure', 'failed']);
  });

  it('persists baseline-linked instability abstention when the shadow request ends in 402', async () => {
    const built = await makeContext();
    const { pool, inserts } = makePool(built);
    const config = await loadConfig({ DATABASE_URL: 'postgres://postgres@127.0.0.1/test', LOCAL_TEST_MODE: 'true' });
    let calls = 0;
    const result = await runPersistedJev({
      pool, config, cycleId: built.context.cycle_id, decisionContextId: built.context.decision_context_id,
      llm1StageRunId: '0199d69b-426b-7d8b-a284-4868d23e3b31', sessionId: 'paper-session', rateLimiter: fakeRateLimiter(),
      fetchImpl: async () => {
        calls += 1;
        return calls === 1 ? new Response(JSON.stringify(response()), { status: 200 }) : new Response(JSON.stringify({ error: { code: 'credits_exhausted' } }), { status: 402 });
      },
    });
    expect(result).toMatchObject({ status: 'failed', outcome: 'no_action', failure_code: 'provider_credits_exhausted' });
    expect(inserts).toHaveLength(2);
    const baselineInput = JSON.parse(String(inserts[0]!.values[19]));
    const shadowInput = JSON.parse(String(inserts[1]!.values[19]));
    const failedShadow = JSON.parse(String(inserts[1]!.values[20]));
    expect(shadowInput).toMatchObject({ request_role: 'shadow', comparison_group_id: baselineInput.comparison_group_id });
    expect(failedShadow).toMatchObject({
      status: 'failed', outcome: 'no_action', failure_code: 'provider_credits_exhausted',
      policy: { status: 'abstained', reason: 'option_order_instability', option_order_stability: { status: 'unavailable', baseline_choice: 'bullish_candidate', shadow_choice: null } },
      answer_pair: { policy_source: 'baseline', baseline: { candidate_outcome: { choice: 'bullish_candidate' } }, shadow: null },
    });
    expect(JSON.stringify(failedShadow)).not.toContain('local-simulation-only');
  });
});
