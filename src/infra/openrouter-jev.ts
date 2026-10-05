import {
  JEV_ENDPOINT_PATH,
  JEV_REQUESTED_MODEL,
  assertJevRequestWithinBound,
  parseJevResponse,
  type JevParsedResponse,
  type JevRequest,
} from '../domain/jev-decision.js';

export const JEV_MAX_ATTEMPTS = 2;
export const JEV_RETRYABLE_HTTP_STATUSES = [408, 429, 500, 502, 503, 524, 529] as const;
const MAX_RESPONSE_BYTES = 65_536;

function containsCredential(value: unknown, credential: string): boolean {
  if (typeof value === 'string') return value.includes(credential);
  if (Array.isArray(value)) return value.some((item) => containsCredential(item, credential));
  if (value && typeof value === 'object') return Object.values(value).some((item) => containsCredential(item, credential));
  return false;
}

export type JevFailureCode =
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
  | 'provider_response_invalid'
  | 'provider_answer_invalid'
  | 'request_preflight_failed'
  | 'llm1_output_unavailable';

export type JevAttemptEvidence = {
  attempt_number: number;
  status: 'succeeded' | 'retryable_failure' | 'failed';
  started_at: string;
  completed_at: string;
  latency_ms: number;
  http_status: number | null;
  failure_code: JevFailureCode | null;
  provider_request_id: string | null;
  resolved_model: string | null;
  resolved_provider: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  reported_cost: string | null;
  response_evidence: { endpoint: string; body_present: boolean; answer_validation: 'passed' | 'failed' | 'not_checked' };
};

export type JevInvocation =
  | { status: 'succeeded'; response: JevParsedResponse; attempts: JevAttemptEvidence[] }
  | { status: 'persistence_failed'; attempts: JevAttemptEvidence[] }
  | { status: 'failed'; outcome: 'no_action'; failure_code: JevFailureCode; attempts: JevAttemptEvidence[] };

export type OpenRouterJevOptions = {
  apiKey: string | undefined;
  baseUrl: string;
  timeoutMs: number;
  request: JevRequest;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  delay?: (ms: number) => Promise<void>;
  beforeAttempt?: () => Promise<void>;
  onAttempt?: (evidence: JevAttemptEvidence, response: JevParsedResponse | null) => Promise<void>;
};

class ProviderFault extends Error {
  constructor(readonly code: JevFailureCode, readonly retryable: boolean, readonly httpStatus: number | null = null, readonly answerInvalid = false) {
    super(code);
  }
}

function endpointFromBase(baseUrl: string): URL {
  let base: URL;
  try { base = new URL(baseUrl); } catch { throw new ProviderFault('provider_request_rejected', false); }
  if (base.protocol !== 'https:' || base.hostname !== 'openrouter.ai' || base.port !== '' || base.pathname.replace(/\/$/, '') !== '/api/v1' || base.username || base.password || base.search || base.hash) {
    throw new ProviderFault('provider_request_rejected', false);
  }
  return new URL(JEV_ENDPOINT_PATH, 'https://openrouter.ai');
}

function failureForStatus(status: number): ProviderFault {
  if (status === 401) return new ProviderFault('provider_authentication_failed', false, status);
  if (status === 402) return new ProviderFault('provider_credits_exhausted', false, status);
  if (status === 403) return new ProviderFault('provider_forbidden', false, status);
  if (status === 404) return new ProviderFault('provider_model_unavailable', false, status);
  if (status === 429) return new ProviderFault('provider_rate_limited', true, status);
  if ((JEV_RETRYABLE_HTTP_STATUSES as readonly number[]).includes(status)) return new ProviderFault('provider_unavailable', true, status);
  return new ProviderFault('provider_request_rejected', status >= 500, status);
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) throw new ProviderFault('provider_response_invalid', false, response.status);
  if (!response.body) throw new ProviderFault('provider_response_invalid', false, response.status);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new ProviderFault('provider_response_invalid', false, response.status);
      }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(bytes)) as unknown; }
  catch { throw new ProviderFault('provider_response_invalid', false, response.status); }
}

function safeIdentifier(value: string | undefined, pattern: RegExp): string | null {
  return value !== undefined && pattern.test(value) ? value : null;
}

function asAttempt(args: {
  attempt: number; start: Date; end: Date; status: number | null; failure: ProviderFault | null;
  response: JevParsedResponse | null; endpoint: string; bodyPresent: boolean; answerValidation: JevAttemptEvidence['response_evidence']['answer_validation'];
}): JevAttemptEvidence {
  const { attempt, start, end, status, failure, response, endpoint, bodyPresent, answerValidation } = args;
  return {
    attempt_number: attempt,
    status: failure ? (failure.retryable && attempt < JEV_MAX_ATTEMPTS ? 'retryable_failure' : 'failed') : 'succeeded',
    started_at: start.toISOString(), completed_at: end.toISOString(), latency_ms: Math.max(0, end.getTime() - start.getTime()),
    http_status: status, failure_code: failure?.code ?? null,
    provider_request_id: safeIdentifier(response?.provider_request_id ?? undefined, /^[A-Za-z0-9._:-]{1,256}$/),
    resolved_model: safeIdentifier(response?.resolved_model, /^[A-Za-z0-9._/:+-]{1,256}$/),
    resolved_provider: safeIdentifier(response?.provider ?? undefined, /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,127}$/),
    input_tokens: response?.usage.input_tokens ?? null, output_tokens: response?.usage.output_tokens ?? null,
    reported_cost: response?.usage.cost === null || response?.usage.cost === undefined ? null : String(response.usage.cost),
    response_evidence: { endpoint, body_present: bodyPresent, answer_validation: answerValidation },
  };
}

