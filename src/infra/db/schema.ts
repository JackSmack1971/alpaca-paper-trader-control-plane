import { pgTable, uuid, text, varchar, jsonb, timestamp, numeric, boolean, integer, uniqueIndex, index, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

const createdAt = () => timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow();
const mode = () => varchar('mode', { length: 8 }).notNull().default('paper');

export const decisionCycles = pgTable('decision_cycles', {
  cycleId: uuid('cycle_id').primaryKey(), mode: mode(), symbol: varchar('symbol', { length: 10 }).notNull(),
  status: varchar('status', { length: 32 }).notNull(), schemaVersion: integer('schema_version').notNull().default(1), createdAt: createdAt(), completedAt: timestamp('completed_at', { withTimezone: true, mode: 'date' })
});
export const decisionContexts = pgTable('decision_contexts', {
  decisionContextId: uuid('decision_context_id').primaryKey(), cycleId: uuid('cycle_id').notNull().references(() => decisionCycles.cycleId), mode: mode(),
  contextVersion: integer('context_version').notNull(), contentHash: varchar('content_hash', { length: 64 }).notNull(), payload: jsonb('payload').notNull(), createdAt: createdAt()
}, (t) => [uniqueIndex('decision_context_cycle_version_uq').on(t.cycleId, t.contextVersion)]);
export const stageRuns = pgTable('stage_runs', {
  stageRunId: uuid('stage_run_id').primaryKey(), cycleId: uuid('cycle_id').notNull().references(() => decisionCycles.cycleId), mode: mode(),
  decisionContextId: uuid('decision_context_id').notNull().references(() => decisionContexts.decisionContextId), stage: varchar('stage', { length: 32 }).notNull(),
  status: varchar('status', { length: 24 }).notNull(), provider: varchar('provider', { length: 32 }), providerRequestId: text('provider_request_id'), model: text('model'),
  input: jsonb('input'), output: jsonb('output'), failureCode: text('failure_code'), startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }).notNull(),
  completedAt: timestamp('completed_at', { withTimezone: true, mode: 'date' }), createdAt: createdAt()
}, (t) => [index('stage_runs_cycle_idx').on(t.cycleId)]);
export const paperOrders = pgTable('paper_orders', {
  orderId: uuid('order_id').primaryKey(), cycleId: uuid('cycle_id').notNull().references(() => decisionCycles.cycleId), decisionContextId: uuid('decision_context_id').notNull().references(() => decisionContexts.decisionContextId),
  stageRunId: uuid('stage_run_id').references(() => stageRuns.stageRunId), mode: mode(), clientOrderId: varchar('client_order_id', { length: 128 }).notNull(), brokerOrderId: text('broker_order_id'),
  symbol: varchar('symbol', { length: 10 }).notNull(), side: varchar('side', { length: 8 }).notNull(), quantity: numeric('quantity', { precision: 30, scale: 12 }).notNull(), limitPrice: numeric('limit_price', { precision: 30, scale: 12 }),
  status: varchar('status', { length: 32 }).notNull(), submittedAt: timestamp('submitted_at', { withTimezone: true, mode: 'date' }), createdAt: createdAt()
}, (t) => [uniqueIndex('paper_orders_client_id_uq').on(t.clientOrderId), index('paper_orders_cycle_idx').on(t.cycleId)]);
export const fills = pgTable('fills', {
  fillId: uuid('fill_id').primaryKey(), orderId: uuid('order_id').notNull().references(() => paperOrders.orderId), cycleId: uuid('cycle_id').notNull().references(() => decisionCycles.cycleId),
  decisionContextId: uuid('decision_context_id').notNull().references(() => decisionContexts.decisionContextId), stageRunId: uuid('stage_run_id').references(() => stageRuns.stageRunId),
  mode: mode(), brokerFillId: text('broker_fill_id'), quantity: numeric('quantity', { precision: 30, scale: 12 }).notNull(), price: numeric('price', { precision: 30, scale: 12 }).notNull(), filledAt: timestamp('filled_at', { withTimezone: true, mode: 'date' }).notNull(), createdAt: createdAt()
}, (t) => [index('fills_cycle_idx').on(t.cycleId)]);
export const marketRecords = pgTable('normalized_market_records', {
  marketRecordId: uuid('market_record_id').primaryKey(), cycleId: uuid('cycle_id').references(() => decisionCycles.cycleId), decisionContextId: uuid('decision_context_id').references(() => decisionContexts.decisionContextId),
  symbol: varchar('symbol', { length: 10 }).notNull(), recordType: varchar('record_type', { length: 32 }).notNull(), source: varchar('source', { length: 32 }).notNull(), observedAt: timestamp('observed_at', { withTimezone: true, mode: 'date' }).notNull(),
  payload: jsonb('payload').notNull(), createdAt: createdAt()
}, (t) => [index('market_records_symbol_time_idx').on(t.symbol, t.observedAt)]);
export const riskDecisions = pgTable('risk_decisions', {
  riskDecisionId: uuid('risk_decision_id').primaryKey(), cycleId: uuid('cycle_id').notNull().references(() => decisionCycles.cycleId), decisionContextId: uuid('decision_context_id').notNull().references(() => decisionContexts.decisionContextId),
  stageRunId: uuid('stage_run_id').references(() => stageRuns.stageRunId), mode: mode(), outcome: varchar('outcome', { length: 16 }).notNull(), rules: jsonb('rules').notNull(), createdAt: createdAt()
}, (t) => [index('risk_decisions_cycle_idx').on(t.cycleId)]);
export const healthSamples = pgTable('health_connection_samples', {
  healthSampleId: uuid('health_sample_id').primaryKey(), component: varchar('component', { length: 32 }).notNull(), status: varchar('status', { length: 24 }).notNull(), detail: text('detail').notNull(), sampledAt: timestamp('sampled_at', { withTimezone: true, mode: 'date' }).notNull(), createdAt: createdAt()
});
export const killSwitchStates = pgTable('kill_switch_state', {
  singletonId: integer('singleton_id').primaryKey(), enabled: boolean('enabled').notNull(), reason: text('reason'), changedAt: timestamp('changed_at', { withTimezone: true, mode: 'date' }).notNull(), changedBy: text('changed_by').notNull()
});
export const configurationSnapshots = pgTable('configuration_snapshots', {
  configSnapshotId: uuid('config_snapshot_id').primaryKey(), version: integer('version').notNull(), digest: varchar('digest', { length: 64 }).notNull(), mode: mode(), config: jsonb('config').notNull(), createdAt: createdAt()
}, (t) => [uniqueIndex('configuration_snapshot_version_uq').on(t.version)]);
export const cycleOutcomes = pgTable('cycle_outcomes', {
  cycleOutcomeId: uuid('cycle_outcome_id').primaryKey(), cycleId: uuid('cycle_id').notNull().references(() => decisionCycles.cycleId), decisionContextId: uuid('decision_context_id').notNull().references(() => decisionContexts.decisionContextId), mode: mode(),
  outcomeVersion: integer('outcome_version').notNull(), label: text('label'), referencePrice: numeric('reference_price', { precision: 30, scale: 12 }), horizonSeconds: integer('horizon_seconds'), observedAt: timestamp('observed_at', { withTimezone: true, mode: 'date' }), payload: jsonb('payload').notNull().default({}), createdAt: createdAt()
}, (t) => [uniqueIndex('cycle_outcomes_cycle_version_uq').on(t.cycleId, t.outcomeVersion)]);
export const localRuntimeSnapshots = pgTable('local_runtime_snapshots', {
  scenarioKey: text('scenario_key').primaryKey(), snapshotVersion: integer('snapshot_version').notNull(), revision: integer('revision').notNull(),
  snapshot: jsonb('snapshot').notNull(), updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow()
}, (t) => [check('local_runtime_snapshot_size_check', sql`octet_length(${t.snapshot}::text) <= 262144`)]);
