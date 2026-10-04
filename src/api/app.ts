import Fastify from 'fastify';
import type { Pool } from 'pg';
import type { AppConfig } from '../domain/config.js';
import { TRADING_MODE } from '../domain/paper.js';
import { providerCapabilities } from '../infra/capabilities.js';
import { InvalidLocalStateExpectation, LocalTestHarness, SimulatedProviderFailure } from '../domain/local-test-harness.js';
import type { AlpacaMarketStream } from '../infra/alpaca-market-stream.js';
import type { LocalAlpacaMarketTransport } from '../infra/local-alpaca-market-transport.js';
import { AlpacaPaperAccountClient, AlpacaPaperAccountReconciler } from '../infra/alpaca-account.js';
import { createLocalAlpacaAccountFetch } from '../infra/local-alpaca-account-transport.js';
import { z } from 'zod';

export function createApp(config: AppConfig, pool: Pool, localHarness?: LocalTestHarness, persistLocalState?: () => Promise<void>, marketStream?: AlpacaMarketStream, accountReconciler?: AlpacaPaperAccountReconciler, localMarketTransport?: LocalAlpacaMarketTransport) {
  if (config.localTestMode && !localHarness) throw new Error('local test mode requires an initialized fixture harness');
  if (config.localTestMode && Boolean(marketStream) !== Boolean(localMarketTransport)) throw new Error('local test mode market adapter dependencies must be provided together');
  const localAdapterResources: Array<'account' | 'positions' | 'orders' | 'clock'> = [];
  let localAccountReconciliationInProgress = false;
  const localAccountReconciler = config.localTestMode && localHarness
    ? new AlpacaPaperAccountReconciler(
      new AlpacaPaperAccountClient('local-test-key', 'local-test-secret', {
        fetchImpl: createLocalAlpacaAccountFetch((resource) => localHarness.accountAdapterResponse(resource), (resource) => localAdapterResources.push(resource)),
      }),
      60,
      5,
      60,
      config.accountStateStaleAfterSeconds,
      () => new Date(localHarness.state().now),
    )
    : undefined;
  const accountHealth = () => {
    if (localHarness) {
      const state = localHarness.state();
      const health = localHarness.providerHealth().providers.account;
      return { status: health.status === 'ready' ? 'simulated' : 'degraded', lastSuccessAt: state.account.reconciledAt, freshness: state.account.freshness.status, lastError: health.lastError };
    }
    const state = accountReconciler?.snapshot();
    return state
      ? { status: state.status, lastSuccessAt: state.lastSuccessAt, lastError: state.lastError, consecutiveFailures: state.consecutiveFailures, retryInMs: state.retryInMs }
      : { status: 'not_configured', lastSuccessAt: null, lastError: null, consecutiveFailures: 0, retryInMs: null };
  };
  const localState = () => {
    const state = localHarness!.state();
    return marketStream && localMarketTransport
      ? { ...state, market: marketStream.marketStates(), marketStream: marketStream.snapshot(), marketTransport: localMarketTransport.snapshot() }
      : state;
  };
  const app = Fastify({
    bodyLimit: config.localTestMode ? 64 * 1024 : 1024 * 1024,
    logger: config.localTestMode ? false : {
      redact: ['req.headers.authorization', 'req.headers.cookie', 'req.headers.x-api-key', 'req.headers.alpaca-api-key', 'req.headers.openrouter-api-key'],
    },
  });
  app.addHook('onRequest', async (_request, reply) => {
    reply.header('X-Paper-Mode', 'true');
  });
  app.addHook('onClose', async () => { accountReconciler?.stop(); marketStream?.stop(); });
  if (config.localTestMode && localHarness) {
    app.addHook('onResponse', async (request, reply) => {
      localHarness.record(request.method, request.routeOptions.url ?? 'unmatched', reply.statusCode);
    });
  }

  app.get('/health', async (_request, reply) => {
    let database: 'connected' | 'unavailable' = 'unavailable';
    try {
      await pool.query('SELECT 1');
      database = 'connected';
    } catch {
      database = 'unavailable';
    }
    const status = database === 'connected' ? 'ok' : 'degraded';
    reply.code(status === 'ok' ? 200 : 503);
    return {
      status,
      mode: TRADING_MODE,
      capabilities: { database, ...providerCapabilities(config) },
      marketData: marketStream?.snapshot() ?? { status: config.localTestMode ? 'simulated' : config.alpacaKeyId ? 'unavailable' : 'not_configured', feed: config.alpacaDataFeed },
      accountReconciliation: accountHealth(),
      timestamp: localHarness?.state().now ?? new Date().toISOString(),
    };
  });

  app.get('/status', async (_request, reply) => ({
    mode: TRADING_MODE,
    capabilities: providerCapabilities(config),
    marketData: marketStream?.snapshot() ?? { status: config.localTestMode ? 'simulated' : config.alpacaKeyId ? 'unavailable' : 'not_configured', feed: config.alpacaDataFeed },
    accountReconciliation: accountHealth(),
    timestamp: localHarness?.state().now ?? new Date().toISOString(),
  }));
  app.get('/market', async () => ({
    mode: TRADING_MODE,
    status: marketStream?.snapshot() ?? { status: config.localTestMode ? 'simulated' : config.alpacaKeyId ? 'unavailable' : 'not_configured', feed: config.alpacaDataFeed },
    states: marketStream?.marketStates() ?? localHarness?.state().market ?? [],
  }));
  app.get('/account', async () => {
    if (localHarness) {
      const state = localHarness.state();
      return { mode: TRADING_MODE, status: 'simulated', account: state.account, lastSuccessAt: state.account.reconciledAt, error: null };
    }
    const observation = accountReconciler?.snapshot();
    return observation
      ? { mode: TRADING_MODE, ...observation }
      : { mode: TRADING_MODE, status: 'not_configured', account: null, lastAttemptAt: null, lastSuccessAt: null, lastError: null, consecutiveFailures: 0, retryInMs: null, rateLimit: {} };
  });
  if (config.localTestMode && localHarness) {
    app.get('/__local/state', async () => localState());
    app.post('/__local/trade-updates', async (request, reply) => {
      try { return localHarness.ingestTradeUpdates(request.body); }
      catch { return reply.code(400).send({ simulated: true, mode: 'paper', error: 'invalid_simulated_trade_updates' }); }
    });
    app.get('/__local/trade-updates', async () => localHarness.tradeUpdates());
    app.post('/__local/assert-state', async (request, reply) => {
      const parsed = z.object({ expected: z.record(z.string(), z.unknown()).refine((value) => Object.keys(value).length > 0) }).strict().safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid local state expectation' });
      try { return localHarness.compareState(parsed.data.expected, localState()); }
      catch (error) {
        if (error instanceof InvalidLocalStateExpectation) return reply.code(400).send({ error: error.message });
        return reply.code(500).send({ error: 'local state comparison failed' });
      }
    });
    app.get('/__local/provider/health', async () => localHarness.providerHealth());
    app.post('/__local/reset', async () => {
      localHarness.reset();
      if (marketStream && localMarketTransport) {
        localMarketTransport.reset();
        marketStream.resetLocalSession();
        await localMarketTransport.waitUntilReady();
      }
      await persistLocalState?.();
      return localState();
    });
    app.post('/__local/scenario/account', async (request, reply) => {
      try {
        localHarness.replaceAccountScenario(request.body);
        return { simulated: true, mode: 'paper', status: 'replaced', account: localHarness.state().account };
      } catch {
        return reply.code(400).send({ error: 'invalid simulated account scenario' });
      }
    });
    app.post('/__local/account/reconcile', async (request, reply) => {
      if (!z.object({}).strict().safeParse(request.body ?? {}).success) return reply.code(400).send({ error: 'invalid simulated reconciliation request' });
      if (!localAccountReconciler) return reply.code(500).send({ simulated: true, mode: 'paper', error: 'simulated_reconciliation_unavailable' });
      if (localAccountReconciliationInProgress) return reply.code(409).send({ simulated: true, mode: 'paper', error: 'simulated_reconciliation_in_progress' });
      localAccountReconciliationInProgress = true;
      try {
        localAdapterResources.length = 0;
        const result = await localAccountReconciler.reconcileOnce();
        if (result.account && !result.lastError) {
          const state = localHarness.recordAccountAdapterSuccess(result.account, localAdapterResources);
          await persistLocalState?.();
          return { simulated: true, mode: 'paper', status: 'reconciled', state: localState(), reconciliation: { status: result.status, lastSuccessAt: result.lastSuccessAt, lastError: null } };
        }
        const kind = result.lastError ?? 'provider_error';
        localHarness.recordAccountAdapterFailure(kind, localAdapterResources);
        const failure = kind === 'network' ? { status: 503, error: 'simulated_network_failure' }
          : kind === 'timeout' ? { status: 504, error: 'simulated_timeout' }
            : kind === 'rate_limited' ? { status: 429, error: 'simulated_rate_limit' }
              : kind === 'unauthorized' ? { status: 403, error: 'simulated_broker_rejection' }
                : kind === 'invalid_response' ? { status: 502, error: 'simulated_invalid_response' }
                  : { status: 502, error: 'simulated_provider_error' };
        return reply.code(failure.status).send({ simulated: true, mode: 'paper', error: failure.error, reconciliation: { status: result.status, lastSuccessAt: result.lastSuccessAt, lastError: kind } });
      } finally {
        localAccountReconciliationInProgress = false;
      }
    });
    app.post('/__local/failures', async (request, reply) => {
      const parsed = z.object({ target: z.enum(['market', 'account']), kind: z.enum(['network', 'rate_limit', 'broker']), count: z.number().int().min(1).max(10).default(1) }).safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid simulated failure configuration' });
      localHarness.injectFailure(parsed.data.target, parsed.data.kind, parsed.data.count);
      return { status: 'armed', target: parsed.data.target, kind: parsed.data.kind, count: parsed.data.count };
    });
    app.get('/__local/provider/:resource', async (request, reply) => {
      const parsed = z.enum(['account', 'positions', 'orders', 'clock', 'market']).safeParse((request.params as { resource?: unknown }).resource);
      if (!parsed.success) return reply.code(404).send({ error: 'unknown simulated provider resource' });
      try { return localHarness.providerResponse(parsed.data); }
      catch (error) {
        if (error instanceof SimulatedProviderFailure) return reply.code(error.statusCode).send({ simulated: true, mode: 'paper', error: error.errorCode });
        return reply.code(500).send({ simulated: true, mode: 'paper', error: 'simulated_provider_error' });
      }
    });
    app.post('/__local/clock', async (request, reply) => {
      const parsed = z.object({ now: z.string().datetime({ offset: true }) }).safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid virtual time' });
      try { localHarness.setClock(parsed.data.now); } catch { return reply.code(400).send({ error: 'invalid virtual time' }); }
      await persistLocalState?.();
      return localState();
    });
    app.post('/__local/market/replay', async (request, reply) => {
      const parsed = z.object({ steps: z.number().int().min(1).max(100) }).safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: 'steps must be an integer from 1 to 100' });
      if (!marketStream || !localMarketTransport) {
        try {
          const state = localHarness.advance(parsed.data.steps);
          await persistLocalState?.();
          return { processed: state.processed, ...localHarness.state() };
        } catch { return reply.code(400).send({ error: 'replay failed' }); }
      }
      const failure = localHarness.consumeMarketFailure();
      if (failure) {
        if (failure === 'network') localMarketTransport.disconnect();
        else if (failure === 'rate_limit') localMarketTransport.emitError(407);
        else localMarketTransport.emitError(402);
        const status = failure === 'network' ? 503 : failure === 'rate_limit' ? 429 : 403;
        const error = failure === 'network' ? 'simulated_network_failure' : failure === 'rate_limit' ? 'simulated_rate_limit' : 'simulated_broker_rejection';
        return reply.code(status).send({ simulated: true, mode: 'paper', error, state: localState() });
      }
      let cursor = localHarness.state().replayCursor;
      try {
        if (marketStream.snapshot().status !== 'connected') {
          if (marketStream.snapshot().lastError === 'alpaca_authentication_failed') {
            localMarketTransport.reset();
            marketStream.resetLocalSession();
          } else await localMarketTransport.flushTimers();
          await localMarketTransport.waitUntilReady();
          if (marketStream.snapshot().status !== 'connected') throw new Error('local market stream recovery failed');
          localHarness.recordMarketAdapterRecovery();
        }
        cursor = localHarness.state().replayCursor;
        const state = localHarness.advance(parsed.data.steps);
        const events = localHarness.marketFixtureEvents(cursor, state.processed);
        for (let offset = 0; offset < events.length; offset += 100) localMarketTransport.emitEvents(events.slice(offset, offset + 100) as Array<Record<string, unknown>>);
        localHarness.recordMarketReplay(state.processed);
      } catch { return reply.code(400).send({ simulated: true, mode: 'paper', error: 'replay_failed', state: localState() }); }
      await persistLocalState?.();
      return { processed: localHarness.state().replayCursor - cursor, ...localState() };
    });
    app.get('/__local/traces', async (request, reply) => {
      const parsed = z.object({ after: z.coerce.number().int().nonnegative().default(0), limit: z.coerce.number().int().min(1).max(100).default(100) }).safeParse(request.query);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid trace bounds' });
      return localHarness.trace(parsed.data.after, parsed.data.limit);
    });
    app.get('/__local/logs', async (request, reply) => {
      const parsed = z.object({ after: z.coerce.number().int().nonnegative().default(0), limit: z.coerce.number().int().min(1).max(100).default(100) }).safeParse(request.query);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid log bounds' });
      return localHarness.logs(parsed.data.after, parsed.data.limit);
    });
  }
  return app;
}
