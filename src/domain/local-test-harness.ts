import { MarketReplay, type MarketState, type ReplayFixture } from './market-state.js';
import { normalizeAccountState, type AccountState } from './account-state.js';
import { z } from 'zod';

export type LocalFixtures = { market: ReplayFixture; account: unknown; startTime: string };
export type LocalRuntimeSnapshot = { version: 1; now: string; replayCursor: number; market: import('./market-state.js').MarketState[] };
type Trace = { sequence: number; at: string; method: string; route: string; status: number };
type LocalLog = { sequence: number; at: string; level: 'info' | 'warn'; message: string; method?: string; route?: string; status?: number; target?: string; error?: string; resources?: SimulatedAccountResource[] };
export type SimulatedAccountResource = 'account' | 'positions' | 'orders' | 'clock';
export type SimulatedProviderResource = SimulatedAccountResource | 'market';
export type InjectedFailureKind = 'network' | 'rate_limit' | 'broker';
export const MAX_QUEUED_FAILURES_PER_PROVIDER = 100;
const MAX_EXPECTATION_BYTES = 32 * 1024;
const MAX_EXPECTATION_NODES = 2_048;
const MAX_EXPECTATION_DEPTH = 12;
const MAX_MISMATCH_PATHS = 100;
type ProviderHealth = { status: 'ready' | 'degraded'; lastError: string | null; observedAt: string };
const resourceSchema = ['account', 'positions', 'orders', 'clock', 'market'] as const;
const decimalString = z.string().regex(/^-?\d{1,20}(\.\d{1,10})?$/);
const scalarSchema = z.union([z.number().finite(), decimalString]);
const positiveScalarSchema = z.union([z.number().finite().positive(), z.string().regex(/^(?:0|[1-9]\d{0,19})(?:\.\d{1,10})?$/).refine((value) => Number(value) > 0)]);
const nonNegativeScalarSchema = z.union([z.number().finite().nonnegative(), z.string().regex(/^(?:0|[1-9]\d{0,19})(?:\.\d{1,10})?$/)]);
const scalar = (value: number | string | null | undefined) => value == null ? null : String(value);
const tradeUpdateSchema = z.object({
  stream: z.literal('trade_updates'),
  data: z.object({
    event: z.enum(['new', 'fill', 'partial_fill', 'canceled', 'expired', 'done_for_day', 'replaced', 'suspended', 'rejected', 'pending_new', 'pending_cancel', 'pending_replace', 'accepted', 'calculated', 'held', 'stopped', 'order_replace_rejected', 'order_cancel_rejected']),
    timestamp: z.string().datetime({ offset: true }).optional(),
    price: positiveScalarSchema.optional(),
    qty: positiveScalarSchema.optional(),
    position_qty: scalarSchema.optional(),
    order: z.object({
      id: z.string().min(1).max(128), client_order_id: z.string().min(1).max(128),
      symbol: z.string().regex(/^[A-Z0-9.-]{1,16}$/), side: z.enum(['buy', 'sell']),
      type: z.enum(['market', 'limit', 'stop', 'stop_limit', 'trailing_stop']),
      status: z.string().min(1).max(32), qty: positiveScalarSchema.optional(),
      filled_qty: nonNegativeScalarSchema.optional(),
      filled_avg_price: positiveScalarSchema.nullable().optional(),
    }),
  }),
}).strict();
const MAX_TRADE_UPDATE_BATCH = 20;
const MAX_TRADE_UPDATE_OBSERVATIONS = 100;
type TradeUpdateHint = { sequence: number; receivedAt: string; event: string; eventAt: string | null; order: { id: string; clientOrderId: string; symbol: string; side: string; type: string; status: string; quantity: string | null; filledQuantity: string | null; filledAveragePrice: string | null }; price: string | null; quantity: string | null; positionQuantity: string | null };

export class SimulatedProviderFailure extends Error {
  constructor(readonly statusCode: number, readonly errorCode: string) { super(errorCode); }
}

export type LocalStateComparison = {
  simulated: true;
  mode: 'paper';
  matched: boolean;
  comparedAt: string;
  mismatchCount: number;
  mismatchPaths: string[];
  mismatchPathsTruncated: boolean;
};

export class InvalidLocalStateExpectation extends Error {
  constructor() { super('invalid local state expectation'); this.name = 'InvalidLocalStateExpectation'; }
}

