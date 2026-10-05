import { describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { persistLlm1Attempt, type PersistLlm1Attempt } from '../src/infra/stage-run-store.js';
import type { Llm1Analysis } from '../src/domain/llm1-analysis.js';

const validAnalysis: Llm1Analysis = {
  schema_version: 1, action_hypothesis: 'no_action', thesis: 'Insufficient evidence for a candidate.',
  supporting_evidence: [], contradicting_evidence: ['History is short.'], uncertainty: 'High due to limited history.',
  horizon: { value: 1, unit: 'hours' }, blocking_preconditions: [], no_action_rationale: 'Wait for more data.',
};

const baseAttempt: PersistLlm1Attempt = {
  cycleId: '0199d69b-426b-7d8b-a284-4868d23e3b2f', decisionContextId: '0199d69b-426b-7d8b-a284-4868d23e3b30',
  invocationId: '0199d69b-426b-7d8b-a284-4868d23e3b31', stageVersion: '1.0.0', requestedModel: 'provider/model',
  normalizedInputRef: `sha256:${'a'.repeat(64)}`,
  evidence: {
    attempt_number: 1, status: 'succeeded', started_at: '2026-01-02T03:04:05.000Z', completed_at: '2026-01-02T03:04:06.000Z',
    latency_ms: 1000, http_status: 200, failure_code: null, provider_request_id: 'generation-1', resolved_model: 'provider/model-resolved',
    resolved_provider: 'OpenAI', system_fingerprint: 'fp-1', prompt_tokens: 20, completion_tokens: 30, reported_cost: '0.001',
    response_evidence: { finish_reason: 'stop', metadata_endpoint_count: 2, usage_present: true },
  },
  analysis: validAnalysis,
};

function fakePool(rowCount = 1) {
  const captured: { sql: string; values: unknown[] }[] = [];
  const pool = {
    connect: async () => ({
      query: async (sql: string, values: unknown[]) => {
        captured.push({ sql, values });
        return { rowCount, rows: rowCount ? [{ stage_run_id: values[0] }] : [] };
      },
      release: () => undefined,
    }),
  } as unknown as Pool;
  return { pool, captured };
}

describe('LLM1 stage-run persistence', () => {
  it('stores correlated success provenance and parsed output without raw provider bodies', async () => {
    const { pool, captured } = fakePool();
    const stageRunId = await persistLlm1Attempt(pool, baseAttempt);
    expect(stageRunId).toBe(captured[0]!.values[0]);
    expect(captured[0]!.sql).toContain("WHERE EXISTS");
    expect(captured[0]!.sql).toContain("c.mode = 'paper'");
    expect(captured[0]!.values.slice(1, 4)).toEqual([baseAttempt.cycleId, baseAttempt.decisionContextId, 'succeeded']);
    expect(captured[0]!.values[6]).toBe('1.0.0');
    expect(captured[0]!.values[7]).toBe(baseAttempt.invocationId);
    expect(captured[0]!.values[13]).toBe(baseAttempt.normalizedInputRef);
    expect(JSON.parse(String(captured[0]!.values[20]))).toEqual({ status: 'succeeded', analysis: validAnalysis });
    expect(JSON.stringify(captured[0]!.values)).not.toContain('test-secret-sentinel');
    expect(JSON.stringify(captured[0]!.values)).not.toContain('raw provider response');
  });

  it('persists typed terminal failure and rejects unsanitized evidence before SQL', async () => {
    const { pool, captured } = fakePool();
    const failed: PersistLlm1Attempt = {
      ...baseAttempt, analysis: null,
      evidence: { ...baseAttempt.evidence, status: 'failed', http_status: 402, failure_code: 'provider_credits_exhausted', response_evidence: {} },
    };
    await persistLlm1Attempt(pool, failed);
    expect(JSON.parse(String(captured[0]!.values[20]))).toEqual({ status: 'failed', outcome: 'no_action', failure_code: 'provider_credits_exhausted' });

    await expect(persistLlm1Attempt(pool, { ...baseAttempt, evidence: { ...baseAttempt.evidence, response_evidence: { secret: 'test-secret-sentinel' } } })).rejects.toThrow('LLM1 stage evidence is invalid');
    expect(captured).toHaveLength(1);
  });

  it('does not reveal database errors or accept uncorrelated contexts', async () => {
    const { pool } = fakePool(0);
    await expect(persistLlm1Attempt(pool, baseAttempt)).rejects.toThrow('LLM1 stage attempt persistence failed');
  });
});
