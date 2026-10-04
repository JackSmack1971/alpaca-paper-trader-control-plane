import { normalizeAccountState, type AccountState } from '../domain/account-state.js';
import { ALPACA_PAPER_BASE_URL, assertPaperOnly } from '../domain/paper.js';

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const OPEN_ORDERS_URL = '/v2/orders?status=open&limit=500';
const rateHeaderNames = ['x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset'] as const;
type RateLimitObservation = Partial<Record<(typeof rateHeaderNames)[number], string>>;
export type AccountFailureKind = 'network' | 'timeout' | 'rate_limited' | 'unauthorized' | 'provider_error' | 'invalid_response';

export class AlpacaAccountError extends Error {
  constructor(readonly kind: AccountFailureKind, readonly retryAfterMs?: number) {
    super(`Alpaca PAPER account request failed: ${kind}`);
    this.name = 'AlpacaAccountError';
  }
}

async function boundedJson(response: Response): Promise<unknown> {
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) throw new AlpacaAccountError('invalid_response');
  if (!response.body) throw new AlpacaAccountError('invalid_response');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new AlpacaAccountError('invalid_response');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total)));
  } catch (error) {
    if (error instanceof AlpacaAccountError) throw error;
    throw new AlpacaAccountError('invalid_response');
  }
}

/** Read-only Alpaca PAPER Trading API adapter. It has no order-writing operation. */
export class AlpacaPaperAccountClient {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private lastRateLimit: RateLimitObservation = {};

  constructor(private readonly keyId: string, private readonly secretKey: string, options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}) {
    assertPaperOnly();
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    if (!keyId || !secretKey || !Number.isInteger(this.timeoutMs) || this.timeoutMs < 1_000 || this.timeoutMs > 30_000) {
      throw new Error('invalid Alpaca PAPER account client configuration');
    }
  }

  rateLimitObservation() { return { ...this.lastRateLimit }; }

  private async get(path: string): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(new URL(path, ALPACA_PAPER_BASE_URL), {
        method: 'GET',
        headers: {
          accept: 'application/json',
          'APCA-API-KEY-ID': this.keyId,
          'APCA-API-SECRET-KEY': this.secretKey,
        },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new AlpacaAccountError(error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'network');
    }
    const observation: RateLimitObservation = {};
    for (const name of rateHeaderNames) {
      const value = response.headers.get(name);
      if (value && /^\d{1,20}$/.test(value)) observation[name] = value;
    }
    this.lastRateLimit = { ...this.lastRateLimit, ...observation };
    const retryAfter = response.headers.get('retry-after');
    const retryAfterSeconds = retryAfter && /^\d{1,5}$/.test(retryAfter) ? Number(retryAfter) : 0;
    if (response.status === 429) throw new AlpacaAccountError('rate_limited', retryAfterSeconds > 0 ? retryAfterSeconds * 1000 : undefined);
    if (response.status === 401 || response.status === 403) throw new AlpacaAccountError('unauthorized');
    if (!response.ok) throw new AlpacaAccountError('provider_error');
    return boundedJson(response);
  }

  async reconcile(at = new Date()): Promise<AccountState> {
    if (!Number.isFinite(at.getTime())) throw new Error('invalid account reconciliation time');
    this.lastRateLimit = {};
    try {
      const account = await this.get('/v2/account');
      const positions = await this.get('/v2/positions');
      const openOrders = await this.get(OPEN_ORDERS_URL);
      if (Array.isArray(openOrders) && openOrders.length >= 500) throw new AlpacaAccountError('invalid_response');
      const clock = await this.get('/v2/clock');
      return normalizeAccountState({ account, positions, open_orders: openOrders, clock }, at.toISOString(), 'alpaca_paper');
    } catch (error) {
      if (error instanceof AlpacaAccountError) throw error;
      throw new AlpacaAccountError('invalid_response');
    }
  }
}

