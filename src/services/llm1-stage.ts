import { createHash, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { AppConfig } from '../domain/config.js';
import { LLM1_STAGE_VERSION, buildLlm1Input, type Llm1Analysis } from '../domain/llm1-analysis.js';
import type { Llm1AttemptEvidence, Llm1FailureCode } from '../infra/openrouter-llm1.js';
import { requestLlm1Analysis } from '../infra/openrouter-llm1.js';
import { loadPersistedLlm1Context, persistLlm1Attempt } from '../infra/stage-run-store.js';
import { llm1RequestRateLimiter, type Llm1RequestRateLimiter } from './llm1-rate-limiter.js';

export type Llm1StageResult =
  | { status: 'succeeded'; stage_run_id: string; invocation_id: string; analysis: Llm1Analysis }
  | { status: 'failed'; outcome: 'no_action'; stage_run_ids: string[]; invocation_id: string | null; failure_code: Llm1FailureCode | 'stage_persistence_failed' };

export type RunPersistedLlm1Options = {
  pool: Pool;
  config: AppConfig;
  cycleId: string;
  decisionContextId: string;
  sessionId: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  rateLimiter?: Llm1RequestRateLimiter;
};

function blockedContextAttempt(now: () => Date): Llm1AttemptEvidence {
  const at = now().toISOString();
  return {
    attempt_number: 1, status: 'failed', started_at: at, completed_at: at, latency_ms: 0, http_status: null,
    failure_code: 'decision_context_unavailable', provider_request_id: null, resolved_model: null, resolved_provider: null,
    system_fingerprint: null, prompt_tokens: null, completion_tokens: null, reported_cost: null,
    response_evidence: {},
  };
}

/** Run LLM1 only from a persisted, replay-verified decision context. */
export async function runPersistedLlm1(options: RunPersistedLlm1Options): Promise<Llm1StageResult> {
  const { pool, config, cycleId, decisionContextId } = options;
  const now = options.now ?? (() => new Date());
  const invocationId = randomUUID();
  const stageRunIds: string[] = [];
  let built;
  try { built = await loadPersistedLlm1Context(pool, cycleId, decisionContextId); }
  catch {
    return { status: 'failed', outcome: 'no_action', stage_run_ids: [], invocation_id: null, failure_code: 'decision_context_unavailable' };
  }

  let input;
  try { input = buildLlm1Input(built); }
  catch {
    const inputRef = `sha256:${createHash('sha256').update(built.canonicalJson).digest('hex')}`;
    const evidence = blockedContextAttempt(now);
    try {
      const stageRunId = await persistLlm1Attempt(pool, {
        cycleId, decisionContextId, invocationId, stageVersion: LLM1_STAGE_VERSION,
        requestedModel: config.analysisModel, normalizedInputRef: inputRef, evidence, analysis: null,
      });
      return { status: 'failed', outcome: 'no_action', stage_run_ids: [stageRunId], invocation_id: invocationId, failure_code: 'decision_context_unavailable' };
    } catch {
      return { status: 'failed', outcome: 'no_action', stage_run_ids: [], invocation_id: invocationId, failure_code: 'stage_persistence_failed' };
    }
  }

  const invocation = await requestLlm1Analysis(input, {
    apiKey: config.localTestMode && options.fetchImpl ? 'local-simulation-only' : config.openRouterApiKey,
    baseUrl: config.openRouterBaseUrl,
    requestedModel: config.analysisModel,
    timeoutMs: config.llm1RequestTimeoutMs,
    maxCompletionTokens: config.llm1MaxCompletionTokens,
    sessionId: options.sessionId,
    beforeAttempt: () => (options.rateLimiter ?? llm1RequestRateLimiter).acquire(config.llm1MinimumIntervalMs),
    onAttempt: async (attempt, analysis) => {
      stageRunIds.push(await persistLlm1Attempt(pool, {
        cycleId, decisionContextId, invocationId, stageVersion: LLM1_STAGE_VERSION,
        requestedModel: config.analysisModel, normalizedInputRef: input.normalized_input_ref, evidence: attempt, analysis,
      }));
    },
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    now,
  });
  if (invocation.status === 'persistence_failed') return { status: 'failed', outcome: 'no_action', stage_run_ids: stageRunIds, invocation_id: invocationId, failure_code: 'stage_persistence_failed' };

  if (invocation.status === 'succeeded') {
    return { status: 'succeeded', stage_run_id: stageRunIds.at(-1)!, invocation_id: invocationId, analysis: invocation.analysis };
  }
  return { status: 'failed', outcome: 'no_action', stage_run_ids: stageRunIds, invocation_id: invocationId, failure_code: invocation.failure_code };
}