/** In-memory deterministic scenario. It has no provider, database, or network dependency. */
export class LocalTestHarness {
  private now: Date;
  private replay: MarketReplay;
  private accountScenario: unknown;
  private accountReconciledAt: string;
  private reconciledAccount: AccountState | null = null;
  private readonly traces: Trace[] = [];
  private readonly appLogs: LocalLog[] = [];
  private readonly tradeUpdateHints: TradeUpdateHint[] = [];
  private tradeUpdateSequence = 0;
  private sequence = 0;
  private logSequence = 0;
  private reconciliation: { status: 'restored' | 'initialized'; source: 'postgres_snapshot' | 'checked_in_fixtures'; revision: number; reconciledAt: string } = { status: 'initialized', source: 'checked_in_fixtures', revision: 0, reconciledAt: '' };
  private readonly failures = new Map<'market' | 'account', InjectedFailureKind[]>();
  private readonly providerHealthState: Record<'market' | 'account', ProviderHealth> = {
    market: { status: 'ready', lastError: null, observedAt: '' },
    account: { status: 'ready', lastError: null, observedAt: '' },
  };

  constructor(private readonly fixtures: LocalFixtures, private readonly accountStateStaleAfterSeconds = 60) {
    this.accountScenario = structuredClone(fixtures.account);
    this.reconciledAccount = null;
    this.now = new Date(fixtures.startTime);
    if (!Number.isFinite(this.now.getTime())) throw new Error('invalid fixture start time');
    if (!Number.isInteger(accountStateStaleAfterSeconds) || accountStateStaleAfterSeconds < 1 || accountStateStaleAfterSeconds > 3600) throw new Error('invalid account freshness threshold');
    this.accountReconciledAt = this.now.toISOString();
    this.reconciliation.reconciledAt = this.now.toISOString();
    for (const target of ['market', 'account'] as const) this.providerHealthState[target] = { status: 'ready', lastError: null, observedAt: this.now.toISOString() };
    this.replay = this.newReplay();
  }

  private newReplay(at?: Date) { return new MarketReplay(this.fixtures.market, () => new Date(at ?? this.now)); }
  private clockSnapshot() {
    const account = this.fixtures.account as { clock: { timestamp: string; next_open: string; next_close: string; is_open: boolean; market: string } };
    const delta = this.now.getTime() - Date.parse(account.clock.timestamp);
    return {
      timestamp: this.now.toISOString(),
      is_open: account.clock.is_open,
      next_open: new Date(Date.parse(account.clock.next_open) + delta).toISOString(),
      next_close: new Date(Date.parse(account.clock.next_close) + delta).toISOString(),
      market: account.clock.market,
    };
  }
  reset() {
    this.now = new Date(this.fixtures.startTime);
    this.accountScenario = structuredClone(this.fixtures.account);
    this.reconciledAccount = null;
    this.accountReconciledAt = this.now.toISOString();
    this.replay = this.newReplay();
    this.traces.length = 0;
    this.appLogs.length = 0;
    this.sequence = 0;
    this.logSequence = 0;
    this.tradeUpdateHints.length = 0;
    this.tradeUpdateSequence = 0;
    this.failures.clear();
    for (const target of ['market', 'account'] as const) this.providerHealthState[target] = { status: 'ready', lastError: null, observedAt: this.now.toISOString() };
    return this.state();
  }
  persistenceSnapshot(): LocalRuntimeSnapshot {
    return { version: 1, now: this.now.toISOString(), replayCursor: this.replay.position, market: this.replay.snapshot() };
  }
  restore(snapshot: LocalRuntimeSnapshot) {
    if (snapshot?.version !== 1 || !Number.isInteger(snapshot.replayCursor) || !Array.isArray(snapshot.market)) throw new Error('invalid persisted local runtime snapshot');
    const now = new Date(snapshot.now);
    if (!Number.isFinite(now.getTime())) throw new Error('invalid persisted local runtime time');
    const replay = this.newReplay(now);
    replay.restore(snapshot.replayCursor, snapshot.market);
    this.now = now;
    this.replay = replay;
  }
  setReconciliation(value: typeof this.reconciliation) { this.reconciliation = structuredClone(value); }
  setClock(value: string) {
    const next = new Date(value);
    if (!Number.isFinite(next.getTime())) throw new Error('invalid virtual time');
    this.now = next;
    return this.state();
  }
  advance(steps: number) {
    if (!Number.isInteger(steps) || steps < 1 || steps > 100) throw new Error('steps must be an integer from 1 to 100');
    let processed = 0;
    while (processed < steps && this.replay.step() !== null) processed += 1;
    return { processed, ...this.state() };
  }
  marketFixtureEvents(from: number, count: number) {
    if (!Number.isInteger(from) || from < 0 || !Number.isInteger(count) || count < 0 || count > 10_000 || from + count > this.fixtures.market.events.length) throw new Error('invalid local market replay range');
    return structuredClone(this.fixtures.market.events.slice(from, from + count));
  }
  state() {
    const account = structuredClone(this.accountScenario) as { clock: unknown };
    account.clock = this.clockSnapshot();
    const ageMs = Math.max(0, this.now.getTime() - Date.parse(this.accountReconciledAt));
    const normalizedAccount = this.reconciledAccount ?? normalizeAccountState(account, this.accountReconciledAt);
    return { now: this.now.toISOString(), market: this.replay.snapshot(), account: { ...normalizedAccount, freshness: { status: ageMs <= this.accountStateStaleAfterSeconds * 1000 ? 'fresh' as const : 'stale' as const, ageMs } }, tradeUpdates: structuredClone(this.tradeUpdateHints), replayCursor: this.replay.position, replayTotal: this.fixtures.market.events.length, reconciliation: structuredClone(this.reconciliation) };
  }

