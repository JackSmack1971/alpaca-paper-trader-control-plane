import { createApp } from './api/app.js';
import { LocalTestHarness } from './domain/local-test-harness.js';
import { loadLocalFixtures } from './infra/local-fixtures.js';
import { TRADING_MODE, assertPaperOnly, ALPACA_PAPER_BASE_URL } from './domain/paper.js';
import { loadConfig } from './infra/config.js';
import { createDatabase } from './infra/db/client.js';
import { applyMigrations } from './infra/migrations.js';
import { persistLocalRuntime, restoreLocalRuntime } from './infra/local-runtime-snapshot.js';
import { createConfiguredAlpacaMarketStream, type AlpacaMarketStream } from './infra/alpaca-market-stream.js';
import { AlpacaPaperAccountClient, AlpacaPaperAccountReconciler } from './infra/alpaca-account.js';
import { createLocalAlpacaMarketStream, type LocalAlpacaMarketTransport } from './infra/local-alpaca-market-transport.js';

let config;
try {
  config = await loadConfig();
  assertPaperOnly(config.mode, ALPACA_PAPER_BASE_URL);
} catch {
  console.error('Application configuration is invalid; values are redacted.');
  process.exit(1);
}

const { pool } = createDatabase(config.databaseUrl);
const harness = config.localTestMode ? new LocalTestHarness(await loadLocalFixtures(), config.accountStateStaleAfterSeconds) : undefined;
let app: ReturnType<typeof createApp> | undefined;
let marketStream: AlpacaMarketStream | undefined;
let accountReconciler: AlpacaPaperAccountReconciler | undefined;
let localMarketTransport: LocalAlpacaMarketTransport | undefined;
try {
  await applyMigrations(pool);
  let persistLocalState: (() => Promise<void>) | undefined;
  if (harness) {
    const reconciliation = await restoreLocalRuntime(pool, (snapshot) => harness.restore(snapshot), harness.state().now);
    harness.setReconciliation(reconciliation);
    if (reconciliation.status === 'initialized') {
      const revision = await persistLocalRuntime(pool, harness.persistenceSnapshot());
      harness.setReconciliation({ ...reconciliation, source: 'postgres_snapshot', revision });
    }
    let persistenceQueue = Promise.resolve();
    persistLocalState = () => {
      const snapshot = harness.persistenceSnapshot();
      const write = persistenceQueue.then(async () => {
        const revision = await persistLocalRuntime(pool, snapshot);
        const current = harness.state().reconciliation;
        harness.setReconciliation({ ...current, source: 'postgres_snapshot', revision });
      });
      persistenceQueue = write.catch(() => undefined);
      return write;
    };
  }
  if (!config.localTestMode && config.alpacaKeyId && config.alpacaSecretKey) {
    marketStream = createConfiguredAlpacaMarketStream(config, () => undefined);
    marketStream.start();
    accountReconciler = new AlpacaPaperAccountReconciler(
      new AlpacaPaperAccountClient(config.alpacaKeyId, config.alpacaSecretKey, { timeoutMs: config.accountRequestTimeoutMs }),
      config.accountReconciliationSeconds,
      config.accountRetryBaseSeconds,
      config.accountRetryMaxSeconds,
      config.accountStateStaleAfterSeconds,
    );
    accountReconciler.start();
  } else if (config.localTestMode && harness) {
    const localMarket = createLocalAlpacaMarketStream(config, () => new Date(harness.state().now));
    marketStream = localMarket.stream;
    localMarketTransport = localMarket.transport;
    marketStream.start();
    await localMarketTransport.waitUntilReady();
    const restored = harness.state();
    marketStream.restoreLocalReplay(
      harness.marketFixtureEvents(0, restored.replayCursor),
      restored.market.map((state) => ({ ...state, feed: config.alpacaDataFeed })),
    );
  }
  app = createApp(config, pool, harness, persistLocalState, marketStream, accountReconciler, localMarketTransport);
  console.log('ALPACA PAPER TRADING CONTROL PLANE — PAPER MODE');
  await app.listen({ host: config.host, port: config.port });
} catch {
  marketStream?.stop();
  accountReconciler?.stop();
  await pool.end();
  app?.log.error('Application startup failed; database connection details are redacted.');
  process.exitCode = 1;
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
process.on(signal, () => {
    void app?.close().finally(async () => { marketStream?.stop(); await pool.end(); });
  });
}
