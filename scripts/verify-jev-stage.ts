import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { buildDecisionContext, type DecisionContextInput } from '../src/domain/decision-context.js';
import { LocalTestHarness } from '../src/domain/local-test-harness.js';
import { loadConfig } from '../src/infra/config.js';
import { loadLocalFixtures } from '../src/infra/local-fixtures.js';
import { persistDecisionContext } from '../src/infra/decision-context-store.js';
import { runPersistedLlm1 } from '../src/services/llm1-stage.js';
import { runPersistedJev } from '../src/services/jev-stage.js';
import { JevRequestRateLimiter } from '../src/services/jev-rate-limiter.js';
import { Llm1RequestRateLimiter } from '../src/services/llm1-rate-limiter.js';

const validAnalysis = {
  schema_version: 1, action_hypothesis: 'bullish_increase_long_candidate', thesis: 'Validated synthetic evidence supports a bounded bullish candidate.',
  supporting_evidence: ['The deterministic trend is positive.'], contradicting_evidence: ['The observation horizon is short.'],
  uncertainty: 'Synthetic verification only.', horizon: { value: 2, unit: 'hours' },
  blocking_preconditions: [], no_action_rationale: '',
};

function validJevResponse() {
  return {
    answers: {
      candidate_outcome: {
        type: 'choice', choice: 'bullish_candidate',
        probabilities: { bullish_candidate: 0.82, bearish_candidate: 0.036, reduce_risk_candidate: 0.036, exit_candidate: 0.036, no_action: 0.036, other: 0.036 }, confidence: 0.75,
      },
      necessary_preconditions: { type: 'noul', noul: 0.9 },
    },
    model: 'typesafe/jev-1.13-verification', provider: 'TypeSafe', id: 'jev-verification-response',
    usage: { input_tokens: 120, output_tokens: 24, cost: 0.00002 },
  };
}

function fakeRateLimiter() {
  let current = 0;
  return new JevRequestRateLimiter(() => current, async (ms) => { current += ms; });
}

