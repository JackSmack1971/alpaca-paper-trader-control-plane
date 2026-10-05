import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Llm1Input, Llm1Analysis } from '../domain/llm1-analysis.js';
import { llm1AnalysisSchema, parseLlm1Analysis } from '../domain/llm1-analysis.js';

export const LLM1_RETRYABLE_HTTP_STATUSES = [408, 429, 500, 502, 503, 524, 529] as const;
export const LLM1_MAX_ATTEMPTS = 2;
const maxProviderResponseBytes = 65_536;

export type Llm1FailureCode =
  | 'decision_context_unavailable'
  | 'model_not_configured'
  | 'request_timeout'
  | 'transport_failure'
  | 'provider_rate_limited'
  | 'provider_unavailable'
  | 'provider_authentication_failed'
  | 'provider_credits_exhausted'
  | 'provider_forbidden'
  | 'provider_model_unavailable'
  | 'provider_request_rejected'
  | 'unsupported_structured_output'
  | 'provider_response_invalid'
  | 'analysis_output_invalid';

export type Llm1AttemptEvidence = {
  attempt_number: number;
  status: 'succeeded' | 'retryable_failure' | 'failed';
  started_at: string;
  completed_at: string;
  latency_ms: number;
  http_status: number | null;
  failure_code: Llm1FailureCode | null;
  provider_request_id: string | null;
  resolved_model: string | null;
  resolved_provider: string | null;
  system_fingerprint: string | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  reported_cost: string | null;
  response_evidence: Record<string, unknown>;
};

export type Llm1Invocation =
  | { status: 'succeeded'; analysis: Llm1Analysis; attempts: Llm1AttemptEvidence[] }
  | { status: 'persistence_failed'; attempts: Llm1AttemptEvidence[] }
  | { status: 'failed'; outcome: 'no_action'; failure_code: Llm1FailureCode; attempts: Llm1AttemptEvidence[] };

export type OpenRouterLlm1Options = {
  apiKey: string | undefined;
  baseUrl: string;
  requestedModel: string;
  timeoutMs: number;
  maxCompletionTokens: number;
  sessionId?: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  beforeAttempt: () => Promise<void>;
  onAttempt?: (evidence: Llm1AttemptEvidence, analysis: Llm1Analysis | null) => Promise<void>;
};

const errorCodeSchema = z.object({ error: z.object({ code: z.union([z.string().max(128), z.number()]).optional() }).passthrough() }).passthrough();
const endpointSchema = z.object({ provider: z.string().max(128).optional(), model: z.string().max(256).optional(), selected: z.boolean().optional() }).passthrough();
const responseSchema = z.object({
  id: z.string().max(256).optional(),
  model: z.string().max(256).optional(),
  system_fingerprint: z.string().max(128).nullable().optional(),
  choices: z.array(z.object({
    finish_reason: z.string().max(64).nullable().optional(),
    message: z.object({ content: z.string().nullable().optional(), tool_calls: z.array(z.unknown()).optional() }).passthrough(),
  }).passthrough()).min(1),
  usage: z.object({
    prompt_tokens: z.number().int().min(0).max(2_147_483_647).optional(),
    completion_tokens: z.number().int().min(0).max(2_147_483_647).optional(),
    cost: z.union([z.number().finite().nonnegative(), z.string().max(64).regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/)]).optional(),
  }).passthrough().optional(),
  openrouter_metadata: z.object({ endpoints: z.object({ available: z.array(endpointSchema).optional() }).passthrough().optional() }).passthrough().optional(),
}).passthrough();

class ProviderFault extends Error {
  constructor(readonly code: Llm1FailureCode, readonly retryable: boolean, readonly httpStatus: number | null = null) {
    super(code);
  }
}

function officialEndpoint(baseUrl: string): URL {
  let base: URL;
  try { base = new URL(baseUrl); } catch { throw new ProviderFault('provider_request_rejected', false); }
  if (base.protocol !== 'https:' || base.hostname !== 'openrouter.ai' || base.port !== '' || base.pathname.replace(/\/$/, '') !== '/api/v1' || base.username || base.password || base.search || base.hash) {
    throw new ProviderFault('provider_request_rejected', false);
  }
  return new URL('https://openrouter.ai/api/v1/chat/completions');
}

