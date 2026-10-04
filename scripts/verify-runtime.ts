import { loadConfig } from '../src/infra/config.js';
import { createDatabase } from '../src/infra/db/client.js';
import { assertPaperOnly, ALPACA_PAPER_BASE_URL } from '../src/domain/paper.js';

const requiredTables = [
  'configuration_snapshots',
  'cycle_outcomes',
  'decision_contexts',
  'decision_cycles',
  'fills',
  'health_connection_samples',
  'kill_switch_state',
  'normalized_market_records',
  'paper_orders',
  'risk_decisions',
  'stage_runs',
];

try {
  const config = await loadConfig();
  assertPaperOnly(config.mode, ALPACA_PAPER_BASE_URL);
  if (config.alpacaKeyId || config.alpacaSecretKey || config.openRouterApiKey) {
    throw new Error('Runtime verification requires provider credentials to be absent.');
  }

  const baseUrl = `http://${config.host}:${config.port}`;
  const healthResponse = await fetch(`${baseUrl}/health`);
  const health = await healthResponse.json() as {
    status?: string;
    mode?: string;
    capabilities?: {
      database?: string;
      alpacaPaper?: { status?: string };
      openrouter?: { status?: string };
    };
  };
  if (!healthResponse.ok || health.status !== 'ok' || health.mode !== 'paper' || health.capabilities?.database !== 'connected') {
    throw new Error('Health response did not report a healthy PAPER application and connected database.');
  }
  if (health.capabilities.alpacaPaper?.status !== 'not_configured' || health.capabilities.openrouter?.status !== 'not_configured') {
    throw new Error('Credential-free provider capabilities were not truthfully reported as not configured.');
  }

  const statusResponse = await fetch(`${baseUrl}/status`);
  const status = await statusResponse.json() as { mode?: string };
  if (!statusResponse.ok || status.mode !== 'paper' || statusResponse.headers.get('x-paper-mode') !== 'true') {
    throw new Error('Status response did not identify PAPER mode in its body and header.');
  }

  const { pool } = createDatabase(config.databaseUrl);
  try {
    const result = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`,
    );
    const tables = result.rows.map((row) => row.table_name);
    const missing = requiredTables.filter((table) => !tables.includes(table));
    if (missing.length) throw new Error(`Required application tables are missing: ${missing.join(', ')}.`);
    const modeColumns = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'mode' AND table_name IN ('cycle_outcomes', 'decision_contexts', 'stage_runs') ORDER BY table_name`,
    );
    const missingMode = ['cycle_outcomes', 'decision_contexts', 'stage_runs'].filter((table) => !modeColumns.rows.some((row) => row.table_name === table));
    if (missingMode.length) throw new Error(`Required PAPER mode columns are missing: ${missingMode.join(', ')}.`);
    console.log(JSON.stringify({
      status: 'verified',
      mode: 'paper',
      app: baseUrl,
      database: 'connected',
      credentials: 'absent',
      providers: { alpacaPaper: 'not_configured', openrouter: 'not_configured' },
      paperHeader: true,
      requiredTables: requiredTables.length,
      correlatedPaperModeColumns: modeColumns.rows.map((row) => `${row.table_name}.mode`),
      tables,
    }));
  } finally {
    await pool.end();
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Runtime verification failed; details are redacted.');
  process.exitCode = 1;
}
