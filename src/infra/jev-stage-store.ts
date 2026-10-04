import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { z } from 'zod';
import { JEV_ENDPOINT_PATH, JEV_OPTION_ORDER_MAX_DELTA, JEV_OPTION_ORDER_STABILITY_VERSION, JEV_OUTCOMES, JEV_REQUESTED_MODEL, JEV_STAGE_VERSION, JEV_RESPONSE_SUM_TOLERANCE, type JevOptionOrderStability, type JevParsedResponse, type JevPolicyResult, type JevRequest } from '../domain/jev-decision.js';
import { parseLlm1Analysis, type Llm1Analysis } from '../domain/llm1-analysis.js';
import type { JevAttemptEvidence } from './openrouter-jev.js';

export class PersistedLlm1OutputError extends Error {
  constructor(readonly code: 'not_found' | 'identity_mismatch' | 'invalid') {
    super(`persisted LLM1 output ${code}`);
    this.name = 'PersistedLlm1OutputError';
  }
}

const succeededLlm1OutputSchema = z.object({ status: z.literal('succeeded'), analysis: z.unknown() }).passthrough();

/** Loads only an explicitly identified successful PAPER LLM1 result correlated to the same cycle/context. */
export async function loadPersistedLlm1Analysis(pool: Pool, input: { cycleId: string; decisionContextId: string; llm1StageRunId: string }): Promise<Llm1Analysis> {
  let result;
  try {
    result = await pool.query<{ cycle_id: string; decision_context_id: string; mode: string; output: unknown }>(
      `SELECT cycle_id, decision_context_id, mode, output FROM stage_runs
       WHERE stage_run_id = $1 AND stage = 'llm1_market_analyst' AND status = 'succeeded'`,
      [input.llm1StageRunId],
    );
  } catch { throw new PersistedLlm1OutputError('invalid'); }
  const row = result.rows[0];
  if (!row) throw new PersistedLlm1OutputError('not_found');
  if (row.cycle_id !== input.cycleId || row.decision_context_id !== input.decisionContextId || row.mode !== 'paper') throw new PersistedLlm1OutputError('identity_mismatch');
  try {
    const output = succeededLlm1OutputSchema.parse(row.output);
    return parseLlm1Analysis(output.analysis);
  } catch { throw new PersistedLlm1OutputError('invalid'); }
}

export type PersistJevAttempt = {
  cycleId: string;
  decisionContextId: string;
  llm1StageRunId: string;
  invocationId: string;
  comparisonGroupId?: string;
  normalizedInputRef: string;
  evidence: JevAttemptEvidence;
  request: JevRequest | null;
  response: JevParsedResponse | null;
  policyResult: JevPolicyResult | null;
  optionOrderStability?: JevOptionOrderStability | null;
  requestRole?: 'baseline' | 'shadow';
  baselineResponse?: JevParsedResponse | null;
  noRequestReason: 'llm1_no_action' | 'request_preflight_failed' | 'llm1_output_unavailable' | null;
};

const evidenceSchema = z.object({
  endpoint: z.literal(`https://openrouter.ai${JEV_ENDPOINT_PATH}`),
  body_present: z.boolean(),
  answer_validation: z.enum(['passed', 'failed', 'not_checked']),
}).strict();

const attemptEvidenceSchema = z.object({
  attempt_number: z.number().int().min(1).max(2),
  status: z.enum(['succeeded', 'retryable_failure', 'failed']),
  started_at: z.string().datetime({ offset: true }),
  completed_at: z.string().datetime({ offset: true }),
  latency_ms: z.number().int().min(0).max(300_000),
  http_status: z.number().int().min(100).max(599).nullable(),
  failure_code: z.enum(['model_not_configured','request_timeout','transport_failure','provider_rate_limited','provider_unavailable','provider_authentication_failed','provider_credits_exhausted','provider_forbidden','provider_model_unavailable','provider_request_rejected','provider_response_invalid','provider_answer_invalid','request_preflight_failed','llm1_output_unavailable']).nullable(),
  provider_request_id: z.string().regex(/^[A-Za-z0-9._:-]{1,256}$/).nullable(),
  resolved_model: z.string().regex(/^[A-Za-z0-9._/:+-]{1,256}$/).nullable(),
  resolved_provider: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,127}$/).nullable(),
  input_tokens: z.number().int().min(0).max(2_147_483_647).nullable(),
  output_tokens: z.number().int().min(0).max(2_147_483_647).nullable(),
  reported_cost: z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d+)?(?:e[+-]?\d+)?$/i).max(32).nullable(),
  response_evidence: evidenceSchema,
}).strict();