async function callOnce(options: OpenRouterJevOptions, endpoint: URL, attempt: number): Promise<{ parsed: JevParsedResponse; evidence: JevAttemptEvidence }> {
  const now = options.now ?? (() => new Date());
  const start = now();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (!options.apiKey) throw new ProviderFault('provider_authentication_failed', false);
    if (options.request.model !== JEV_REQUESTED_MODEL) throw new ProviderFault('model_not_configured', false);
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new ProviderFault('request_timeout', true)); }, options.timeoutMs);
    });
    const operation = async () => {
      const response = await (options.fetchImpl ?? fetch)(endpoint, {
        method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { authorization: `Bearer ${options.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify(options.request),
      });
      if (!response.ok) throw failureForStatus(response.status);
      const raw = await readBoundedJson(response);
      let parsed: JevParsedResponse;
      try { parsed = parseJevResponse(raw); }
      catch { throw new ProviderFault('provider_answer_invalid', false, response.status, true); }
      if (containsCredential(raw, options.apiKey!)) throw new ProviderFault('provider_response_invalid', false, response.status);
      if (!parsed.answers || parsed.resolved_model.length === 0) throw new ProviderFault('provider_answer_invalid', false, response.status, true);
      const evidence = asAttempt({ attempt, start, end: now(), status: response.status, failure: null, response: parsed, endpoint: endpoint.href, bodyPresent: true, answerValidation: 'passed' });
      return { parsed, evidence };
    };
    return await Promise.race([operation(), timeout]);
  } catch (error) {
    const failure = error instanceof ProviderFault
      ? error
      : error instanceof Error && error.name === 'AbortError'
        ? new ProviderFault('request_timeout', true)
        : new ProviderFault('transport_failure', true);
    const evidence = asAttempt({ attempt, start, end: now(), status: failure.httpStatus, failure, response: null, endpoint: endpoint.href, bodyPresent: failure.httpStatus !== null && failure.httpStatus >= 200 && failure.httpStatus < 300, answerValidation: failure.answerInvalid ? 'failed' : 'not_checked' });
    throw Object.assign(failure, { evidence });
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

/** Decisions API adapter: only the official fixed host/path is reachable from this boundary. */
export async function requestJevDecision(options: OpenRouterJevOptions): Promise<JevInvocation> {
  const now = options.now ?? (() => new Date());
  const attempts: JevAttemptEvidence[] = [];
  let endpoint: URL;
  try { endpoint = endpointFromBase(options.baseUrl); assertJevRequestWithinBound(options.request); }
  catch (error) {
    const failure = error instanceof ProviderFault ? error : new ProviderFault('provider_request_rejected', false);
    const at = now();
    attempts.push(asAttempt({ attempt: 1, start: at, end: at, status: null, failure, response: null, endpoint: `https://openrouter.ai${JEV_ENDPOINT_PATH}`, bodyPresent: false, answerValidation: 'not_checked' }));
    return { status: 'failed', outcome: 'no_action', failure_code: failure.code, attempts };
  }
  const delay = options.delay ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 1; attempt <= JEV_MAX_ATTEMPTS; attempt += 1) {
    try {
      await options.beforeAttempt?.();
      const result = await callOnce(options, endpoint, attempt);
      attempts.push(result.evidence);
      try { await options.onAttempt?.(result.evidence, result.parsed); }
      catch { return { status: 'persistence_failed', attempts }; }
      return { status: 'succeeded', response: result.parsed, attempts };
    } catch (error) {
      const failure = error instanceof ProviderFault ? error : new ProviderFault('transport_failure', true);
      const evidence = (error as ProviderFault & { evidence?: JevAttemptEvidence }).evidence;
      attempts.push(evidence ?? asAttempt({ attempt, start: now(), end: now(), status: failure.httpStatus, failure, response: null, endpoint: endpoint.href, bodyPresent: false, answerValidation: 'not_checked' }));
      try { await options.onAttempt?.(attempts.at(-1)!, null); }
      catch { return { status: 'persistence_failed', attempts }; }
      if (!failure.retryable || attempt === JEV_MAX_ATTEMPTS) return { status: 'failed', outcome: 'no_action', failure_code: failure.code, attempts };
      await delay(Math.min(250 * attempt, 500));
    }
  }
  return { status: 'failed', outcome: 'no_action', failure_code: 'provider_unavailable', attempts };
}
