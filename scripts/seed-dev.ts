import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { assertLoopbackDatabase } from '../src/domain/dev-db.js';
import { loadConfig } from '../src/infra/config.js';
import { createDatabase } from '../src/infra/db/client.js';

const fixtureSchema = z.object({
  version: z.literal(1),
  cycleId: z.string().uuid(),
  contextId: z.string().uuid(),
  marketRecordId: z.string().uuid(),
  symbol: z.string().regex(/^[A-Z][A-Z0-9.-]{0,9}$/),
  observedAt: z.string().datetime({ offset: true }),
  context: z.object({ fixture: z.literal('synthetic-dev-seed-v1'), mode: z.literal('paper'), market: z.record(z.string(), z.unknown()), account: z.record(z.string(), z.unknown()) }),
  marketRecord: z.record(z.string(), z.unknown()),
});

try {
  const config = await loadConfig();
  assertLoopbackDatabase(config.databaseUrl);
  const fixture = fixtureSchema.parse(JSON.parse(await readFile(resolve('fixtures/dev/seed.json'), 'utf8')));
  const contextJson = JSON.stringify(fixture.context);
  const contentHash = createHash('sha256').update(contextJson).digest('hex');
  const { pool } = createDatabase(config.databaseUrl);
  let client: PoolClient | undefined;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO decision_cycles(cycle_id, mode, symbol, status, created_at)
       VALUES ($1, 'paper', $2, 'seeded', $3)
       ON CONFLICT (cycle_id) DO UPDATE SET mode = 'paper', symbol = EXCLUDED.symbol, status = EXCLUDED.status, created_at = EXCLUDED.created_at`,
      [fixture.cycleId, fixture.symbol, fixture.observedAt],
    );
    await client.query(
      `INSERT INTO decision_contexts(decision_context_id, cycle_id, context_version, content_hash, payload, created_at)
       VALUES ($1, $2, 1, $3, $4::jsonb, $5)
       ON CONFLICT (decision_context_id) DO UPDATE SET content_hash = EXCLUDED.content_hash, payload = EXCLUDED.payload, created_at = EXCLUDED.created_at`,
      [fixture.contextId, fixture.cycleId, contentHash, contextJson, fixture.observedAt],
    );
    await client.query(
      `INSERT INTO normalized_market_records(market_record_id, cycle_id, decision_context_id, symbol, record_type, source, observed_at, payload)
       VALUES ($1, $2, $3, $4, 'bar', 'synthetic-fixture', $5, $6::jsonb)
       ON CONFLICT (market_record_id) DO UPDATE SET payload = EXCLUDED.payload, observed_at = EXCLUDED.observed_at`,
      [fixture.marketRecordId, fixture.cycleId, fixture.contextId, fixture.symbol, fixture.observedAt, JSON.stringify(fixture.marketRecord)],
    );
    await client.query('COMMIT');
    console.log(JSON.stringify({ status: 'seeded', mode: 'paper', cycleId: fixture.cycleId, symbol: fixture.symbol, fixture: 'synthetic-dev-seed-v1' }));
  } catch {
    if (client) await client.query('ROLLBACK');
    throw new Error('Development seed failed; database details are redacted.');
  } finally {
    client?.release();
    await pool.end();
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Development seed failed; details are redacted.');
  process.exitCode = 1;
}
