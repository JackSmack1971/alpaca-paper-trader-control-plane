import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { InvalidLocalStateExpectation, LocalTestHarness, MAX_QUEUED_FAILURES_PER_PROVIDER, type SimulatedAccountResource } from '../src/domain/local-test-harness.js';
import { createApp } from '../src/api/app.js';
import { loadConfig } from '../src/infra/config.js';
import { loadLocalFixtures, parseLocalFixtureTexts } from '../src/infra/local-fixtures.js';
import { persistLocalRuntime, restoreLocalRuntime } from '../src/infra/local-runtime-snapshot.js';
import { createLocalAlpacaAccountFetch } from '../src/infra/local-alpaca-account-transport.js';
import { createLocalAlpacaMarketStream } from '../src/infra/local-alpaca-market-transport.js';
import { ALPACA_PAPER_BASE_URL } from '../src/domain/paper.js';

describe('loopback local runtime controls', () => {
  it('routes local account reconciliation through the PAPER adapter with bounded simulated failures and recovery', async () => {
    const config = await loadConfig({ DATABASE_URL: 'postgres://postgres@127.0.0.1/test', LOCAL_TEST_MODE: 'true' });
    const harness = new LocalTestHarness(await loadLocalFixtures());
    const readSimulatedResource = harness.accountAdapterResponse.bind(harness);
    vi.spyOn(harness, 'accountAdapterResponse').mockImplementation(async (resource) => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return readSimulatedResource(resource);
    });
    const app = createApp(config, { query: vi.fn() } as unknown as Pool, harness);
    const networkFetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('global fetch must not be used'));

    const firstReconciliations = await Promise.all([
      app.inject({ method: 'POST', url: '/__local/account/reconcile', payload: {} }),
      app.inject({ method: 'POST', url: '/__local/account/reconcile', payload: {} }),
    ]);
    expect(firstReconciliations.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    const success = firstReconciliations.find((response) => response.statusCode === 200)!;
    expect(success.statusCode).toBe(200);
    expect(success.json()).toMatchObject({
      simulated: true,
      mode: 'paper',
      status: 'reconciled',
      state: { account: { account: { equity: '100000', status: 'ACTIVE' }, provenance: { source: 'alpaca_paper', groups: ['account', 'positions', 'open_orders', 'market_clock'] }, positions: [{ symbol: 'AAPL', quantity: '3.5' }, { symbol: 'TSLA', quantity: '2' }], openOrders: [{ symbol: 'MSFT', quantity: '1.25' }], exposure: { long: '666.4', short: '480.5', gross: '1146.9', complete: true }, market: { timestamp: '2025-01-02T14:30:00.000Z' }, reconciledAt: '2025-01-02T14:30:00.000Z' } },
    });
    const successLog = (await app.inject('/__local/logs')).json().find((entry: { message: string }) => entry.message === 'simulated_account_adapter_reconciled');
    expect(successLog).toMatchObject({ resources: ['account', 'positions', 'orders', 'clock'], at: '2025-01-02T14:30:00.000Z' });
    expect(networkFetch).not.toHaveBeenCalled();

    for (const [kind, status, error] of [
      ['network', 503, 'simulated_network_failure'],
      ['rate_limit', 429, 'simulated_rate_limit'],
      ['broker', 403, 'simulated_broker_rejection'],
    ] as const) {
      const beforeFailure = (await app.inject('/__local/state')).json().account;
      await app.inject({ method: 'POST', url: '/__local/failures', payload: { target: 'account', kind } });
      const failed = await app.inject({ method: 'POST', url: '/__local/account/reconcile', payload: {} });
      expect(failed.statusCode).toBe(status);
      expect(failed.json()).toMatchObject({ simulated: true, mode: 'paper', error });
      expect((await app.inject('/__local/state')).json().account).toEqual(beforeFailure);
      expect((await app.inject('/__local/provider/health')).json().providers.account).toMatchObject({ status: 'degraded' });
      expect((await app.inject('/__local/traces')).json()).toContainEqual(expect.objectContaining({ method: 'POST', route: '/__local/account/reconcile', status }));
      const failureLog = (await app.inject('/__local/logs')).json().find((entry: { message: string; error?: string }) => entry.message === 'simulated_account_adapter_failed' && entry.error);
      expect(JSON.stringify(failureLog)).not.toContain('local-test-key');
      expect(JSON.stringify(failureLog)).not.toContain('local-test-secret');

      const recovered = await app.inject({ method: 'POST', url: '/__local/account/reconcile', payload: {} });
      expect(recovered.statusCode).toBe(200);
      expect(recovered.json().state.account.provenance.source).toBe('alpaca_paper');
      expect((await app.inject('/__local/provider/health')).json().providers.account).toMatchObject({ status: 'ready', lastError: null });
    }
    expect(networkFetch).not.toHaveBeenCalled();
    networkFetch.mockRestore();
    await app.close();
  });

  it('allows the local Alpaca transport only the fixed PAPER GET resources and never falls through to network', async () => {
    const readResource = vi.fn((resource: SimulatedAccountResource) => ({ simulated: true, data: { resource } }));
    const observeRequest = vi.fn((_resource: SimulatedAccountResource) => undefined);
    const localFetch = createLocalAlpacaAccountFetch(readResource, observeRequest);
    const allowed = [
      '/v2/account',
      '/v2/positions',
      '/v2/orders?status=open&limit=500',
      '/v2/clock',
    ];
    for (const path of allowed) {
      const response = await localFetch(new URL(path, ALPACA_PAPER_BASE_URL), { method: 'GET' });
      expect(response.status).toBe(200);
    }
    expect(readResource).toHaveBeenCalledTimes(4);
    expect(observeRequest).toHaveBeenCalledTimes(4);
    for (const [url, init] of [
      ['https://live-api.alpaca.markets/v2/account', { method: 'GET' }],
      ['https://paper-api.alpaca.markets/v2/orders?status=all&limit=500', { method: 'GET' }],
      ['https://paper-api.alpaca.markets/v2/account', { method: 'POST' }],
    ] as const) {
      await expect(localFetch(url, init)).rejects.toThrow('unsupported simulated PAPER request');
    }
    expect(readResource).toHaveBeenCalledTimes(4);
  });

  it('compares bounded expected state projections and reports only mismatch paths', async () => {
    const config = await loadConfig({ DATABASE_URL: 'postgres://postgres@127.0.0.1/test', LOCAL_TEST_MODE: 'true' });
    const harness = new LocalTestHarness(await loadLocalFixtures());
    const app = createApp(config, { query: vi.fn() } as unknown as Pool, harness);
    const market = await app.inject('/market');
    expect(market.statusCode).toBe(200);
    expect(market.json()).toMatchObject({ mode: 'paper', status: { status: 'simulated' }, states: [] });
    const matched = await app.inject({ method: 'POST', url: '/__local/assert-state', payload: { expected: { now: '2025-01-02T14:30:00.000Z', replayCursor: 0, account: { exposure: { complete: true } } } } });
    expect(matched.statusCode).toBe(200);
    expect(matched.json()).toMatchObject({ simulated: true, mode: 'paper', matched: true, mismatchCount: 0, mismatchPaths: [] });
    const mismatch = await app.inject({ method: 'POST', url: '/__local/assert-state', payload: { expected: { replayCursor: 2, account: { credential: 'must-not-be-echoed' } } } });
    expect(mismatch.statusCode).toBe(200);
    expect(mismatch.json()).toMatchObject({ matched: false, mismatchCount: 2, mismatchPaths: ['$.replayCursor', '$.account.credential'] });
    expect(mismatch.body).not.toContain('must-not-be-echoed');
    expect((await app.inject({ method: 'POST', url: '/__local/assert-state', payload: { expected: {} } })).statusCode).toBe(400);
    expect((await app.inject('/__local/assert-state')).statusCode).toBe(404);
    const deep: Record<string, unknown> = {};
    let cursor = deep;
    for (let index = 0; index < 13; index += 1) { cursor.child = {}; cursor = cursor.child as Record<string, unknown>; }
    expect(() => harness.compareState(deep)).toThrow(InvalidLocalStateExpectation);
    await app.close();
  });

  it('resets, controls virtual time, replays bounded fixtures, and exposes normalized account state', async () => {
    const config = await loadConfig({ DATABASE_URL: 'postgres://postgres@127.0.0.1/test', LOCAL_TEST_MODE: 'true' });
    const harness = new LocalTestHarness(await loadLocalFixtures());
    const localMarket = createLocalAlpacaMarketStream(config, () => new Date(harness.state().now));
    localMarket.stream.start();
    await localMarket.transport.waitUntilReady();
    const pool = { query: vi.fn().mockResolvedValue({ rowCount: 1 }) } as unknown as Pool;
    const app = createApp(config, pool, harness, undefined, localMarket.stream, undefined, localMarket.transport);
    const state = await app.inject('/__local/state');
    const observedAccount = await app.inject('/account');
    expect(observedAccount.json()).toMatchObject({ mode: 'paper', status: 'simulated', account: { mode: 'paper', freshness: { status: 'fresh' } } });
    expect(state.statusCode).toBe(200);
    expect(state.json().account).toHaveProperty('positions');
    expect(state.json().account).toHaveProperty('openOrders');
    expect(state.json().account).toHaveProperty('exposure');
    expect(state.json().replayCursor).toBe(0);
    expect((await app.inject({ method: 'POST', url: '/__local/market/replay', payload: { steps: 2 } })).json().replayCursor).toBe(2);
    const observed = (await app.inject('/__local/state')).json();
    expect(observed).toMatchObject({ replayCursor: 2, marketStream: { status: 'connected', eventsProcessed: 2 }, marketTransport: { simulated: true, eventsSent: 2 } });
    expect(observed.market).toEqual(expect.arrayContaining([expect.objectContaining({ symbol: 'AAPL', lastTrade: expect.objectContaining({ price: 190.25, size: 2, sourceTime: '2025-01-02T14:30:00.000Z' }) })]));
    const replaySnapshot = harness.persistenceSnapshot();
    const restoredHarness = new LocalTestHarness(await loadLocalFixtures());
    restoredHarness.restore(replaySnapshot);
    expect(restoredHarness.state().replayCursor).toBe(2);
    expect(restoredHarness.state().market).toEqual(harness.state().market);
    expect(() => restoredHarness.restore({ ...replaySnapshot, market: [] })).toThrow(/does not match replay cursor/);
    const rewoundHarness = new LocalTestHarness(await loadLocalFixtures());
    rewoundHarness.restore({ ...replaySnapshot, now: '2025-01-02T14:00:00.000Z' });
    expect(rewoundHarness.state().now).toBe('2025-01-02T14:00:00.000Z');
    expect(rewoundHarness.state().market.every((item) => item.freshness === 'fresh')).toBe(true);
    expect((await app.inject({ method: 'POST', url: '/__local/market/replay', payload: { steps: 101 } })).statusCode).toBe(400);
    const fixed = await app.inject({ method: 'POST', url: '/__local/clock', payload: { now: '2025-01-02T14:31:00.000Z' } });
    expect(fixed.json().now).toBe('2025-01-02T14:31:00.000Z');
    expect(fixed.json().account.market.timestamp).toBe('2025-01-02T14:31:00.000Z');
    expect(fixed.json().account.freshness).toEqual({ status: 'fresh', ageMs: 60_000 });
    expect(fixed.json().market.every((item: { freshness: string }) => item.freshness === 'stale')).toBe(true);
    expect((await app.inject('/__local/provider/clock')).json().data.timestamp).toBe('2025-01-02T14:31:00.000Z');
    await app.inject({ method: 'GET', url: '/health?token=query-secret' });
    const traces = await app.inject('/__local/traces');
    expect(traces.body).not.toContain('query-secret');
    expect(traces.json().every((item: { route: string }) => !item.route.includes('?'))).toBe(true);
    const appLogs = (await app.inject('/__local/logs?limit=10')).json();
    expect(appLogs).toEqual(expect.arrayContaining([expect.objectContaining({ at: '2025-01-02T14:31:00.000Z', level: 'info', message: 'http_request_completed' })]));
    expect(appLogs).not.toEqual(traces.json());
    const stale = await app.inject({ method: 'POST', url: '/__local/clock', payload: { now: '2025-01-02T14:31:01.000Z' } });
    expect(stale.json().account.freshness).toEqual({ status: 'stale', ageMs: 61_000 });
    expect(stale.json().account.reconciledAt).toBe('2025-01-02T14:30:00.000Z');
    await app.inject({ method: 'POST', url: '/__local/failures', payload: { target: 'account', kind: 'network' } });
    const failedReconcile = await app.inject({ method: 'POST', url: '/__local/account/reconcile', payload: {} });
    expect(failedReconcile.statusCode).toBe(503);
    expect(failedReconcile.json()).toMatchObject({ simulated: true, mode: 'paper', error: 'simulated_network_failure' });
    expect((await app.inject('/__local/state')).json().account.freshness.status).toBe('stale');
    const reconciled = await app.inject({ method: 'POST', url: '/__local/account/reconcile', payload: {} });
    expect(reconciled.json()).toMatchObject({ simulated: true, mode: 'paper', status: 'reconciled', state: { account: { freshness: { status: 'fresh', ageMs: 0 }, reconciledAt: '2025-01-02T14:31:01.000Z' } } });
    const simulatedAccount = await app.inject('/__local/provider/account');
    expect(simulatedAccount.json()).toMatchObject({ simulated: true, mode: 'paper', resource: 'account', data: { status: 'ACTIVE' } });
    expect((await app.inject('/__local/provider/health')).json().providers.account.status).toBe('ready');
    expect((await app.inject('/__local/provider/positions')).json().data).toHaveLength(2);
    const armed = await app.inject({ method: 'POST', url: '/__local/failures', payload: { target: 'account', kind: 'rate_limit', count: 2 } });
    expect(armed.statusCode).toBe(200);
    expect((await app.inject('/__local/provider/orders')).statusCode).toBe(429);
    expect((await app.inject('/__local/provider/health')).json().providers.account).toMatchObject({ status: 'degraded', lastError: 'simulated_rate_limit' });
    expect((await app.inject('/__local/logs')).json()).toEqual(expect.arrayContaining([expect.objectContaining({ level: 'warn', message: 'simulated_provider_failure', error: 'simulated_rate_limit' })]));
    expect((await app.inject('/__local/provider/account')).statusCode).toBe(429);
    expect((await app.inject('/__local/provider/clock')).statusCode).toBe(200);
    expect((await app.inject('/__local/provider/health')).json().providers.account).toMatchObject({ status: 'ready', lastError: null });
    await app.inject({ method: 'POST', url: '/__local/reset', payload: {} });
    expect((await app.inject('/__local/provider/account')).statusCode).toBe(200);
    for (const [kind, status] of [['network', 503], ['broker', 403]] as const) {
      await app.inject({ method: 'POST', url: '/__local/failures', payload: { target: 'market', kind } });
      const failed = await app.inject('/__local/provider/market');
      expect(failed.statusCode).toBe(status);
      expect(failed.json()).toMatchObject({ simulated: true, mode: 'paper' });
      expect((await app.inject('/__local/provider/health')).json().providers.market.status).toBe('degraded');
      expect((await app.inject('/__local/provider/market')).statusCode).toBe(200);
      expect((await app.inject('/__local/provider/health')).json().providers.market.status).toBe('ready');
    }
    expect((await app.inject({ method: 'POST', url: '/__local/reset', payload: {} })).json().replayCursor).toBe(0);
    await app.close();
    const restoredMarket = createLocalAlpacaMarketStream(config, () => new Date(restoredHarness.state().now));
    restoredMarket.stream.start();
    await restoredMarket.transport.waitUntilReady();
    try {
      const fixtureStates = restoredHarness.state().market;
      restoredMarket.stream.restoreLocalReplay(restoredHarness.marketFixtureEvents(0, restoredHarness.state().replayCursor), fixtureStates.map((state) => ({ ...state, feed: config.alpacaDataFeed })));
      expect(restoredMarket.stream.marketStates()).toEqual(fixtureStates.map((state) => ({ ...state, feed: config.alpacaDataFeed })));
    } finally {
      restoredMarket.stream.stop();
    }
  });

  it('injects deterministic market-stream failures and recovers through the in-memory adapter', async () => {
    const config = await loadConfig({ DATABASE_URL: 'postgres://postgres@127.0.0.1/test', LOCAL_TEST_MODE: 'true' });
    const harness = new LocalTestHarness(await loadLocalFixtures());
    const localMarket = createLocalAlpacaMarketStream(config, () => new Date(harness.state().now));
    localMarket.stream.start();
    await localMarket.transport.waitUntilReady();
    const app = createApp(config, { query: vi.fn() } as unknown as Pool, harness, undefined, localMarket.stream, undefined, localMarket.transport);
    const ready = await app.inject('/__local/state');
    expect(ready.json().marketStream.status).toBe('connected');

    let cursor = 0;
    for (const [kind, status] of [['network', 503], ['rate_limit', 429], ['broker', 403]] as const) {
      await app.inject({ method: 'POST', url: '/__local/failures', payload: { target: 'market', kind } });
      const failed = await app.inject({ method: 'POST', url: '/__local/market/replay', payload: { steps: 1 } });
      expect(failed.statusCode).toBe(status);
      expect(failed.json().state.replayCursor).toBe(cursor);
      expect(failed.json().state.marketStream.status).toBe('degraded');
      const recovered = await app.inject({ method: 'POST', url: '/__local/market/replay', payload: { steps: 1 } });
      expect(recovered.statusCode).toBe(200);
      cursor += 1;
      expect(recovered.json()).toMatchObject({ processed: 1, replayCursor: cursor, marketStream: { status: 'connected' }, market: expect.arrayContaining([expect.objectContaining({ symbol: 'AAPL' })]) });
    }
    const health = (await app.inject('/__local/provider/health')).json();
    expect(health.providers.market).toMatchObject({ status: 'ready', lastError: null });
    const logs = (await app.inject('/__local/logs')).json();
    expect(logs.some((entry: { message: string }) => entry.message === 'simulated_market_stream_failed')).toBe(true);
    expect(logs.some((entry: { message: string }) => entry.message === 'simulated_market_stream_recovered')).toBe(true);
    expect(JSON.stringify(logs)).not.toContain('local-simulated-market-secret');
    const traces = (await app.inject('/__local/traces')).json();
    expect(traces).toContainEqual(expect.objectContaining({ route: '/__local/market/replay', status: 503 }));
    expect(traces).toContainEqual(expect.objectContaining({ route: '/__local/market/replay', status: 429 }));
    expect(traces).toContainEqual(expect.objectContaining({ route: '/__local/market/replay', status: 403 }));
    await app.close();
  });

  it('does not register controls by default', async () => {
    const config = await loadConfig({ DATABASE_URL: 'postgres://local/test' });
    const app = createApp(config, { query: vi.fn() } as unknown as Pool);
    expect((await app.inject('/__local/state')).statusCode).toBe(404);
    expect((await app.inject('/__local/trade-updates')).statusCode).toBe(404);
    await app.close();
  });

  it('accepts zero cumulative fill quantity on unfilled provider-shaped orders', async () => {
    const harness = new LocalTestHarness(await loadLocalFixtures());
    const observation = harness.ingestTradeUpdates({ updates: [{ stream: 'trade_updates', data: { event: 'new', execution_id: 'execution-new', order: { id: 'order-new', client_order_id: 'local-order-new', asset_id: 'asset-123', symbol: 'AAPL', side: 'buy', type: 'limit', status: 'new', qty: '4', filled_qty: '0', filled_avg_price: null, time_in_force: 'day' } } }] });
    expect(observation.accepted).toBe(1);
    expect(observation.observations.updates[0]?.order.filledQuantity).toBe('0');
  });

  it('accepts bounded simulated trade update hints without changing account truth and resets them', async () => {
    const config = await loadConfig({ DATABASE_URL: 'postgres://postgres@127.0.0.1/test', LOCAL_TEST_MODE: 'true' });
    const harness = new LocalTestHarness(await loadLocalFixtures());
    const app = createApp(config, { query: vi.fn() } as unknown as Pool, harness);
    const before = (await app.inject('/__local/state')).json();
    const update = { stream: 'trade_updates', data: { event: 'partial_fill', execution_id: 'execution-123', timestamp: '2025-01-02T14:30:01.000Z', price: '190.25', qty: '2', position_qty: '2', order: { id: 'order-123', client_order_id: 'local-order-123', asset_id: 'asset-123', symbol: 'AAPL', side: 'buy', type: 'limit', status: 'partially_filled', order_class: 'simple', time_in_force: 'day', qty: '4', filled_qty: '2', filled_avg_price: '190.25' } } };
    const accepted = await app.inject({ method: 'POST', url: '/__local/trade-updates', payload: { updates: [update] } });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({ simulated: true, mode: 'paper', accepted: 1, observations: { updates: [{ event: 'partial_fill', receivedAt: '2025-01-02T14:30:00.000Z', eventAt: update.data.timestamp, order: { id: 'order-123', symbol: 'AAPL', status: 'partially_filled', filledQuantity: '2' } }] } });
    const observed = (await app.inject('/__local/state')).json();
    expect(observed.tradeUpdates).toHaveLength(1);
    expect(observed.account).toEqual(before.account);
    expect((await app.inject('/__local/trade-updates')).json()).toMatchObject({ simulated: true, mode: 'paper', updates: observed.tradeUpdates });
    expect((await app.inject({ method: 'POST', url: '/__local/assert-state', payload: { expected: { tradeUpdates: [{ ...observed.tradeUpdates[0] }] } } })).json().matched).toBe(true);

    const badBatch = await app.inject({ method: 'POST', url: '/__local/trade-updates', payload: { updates: [update, { stream: 'trade_updates', data: { event: 'not-an-event', order: update.data.order } }] } });
    expect(badBatch.statusCode).toBe(400);
    expect(badBatch.json()).toMatchObject({ simulated: true, mode: 'paper', error: 'invalid_simulated_trade_updates' });
    const negativeExecution = await app.inject({ method: 'POST', url: '/__local/trade-updates', payload: { updates: [update, { stream: 'trade_updates', data: { ...update.data, price: '-1' } }] } });
    expect(negativeExecution.statusCode).toBe(400);
    expect((await app.inject('/__local/trade-updates')).json().updates).toHaveLength(1);
    const tooMany = await app.inject({ method: 'POST', url: '/__local/trade-updates', payload: { updates: Array.from({ length: 21 }, () => update) } });
    expect(tooMany.statusCode).toBe(400);
    await app.inject({ method: 'POST', url: '/__local/clock', payload: { now: '2025-01-02T14:35:00.000Z' } });
    const next = await app.inject({ method: 'POST', url: '/__local/trade-updates', payload: { updates: [update] } });
    expect(next.json().observations.updates[1].receivedAt).toBe('2025-01-02T14:35:00.000Z');
    expect((await app.inject('/__local/state')).json().account.openOrders).toEqual(before.account.openOrders);
    await app.inject({ method: 'POST', url: '/__local/reset', payload: {} });
    expect((await app.inject('/__local/trade-updates')).json()).toMatchObject({ simulated: true, mode: 'paper', updates: [] });
    for (let index = 0; index < 101; index += 1) harness.ingestTradeUpdates({ updates: [update] });
    const bounded = (await app.inject('/__local/trade-updates')).json();
    expect(bounded.updates).toHaveLength(100);
    expect(bounded.updates[0].sequence).toBe(2);
    expect(bounded.updates[99].sequence).toBe(101);
    await app.close();
  });

  it('bounds queued simulated failures and rejects overflow without mutation', async () => {
    const harness = new LocalTestHarness(await loadLocalFixtures());
    for (let i = 0; i < MAX_QUEUED_FAILURES_PER_PROVIDER / 10; i += 1) harness.injectFailure('account', 'network', 10);
    expect(() => harness.injectFailure('account', 'broker', 1)).toThrow('simulated failure queue limit exceeded');
    for (let i = 0; i < MAX_QUEUED_FAILURES_PER_PROVIDER; i += 1) {
      expect(() => harness.providerResponse('account')).toThrow('simulated_network_failure');
    }
    expect(harness.providerResponse('account')).toMatchObject({ simulated: true, resource: 'account' });
  });

  it('returns only normalized market data from simulated provider responses', async () => {
    const fixtures = await loadLocalFixtures();
    const events = structuredClone(fixtures.market.events) as Array<Record<string, unknown>>;
    events[0]!.credential = 'fixture-secret-must-not-escape';
    const account = structuredClone(fixtures.account) as { account: Record<string, unknown>; positions: Array<Record<string, unknown>>; open_orders: Array<Record<string, unknown>>; clock: Record<string, unknown> };
    account.account.credential = 'fixture-secret-must-not-escape';
    account.positions[0]!.credential = 'fixture-secret-must-not-escape';
    account.open_orders[0]!.credential = 'fixture-secret-must-not-escape';
    account.clock.credential = 'fixture-secret-must-not-escape';
    const harness = new LocalTestHarness({ ...fixtures, market: { ...fixtures.market, events }, account });
    harness.advance(1);
    const responses = ['market', 'account', 'positions', 'orders', 'clock'].map((resource) => harness.providerResponse(resource as 'market' | 'account' | 'positions' | 'orders' | 'clock'));
    expect(JSON.stringify(responses)).not.toContain('fixture-secret-must-not-escape');
    expect(responses[0]!.data).toMatchObject({ cursor: 1, states: [{ symbol: 'AAPL', lastTrade: { price: 190.25 } }] });
    expect(responses[0]!.data).not.toHaveProperty('events');
  });

  it('replaces simulated account responses with a validated resettable PAPER scenario', async () => {
    const config = await loadConfig({ DATABASE_URL: 'postgres://postgres@127.0.0.1/test', LOCAL_TEST_MODE: 'true' });
    const fixtures = await loadLocalFixtures();
    const app = createApp(config, { query: vi.fn() } as unknown as Pool, new LocalTestHarness(fixtures));
    const scenario = structuredClone(fixtures.account) as { account: Record<string, unknown>; positions: Array<Record<string, unknown>> };
    scenario.account.equity = '125000.50';
    scenario.positions[0]!.qty = '5';
    scenario.positions[0]!.market_value = '-1201.25';
    scenario.account.credential = 'fixture-secret-must-not-escape';

    const replaced = await app.inject({ method: 'POST', url: '/__local/scenario/account', payload: scenario });
    expect(replaced.statusCode).toBe(200);
    expect(replaced.body).not.toContain('fixture-secret-must-not-escape');
    expect(replaced.json()).toMatchObject({ simulated: true, mode: 'paper', status: 'replaced', account: { account: { equity: '125000.5' }, positions: [{ symbol: 'AAPL' }, { symbol: 'TSLA', quantity: '5' }], exposure: { short: '1201.25', gross: '1867.65' } } });
    expect((await app.inject('/__local/provider/account')).json().data.equity).toBe('125000.50');
    expect((await app.inject('/__local/provider/positions')).json().data[0].qty).toBe('5');

    const invalid = await app.inject({ method: 'POST', url: '/__local/scenario/account', payload: { account: { equity: 'broken' } } });
    expect(invalid.statusCode).toBe(400);
    expect((await app.inject('/__local/provider/account')).json().data.equity).toBe('125000.50');

    expect((await app.inject({ method: 'POST', url: '/__local/reset', payload: {} })).statusCode).toBe(200);
    expect((await app.inject('/__local/provider/account')).json().data.equity).toBe('100000.00');
    await app.close();
  });

  it('redacts rejected fixture contents from startup errors', async () => {
    const fixtures = await loadLocalFixtures();
    const market = structuredClone(fixtures.market);
    (market.events[0] as Record<string, unknown>).credential = 'fixture-secret-must-not-escape';
    let error: unknown;
    try { parseLocalFixtureTexts(JSON.stringify(market), JSON.stringify(fixtures.account)); }
    catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('local fixtures are invalid');
    expect((error as Error).message).not.toContain('fixture-secret-must-not-escape');
  });

  it('persists and restores a normalized crossed quote without changing its state', async () => {
    const fixtures = await loadLocalFixtures();
    const originalQuote = fixtures.market.events[1] as Record<string, unknown>;
    const crossedQuote = { ...originalQuote, bp: 190.4, ap: 190.3 };
    const crossedFixtures = { ...fixtures, market: { ...fixtures.market, events: [crossedQuote] } };
    const replayHarness = new LocalTestHarness(crossedFixtures);
    replayHarness.advance(1);
    const snapshot = replayHarness.persistenceSnapshot();
    const pool = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [{ revision: 1 }] })
        .mockResolvedValueOnce({ rowCount: 1, rows: [{ scenarioKey: 'checked-in-local-fixtures', snapshotVersion: 1, revision: 1, snapshot }] }),
    } as unknown as Pool;

    await persistLocalRuntime(pool, snapshot);
    const restoredHarness = new LocalTestHarness(crossedFixtures);
    const reconciliation = await restoreLocalRuntime(pool, (restored) => restoredHarness.restore(restored), fixtures.startTime);

    expect(reconciliation).toMatchObject({ status: 'restored', source: 'postgres_snapshot', revision: 1 });
    expect(restoredHarness.persistenceSnapshot()).toEqual(snapshot);
  });
});