function providerFailure(status: number, body: unknown): ProviderFault {
  const codeParsed = errorCodeSchema.safeParse(body);
  const safeCode = codeParsed.success ? String(codeParsed.data.error.code ?? '').toLowerCase() : '';
  if ([400, 422].includes(status) && /(structured|json_schema|response_format)/.test(safeCode)) return new ProviderFault('unsupported_structured_output', false, status);
  if (status === 401) return new ProviderFault('provider_authentication_failed', false, status);
  if (status === 402) return new ProviderFault('provider_credits_exhausted', false, status);
  if (status === 403) return new ProviderFault('provider_forbidden', false, status);
  if (status === 404) return new ProviderFault('provider_model_unavailable', false, status);
  if (status === 429) return new ProviderFault('provider_rate_limited', true, status);
  if ([408, 500, 502, 503, 524, 529].includes(status)) return new ProviderFault('provider_unavailable', true, status);
  if (status === 400 || status === 413 || status === 422) return new ProviderFault('provider_request_rejected', false, status);
  return new ProviderFault('provider_unavailable', status >= 500, status);
}

function safeResponseEvidence(data: z.infer<typeof responseSchema>, finishReason: string | null): Record<string, unknown> {
  return {
    finish_reason: finishReason === 'stop' ? 'stop' : 'other',
    metadata_endpoint_count: data.openrouter_metadata?.endpoints?.available?.length ?? null,
    usage_present: data.usage !== undefined,
  };
}

function safeProviderText(value: string | undefined, pattern: RegExp): string | null {
  return value !== undefined && pattern.test(value) ? value : null;
}

function containsCredential(value: unknown, credential: string): boolean {
  if (typeof value === 'string') return value.includes(credential);
  if (Array.isArray(value)) return value.some((item) => containsCredential(item, credential));
  if (value && typeof value === 'object') return Object.values(value).some((item) => containsCredential(item, credential));
  return false;
}

function toAttempt(args: {
  attemptNumber: number; startedAt: Date; completedAt: Date; httpStatus: number | null;
  failure: ProviderFault | null; response: z.infer<typeof responseSchema> | null;
}): Llm1AttemptEvidence {
  const { attemptNumber, startedAt, completedAt, httpStatus, failure, response } = args;
  const finishReason = response?.choices[0]?.finish_reason ?? null;
  const selected = response?.openrouter_metadata?.endpoints?.available?.find((item) => item.selected === true);
  const status = failure ? (failure.retryable && attemptNumber < LLM1_MAX_ATTEMPTS ? 'retryable_failure' : 'failed') : 'succeeded';
  return {
    attempt_number: attemptNumber,
    status,
    started_at: startedAt.toISOString(),
    completed_at: completedAt.toISOString(),
    latency_ms: Math.max(0, completedAt.getTime() - startedAt.getTime()),
    http_status: httpStatus,
    failure_code: failure?.code ?? null,
    provider_request_id: safeProviderText(response?.id, /^[A-Za-z0-9._:-]{1,256}$/),
    resolved_model: safeProviderText(response?.model ?? selected?.model, /^[A-Za-z0-9._/:+-]{1,256}$/),
    resolved_provider: safeProviderText(selected?.provider, /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,127}$/),
    system_fingerprint: safeProviderText(response?.system_fingerprint ?? undefined, /^[A-Za-z0-9._:-]{1,128}$/),
    prompt_tokens: response?.usage?.prompt_tokens ?? null,
    completion_tokens: response?.usage?.completion_tokens ?? null,
    reported_cost: response?.usage?.cost === undefined ? null : String(response.usage.cost),
    response_evidence: response ? safeResponseEvidence(response, finishReason) : {},
  };
}

async function readProviderError(response: Response): Promise<ProviderFault> {
  let body: unknown;
  try { body = await boundedResponseJson(response); } catch { body = null; }
  return providerFailure(response.status, body);
}

async function boundedResponseJson(response: Response): Promise<unknown> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxProviderResponseBytes) throw new ProviderFault('provider_response_invalid', false, response.status);
  if (!response.body) throw new ProviderFault('provider_response_invalid', false, response.status);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      length += item.value.byteLength;
      if (length > maxProviderResponseBytes) {
        await reader.cancel();
        throw new ProviderFault('provider_response_invalid', false, response.status);
      }
      chunks.push(item.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(bytes)) as unknown; }
  catch { throw new ProviderFault('provider_response_invalid', false, response.status); }
}

