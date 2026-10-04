import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { buildDecisionContext, type DecisionContextInput } from '../src/domain/decision-context.js';
import { LocalTestHarness } from '../src/domain/local-test-harness.js';
import { loadConfig } from '../src/infra/config.js';
import { loadLocalFixtures } from '../src/infra/local-fixtures.js';
import { persistDecisionContext } from '../src/infra/decision-context-store.js';
import { runPersistedLlm1 } from '../src/services/llm1-stage.js';
import { Llm1RequestRateLimiter } from '../src/services/llm1-rate-limiter.js';

const validAnalysis = {
  schema_version: 1, action_hypothesis: 'no_action', thesis: 'No directional candidate is supported.',
  supporting_evidence: ['The snapshot is recent.'], contradicting_evidence: ['The trend is short.'],
  uncertainty: 'More history is needed.', horizon: { value: 2, unit: 'hours' },
  blocking_preconditions: [], no_action_rationale: 'Wait for a stronger signal.',
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function fakeRateLimiter() {
  let current = 0;
  return new Llm1RequestRateLimiter(() => current, async (ms) => { current += ms; });
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
      pool, config, cycleId, decisionContextId: built.context.decision_context_id, sessionId: cycleId, rateLimiter: fakeRateLimiter(),
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
    const failure = await runPersistedLlm1({
      pool, config, cycleId, decisionContextId: built.context.decision_context_id, sessionId: cycleId, rateLimiter: fakeRateLimiter(),
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
    console.log(JSON.stringify({ status: 'PASS', simulated: true, mode: 'paper', persistedAttempts: rows.rowCount, statuses: ['succeeded', 'failed'], terminalFailure: 'no_action', providerCalls: calls.length, liveProviderUsed: false }));
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error && /^[a-zA-Z0-9 _-]{1,120}$/.test(error.message) ? error.message : 'internal verification error';
  console.error(`LLM1 persisted runtime verification failed: ${message}`);
  process.exitCode = 1;
});
