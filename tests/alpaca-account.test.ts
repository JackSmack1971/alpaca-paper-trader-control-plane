import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AlpacaAccountError, AlpacaPaperAccountClient, AlpacaPaperAccountReconciler } from '../src/infra/alpaca-account.js';
import { loadLocalFixtures } from '../src/infra/local-fixtures.js';

describe('read-only Alpaca PAPER account reconciliation', () => {
  type AccountFixture = { account: Record<string, unknown>; positions: Array<Record<string, unknown>>; open_orders: Array<Record<string, unknown>>; clock: Record<string, unknown> };
  let fixture: AccountFixture;

  beforeEach(async () => { fixture = (await loadLocalFixtures()).account as AccountFixture; });

  it('uses only fixed PAPER GET endpoints and publishes one normalized complete snapshot', async () => {
    const paths: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input.toString());
      paths.push(`${url.host}${url.pathname}${url.search}`);
      expect(url.origin).toBe('https://paper-api.alpaca.markets');
      expect(init?.method).toBe('GET');
      const headers = new Headers(init?.headers);
      expect(headers.get('APCA-API-KEY-ID')).toBe('test-key');
      expect(headers.get('APCA-API-SECRET-KEY')).toBe('test-secret');
      const data = url.pathname.endsWith('/account') ? fixture.account
        : url.pathname.endsWith('/positions') ? fixture.positions
          : url.pathname.endsWith('/orders') ? fixture.open_orders
            : fixture.clock;
      return Response.json(data, { headers: { 'x-ratelimit-limit': '200', 'x-ratelimit-remaining': '196', 'x-ratelimit-reset': '1791111000' } });
    });
    const client = new AlpacaPaperAccountClient('test-key', 'test-secret', { fetchImpl, timeoutMs: 2000 });
    const state = await client.reconcile(new Date('2025-01-02T15:00:00.000Z'));

    expect(paths).toEqual([
      'paper-api.alpaca.markets/v2/account',
      'paper-api.alpaca.markets/v2/positions',
      'paper-api.alpaca.markets/v2/orders?status=open&limit=500',
      'paper-api.alpaca.markets/v2/clock',
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(state).toMatchObject({ mode: 'paper', reconciledAt: '2025-01-02T15:00:00.000Z', provenance: { source: 'alpaca_paper' }, positions: [{ symbol: 'AAPL' }, { symbol: 'TSLA' }] });
    expect(state.exposure.gross).toBe('1146.9');
    expect(client.rateLimitObservation()).toEqual({ 'x-ratelimit-limit': '200', 'x-ratelimit-remaining': '196', 'x-ratelimit-reset': '1791111000' });
  });

  it('fetches a fresh complete provider snapshot when a new reconciler starts after restart', async () => {
    let provider = structuredClone(fixture);
    const createReconciler = () => {
      const paths: string[] = [];
      const fetchImpl = vi.fn(async (input: string | URL | Request) => {
        const path = new URL(input.toString()).pathname;
        paths.push(path);
        const data = path.endsWith('/account') ? provider.account
          : path.endsWith('/positions') ? provider.positions
            : path.endsWith('/orders') ? provider.open_orders
              : provider.clock;
        return Response.json(data);
      });
      const client = new AlpacaPaperAccountClient('test-key', 'test-secret', { fetchImpl });
      const reconciler = new AlpacaPaperAccountReconciler(client, 60, 5, 60, 60, () => new Date('2025-01-02T15:00:00.000Z'));
      return { reconciler, fetchImpl, paths };
    };

    const firstProcess = createReconciler();
    const first = await firstProcess.reconciler.reconcileOnce();
    expect(first.status).toBe('connected');
    expect(first.account?.account.equity).toBe('100000');
    expect(firstProcess.fetchImpl).toHaveBeenCalledTimes(4);

    provider = {
      ...structuredClone(fixture),
      account: { ...fixture.account, equity: '125000.50' },
    };
    const restartedProcess = createReconciler();
    const restored = await restartedProcess.reconciler.reconcileOnce();

    expect(restartedProcess.fetchImpl).toHaveBeenCalledTimes(4);
    expect(restartedProcess.paths).toEqual(['/v2/account', '/v2/positions', '/v2/orders', '/v2/clock']);
    expect(restored).toMatchObject({
      status: 'connected',
      account: {
        mode: 'paper',
        account: { equity: '125000.5' },
        provenance: { source: 'alpaca_paper' },
        positions: [{ symbol: 'AAPL' }, { symbol: 'TSLA' }],
        openOrders: [{ clientOrderId: 'fixture-open-order-1' }],
      },
    });
  });

  it('fails closed on a rate limit and exposes no response body or credentials', async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return Response.json(fixture.account);
      return new Response('private-provider-error-secret', { status: 429, headers: { 'retry-after': '7', 'x-ratelimit-remaining': '0' } });
    });
    const client = new AlpacaPaperAccountClient('private-key', 'private-secret', { fetchImpl });

    await expect(client.reconcile()).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 7000 });
    try { await client.reconcile(); } catch (error) {
      expect((error as Error).message).not.toContain('private-provider-error-secret');
      expect((error as Error).message).not.toContain('private-key');
      expect((error as Error).message).not.toContain('private-secret');
    }
    expect(client.rateLimitObservation()).toEqual({ 'x-ratelimit-remaining': '0' });
  });

  it('retains the last good complete snapshot after a failed refresh and reports bounded retry delay', async () => {
    let fail = false;
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input.toString());
      if (fail && url.pathname.endsWith('/positions')) return new Response('{}', { status: 503 });
      const data = url.pathname.endsWith('/account') ? fixture.account
        : url.pathname.endsWith('/positions') ? fixture.positions
          : url.pathname.endsWith('/orders') ? fixture.open_orders
            : fixture.clock;
      return Response.json(data);
    });
    const client = new AlpacaPaperAccountClient('key', 'secret', { fetchImpl });
    const reconciler = new AlpacaPaperAccountReconciler(client, 60, 5, 60, 60, () => new Date('2025-01-02T15:00:00.000Z'));
    const good = await reconciler.reconcileOnce();
    expect(good.status).toBe('connected');
    fail = true;
    const failed = await reconciler.reconcileOnce();
    expect(failed).toMatchObject({ status: 'degraded', lastError: 'provider_error', consecutiveFailures: 1, retryInMs: 5000 });
    expect(failed.account).toEqual(good.account);
  });

  it('rejects a capped open-order page and malformed provider payloads', async () => {
    const cappedOrders = Array.from({ length: 500 }, (_, index) => ({ ...fixture.open_orders[0], id: `00000000-0000-4000-8000-${String(index + 100).padStart(12, '0')}` }));
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const path = new URL(input.toString()).pathname;
      const data = path.endsWith('/account') ? fixture.account
        : path.endsWith('/positions') ? fixture.positions
          : path.endsWith('/orders') ? cappedOrders
            : fixture.clock;
      return Response.json(data);
    });
    const client = new AlpacaPaperAccountClient('key', 'secret', { fetchImpl });
    await expect(client.reconcile()).rejects.toMatchObject({ kind: 'invalid_response' });

    const malformed = new AlpacaPaperAccountClient('key', 'secret', { fetchImpl: vi.fn(async () => Response.json({ bad: true })) });
    await expect(malformed.reconcile()).rejects.toBeInstanceOf(AlpacaAccountError);
  });

  it('marks a retained snapshot stale using the injected clock', async () => {
    let now = new Date('2025-01-02T15:00:00.000Z');
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const path = new URL(input.toString()).pathname;
      const data = path.endsWith('/account') ? fixture.account
        : path.endsWith('/positions') ? fixture.positions
          : path.endsWith('/orders') ? fixture.open_orders
            : fixture.clock;
      return Response.json(data);
    });
    const reconciler = new AlpacaPaperAccountReconciler(new AlpacaPaperAccountClient('key', 'secret', { fetchImpl }), 60, 5, 60, 60, () => now);
    await reconciler.reconcileOnce();
    expect(reconciler.snapshot().account?.freshness).toEqual({ status: 'fresh', ageMs: 0 });
    now = new Date('2025-01-02T15:01:01.000Z');
    expect(reconciler.snapshot()).toMatchObject({ status: 'stale', account: { freshness: { status: 'stale', ageMs: 61_000 } } });
  });
});