  ingestTradeUpdates(input: unknown) {
    const batchSchema = z.object({ updates: z.array(tradeUpdateSchema).min(1).max(MAX_TRADE_UPDATE_BATCH) }).strict();
    const parsed = batchSchema.safeParse(input);
    if (!parsed.success) throw new Error('invalid simulated trade updates');
    const mapped = parsed.data.updates.map(({ data }) => ({
      receivedAt: this.now.toISOString(), event: data.event, eventAt: data.timestamp ?? null,
      order: { id: data.order.id, clientOrderId: data.order.client_order_id, symbol: data.order.symbol, side: data.order.side, type: data.order.type, status: data.order.status, quantity: scalar(data.order.qty), filledQuantity: scalar(data.order.filled_qty), filledAveragePrice: scalar(data.order.filled_avg_price) },
      price: scalar(data.price), quantity: scalar(data.qty), positionQuantity: scalar(data.position_qty),
    }));
    for (const hint of mapped) {
      this.tradeUpdateSequence += 1;
      this.tradeUpdateHints.push({ sequence: this.tradeUpdateSequence, ...hint });
      if (this.tradeUpdateHints.length > MAX_TRADE_UPDATE_OBSERVATIONS) this.tradeUpdateHints.shift();
    }
    this.writeLog('info', 'simulated_trade_updates_received', { target: 'account', status: mapped.length });
    return { simulated: true as const, mode: 'paper' as const, accepted: mapped.length, observations: this.tradeUpdates() };
  }

  tradeUpdates() { return { simulated: true as const, mode: 'paper' as const, observedAt: this.now.toISOString(), updates: structuredClone(this.tradeUpdateHints) }; }

  reconcileAccount() {
    this.accountReconciledAt = this.now.toISOString();
    this.providerHealthState.account = { status: 'ready', lastError: null, observedAt: this.accountReconciledAt };
    this.writeLog('info', 'simulated_account_reconciled', { target: 'account' });
    return this.state();
  }

  accountAdapterResponse(resource: SimulatedAccountResource) {
    return this.buildProviderResponse(resource, false).data;
  }

  recordAccountAdapterSuccess(account: AccountState, resources: SimulatedAccountResource[]) {
    this.reconciledAccount = structuredClone(account);
    this.accountReconciledAt = account.reconciledAt;
    this.providerHealthState.account = { status: 'ready', lastError: null, observedAt: this.now.toISOString() };
    this.writeLog('info', 'simulated_account_adapter_reconciled', { target: 'account', resources: [...resources] });
    return this.state();
  }

  recordAccountAdapterFailure(kind: string, resources: SimulatedAccountResource[]) {
    const error = `simulated_${kind}`;
    this.providerHealthState.account = { status: 'degraded', lastError: error, observedAt: this.now.toISOString() };
    this.writeLog('warn', 'simulated_account_adapter_failed', { target: 'account', error, resources: [...resources] });
  }

