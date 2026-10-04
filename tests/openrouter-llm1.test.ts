import { describe, expect, it } from 'vitest';
import { LLM1_MAX_ATTEMPTS, requestLlm1Analysis, type OpenRouterLlm1Options } from '../src/infra/openrouter-llm1.js';
import type { Llm1Input } from '../src/domain/llm1-analysis.js';
import { Llm1RequestRateLimiter } from '../src/services/llm1-rate-limiter.js';

const analysis = {
  schema_version: 1,
  action_hypothesis: 'no_action',
  thesis: 'The available observations do not support a directional candidate.',
  supporting_evidence: ['The market snapshot is current.'],
  contradicting_evidence: ['The recent trend is not conclusive.'],
  uncertainty: 'The local replay has limited history.',
  horizon: { value: 2, unit: 'hours' },
  blocking_preconditions: [],
  no_action_rationale: 'Wait for additional evidence.',
} as const;

const input: Llm1Input = {
  stage_id: 'llm1_market_analyst',
  stage_version: '1.0.0',
  cycle_id: '0199d69b-426b-7d8b-a284-4868d23e3b2f',
  decision_context_id: '0199d69b-426b-7d8b-a284-4868d23e3b30',
  normalized_input_ref: `sha256:${'a'.repeat(64)}`,
  messages: [
    { role: 'system', content: 'Versioned bounded instructions.' },
    { role: 'user', content: '{"mode":"paper"}' },
  ],
};

function successBody() {
  return {
    id: 'generation-123', model: 'provider/model-resolved', system_fingerprint: 'fingerprint-7',
    choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(analysis) } }],
    usage: { prompt_tokens: 120, completion_tokens: 80, cost: 0.00125 },
    openrouter_metadata: { endpoints: { available: [{ provider: 'OpenAI', model: 'provider/model-resolved', selected: true }] } },
  };
}

function options(fetchImpl: typeof fetch, extra: Partial<OpenRouterLlm1Options> = {}): OpenRouterLlm1Options {
  return {
    apiKey: 'test-secret-sentinel', baseUrl: 'https://openrouter.ai/api/v1', requestedModel: 'provider/model-requested',
    timeoutMs: 1_000, maxCompletionTokens: 800, sessionId: 'session-test-1', fetchImpl,
    beforeAttempt: async () => undefined,
    now: () => new Date('2026-01-02T03:04:05.000Z'), ...extra,
  };
}

