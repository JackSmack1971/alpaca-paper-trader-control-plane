import type { Pool } from 'pg';
import { buildDecisionContext, canonicalJson, type BuiltDecisionContext, type DecisionContextInput } from '../domain/decision-context.js';

export class DecisionContextConflict extends Error {
  constructor() { super('decision context identity conflicts with persisted content'); this.name = 'DecisionContextConflict'; }
}

export type PersistedDecisionContext = BuiltDecisionContext & { replayed: boolean };

/** Persist the exact source input and its immutable derived context in one transaction. */
export async function persistDecisionContext(pool: Pool, built: BuiltDecisionContext): Promise<PersistedDecisionContext> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { context, sourceInput } = built;
    await client.query(
      `INSERT INTO decision_cycles(cycle_id, mode, symbol, status, schema_version, created_at)
       VALUES ($1, 'paper', $2, 'context_ready', 1, $3) ON CONFLICT (cycle_id) DO NOTHING`,
      [context.cycle_id, context.symbol, context.built_at],
    );
    const cycle = await client.query<{ mode: string; symbol: string }>(
      'SELECT mode, symbol FROM decision_cycles WHERE cycle_id = $1 FOR SHARE', [context.cycle_id],
    );
    if (cycle.rowCount !== 1 || cycle.rows[0]!.mode !== 'paper' || cycle.rows[0]!.symbol !== context.symbol) throw new DecisionContextConflict();

    const sourceInputId = context.decision_context_id;
    const persistedPayload = {
      canonical_json: built.canonicalJson,
      token_budget: { estimated_tokens: built.estimatedTokens, method: built.tokenEstimateMethod, max_tokens: 4_000 },
      source_input_id: sourceInputId,
      source_input_sha256: context.provenance.input_sha256,
    };
    await client.query(
      `INSERT INTO decision_contexts(decision_context_id, cycle_id, mode, context_version, content_hash, payload, created_at)
       VALUES ($1, $2, 'paper', $3, $4, $5::jsonb, $6)
       ON CONFLICT (cycle_id, context_version) DO NOTHING`,
      [context.decision_context_id, context.cycle_id, context.schema_version, built.contentHash, JSON.stringify(persistedPayload), context.built_at],
    );
    const existing = await client.query<{ decision_context_id: string; content_hash: string; payload: unknown }>(
      'SELECT decision_context_id, content_hash, payload FROM decision_contexts WHERE cycle_id = $1 AND context_version = $2 FOR SHARE',
      [context.cycle_id, context.schema_version],
    );
    if (existing.rowCount !== 1 || existing.rows[0]!.decision_context_id !== context.decision_context_id || existing.rows[0]!.content_hash !== built.contentHash) throw new DecisionContextConflict();
    const storedContextPayload = existing.rows[0]!.payload as typeof persistedPayload;
    if (storedContextPayload.canonical_json !== built.canonicalJson || storedContextPayload.source_input_id !== sourceInputId || storedContextPayload.source_input_sha256 !== context.provenance.input_sha256) throw new DecisionContextConflict();

    const sourceRecordPayload = { input: sourceInput, input_sha256: context.provenance.input_sha256 };
    await client.query(
      `INSERT INTO normalized_market_records(market_record_id, cycle_id, decision_context_id, symbol, record_type, source, observed_at, payload)
       VALUES ($1, $2, $3, $4, 'decision_context_input', 'normalized_runtime', $5, $6::jsonb)
       ON CONFLICT (market_record_id) DO NOTHING`,
      [sourceInputId, context.cycle_id, context.decision_context_id, context.symbol, context.as_of, JSON.stringify(sourceRecordPayload)],
    );
    const storedInput = await client.query<{ payload: unknown }>(
      'SELECT payload FROM normalized_market_records WHERE market_record_id = $1 AND decision_context_id = $2 FOR SHARE',
      [sourceInputId, context.decision_context_id],
    );
    const storedRecordPayload = storedInput.rows[0]?.payload as typeof sourceRecordPayload | undefined;
    if (storedInput.rowCount !== 1 || !storedRecordPayload || storedRecordPayload.input_sha256 !== context.provenance.input_sha256 || canonicalJson(storedRecordPayload.input) !== canonicalJson(sourceInput)) throw new DecisionContextConflict();
    await client.query('COMMIT');
    return { ...built, replayed: false };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* preserve original failure */ }
    if (error instanceof DecisionContextConflict) throw error;
    throw new Error('decision context persistence failed');
  } finally {
    client.release();
  }
}

/** Rebuild a stored context from its persisted normalized inputs and verify its canonical digest. */
export async function replayDecisionContext(pool: Pool, cycleId: string): Promise<PersistedDecisionContext | null> {
  const result = await pool.query<{ content_hash: string; payload: unknown; source_payload: unknown }>(
    `SELECT c.content_hash, c.payload, m.payload AS source_payload
     FROM decision_contexts c
     JOIN normalized_market_records m ON m.market_record_id = (c.payload->>'source_input_id')::uuid
       AND m.decision_context_id = c.decision_context_id
     WHERE c.cycle_id = $1 AND c.context_version = 1`,
    [cycleId],
  );
  if (result.rowCount === 0) return null;
  if (result.rowCount !== 1) throw new Error('decision context replay is ambiguous');
  const sourcePayload = result.rows[0]!.source_payload as { input?: DecisionContextInput; input_sha256?: string };
  const contextPayload = result.rows[0]!.payload as { canonical_json?: string; source_input_sha256?: string; source_input_id?: string; token_budget?: { estimated_tokens?: number; method?: string } };
  if (!sourcePayload?.input || sourcePayload.input_sha256 !== contextPayload.source_input_sha256) throw new Error('persisted decision context source input is invalid');
  const replayed = buildDecisionContext(sourcePayload.input);
  if (replayed.contentHash !== result.rows[0]!.content_hash || replayed.canonicalJson !== contextPayload.canonical_json || replayed.context.decision_context_id !== contextPayload.source_input_id) throw new Error('persisted decision context replay mismatch');
  return { ...replayed, replayed: true };
}