const choiceResultSchema = z.object({
  type: z.literal('choice'), choice: z.enum(JEV_OUTCOMES), probabilities: z.record(z.string(), z.number().finite().min(0).max(1)),
  confidence: z.number().finite().min(0).max(1), top_probability: z.number().finite().min(0).max(1), runner_up_probability: z.number().finite().min(0).max(1), confidence_recomputed: z.null(),
}).strict().superRefine((choice, context) => {
  const expected = [...JEV_OUTCOMES].sort();
  const keys = Object.keys(choice.probabilities).sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) context.addIssue({ code: 'custom', path: ['probabilities'], message: 'Choice distribution option coverage is invalid' });
  const values = Object.values(choice.probabilities);
  if (Math.abs(values.reduce((sum, probability) => sum + probability, 0) - 1) > JEV_RESPONSE_SUM_TOLERANCE) context.addIssue({ code: 'custom', path: ['probabilities'], message: 'Choice distribution total is invalid' });
  const ranked = values.sort((a, b) => b - a);
  if (Math.abs((ranked[0] ?? 0) - choice.top_probability) > JEV_RESPONSE_SUM_TOLERANCE || Math.abs((ranked[1] ?? 0) - choice.runner_up_probability) > JEV_RESPONSE_SUM_TOLERANCE) context.addIssue({ code: 'custom', path: ['top_probability'], message: 'Choice probability summary is invalid' });
});

const parsedResponseSchema = z.object({
  answers: z.object({
    candidate_outcome: choiceResultSchema,
    necessary_preconditions: z.object({ type: z.literal('noul'), noul: z.number().finite().min(0).max(1) }).strict(),
  }).strict(),
  resolved_model: z.string().regex(/^[A-Za-z0-9._/:+-]{1,256}$/), provider: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,127}$/).nullable(), provider_request_id: z.string().regex(/^[A-Za-z0-9._:-]{1,256}$/).nullable(),
  usage: z.object({ input_tokens: z.number().int().min(0).max(2_147_483_647).nullable(), output_tokens: z.number().int().min(0).max(2_147_483_647).nullable(), cost: z.number().finite().min(0).max(1_000_000).nullable() }).strict(),
}).strict();

const policyResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('selected_candidate'), selected_outcome: z.enum(['bullish_candidate','bearish_candidate','reduce_risk_candidate','exit_candidate']), policy_version: z.string().min(1).max(64), calibrated: z.literal(false), option_order_stability: z.object({ version: z.literal(JEV_OPTION_ORDER_STABILITY_VERSION), status: z.literal('stable'), baseline_choice: z.enum(JEV_OUTCOMES), shadow_choice: z.enum(JEV_OUTCOMES), maximum_named_probability_delta: z.number().finite().min(0).max(JEV_OPTION_ORDER_MAX_DELTA), maximum_allowed_delta: z.literal(JEV_OPTION_ORDER_MAX_DELTA) }).strict() }).strict(),
  z.object({ status: z.literal('abstained'), outcome: z.literal('no_action'), reason: z.enum(['unsupported_outcome','low_choice_confidence','low_top_probability','small_probability_margin','necessary_preconditions_not_established','llm1_jev_disagreement','option_order_instability']), policy_version: z.string().min(1).max(64), calibrated: z.literal(false), option_order_stability: z.object({ version: z.literal(JEV_OPTION_ORDER_STABILITY_VERSION), status: z.enum(['stable','unstable','unavailable']), baseline_choice: z.enum(JEV_OUTCOMES), shadow_choice: z.enum(JEV_OUTCOMES).nullable(), maximum_named_probability_delta: z.number().finite().min(0).max(1).nullable(), maximum_allowed_delta: z.literal(JEV_OPTION_ORDER_MAX_DELTA) }).strict().optional() }).strict(),
  z.object({ status: z.literal('selected_no_action'), selected_outcome: z.literal('no_action'), policy_version: z.string().min(1).max(64), calibrated: z.literal(false), option_order_stability: z.object({ version: z.literal(JEV_OPTION_ORDER_STABILITY_VERSION), status: z.enum(['stable','unstable','unavailable']), baseline_choice: z.enum(JEV_OUTCOMES), shadow_choice: z.enum(JEV_OUTCOMES).nullable(), maximum_named_probability_delta: z.number().finite().min(0).max(1).nullable(), maximum_allowed_delta: z.literal(JEV_OPTION_ORDER_MAX_DELTA) }).strict().optional() }).strict(),
]);