async function oneRequest(args: {
  options: OpenRouterLlm1Options; input: Llm1Input; endpoint: URL; sessionId: string; attemptNumber: number;
}): Promise<{ analysis: Llm1Analysis; evidence: Llm1AttemptEvidence }> {
  const { options, input, endpoint, sessionId, attemptNumber } = args;
  const now = options.now ?? (() => new Date());
  const startedAt = now();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (!options.apiKey) throw new ProviderFault('provider_authentication_failed', false);
    const apiKey = options.apiKey;
    if (!options.requestedModel.trim()) throw new ProviderFault('model_not_configured', false);
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new ProviderFault('request_timeout', true));
      }, options.timeoutMs);
    });
    const operation = async () => {
      const response = await (options.fetchImpl ?? fetch)(endpoint, {
        method: 'POST',
        redirect: 'error',
        signal: controller.signal,
        headers: { authorization: `Bearer ${options.apiKey}`, 'content-type': 'application/json', 'x-openrouter-metadata': 'enabled' },
        body: JSON.stringify({
          model: options.requestedModel,
          messages: input.messages,
          stream: false,
          temperature: 0,
          max_completion_tokens: options.maxCompletionTokens,
          provider: { require_parameters: true, data_collection: 'deny' },
          response_format: {
            type: 'json_schema',
            json_schema: { name: 'llm1_market_analysis_v1', strict: true, schema: z.toJSONSchema(llm1AnalysisSchema, { unrepresentable: 'any' }) },
          },
          trace: { trace_id: input.cycle_id, trace_name: 'paper_trading_llm1_analysis' },
          session_id: sessionId,
        }),
      });
      if (!response.ok) throw await readProviderError(response);
      const raw: unknown = await boundedResponseJson(response);
      const parsed = responseSchema.safeParse(raw);
      if (!parsed.success) throw new ProviderFault('provider_response_invalid', false, response.status);
      const message = parsed.data.choices[0]?.message.content;
      if (message === undefined || message === null) throw new ProviderFault('provider_response_invalid', false, response.status);
      if ((parsed.data.choices[0]?.message.tool_calls?.length ?? 0) > 0) throw new ProviderFault('provider_response_invalid', false, response.status);
      const finishReason = parsed.data.choices[0]?.finish_reason;
      if (finishReason !== 'stop') throw new ProviderFault('provider_response_invalid', false, response.status);
      let analysis: Llm1Analysis;
      try { analysis = parseLlm1Analysis(JSON.parse(message) as unknown); }
      catch { throw new ProviderFault('analysis_output_invalid', false, response.status); }
      if (containsCredential({ analysis, providerMetadata: parsed.data }, apiKey)) throw new ProviderFault('provider_response_invalid', false, response.status);
      const evidence = toAttempt({ attemptNumber, startedAt, completedAt: now(), httpStatus: response.status, failure: null, response: parsed.data });
      return { analysis, evidence };
    };
    const result = await Promise.race([operation(), timeout]);
    return result;
  } catch (error) {
    const failure = error instanceof ProviderFault
      ? error
      : error instanceof Error && error.name === 'AbortError'
        ? new ProviderFault('request_timeout', true)
        : new ProviderFault('transport_failure', true);
    throw Object.assign(failure, { attemptEvidence: toAttempt({ attemptNumber, startedAt, completedAt: now(), httpStatus: failure.httpStatus, failure, response: null }) });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Invoke OpenRouter with bounded retries; all returned content has passed the local versioned schema. */
export async function requestLlm1Analysis(input: Llm1Input, options: OpenRouterLlm1Options): Promise<Llm1Invocation> {
  const attempts: Llm1AttemptEvidence[] = [];
  let endpoint: URL;
  try { endpoint = officialEndpoint(options.baseUrl); }
  catch (error) {
    const failure = error instanceof ProviderFault ? error : new ProviderFault('provider_request_rejected', false);
    const at = (options.now ?? (() => new Date()))();
    attempts.push(toAttempt({ attemptNumber: 1, startedAt: at, completedAt: at, httpStatus: null, failure, response: null }));
    return { status: 'failed', outcome: 'no_action', failure_code: failure.code, attempts };
  }
  const sessionId = options.sessionId ?? randomUUID();
  for (let attemptNumber = 1; attemptNumber <= LLM1_MAX_ATTEMPTS; attemptNumber += 1) {
    try {
      await options.beforeAttempt();
      const result = await oneRequest({ options, input, endpoint, sessionId, attemptNumber });
      attempts.push(result.evidence);
      try { await options.onAttempt?.(result.evidence, result.analysis); }
      catch { return { status: 'persistence_failed', attempts }; }
      return { status: 'succeeded', analysis: result.analysis, attempts };
    } catch (error) {
      const failure = error instanceof ProviderFault ? error : new ProviderFault('transport_failure', true);
      const attached = (error as ProviderFault & { attemptEvidence?: Llm1AttemptEvidence }).attemptEvidence;
      if (attached) attempts.push(attached);
      else {
        const at = (options.now ?? (() => new Date()))();
        attempts.push(toAttempt({ attemptNumber, startedAt: at, completedAt: at, httpStatus: failure.httpStatus, failure, response: null }));
      }
      try { await options.onAttempt?.(attempts.at(-1)!, null); }
      catch { return { status: 'persistence_failed', attempts }; }
      if (!failure.retryable || attemptNumber >= LLM1_MAX_ATTEMPTS) return { status: 'failed', outcome: 'no_action', failure_code: failure.code, attempts };
    }
  }
  return { status: 'failed', outcome: 'no_action', failure_code: 'provider_unavailable', attempts };
}
