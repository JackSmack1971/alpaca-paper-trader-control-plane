import { createHash, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { AppConfig } from '../domain/config.js';
import {
  applyJevAbstentionPolicy,
  buildJevOptionOrderShadow,
  buildJevStagePlan,
  compareJevOptionOrder,
  JEV_OPTION_ORDER_MAX_DELTA,
  JEV_OPTION_ORDER_STABILITY_VERSION,
  JEV_ENDPOINT_PATH,
  type JevParsedResponse,
  type JevOptionOrderStability,
  type JevPolicyResult,
} from '../domain/jev-decision.js';
import type { Llm1Analysis } from '../domain/llm1-analysis.js';
import { loadPersistedLlm1Context } from '../infra/stage-run-store.js';
import { requestJevDecision, type JevAttemptEvidence, type JevFailureCode } from '../infra/openrouter-jev.js';
import { loadPersistedLlm1Analysis, PersistedLlm1OutputError, persistJevAttempt } from '../infra/jev-stage-store.js';
import { jevRequestRateLimiter } from './jev-rate-limiter.js';
import type { JevRequestRateLimiter } from './jev-rate-limiter.js';

export type JevStageResult =
  | { status: 'completed'; authority: 'advisory_only'; stage_run_id: string; invocation_id: string; response: JevParsedResponse; policy: JevPolicyResult }
  | { status: 'skipped'; stage_run_id: string; invocation_id: string; outcome: 'no_action'; reason: 'llm1_no_action' }
  | { status: 'failed'; outcome: 'no_action'; stage_run_ids: string[]; invocation_id: string | null; failure_code: JevFailureCode | 'decision_context_unavailable' | 'llm1_output_unavailable' | 'request_preflight_failed' | 'stage_persistence_failed' };

export type RunPersistedJevOptions = {
  pool: Pool;
  config: AppConfig;
  cycleId: string;
  decisionContextId: string;
  llm1StageRunId: string;
  sessionId: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  delay?: (ms: number) => Promise<void>;
  rateLimiter?: JevRequestRateLimiter;
};

function attempt(args: { now: () => Date; code: JevFailureCode | null; status?: JevAttemptEvidence['status']; httpStatus?: number | null; attemptNumber?: number }): JevAttemptEvidence {
  const at = args.now().toISOString();
  const endpoint = `https://openrouter.ai${JEV_ENDPOINT_PATH}`;
  return {
    attempt_number: args.attemptNumber ?? 1,
    status: args.status ?? (args.code ? 'failed' : 'succeeded'),
    started_at: at, completed_at: at, latency_ms: 0,
    http_status: args.httpStatus ?? null, failure_code: args.code,
    provider_request_id: null, resolved_model: null, resolved_provider: null,
    input_tokens: null, output_tokens: null, reported_cost: null,
    response_evidence: { endpoint, body_present: false, answer_validation: 'not_checked' },
  };
}

async function persistUnavailable(options: RunPersistedJevOptions, invocationId: string, code: JevFailureCode, inputRef: string, noRequestReason: 'request_preflight_failed' | 'llm1_output_unavailable'): Promise<string> {
  const now = options.now ?? (() => new Date());
  return persistJevAttempt(options.pool, {
    cycleId: options.cycleId, decisionContextId: options.decisionContextId, llm1StageRunId: options.llm1StageRunId,
    invocationId, normalizedInputRef: inputRef, evidence: attempt({ now, code }), request: null, response: null, policyResult: null, noRequestReason,
  });
}

/** Runs Jev only from a replay-verified context and the explicitly correlated persisted LLM1 stage. */
export async function runPersistedJev(options: RunPersistedJevOptions): Promise<JevStageResult> {
  const now = options.now ?? (() => new Date());
  const invocationId = randomUUID();
  let built;
  try { built = await loadPersistedLlm1Context(options.pool, options.cycleId, options.decisionContextId); }
  catch {
    return { status: 'failed', outcome: 'no_action', stage_run_ids: [], invocation_id: null, failure_code: 'decision_context_unavailable' };
  }
  let analysis: Llm1Analysis;
  try { analysis = await loadPersistedLlm1Analysis(options.pool, { cycleId: options.cycleId, decisionContextId: options.decisionContextId, llm1StageRunId: options.llm1StageRunId }); }
  catch (error) {
    if (error instanceof PersistedLlm1OutputError && error.code === 'not_found') return { status: 'failed', outcome: 'no_action', stage_run_ids: [], invocation_id: null, failure_code: 'llm1_output_unavailable' };
    const ref = `sha256:${createHash('sha256').update(built.canonicalJson).digest('hex')}`;
    try {
      const id = await persistUnavailable(options, invocationId, 'llm1_output_unavailable', ref, 'llm1_output_unavailable');
      return { status: 'failed', outcome: 'no_action', stage_run_ids: [id], invocation_id: invocationId, failure_code: 'llm1_output_unavailable' };
    } catch { return { status: 'failed', outcome: 'no_action', stage_run_ids: [], invocation_id: invocationId, failure_code: 'stage_persistence_failed' }; }
  }

  let plan;
  try { plan = buildJevStagePlan(built, analysis, options.sessionId); }
  catch {
    const ref = `sha256:${createHash('sha256').update(built.canonicalJson).digest('hex')}`;
    try {
      const id = await persistUnavailable(options, invocationId, 'request_preflight_failed', ref, 'request_preflight_failed');
      return { status: 'failed', outcome: 'no_action', stage_run_ids: [id], invocation_id: invocationId, failure_code: 'request_preflight_failed' };
    } catch { return { status: 'failed', outcome: 'no_action', stage_run_ids: [], invocation_id: invocationId, failure_code: 'stage_persistence_failed' }; }
  }

  if (plan.status === 'skipped') {
    const responseAttempt = attempt({ now, code: null });
    try {
      const stageRunId = await persistJevAttempt(options.pool, {
        cycleId: options.cycleId, decisionContextId: options.decisionContextId, llm1StageRunId: options.llm1StageRunId,
        invocationId, normalizedInputRef: `sha256:${createHash('sha256').update(`${options.llm1StageRunId}:no_action`).digest('hex')}`,
        evidence: responseAttempt, request: null, response: null,
        policyResult: { status: 'selected_no_action', selected_outcome: 'no_action', policy_version: options.config.jevPolicy.version, calibrated: false },
        noRequestReason: 'llm1_no_action',
      });
      return { status: 'skipped', stage_run_id: stageRunId, invocation_id: invocationId, outcome: 'no_action', reason: 'llm1_no_action' };
    } catch { return { status: 'failed', outcome: 'no_action', stage_run_ids: [], invocation_id: invocationId, failure_code: 'stage_persistence_failed' }; }
  }

  const stageRunIds: string[] = [];
  const baseRequest = plan.request;
  let baselineResponse: JevParsedResponse | null = null;
  const invoke = async (request: typeof plan.request, kind: 'baseline' | 'shadow') => {
    const requestInvocationId = randomUUID();
    return requestJevDecision({
    apiKey: options.config.localTestMode && options.fetchImpl ? 'local-simulation-only' : options.config.openRouterApiKey,
    baseUrl: options.config.openRouterBaseUrl,
    timeoutMs: options.config.jevRequestTimeoutMs,
    request,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.delay ? { delay: options.delay } : {}),
    beforeAttempt: () => (options.rateLimiter ?? jevRequestRateLimiter).acquire(options.config.jevMinimumIntervalMs),
    now,
    onAttempt: async (evidence, response) => {
      let stability: JevOptionOrderStability | null = null;
      let policy: JevPolicyResult | null = null;
      if (kind === 'baseline' && response) baselineResponse = response;
      if (kind === 'shadow' && response && baselineResponse) {
        stability = compareJevOptionOrder(baselineResponse, response);
        policy = applyJevAbstentionPolicy(baselineResponse, analysis, options.config.jevPolicy, stability);
      } else if (kind === 'shadow' && !response && baselineResponse) {
        stability = { version: JEV_OPTION_ORDER_STABILITY_VERSION, status: 'unavailable', baseline_choice: baselineResponse.answers.candidate_outcome.choice, shadow_choice: null, maximum_named_probability_delta: null, maximum_allowed_delta: JEV_OPTION_ORDER_MAX_DELTA };
        policy = { status: 'abstained', outcome: 'no_action', reason: 'option_order_instability', policy_version: options.config.jevPolicy.version, calibrated: false, option_order_stability: stability };
      }
      stageRunIds.push(await persistJevAttempt(options.pool, {
        cycleId: options.cycleId, decisionContextId: options.decisionContextId, llm1StageRunId: options.llm1StageRunId,
        invocationId: requestInvocationId, comparisonGroupId: invocationId,
        normalizedInputRef: `sha256:${createHash('sha256').update(JSON.stringify({ base: plan.normalized_input_ref, kind, request: request.questions })).digest('hex')}`,
        evidence, request, response, policyResult: policy, optionOrderStability: stability,
        requestRole: kind, ...(kind === 'shadow' ? { baselineResponse } : {}), noRequestReason: null,
      }));
    },
    });
  };
  const baseline = await invoke(baseRequest, 'baseline');
  if (baseline.status === 'persistence_failed') return { status: 'failed', outcome: 'no_action', stage_run_ids: stageRunIds, invocation_id: invocationId, failure_code: 'stage_persistence_failed' };
  if (baseline.status === 'failed') return { status: 'failed', outcome: 'no_action', stage_run_ids: stageRunIds, invocation_id: invocationId, failure_code: baseline.failure_code };
  const shadow = await invoke(buildJevOptionOrderShadow(baseRequest), 'shadow');
  if (shadow.status === 'persistence_failed') return { status: 'failed', outcome: 'no_action', stage_run_ids: stageRunIds, invocation_id: invocationId, failure_code: 'stage_persistence_failed' };
  if (shadow.status === 'failed') return { status: 'failed', outcome: 'no_action', stage_run_ids: stageRunIds, invocation_id: invocationId, failure_code: shadow.failure_code };
  const stability = compareJevOptionOrder(baseline.response, shadow.response);
  const policy = applyJevAbstentionPolicy(baseline.response, analysis, options.config.jevPolicy, stability);
  const stageRunId = stageRunIds.at(-1);
  if (!stageRunId) return { status: 'failed', outcome: 'no_action', stage_run_ids: [], invocation_id: invocationId, failure_code: 'stage_persistence_failed' };
  return { status: 'completed', authority: 'advisory_only', stage_run_id: stageRunId, invocation_id: invocationId, response: baseline.response, policy };
}