function fakeLlm1RateLimiter() {
  let current = 0;
  return new Llm1RequestRateLimiter(() => current, async (ms) => { current += ms; });
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function main() {
  const config = await loadConfig({ ...process.env, HOST: '127.0.0.1', LOCAL_TEST_MODE: 'true', ANALYSIS_MODEL: process.env.ANALYSIS_MODEL ?? 'local/verification-model' });
  const dbHost = new URL(config.databaseUrl).hostname.toLowerCase();
  assert(['localhost', '127.0.0.1', '[::1]'].includes(dbHost), 'verification requires a loopback database');
  assert(config.localTestMode && !config.openRouterApiKey && !config.alpacaKeyId && !config.alpacaSecretKey, 'verification requires credential-free local test mode');
  const pool = new Pool({ connectionString: config.databaseUrl, max: 2, connectionTimeoutMillis: 3_000, idleTimeoutMillis: 1_000 });
  try {
    await pool.query('SELECT 1');
    const harness = new LocalTestHarness(await loadLocalFixtures(), config.accountStateStaleAfterSeconds);
    harness.advance(3);
    const state = harness.state();
    const market = state.market.find((item) => item.symbol === 'AAPL');
    assert(market, 'fixture market snapshot is unavailable');
    const { freshness: _freshness, ...account } = state.account;
    const asOf = new Date(Math.max(Date.parse(state.now), Date.parse(market.sourceEventTime))).toISOString();
    const cycleId = randomUUID();
    const input: DecisionContextInput = {
      cycleId, symbol: 'AAPL', builtAt: asOf, asOf, market,
      marketHistory: Array.from({ length: 6 }, (_, index) => ({ T: 't' as const, i: 100 + index, S: 'AAPL', x: 'D', p: 190 + index, s: index + 1, t: new Date(Date.parse(asOf) - (5 - index) * 1_000).toISOString() })),
      marketFreshnessMs: 30_000, account, accountFreshnessMs: 60_000,
      capabilities: { tradable: true, shortable: true, fractional: true },
      capabilityProvenance: { source: 'fixture', recordId: 'asset:AAPL', sourceTime: null, receivedAt: asOf }, recentCycleState: null,
    };
    const built = buildDecisionContext(input);
    assert(built.context.eligible_for_inference, 'synthetic fixture context is not eligible');
    await persistDecisionContext(pool, built);
    const calls: string[] = [];
    const success = await runPersistedLlm1({
      pool, config, cycleId, decisionContextId: built.context.decision_context_id, sessionId: cycleId, rateLimiter: fakeLlm1RateLimiter(),
      fetchImpl: async (_url, init) => {
        calls.push('success');
        assert((init?.headers as Record<string, string>).authorization === 'Bearer local-simulation-only', 'fake transport did not receive local sentinel');
        return new Response(JSON.stringify({
          id: 'generation-verify-1', model: config.analysisModel, system_fingerprint: 'fp-verify-1',
          choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(validAnalysis) } }],
          usage: { prompt_tokens: 80, completion_tokens: 40, cost: '0.0005' },
        }), { status: 200 });
      },
    });
    assert(success.status === 'succeeded', 'synthetic success did not complete');
    const jevCalls: string[] = [];
    const jevSuccess = await runPersistedJev({
      pool, config, cycleId, decisionContextId: built.context.decision_context_id, llm1StageRunId: success.stage_run_id,
      sessionId: cycleId, rateLimiter: fakeRateLimiter(),
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as { questions: { candidate_outcome: { criteria: Record<string, unknown> } } };
        jevCalls.push(Object.keys(body.questions.candidate_outcome.criteria).join(','));
        assert((init?.headers as Record<string, string>).authorization === 'Bearer local-simulation-only', 'fake Jev transport did not receive local sentinel');
        return new Response(JSON.stringify(validJevResponse()), { status: 200 });
      },
    });
    assert(jevSuccess.status === 'completed' && jevSuccess.policy.status === 'selected_candidate', `stable synthetic Jev pair did not complete as a candidate: ${JSON.stringify({ status: jevSuccess.status, failure_code: jevSuccess.status === 'failed' ? jevSuccess.failure_code : null, policy: jevSuccess.status === 'completed' ? jevSuccess.policy : null })}`);
    assert(jevCalls.length === 2 && jevCalls[0] !== jevCalls[1], 'Jev baseline and reordered shadow requests were not both sent');
    let failureJevCalls = 0;
    const jevFailure = await runPersistedJev({
      pool, config, cycleId, decisionContextId: built.context.decision_context_id, llm1StageRunId: success.stage_run_id,
      sessionId: cycleId, rateLimiter: fakeRateLimiter(),
      fetchImpl: async () => {
        failureJevCalls += 1;
        return failureJevCalls === 1
          ? new Response(JSON.stringify(validJevResponse()), { status: 200 })
          : new Response(JSON.stringify({ error: { code: 'credits_exhausted' } }), { status: 402 });
      },
    });
    assert(jevFailure.status === 'failed' && jevFailure.outcome === 'no_action', 'Jev provider failure did not fail closed to no-action');
    const failure = await runPersistedLlm1({
      pool, config, cycleId, decisionContextId: built.context.decision_context_id, sessionId: cycleId, rateLimiter: fakeLlm1RateLimiter(),
      fetchImpl: async () => { calls.push('failure'); return new Response(JSON.stringify({ error: { code: 'credits_exhausted' } }), { status: 402 }); },
    });
    assert(failure.status === 'failed' && failure.outcome === 'no_action', 'provider failure did not become terminal no-action');
    assert(calls.length === 2, 'unexpected provider transport call count');
    const rows = await pool.query<{
      invocation_id: string; status: string; failure_code: string | null; provider_request_id: string | null;
      resolved_model: string | null; prompt_tokens: number | null; completion_tokens: number | null;
      reported_cost: string | null; response_evidence: Record<string, unknown>; output: Record<string, unknown>;
    }>(
      `SELECT invocation_id, status, failure_code, provider_request_id, resolved_model, prompt_tokens,
              completion_tokens, reported_cost, response_evidence, output
       FROM stage_runs WHERE cycle_id = $1 AND stage = 'llm1_market_analyst' ORDER BY created_at`, [cycleId],
    );
    assert(rows.rowCount === 2, 'expected exactly two persisted stage attempts');
    const successRow = rows.rows.find((row) => row.status === 'succeeded');
    const failureRow = rows.rows.find((row) => row.status === 'failed');
    assert(successRow && successRow.provider_request_id === 'generation-verify-1' && successRow.prompt_tokens === 80 && successRow.completion_tokens === 40, 'success metadata was not persisted');
    assert(Number(successRow.reported_cost) === 0.0005 && successRow.response_evidence.finish_reason === 'stop', 'success usage evidence was not persisted');
    assert(failureRow?.failure_code === 'provider_credits_exhausted' && failureRow.output.outcome === 'no_action', 'failure evidence was not persisted safely');
    assert(successRow.invocation_id !== failureRow.invocation_id, 'stage attempts unexpectedly share invocation identity');
    const jevRows = await pool.query<{ invocation_id: string; status: string; failure_code: string | null; input: Record<string, unknown>; output: Record<string, unknown> }>(
      `SELECT invocation_id, status, failure_code, input, output FROM stage_runs WHERE cycle_id = $1 AND stage = 'jev_structured' ORDER BY created_at`, [cycleId],
    );
    const baseline = jevRows.rows.find((row) => row.input.request_role === 'baseline' && row.output.status === 'shadow_pending');
    const shadow = jevRows.rows.find((row) => row.input.request_role === 'shadow' && row.output.status === 'selected_candidate');
    const jevFailureRow = jevRows.rows.find((row) => row.status === 'failed');
    assert(jevRows.rowCount === 4 && baseline && shadow && jevFailureRow, 'expected stable baseline/shadow and terminal shadow failure Jev evidence');
    assert(baseline.invocation_id !== shadow.invocation_id, 'baseline and shadow must have distinct invocation identities');
    assert(baseline.input.comparison_group_id === shadow.input.comparison_group_id, 'baseline and shadow comparison group does not correlate');
    const pair = shadow.output.answer_pair as Record<string, unknown>;
    assert(pair.policy_source === 'baseline' && pair.baseline !== null && pair.shadow !== null, 'paired Jev answers were not persisted with policy source');
    assert((shadow.output.option_order_stability as Record<string, unknown>).status === 'stable', 'stable option-order evidence was not persisted');
    const failureBaseline = jevRows.rows.find((row) => row.input.request_role === 'baseline' && row.input.comparison_group_id === jevFailureRow.input.comparison_group_id);
    assert(jevFailureRow.input.request_role === 'shadow' && failureBaseline, 'shadow failure is not linked to its successful baseline request');
    assert(jevFailureRow.failure_code === 'provider_credits_exhausted' && jevFailureRow.output.outcome === 'no_action', 'Jev failure/no-action evidence was not persisted');
    assert((jevFailureRow.output.policy as Record<string, unknown>).reason === 'option_order_instability', 'shadow failure abstention policy was not persisted');
    assert((jevFailureRow.output.option_order_stability as Record<string, unknown>).status === 'unavailable', 'unavailable shadow stability was not persisted');
    const failurePair = jevFailureRow.output.answer_pair as Record<string, unknown>;
    assert(failurePair.policy_source === 'baseline' && failurePair.baseline !== null && failurePair.shadow === null, 'failed shadow did not preserve its typed baseline answer pair');
    console.log(JSON.stringify({ status: 'PASS', simulated: true, mode: 'paper', persistedLlm1Attempts: rows.rowCount, persistedJevAttempts: jevRows.rowCount, jevStatuses: jevRows.rows.map((row) => row.output.status), terminalFailure: 'no_action', providerCalls: calls.length + jevCalls.length + failureJevCalls, liveProviderUsed: false }));
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error && /^[a-zA-Z0-9 _-]{1,120}$/.test(error.message) ? error.message : 'internal verification error';
  console.error(`Jev persisted runtime verification failed: ${message}`);
  process.exitCode = 1;
});
