import { z } from 'zod';
import type { Pool } from 'pg';
import { MAX_MARKET_STATES } from '../domain/market-state.js';
import type { LocalRuntimeSnapshot } from '../domain/local-test-harness.js';

const scenarioKey = 'checked-in-local-fixtures';
const maxSnapshotBytes = 262144;
const storedSnapshot = z.object({ scenarioKey: z.literal(scenarioKey), snapshotVersion: z.literal(1), revision: z.number().int().positive(), snapshot: z.unknown() }).strict();
const tradeState = z.object({ id: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(), price: z.number().finite().positive(), size: z.number().finite().positive(), sourceTime: z.string().datetime({ offset: true }) }).strict();
const quoteState = z.object({ bid: z.number().finite().positive(), bidSize: z.number().finite().positive(), ask: z.number().finite().positive(), askSize: z.number().finite().positive(), sourceTime: z.string().datetime({ offset: true }) }).strict();
const runtimeSnapshot = z.object({ version: z.literal(1), now: z.string().datetime({ offset: true }), replayCursor: z.number().int().nonnegative(), market: z.array(z.object({
  symbol: z.string().regex(/^[A-Z][A-Z0-9.-]{0,9}$/), feed: z.string().min(1).max(32), sourceEventTime: z.string().datetime({ offset: true }), receivedAt: z.string().datetime({ offset: true }),
  freshness: z.enum(['fresh', 'stale']), staleReason: z.string().max(64).nullable(), lastTrade: tradeState.nullable(), quote: quoteState.nullable()
}).strict()).max(MAX_MARKET_STATES) }).strict();

export type LocalRuntimeReconciliation = {
  status: 'restored' | 'initialized';
  source: 'postgres_snapshot' | 'checked_in_fixtures';
  revision: number;
  reconciledAt: string;
};

export async function restoreLocalRuntime(pool: Pool, restore: (snapshot: LocalRuntimeSnapshot) => void, initialTime: string): Promise<LocalRuntimeReconciliation> {
  const result = await pool.query('SELECT scenario_key AS "scenarioKey", snapshot_version AS "snapshotVersion", revision, snapshot FROM local_runtime_snapshots WHERE scenario_key = $1', [scenarioKey]);
  if (result.rowCount) {
    const row = storedSnapshot.parse(result.rows[0]);
    if (row.snapshotVersion !== 1) throw new Error('unsupported local runtime snapshot version');
    const snapshot = runtimeSnapshot.parse(row.snapshot) as LocalRuntimeSnapshot;
    restore(snapshot);
    return { status: 'restored', source: 'postgres_snapshot', revision: row.revision, reconciledAt: snapshot.now };
  }
  return { status: 'initialized', source: 'checked_in_fixtures', revision: 0, reconciledAt: initialTime };
}

export async function persistLocalRuntime(pool: Pool, snapshot: LocalRuntimeSnapshot): Promise<number> {
  const serialized = JSON.stringify(snapshot);
  if (Buffer.byteLength(serialized, 'utf8') > maxSnapshotBytes) throw new Error('local runtime snapshot exceeds storage limit');
  const result = await pool.query(
    `INSERT INTO local_runtime_snapshots(scenario_key, snapshot_version, revision, snapshot)
     VALUES ($1, 1, 1, $2::jsonb)
     ON CONFLICT (scenario_key) DO UPDATE SET snapshot_version = 1, revision = local_runtime_snapshots.revision + 1, snapshot = EXCLUDED.snapshot, updated_at = now()
     RETURNING revision`,
    [scenarioKey, serialized],
  );
  return Number(result.rows[0]?.revision);
}