export type AccountReconciliationSnapshot = {
  status: 'not_configured' | 'connected' | 'stale' | 'degraded';
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastError: AccountFailureKind | null;
  consecutiveFailures: number;
  retryInMs: number | null;
  rateLimit: RateLimitObservation;
  account: (AccountState & { freshness: { status: 'fresh' | 'stale'; ageMs: number } }) | null;
};

/** One in-process owner for periodic, atomic account snapshots. */
export class AlpacaPaperAccountReconciler {
  private latest: AccountState | null = null;
  private lastAttemptAt: string | null = null;
  private lastSuccessAt: string | null = null;
  private lastError: AccountFailureKind | null = null;
  private consecutiveFailures = 0;
  private retryInMs: number | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private rateLimit: RateLimitObservation = {};

  constructor(
    private readonly client: AlpacaPaperAccountClient,
    private readonly intervalSeconds: number,
    private readonly retryBaseSeconds: number,
    private readonly retryMaxSeconds: number,
    private readonly staleAfterSeconds = 60,
    private readonly now: () => Date = () => new Date(),
  ) {
    if (!Number.isInteger(intervalSeconds) || intervalSeconds < 10 || !Number.isInteger(retryBaseSeconds) || retryBaseSeconds < 1 || retryMaxSeconds < retryBaseSeconds || !Number.isInteger(staleAfterSeconds) || staleAfterSeconds < 1) {
      throw new Error('invalid Alpaca PAPER reconciliation schedule');
    }
  }

  snapshot(): AccountReconciliationSnapshot {
    const ageMs = this.latest && this.lastSuccessAt ? Math.max(0, this.now().getTime() - Date.parse(this.lastSuccessAt)) : 0;
    const freshness = ageMs <= this.staleAfterSeconds * 1000 ? 'fresh' as const : 'stale' as const;
    return {
      status: this.lastError ? 'degraded' : this.latest ? (freshness === 'fresh' ? 'connected' : 'stale') : 'not_configured',
      lastAttemptAt: this.lastAttemptAt,
      lastSuccessAt: this.lastSuccessAt,
      lastError: this.lastError,
      consecutiveFailures: this.consecutiveFailures,
      retryInMs: this.retryInMs,
      rateLimit: { ...this.rateLimit },
      account: this.latest ? { ...structuredClone(this.latest), freshness: { status: freshness, ageMs } } : null,
    };
  }

  async reconcileOnce(): Promise<AccountReconciliationSnapshot> {
    const at = this.now();
    this.lastAttemptAt = at.toISOString();
    try {
      const next = await this.client.reconcile(at);
      this.latest = next;
      this.lastSuccessAt = at.toISOString();
      this.lastError = null;
      this.consecutiveFailures = 0;
      this.retryInMs = null;
    } catch (error) {
      this.lastError = error instanceof AlpacaAccountError ? error.kind : 'provider_error';
      this.consecutiveFailures = Math.min(this.consecutiveFailures + 1, 16);
      const exponential = this.retryBaseSeconds * 1000 * (2 ** (this.consecutiveFailures - 1));
      const retryAfter = error instanceof AlpacaAccountError ? error.retryAfterMs ?? 0 : 0;
      this.retryInMs = Math.min(3_600_000, Math.max(retryAfter, Math.min(exponential, this.retryMaxSeconds * 1000, this.intervalSeconds * 1000)));
    }
    this.rateLimit = this.client.rateLimitObservation();
    return this.snapshot();
  }

  start(onUpdate: (state: AccountReconciliationSnapshot) => void = () => undefined) {
    if (this.running) return;
    this.running = true;
    const tick = async () => {
      const result = await this.reconcileOnce();
      if (!this.running) return;
      try { onUpdate(result); } catch { /* observers cannot break reconciliation */ }
      const delay = this.retryInMs ?? this.intervalSeconds * 1000;
      this.timer = setTimeout(() => { void tick(); }, delay);
    };
    void tick();
  }

  stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}