/** Persist one attempt with the full provider-visible state/question set and only sanitized response evidence. */
export async function persistJevAttempt(pool: Pool, input: PersistJevAttempt): Promise<string> {
  const stageRunId = randomUUID();
  if (!/^sha256:[a-f0-9]{64}$/.test(input.normalizedInputRef)) throw new Error('Jev input reference is invalid');
  if (input.request && input.request.model !== JEV_REQUESTED_MODEL) throw new Error('Jev requested model is invalid');
  let safeEvidence: z.infer<typeof evidenceSchema>;
  let parsedOutput: z.infer<typeof parsedResponseSchema> | null;
  let baselineOutput: z.infer<typeof parsedResponseSchema> | null;
  let policyResult: z.infer<typeof policyResultSchema> | null;
  try {
    safeEvidence = evidenceSchema.parse(input.evidence.response_evidence);
    parsedOutput = input.response === null ? null : parsedResponseSchema.parse(input.response);
    baselineOutput = input.baselineResponse == null ? null : parsedResponseSchema.parse(input.baselineResponse);
    policyResult = input.policyResult === null ? null : policyResultSchema.parse(input.policyResult);
  } catch { throw new Error('Jev stage evidence is invalid'); }
  if (policyResult?.status === 'selected_candidate' && policyResult.option_order_stability.status !== 'stable') throw new Error('Jev candidate result lacks stable option-order evidence');
  if ((input.request === null) !== (input.noRequestReason !== null)) throw new Error('Jev request and no-request reason do not correlate');
  let at: z.infer<typeof attemptEvidenceSchema>;
  try { at = attemptEvidenceSchema.parse(input.evidence); }
  catch { throw new Error('Jev stage attempt evidence is invalid'); }
  if (input.noRequestReason === 'llm1_no_action' && (at.status !== 'succeeded' || policyResult?.status !== 'selected_no_action')) throw new Error('Jev no-action skip evidence is inconsistent');
  if (input.noRequestReason !== null && input.noRequestReason !== 'llm1_no_action' && (at.status !== 'failed' || policyResult !== null)) throw new Error('Jev preflight failure evidence is inconsistent');
  if (at.status === 'succeeded' && input.request !== null && input.response === null) throw new Error('successful Jev attempt requires validated answer evidence');
  if (input.response !== null && (at.status !== 'succeeded' || input.request === null)) throw new Error('Jev response does not match attempt status');
  if ((input.requestRole ?? 'baseline') === 'shadow' && input.response !== null && baselineOutput === null) throw new Error('Jev shadow result lacks its baseline response');
  if ((input.requestRole ?? 'baseline') === 'baseline' && baselineOutput !== null) throw new Error('Jev baseline result cannot contain a paired baseline response');
  const serializedInput = input.request
    ? {
      schema_version: JEV_STAGE_VERSION,
      llm1_stage_run_id: input.llm1StageRunId,
      comparison_group_id: input.comparisonGroupId ?? input.invocationId,
      requested_endpoint: `https://openrouter.ai${JEV_ENDPOINT_PATH}`,
      requested_model: JEV_REQUESTED_MODEL,
      request_role: input.requestRole ?? 'baseline',
      normalized_input_ref: input.normalizedInputRef,
      state: input.request.state,
      questions: input.request.questions,
      session_id: input.request.session_id,
      trace: input.request.trace,
    }
    : {
      schema_version: JEV_STAGE_VERSION,
      llm1_stage_run_id: input.llm1StageRunId,
      comparison_group_id: input.comparisonGroupId ?? input.invocationId,
      requested_endpoint: `https://openrouter.ai${JEV_ENDPOINT_PATH}`,
      requested_model: JEV_REQUESTED_MODEL,
      request_role: input.requestRole ?? 'baseline',
      normalized_input_ref: input.normalizedInputRef,
      not_requested_reason: input.noRequestReason,
    };
  const output = parsedOutput === null
    ? input.request === null && policyResult !== null
      ? { status: policyResult.status, authority: 'advisory_only', policy: policyResult, answers: null }
      : {
        status: at.status === 'retryable_failure' ? 'retrying' : 'failed', authority: 'advisory_only', outcome: 'no_action',
        failure_code: at.failure_code, policy: policyResult, option_order_stability: input.optionOrderStability ?? null,
        answers: (input.requestRole ?? 'baseline') === 'shadow' && baselineOutput ? baselineOutput.answers : null,
        answer_pair: (input.requestRole ?? 'baseline') === 'shadow' && baselineOutput
          ? { policy_source: 'baseline', baseline: baselineOutput.answers, shadow: null }
          : null,
      }
    : {
      status: policyResult?.status ?? 'shadow_pending', authority: 'advisory_only', policy: policyResult,
      option_order_stability: input.optionOrderStability ?? null,
      answers: (input.requestRole ?? 'baseline') === 'shadow' && baselineOutput ? baselineOutput.answers : parsedOutput.answers,
      answer_pair: (input.requestRole ?? 'baseline') === 'shadow' && baselineOutput
        ? { policy_source: 'baseline', baseline: baselineOutput.answers, shadow: parsedOutput.answers }
        : null,
    };
  const client = await pool.connect();
  try {
    const result = await client.query<{ stage_run_id: string }>(
      `INSERT INTO stage_runs(
         stage_run_id, cycle_id, mode, decision_context_id, stage, status, provider, provider_request_id, model,
         stage_version, invocation_id, attempt_number, requested_model, resolved_model, resolved_provider,
         normalized_input_ref, latency_ms, prompt_tokens, completion_tokens, reported_cost, response_evidence,
         input, output, failure_code, started_at, completed_at
       )
       SELECT $1, $2, 'paper', $3, 'jev_structured', $4, $5, $6, $7,
              $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18,
              $19::jsonb, $20::jsonb, $21, $22, $23, $24
       WHERE EXISTS (
         SELECT 1 FROM decision_contexts c
         WHERE c.decision_context_id = $3 AND c.cycle_id = $2 AND c.mode = 'paper'
       ) AND EXISTS (
         SELECT 1 FROM stage_runs upstream
         WHERE upstream.stage_run_id = $25 AND upstream.cycle_id = $2
           AND upstream.decision_context_id = $3 AND upstream.mode = 'paper'
           AND upstream.stage = 'llm1_market_analyst' AND upstream.status = 'succeeded'
       )
       RETURNING stage_run_id`,
      [
        stageRunId, input.cycleId, input.decisionContextId, at.status, at.http_status !== null ? 'openrouter' : null,
        at.provider_request_id, JEV_REQUESTED_MODEL, JEV_STAGE_VERSION, input.invocationId, at.attempt_number,
        JEV_REQUESTED_MODEL, at.resolved_model,
        at.resolved_provider, input.normalizedInputRef, at.latency_ms, at.input_tokens, at.output_tokens, at.reported_cost,
        JSON.stringify(safeEvidence), JSON.stringify(serializedInput), JSON.stringify(output), at.failure_code,
        at.started_at, at.completed_at, input.llm1StageRunId,
      ],
    );
    if (result.rowCount !== 1) throw new Error('Jev upstream PAPER correlation is absent');
    return stageRunId;
  } catch { throw new Error('Jev stage attempt persistence failed'); }
  finally { client.release(); }
}

export type { JevParsedResponse };