describe('OpenRouter LLM1 adapter', () => {
  it('requests strict bounded structured output with no tools and validates/preserves response provenance', async () => {
    let requestUrl = '';
    let requestInit: RequestInit | undefined;
    const result = await requestLlm1Analysis(input, options(async (url, init) => {
      requestUrl = String(url);
      requestInit = init;
      return new Response(JSON.stringify(successBody()), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    expect(result.status).toBe('succeeded');
    if (result.status !== 'succeeded') return;
    expect(result.analysis).toEqual(analysis);
    expect(result.attempts[0]).toMatchObject({
      attempt_number: 1, status: 'succeeded', http_status: 200, provider_request_id: 'generation-123',
      resolved_model: 'provider/model-resolved', resolved_provider: 'OpenAI', system_fingerprint: 'fingerprint-7',
      prompt_tokens: 120, completion_tokens: 80, reported_cost: '0.00125',
    });
    expect(requestUrl).toBe('https://openrouter.ai/api/v1/chat/completions');
    const body = JSON.parse(String(requestInit?.body));
    expect((requestInit?.headers as Record<string, string>).authorization).toBe('Bearer test-secret-sentinel');
    expect(body).toMatchObject({
      model: 'provider/model-requested', temperature: 0, max_completion_tokens: 800, stream: false,
      provider: { require_parameters: true, data_collection: 'deny' },
      response_format: { type: 'json_schema', json_schema: { name: 'llm1_market_analysis_v1', strict: true } },
      trace: { trace_id: input.cycle_id }, session_id: 'session-test-1',
    });
    expect(body.tools).toBeUndefined();
    expect(requestInit?.redirect).toBe('error');
  });

  it('rejects malformed analysis and never returns provider error bodies', async () => {
    const malformed = { ...successBody(), choices: [{ finish_reason: 'stop', message: { content: '{"action_hypothesis":"market_buy"}' } }] };
    const badOutput = await requestLlm1Analysis(input, options(async () => new Response(JSON.stringify(malformed), { status: 200 })));
    expect(badOutput).toMatchObject({ status: 'failed', outcome: 'no_action', failure_code: 'analysis_output_invalid' });

    const unsupported = await requestLlm1Analysis(input, options(async () => new Response(JSON.stringify({ error: { code: 'unsupported_response_format', message: 'test-secret-sentinel unsupported' } }), { status: 400 })));
    expect(unsupported).toMatchObject({ status: 'failed', outcome: 'no_action', failure_code: 'unsupported_structured_output' });
    expect(JSON.stringify(unsupported)).not.toContain('test-secret-sentinel');
    expect(JSON.stringify(unsupported)).not.toContain('unsupported_response_format');
  });

  it('rejects successful analysis or provider metadata that echoes the configured credential', async () => {
    const echoedAnalysis = { ...successBody(), choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ ...analysis, thesis: 'test-secret-sentinel' }) } }] };
    const analysisResult = await requestLlm1Analysis(input, options(async () => new Response(JSON.stringify(echoedAnalysis), { status: 200 })));
    expect(analysisResult).toMatchObject({ status: 'failed', outcome: 'no_action', failure_code: 'provider_response_invalid' });
    expect(JSON.stringify(analysisResult)).not.toContain('test-secret-sentinel');

    const echoedMetadata = { ...successBody(), id: 'test-secret-sentinel' };
    const metadataResult = await requestLlm1Analysis(input, options(async () => new Response(JSON.stringify(echoedMetadata), { status: 200 })));
    expect(metadataResult).toMatchObject({ status: 'failed', outcome: 'no_action', failure_code: 'provider_response_invalid' });
    expect(JSON.stringify(metadataResult)).not.toContain('test-secret-sentinel');
  });

  it('rejects incomplete responses without an explicit stop finish reason', async () => {
    for (const finishReason of [undefined, null, 'length']) {
      const body = successBody();
      const choice = { ...body.choices[0] };
      if (finishReason === undefined) delete (choice as { finish_reason?: string | null }).finish_reason;
      else (choice as { finish_reason?: string | null }).finish_reason = finishReason;
      const responseBody = { ...body, choices: [choice] };
      const result = await requestLlm1Analysis(input, options(async () => new Response(JSON.stringify(responseBody), { status: 200 })));
      expect(result).toMatchObject({ status: 'failed', outcome: 'no_action', failure_code: 'provider_response_invalid' });
    }
  });

  it('retries a transient provider failure at most once and records both attempts', async () => {
    let count = 0;
    let virtualNow = 0;
    const startTimes: number[] = [];
    const limiter = new Llm1RequestRateLimiter(() => virtualNow, async (ms) => { virtualNow += ms; });
    const events: string[] = [];
    const result = await requestLlm1Analysis(input, options(async () => {
      count += 1;
      startTimes.push(virtualNow);
      events.push(`request-${count}`);
      return count === 1
        ? new Response(JSON.stringify({ error: { code: 'rate_limited' } }), { status: 429 })
        : new Response(JSON.stringify(successBody()), { status: 200 });
    }, { beforeAttempt: () => limiter.acquire(30_000), onAttempt: async (attempt) => { events.push(`persist-${attempt.attempt_number}`); } }));
    expect(count).toBe(2);
    expect(events).toEqual(['request-1', 'persist-1', 'request-2', 'persist-2']);
    expect(startTimes).toEqual([0, 30_000]);
    expect(LLM1_MAX_ATTEMPTS).toBe(2);
    expect(result.status).toBe('succeeded');
    expect(result.attempts.map((attempt) => attempt.status)).toEqual(['retryable_failure', 'succeeded']);
  });

  it('stops before retry when the completed attempt cannot be persisted', async () => {
    let count = 0;
    const result = await requestLlm1Analysis(input, options(async () => {
      count += 1;
      return new Response('{}', { status: 503 });
    }, { onAttempt: async () => { throw new Error('persistence unavailable'); } }));
    expect(count).toBe(1);
    expect(result).toMatchObject({ status: 'persistence_failed', attempts: [{ attempt_number: 1 }] });
  });

  it('does not retry authentication, request, or exhausted-credit failures', async () => {
    for (const [status, code] of [[401, 'provider_authentication_failed'], [402, 'provider_credits_exhausted'], [400, 'provider_request_rejected']] as const) {
      let count = 0;
      const result = await requestLlm1Analysis(input, options(async () => {
        count += 1;
        return new Response(JSON.stringify({ error: { code: 'invalid_request', message: 'private response' } }), { status });
      }));
      expect(count).toBe(1);
      expect(result).toMatchObject({ status: 'failed', outcome: 'no_action', failure_code: code });
    }
  });

  it('turns timeout into one bounded retry and then terminal no-action', async () => {
    let count = 0;
    const result = await requestLlm1Analysis(input, options(async () => {
      count += 1;
      return await new Promise<Response>(() => {});
    }, { timeoutMs: 5 }));
    expect(count).toBe(LLM1_MAX_ATTEMPTS);
    expect(result).toMatchObject({ status: 'failed', outcome: 'no_action', failure_code: 'request_timeout' });
    expect(result.attempts.map((attempt) => attempt.failure_code)).toEqual(['request_timeout', 'request_timeout']);
  });

  it('prevents credential-bearing requests to non-OpenRouter endpoints', async () => {
    let count = 0;
    const result = await requestLlm1Analysis(input, options(async () => {
      count += 1;
      return new Response('{}', { status: 200 });
    }, { baseUrl: 'https://attacker.example/api/v1' }));
    expect(count).toBe(0);
    expect(result).toMatchObject({ status: 'failed', outcome: 'no_action', failure_code: 'provider_request_rejected' });
  });
});
