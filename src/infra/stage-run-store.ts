import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { z } from 'zod';
import type { BuiltDecisionContext } from '../domain/decision-context.js';
import { parseLlm1Analysis, type Llm1Analysis } from '../domain/llm1-analysis.js';
import type { Llm1AttemptEvidence } from './openrouter-llm1.js';
import { replayDecisionContext } from './decision-context-store.js';

export class PersistedLlm1ContextError extends Error {
  constructor(readonly code: 'not_found' | 'identity_mismatch' | 'invalid') {
    super(`persisted LLM1 context ${code}`);
    this.name = 'PersistedLlm1ContextError';
  }
}

export async function loadPersistedLlm1Context(pool: Pool, cycleId: string, decisionContextId: string): Promise<BuiltDecisionContext> {
  let built;
  try { built = await replayDecisionContext(pool, cycleId); }
  catch { throw new PersistedLlm1ContextError('invalid'); }
  if (!built) throw new PersistedLlm1ContextError('not_found');
  if (built.context.decision_context_id !== decisionContextId) throw new PersistedLlm1ContextError('identity_mismatch');
  return built;
}

export type PersistLlm1Attempt = {
  cycleId: string;
  decisionContextId: string;
  invocationId: string;
  stageVersion: string;
  requestedModel: string;
  normalizedInputRef: string;
  evidence: Llm1AttemptEvidence;
  analysis: Llm1Analysis | null;
};

const evidenceSchema = z.object({
  finish_reason: z.string().max(64).nullable().optional(),
  metadata_endpoint_count: z.number().int().nonnegative().max(10_000).nullable().optional(),
  usage_present: z.boolean().optional(),
}).strict();

/** Persist one provider attempt without retaining raw provider bodies or credential material. */
export async function persistLlm1Attempt(pool: Pool, input: PersistLlm1Attempt): Promise<string> {
  const stageRunId = randomUUID();
  const attempt = input.evidence;
  let safeEvidence: z.infer<typeof evidenceSchema>;
  let analysis: Llm1Analysis | null;
  try {
    safeEvidence = evidenceSchema.parse(attempt.response_evidence);
    analysis = input.analysis === null ? null : parseLlm1Analysis(input.analysis);
  } catch { throw new Error('LLM1 stage evidence is invalid'); }
  if (!/^sha256:[a-f0-9]{64}$/.test(input.normalizedInputRef)) throw new Error('LLM1 stage input reference is invalid');
  const output = input.analysis
    ? { status: 'succeeded', analysis }
    : attempt.status === 'retryable_failure'
      ? { status: 'retrying', failure_code: attempt.failure_code }
      : { status: 'failed', outcome: 'no_action', failure_code: attempt.failure_code };
  const client = await pool.connect();
  try {
    const result = await client.query<{ stage_run_id: string }>(
      `INSERT INTO stage_runs(
         stage_run_id, cycle_id, mode, decision_context_id, stage, status, provider, provider_request_id, model,
         stage_version, invocation_id, attempt_number, requested_model, resolved_model, resolved_provider,
         provider_system_fingerprint, normalized_input_ref, latency_ms, prompt_tokens, completion_tokens,
         reported_cost, response_evidence, input, output, failure_code, started_at, completed_at
       )
       SELECT $1, $2, 'paper', $3, 'llm1_market_analyst', $4, 'openrouter', $5, $6,
              $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19::jsonb,
              $20::jsonb, $21::jsonb, $22, $23, $24
       WHERE EXISTS (
         SELECT 1 FROM decision_contexts c
         WHERE c.decision_context_id = $3 AND c.cycle_id = $2 AND c.mode = 'paper'
       )
       RETURNING stage_run_id`,
      [
        stageRunId, input.cycleId, input.decisionContextId, attempt.status, attempt.provider_request_id, input.requestedModel,
        input.stageVersion, input.invocationId, attempt.attempt_number, input.requestedModel, attempt.resolved_model,
        attempt.resolved_provider, attempt.system_fingerprint, input.normalizedInputRef, attempt.latency_ms,
        attempt.prompt_tokens, attempt.completion_tokens, attempt.reported_cost, JSON.stringify(safeEvidence),
        JSON.stringify({ normalized_input_ref: input.normalizedInputRef }), JSON.stringify(output), attempt.failure_code,
        attempt.started_at, attempt.completed_at,
      ],
    );
    if (result.rowCount !== 1) throw new Error('LLM1 context correlation is absent');
    return stageRunId;
  } catch {
    throw new Error('LLM1 stage attempt persistence failed');
  } finally {
    client.release();
  }
}