  compareState(expected: unknown, observedState: unknown = this.state()): LocalStateComparison {
    if (!expected || typeof expected !== 'object' || Array.isArray(expected)) throw new InvalidLocalStateExpectation();
    let encoded: string;
    try { encoded = JSON.stringify(expected); } catch { throw new InvalidLocalStateExpectation(); }
    if (typeof encoded !== 'string' || new TextEncoder().encode(encoded).byteLength > MAX_EXPECTATION_BYTES) throw new InvalidLocalStateExpectation();
    let nodes = 0;
    const validate = (value: unknown, depth: number): void => {
      nodes += 1;
      if (nodes > MAX_EXPECTATION_NODES || depth > MAX_EXPECTATION_DEPTH) throw new InvalidLocalStateExpectation();
      if (value === null || typeof value === 'boolean') return;
      if (typeof value === 'number') { if (!Number.isFinite(value)) throw new InvalidLocalStateExpectation(); return; }
      if (typeof value === 'string') { if (value.length > 2_048) throw new InvalidLocalStateExpectation(); return; }
      if (Array.isArray(value)) {
        if (value.length > 100) throw new InvalidLocalStateExpectation();
        for (const item of value) validate(item, depth + 1);
        return;
      }
      if (typeof value === 'object') {
        const entries = Object.entries(value as Record<string, unknown>);
        for (const [key, item] of entries) {
          if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key)) throw new InvalidLocalStateExpectation();
          validate(item, depth + 1);
        }
        return;
      }
      throw new InvalidLocalStateExpectation();
    };
    validate(expected, 0);

    const observed = observedState;
    const mismatchPaths: string[] = [];
    let mismatchCount = 0;
    const recordMismatch = (path: string) => {
      mismatchCount += 1;
      if (mismatchPaths.length < MAX_MISMATCH_PATHS) mismatchPaths.push(path);
    };
    const compare = (want: unknown, got: unknown, path: string): void => {
      if (want !== null && typeof want === 'object') {
        if (Array.isArray(want)) {
          if (!Array.isArray(got)) { recordMismatch(path); return; }
          if (want.length !== got.length) recordMismatch(`${path}.length`);
          const count = Math.min(want.length, got.length);
          for (let index = 0; index < count; index += 1) compare(want[index], got[index], `${path}[${index}]`);
          return;
        }
        if (!got || typeof got !== 'object' || Array.isArray(got)) { recordMismatch(path); return; }
        for (const [key, value] of Object.entries(want as Record<string, unknown>)) {
          if (!Object.hasOwn(got, key)) recordMismatch(`${path}.${key}`);
          else compare(value, (got as Record<string, unknown>)[key], `${path}.${key}`);
        }
        return;
      }
      if (!Object.is(want, got)) recordMismatch(path);
    };
    compare(expected, observed, '$');
    return {
      simulated: true,
      mode: 'paper',
      matched: mismatchCount === 0,
      comparedAt: this.now.toISOString(),
      mismatchCount,
      mismatchPaths,
      mismatchPathsTruncated: mismatchCount > mismatchPaths.length,
    };
  }
  record(method: string, route: string, status: number) {
    this.sequence += 1;
    this.traces.push({ sequence: this.sequence, at: this.now.toISOString(), method, route, status });
    if (this.traces.length > 200) this.traces.shift();
    this.writeLog('info', 'http_request_completed', { method, route, status });
  }

  private writeLog(level: LocalLog['level'], message: string, fields: Omit<LocalLog, 'sequence' | 'at' | 'level' | 'message'> = {}) {
    this.logSequence += 1;
    this.appLogs.push({ sequence: this.logSequence, at: this.now.toISOString(), level, message, ...fields });
    if (this.appLogs.length > 200) this.appLogs.shift();
  }

  trace(after = 0, limit = 100) {
    if (!Number.isInteger(after) || after < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('invalid trace bounds');
    return this.traces.filter((item) => item.sequence > after).slice(0, limit);
  }

  logs(after = 0, limit = 100) {
    if (!Number.isInteger(after) || after < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('invalid log bounds');
    return this.appLogs.filter((item) => item.sequence > after).slice(0, limit);
  }

  injectFailure(target: 'market' | 'account', kind: InjectedFailureKind, count: number) {
    if (!Number.isInteger(count) || count < 1 || count > 10) throw new Error('failure count must be an integer from 1 to 10');
    const queue = this.failures.get(target) ?? [];
    if (queue.length + count > MAX_QUEUED_FAILURES_PER_PROVIDER) throw new Error('simulated failure queue limit exceeded');
    this.failures.set(target, [...queue, ...Array.from({ length: count }, () => kind)]);
  }

  consumeMarketFailure(): InjectedFailureKind | null {
    const queue = this.failures.get('market') ?? [];
    const failure = queue.shift() ?? null;
    if (queue.length) this.failures.set('market', queue); else this.failures.delete('market');
    if (failure) this.recordMarketAdapterFailure(failure);
    return failure;
  }

  recordMarketAdapterFailure(kind: InjectedFailureKind) {
    const error = kind === 'network' ? 'simulated_network_failure' : kind === 'rate_limit' ? 'simulated_rate_limit' : 'simulated_broker_rejection';
    this.providerHealthState.market = { status: 'degraded', lastError: error, observedAt: this.now.toISOString() };
    this.writeLog('warn', 'simulated_market_stream_failed', { target: 'market', error });
  }

  recordMarketAdapterRecovery() {
    this.providerHealthState.market = { status: 'ready', lastError: null, observedAt: this.now.toISOString() };
    this.writeLog('info', 'simulated_market_stream_recovered', { target: 'market' });
  }

  recordMarketReplay(count: number) {
    this.writeLog('info', 'simulated_market_stream_replay', { target: 'market', status: count });
  }

  replaceAccountScenario(input: unknown) {
    // Validate the same provider-shaped boundary used by normalization before mutating the scenario.
    normalizeAccountState(input, this.now.toISOString());
    this.accountScenario = structuredClone(input);
    this.reconciledAccount = null;
    this.accountReconciledAt = this.now.toISOString();
    this.providerHealthState.account = { status: 'ready', lastError: null, observedAt: this.accountReconciledAt };
    this.writeLog('info', 'simulated_account_scenario_replaced', { target: 'account' });
  }

  providerResponse(resource: SimulatedProviderResource) {
    return this.buildProviderResponse(resource, true);
  }

  private buildProviderResponse(resource: SimulatedProviderResource, updateHealth: boolean) {
    if (!(resourceSchema as readonly string[]).includes(resource)) throw new Error('unsupported simulated provider resource');
    const target = resource === 'market' ? 'market' : 'account';
    const queue = this.failures.get(target) ?? [];
    const failure = queue.shift();
    if (queue.length) this.failures.set(target, queue); else this.failures.delete(target);
    if (failure) {
      const errorCode = failure === 'network' ? 'simulated_network_failure' : failure === 'rate_limit' ? 'simulated_rate_limit' : 'simulated_broker_rejection';
      const statusCode = failure === 'network' ? 503 : failure === 'rate_limit' ? 429 : 403;
      if (updateHealth) {
        this.providerHealthState[target] = { status: 'degraded', lastError: errorCode, observedAt: this.now.toISOString() };
        this.writeLog('warn', 'simulated_provider_failure', { target, error: errorCode, status: statusCode });
      }
      throw new SimulatedProviderFailure(statusCode, errorCode);
    }
    if (updateHealth) this.providerHealthState[target] = { status: 'ready', lastError: null, observedAt: this.now.toISOString() };

    const account = this.accountScenario as {
      account: { id: string; status: string; currency: string; equity: string; cash: string; buying_power: string; trading_blocked: boolean; account_blocked: boolean; shorting_enabled: boolean };
      positions: Array<{ symbol: string; qty: string; side: string; avg_entry_price: string; current_price: string | null; market_value: string | null }>;
      open_orders: Array<{ id: string; client_order_id: string; symbol: string; side: string; qty?: string | null; notional?: string | null; status: string; created_at: string; type: string }>;
    };
    const values: Record<SimulatedProviderResource, unknown> = {
      account: {
        id: account.account.id, status: account.account.status, currency: account.account.currency,
        equity: account.account.equity, cash: account.account.cash, buying_power: account.account.buying_power,
        trading_blocked: account.account.trading_blocked, account_blocked: account.account.account_blocked,
        shorting_enabled: account.account.shorting_enabled,
      },
      positions: account.positions.map(({ symbol, qty, side, avg_entry_price, current_price, market_value }) => ({ symbol, qty, side, avg_entry_price, current_price, market_value })),
      orders: account.open_orders.map(({ id, client_order_id, symbol, side, qty, notional, status, created_at, type }) => ({ id, client_order_id, symbol, side, ...(qty === undefined ? {} : { qty }), ...(notional === undefined ? {} : { notional }), status, created_at, type })),
      clock: this.clockSnapshot(),
      market: { feed: this.fixtures.market.feed, cursor: this.replay.position, states: this.replay.snapshot() },
    };
    return { simulated: true, mode: 'paper', resource, observedAt: this.now.toISOString(), data: structuredClone(values[resource]) };
  }

  providerHealth() {
    return { simulated: true, mode: 'paper', observedAt: this.now.toISOString(), providers: structuredClone(this.providerHealthState) };
  }
}
