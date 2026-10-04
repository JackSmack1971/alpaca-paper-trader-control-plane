import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { AccountState } from './account-state.js';
import { parseMarketBatch, type MarketEvent, type MarketState } from './market-state.js';

export const DECISION_CONTEXT_SCHEMA_VERSION = 1;
export const DECISION_CONTEXT_TRANSFORM_VERSION = 'decision-context-transform-2';
export const MAX_DECISION_CONTEXT_TOKENS = 4_000;
export const TOKEN_ESTIMATE_METHOD = 'utf8-bytes-upper-bound-v1';

export type UnavailableReason = 'stale' | 'insufficient_history' | 'no_feed' | 'unsupported' | 'pre_market' | 'unavailable_account_state';
export type ContextUnavailable = { path: string; reason: UnavailableReason };

export type DecisionContextInput = {
  cycleId: string;
  symbol: string;
  builtAt: string;
  asOf: string;
  market: MarketState | null;
  marketHistory: unknown[];
  marketFreshnessMs: number;
  account: AccountState | null;
  accountFreshnessMs: number;
  capabilities: { tradable: boolean; shortable: boolean; fractional: boolean } | null;
  capabilityProvenance: { source: string; recordId: string; sourceTime: string | null; receivedAt: string } | null;
  recentCycleState: { status: string; observedAt: string } | null;
};

export type DecisionContext = {
  decision_context_id: string;
  cycle_id: string;
  mode: 'paper';
  symbol: string;
  schema_version: number;
  built_at: string;
  as_of: string;
  transform_versions: { context: string; arithmetic: string };
  eligible_for_inference: boolean;
  blockers: string[];
  market: {
    feed: string | null;
    current_price: string | null;
    return_one_trade: string | null;
    return_five_trades: string | null;
    trend: 'up' | 'down' | 'flat' | null;
    realized_variance: string | null;
    observed_trade_volume: string | null;
    spread: string | null;
    spread_basis_points: string | null;
    data_age_ms: number | null;
    freshness: 'fresh' | 'stale' | 'unavailable';
  };
  account: {
    freshness: 'fresh' | 'stale' | 'unavailable';
    reconciled_at: string | null;
    equity: string | null;
    cash: string | null;
    buying_power: string | null;
    position: { side: 'long' | 'short'; quantity: string; average_entry_price: string; current_price: string | null; market_value: string | null; unrealized_pnl: string | null } | null;
    open_orders: Array<{ client_order_id: string; side: 'buy' | 'sell'; quantity: string | null; notional: string | null; status: string }> | null;
    exposure: AccountState['exposure'] | null;
    realized_pnl: null;
  };
  market_session: { is_open: boolean; market: string; next_open: string; next_close: string } | null;
  symbol_capabilities: { tradable: boolean; shortable: boolean; fractional: boolean } | null;
  recent_cycle_state: { status: string; observed_at: string } | null;
  unavailable: ContextUnavailable[];
  provenance: {
    input_sha256: string;
    sources: Array<{ sequence: number; kind: string; source: string; record_id: string | null; source_time: string | null; received_at: string | null }>;
  };
};

export type BuiltDecisionContext = {
  context: DecisionContext;
  canonicalJson: string;
  contentHash: string;
  estimatedTokens: number;
  tokenEstimateMethod: typeof TOKEN_ESTIMATE_METHOD;
  sourceInput: DecisionContextInput;
};

const inputSchema = z.object({
  cycleId: z.string().uuid(),
  symbol: z.string().regex(/^[A-Z][A-Z0-9.-]{0,9}$/),
  builtAt: z.string().datetime({ offset: true }),
  asOf: z.string().datetime({ offset: true }),
  market: z.unknown().nullable(),
  marketHistory: z.array(z.unknown()).max(500),
  marketFreshnessMs: z.number().int().min(1).max(3_600_000),
  account: z.unknown().nullable(),
  accountFreshnessMs: z.number().int().min(1).max(3_600_000),
  capabilities: z.object({ tradable: z.boolean(), shortable: z.boolean(), fractional: z.boolean() }).strict().nullable(),
  capabilityProvenance: z.object({
    source: z.string().min(1).max(64),
    recordId: z.string().min(1).max(128),
    sourceTime: z.string().datetime({ offset: true }).nullable(),
    receivedAt: z.string().datetime({ offset: true }),
  }).strict().nullable(),
  recentCycleState: z.object({ status: z.string().min(1).max(32), observedAt: z.string().datetime({ offset: true }) }).strict().nullable(),
}).strict().superRefine((input, context) => {
  if ((input.capabilities === null) !== (input.capabilityProvenance === null)) {
    context.addIssue({ code: 'custom', path: ['capabilityProvenance'], message: 'capability values and provenance must be supplied together' });
  }
});

const timestamp = z.string().datetime({ offset: true });
const decimalText = z.string().max(64).regex(/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/);
const positiveDecimalText = decimalText.refine((value) => {
  try { return decimal(value).units > 0n; } catch { return false; }
});
const normalizedMarketStateSchema = z.object({
  symbol: z.string().regex(/^[A-Z][A-Z0-9.-]{0,9}$/),
  feed: z.string().min(1).max(64),
  lastTrade: z.object({
    id: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    price: z.number().finite().positive().max(Number.MAX_SAFE_INTEGER),
    size: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    sourceTime: timestamp,
  }).strict().nullable(),
  quote: z.object({
    bid: z.number().finite().positive().max(Number.MAX_SAFE_INTEGER),
    bidSize: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    ask: z.number().finite().positive().max(Number.MAX_SAFE_INTEGER),
    askSize: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    sourceTime: timestamp,
  }).strict().nullable(),
  sourceEventTime: timestamp,
  receivedAt: timestamp,
  freshness: z.enum(['fresh', 'stale']),
  staleReason: z.string().min(1).max(128).nullable(),
}).strict();

const normalizedAccountStateSchema = z.object({
  mode: z.literal('paper'),
  account: z.object({
    equity: decimalText,
    cash: decimalText,
    buyingPower: decimalText,
    currency: z.string().length(3),
    status: z.string().min(1),
    restrictions: z.object({ tradingBlocked: z.boolean(), accountBlocked: z.boolean(), shortingEnabled: z.boolean() }).strict(),
  }).strict(),
  positions: z.array(z.object({
    symbol: z.string().regex(/^[A-Z][A-Z0-9.-]{0,19}$/),
    side: z.enum(['long', 'short']),
    quantity: positiveDecimalText,
    averageEntryPrice: positiveDecimalText,
    currentPrice: positiveDecimalText.nullable(),
    marketValue: decimalText.nullable(),
  }).strict()).max(100),
  openOrders: z.array(z.object({
    orderId: z.string().uuid(),
    clientOrderId: z.string().min(1).max(128),
    symbol: z.string().regex(/^[A-Z][A-Z0-9.-]{0,19}$/),
    side: z.enum(['buy', 'sell']),
    quantity: positiveDecimalText.nullable(),
    notional: positiveDecimalText.nullable(),
    status: z.string().min(1),
    submittedAt: timestamp,
  }).strict().refine((order) => order.quantity !== null || order.notional !== null, 'order must provide quantity or notional')).max(500),
  exposure: z.object({
    long: decimalText,
    short: decimalText,
    gross: decimalText,
    complete: z.boolean(),
    unpricedSymbols: z.array(z.string().regex(/^[A-Z][A-Z0-9.-]{0,19}$/)).max(100),
  }).strict(),
  market: z.object({ timestamp, isOpen: z.boolean(), nextOpen: timestamp, nextClose: timestamp }).strict(),
  reconciledAt: timestamp,
  provenance: z.object({
    source: z.enum(['fixture', 'alpaca_paper']),
    groups: z.tuple([z.literal('account'), z.literal('positions'), z.literal('open_orders'), z.literal('market_clock')]),
  }).strict(),
}).strict();

type Decimal = { units: bigint; scale: number };
const POW10 = (scale: number) => 10n ** BigInt(scale);

function expandExponent(value: string): string {
  const match = /^(-?)(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/.exec(value);
  if (!match) return value;
  const sign = match[1] ?? '';
  const whole = match[2] ?? '';
  const fraction = match[3] ?? '';
  const exponent = Number(match[4]);
  const digits = whole + fraction;
  const point = whole.length + exponent;
  if (point <= 0) return `${sign}0.${'0'.repeat(-point)}${digits}`;
  if (point >= digits.length) return `${sign}${digits}${'0'.repeat(point - digits.length)}`;
  return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
}

function decimal(value: string | number): Decimal {
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('invalid context decimal');
  const normalized = typeof value === 'number' ? expandExponent(value.toString()) : value;
  const match = /^(-?)(0|[1-9]\d*)(?:\.(\d+))?$/.exec(normalized);
  if (!match) throw new Error('invalid context decimal');
  const fraction = match[3] ?? '';
  if (fraction.length > 18 || match[2]!.length > 40) throw new Error('context decimal is out of range');
  const magnitude = BigInt(`${match[2]}${fraction}`);
  return { units: match[1] === '-' ? -magnitude : magnitude, scale: fraction.length };
}

function align(value: Decimal, scale: number): bigint { return value.units * POW10(scale - value.scale); }
function add(a: Decimal, b: Decimal): Decimal { const scale = Math.max(a.scale, b.scale); return { units: align(a, scale) + align(b, scale), scale }; }
function subtract(a: Decimal, b: Decimal): Decimal { const scale = Math.max(a.scale, b.scale); return { units: align(a, scale) - align(b, scale), scale }; }
function multiply(a: Decimal, b: Decimal): Decimal { return { units: a.units * b.units, scale: a.scale + b.scale }; }

function roundedQuotient(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new Error('division by zero');
  const negative = (numerator < 0n) !== (denominator < 0n);
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;
  let quotient = n / d;
  const remainder = n % d;
  const doubled = remainder * 2n;
  if (doubled > d || doubled === d && quotient % 2n !== 0n) quotient += 1n;
  return negative ? -quotient : quotient;
}

function divide(a: Decimal, b: Decimal, places: number): Decimal {
  const numerator = a.units * POW10(b.scale + places);
  const denominator = b.units * POW10(a.scale);
  return { units: roundedQuotient(numerator, denominator), scale: places };
}

function canonical(value: Decimal): string {
  let { units, scale } = value;
  while (scale > 0 && units % 10n === 0n) { units /= 10n; scale -= 1; }
  const negative = units < 0n;
  const digits = (negative ? -units : units).toString().padStart(scale + 1, '0');
  const formatted = scale === 0 ? digits : `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
  return negative && units !== 0n ? `-${formatted}` : formatted;
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`;
}

function sha256(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex'); }

function deterministicUuid(seed: string): string {
  const bytes = sha256(seed).slice(0, 32).split('');
  bytes[12] = '5';
  const variant = Number.parseInt(bytes[16]!, 16);
  bytes[16] = ((variant & 0x3) | 0x8).toString(16);
  const hex = bytes.join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function decimalSum(values: Decimal[]): Decimal { return values.reduce((sum, value) => add(sum, value), { units: 0n, scale: 0 }); }
function magnitudeDirection(a: Decimal, b: Decimal): 'up' | 'down' | 'flat' { return a.units < b.units ? 'up' : a.units > b.units ? 'down' : 'flat'; }

function effectiveTrades(events: MarketEvent[], symbol: string): Array<Extract<MarketEvent, { type: 'trade' }>> {
  const trades = new Map<number, { trade: Extract<MarketEvent, { type: 'trade' }>; order: number }>();
  events.forEach((event, order) => {
    if (event.symbol !== symbol) return;
    if (event.type === 'trade') trades.set(event.id, { trade: event, order });
    else if (event.type === 'trade_correction') {
      const original = trades.get(event.originalTradeId);
      trades.delete(event.originalTradeId);
      trades.set(event.correctedTrade.id, {
        trade: { type: 'trade', symbol, id: event.correctedTrade.id, price: event.correctedTrade.price, size: event.correctedTrade.size, sourceTime: original?.trade.sourceTime ?? event.sourceTime },
        order: original?.order ?? order,
      });
    } else if (event.type === 'trade_cancel') trades.delete(event.tradeId);
  });
  return [...trades.values()].sort((left, right) => left.order - right.order).map(({ trade }) => trade);
}

export function buildDecisionContext(inputValue: DecisionContextInput): BuiltDecisionContext {
  const parsed = inputSchema.parse(inputValue) as DecisionContextInput;
  const asOfMs = Date.parse(parsed.asOf);
  const builtAtMs = Date.parse(parsed.builtAt);
  if (builtAtMs < asOfMs) throw new Error('built_at must not precede effective as_of');
  if (parsed.market !== null && (typeof parsed.market !== 'object' || Array.isArray(parsed.market))) throw new Error('invalid normalized market input');
  if (parsed.account !== null && (typeof parsed.account !== 'object' || Array.isArray(parsed.account))) throw new Error('invalid normalized account input');
  const marketResult = parsed.market === null ? null : normalizedMarketStateSchema.safeParse(parsed.market);
  if (marketResult && !marketResult.success) throw new Error('invalid normalized market input');
  const accountResult = parsed.account === null ? null : normalizedAccountStateSchema.safeParse(parsed.account);
  if (accountResult && !accountResult.success) throw new Error('invalid normalized account input');
  const market = marketResult?.data as MarketState | undefined ?? null;
  const account = accountResult?.data as AccountState | undefined ?? null;
  if (market && market.symbol !== parsed.symbol) throw new Error('market symbol does not match decision context');
  if (parsed.recentCycleState && Date.parse(parsed.recentCycleState.observedAt) > asOfMs) throw new Error('cycle state observation is in the future');

  const parsedEvents: MarketEvent[] = parsed.marketHistory.length ? parseMarketBatch(parsed.marketHistory) : [];
  const symbolEvents = parsedEvents.filter((event) => event.symbol === parsed.symbol);
  if (symbolEvents.some((event) => Date.parse(event.sourceTime) > asOfMs)) throw new Error('market event is in the future');
  if (market && (Date.parse(market.sourceEventTime) > asOfMs || Date.parse(market.receivedAt) > asOfMs)) throw new Error('market snapshot is in the future');
  if (account && Date.parse(account.reconciledAt) > asOfMs) throw new Error('account reconciliation is in the future');
  if (parsed.capabilityProvenance && (Date.parse(parsed.capabilityProvenance.receivedAt) > asOfMs || (parsed.capabilityProvenance.sourceTime !== null && Date.parse(parsed.capabilityProvenance.sourceTime) > asOfMs))) throw new Error('symbol capabilities are in the future');

  const unavailable: ContextUnavailable[] = [];
  const addUnavailable = (path: string, reason: UnavailableReason) => unavailable.push({ path, reason });
  const blockers: string[] = [];
  const marketReceiveAgeMs = market ? asOfMs - Date.parse(market.receivedAt) : null;
  const marketSourceAgeMs = market ? asOfMs - Date.parse(market.sourceEventTime) : null;
  const marketAgeMs = marketReceiveAgeMs === null || marketSourceAgeMs === null ? null : Math.max(marketReceiveAgeMs, marketSourceAgeMs);
  const marketFresh = Boolean(market && market.freshness === 'fresh' && market.staleReason === null && marketAgeMs !== null && marketAgeMs <= parsed.marketFreshnessMs);
  if (!market) { addUnavailable('market', 'no_feed'); blockers.push('market_unavailable'); }
  else if (!marketFresh) { addUnavailable('market', 'stale'); blockers.push('stale_market'); }
  const accountAgeMs = account ? asOfMs - Date.parse(account.reconciledAt) : null;
  const accountFresh = Boolean(account && accountAgeMs !== null && accountAgeMs <= parsed.accountFreshnessMs);
  if (!account) { addUnavailable('account', 'unavailable_account_state'); blockers.push('account_unavailable'); }
  else if (!accountFresh) { addUnavailable('account', 'stale'); blockers.push('stale_account'); }

  const usableTrades = effectiveTrades(symbolEvents, parsed.symbol);
  const prices = usableTrades.map((event) => decimal(event.price));
  const currentPrice = marketFresh
    ? usableTrades.length ? canonical(decimal(usableTrades.at(-1)!.price)) : market?.lastTrade ? canonical(decimal(market.lastTrade.price)) : null
    : null;
  if (marketFresh && !currentPrice) addUnavailable('market.current_price', market ? 'insufficient_history' : 'no_feed');
  if (marketFresh && prices.length < 2) {
    blockers.push('insufficient_market_history');
  }
  let returnOneTrade: string | null = null;
  let returnFiveTrades: string | null = null;
  if (!marketFresh) {
    addUnavailable('market.return_one_trade', market ? 'stale' : 'no_feed');
    addUnavailable('market.return_five_trades', market ? 'stale' : 'no_feed');
  } else if (prices.length >= 2) {
    returnOneTrade = canonical(divide(subtract(prices.at(-1)!, prices.at(-2)!), prices.at(-2)!, 8));
    if (prices.length >= 6) returnFiveTrades = canonical(divide(subtract(prices.at(-1)!, prices.at(-6)!), prices.at(-6)!, 8));
    else addUnavailable('market.return_five_trades', 'insufficient_history');
  } else {
    addUnavailable('market.return_one_trade', market ? 'insufficient_history' : 'no_feed');
    addUnavailable('market.return_five_trades', market ? 'insufficient_history' : 'no_feed');
  }

  let trend: 'up' | 'down' | 'flat' | null = null;
  let realizedVariance: string | null = null;
  if (marketFresh && prices.length >= 3) {
    const sample = prices.slice(-5);
    trend = magnitudeDirection(sample[0]!, sample.at(-1)!);
    const returns = sample.slice(1).map((price, index) => divide(subtract(price, sample[index]!), sample[index]!, 8));
    const mean = divide(decimalSum(returns), decimal(returns.length), 8);
    const deviations = returns.map((value) => subtract(value, mean));
    const squares = deviations.map((value) => multiply(value, value));
    realizedVariance = canonical(divide(decimalSum(squares), decimal(squares.length), 16));
  } else {
    addUnavailable('market.trend', marketFresh ? 'insufficient_history' : market ? 'stale' : 'no_feed');
    addUnavailable('market.realized_variance', marketFresh ? 'insufficient_history' : market ? 'stale' : 'no_feed');
  }
  if (marketFresh && returnFiveTrades === null) blockers.push('insufficient_return_history');
  if (marketFresh && trend === null) blockers.push('insufficient_trend_history');
  if (marketFresh && realizedVariance === null) blockers.push('insufficient_volatility_history');

  const observedVolume = marketFresh && prices.length ? canonical(decimalSum(usableTrades.map((event) => decimal(event.size)))) : null;
  if (marketFresh && !observedVolume) addUnavailable('market.observed_trade_volume', 'insufficient_history');
  else if (!marketFresh) addUnavailable('market.observed_trade_volume', market ? 'stale' : 'no_feed');
  let spread: string | null = null;
  let spreadBps: string | null = null;
  if (marketFresh && market?.quote) {
    const bid = decimal(market.quote.bid);
    const ask = decimal(market.quote.ask);
    if (ask.units * POW10(bid.scale) < bid.units * POW10(ask.scale)) throw new Error('market quote ask is below bid');
    const difference = subtract(ask, bid);
    const midpoint = divide(add(ask, bid), decimal(2), 8);
    spread = canonical(difference);
    spreadBps = canonical(multiply(divide(difference, midpoint, 6), decimal(10_000)));
  } else addUnavailable('market.spread', marketFresh ? market ? 'no_feed' : 'no_feed' : market ? 'stale' : 'no_feed');

  let position: DecisionContext['account']['position'] = null;
  let openOrders: DecisionContext['account']['open_orders'] = null;
  let exposure: AccountState['exposure'] | null = null;
  let equity: string | null = null;
  let cash: string | null = null;
  let buyingPower: string | null = null;
  let reconciledAt: string | null = null;
  let accountFreshness: DecisionContext['account']['freshness'] = 'unavailable';
  let marketSession: DecisionContext['market_session'] = null;
  let realizedPnl: null = null;
  if (account && accountFresh) {
    accountFreshness = 'fresh';
    reconciledAt = account.reconciledAt;
    equity = account.account.equity;
    cash = account.account.cash;
    buyingPower = account.account.buyingPower;
    exposure = structuredClone(account.exposure);
    const found = account.positions.find((item) => item.symbol === parsed.symbol);
    if (found) {
      let unrealized: string | null = null;
      if (found.currentPrice !== null) {
        const signedDelta = found.side === 'long'
          ? subtract(decimal(found.currentPrice), decimal(found.averageEntryPrice))
          : subtract(decimal(found.averageEntryPrice), decimal(found.currentPrice));
        unrealized = canonical(multiply(signedDelta, decimal(found.quantity)));
      } else addUnavailable('account.position.unrealized_pnl', 'unavailable_account_state');
      position = { side: found.side, quantity: found.quantity, average_entry_price: found.averageEntryPrice, current_price: found.currentPrice, market_value: found.marketValue, unrealized_pnl: unrealized };
    }
    openOrders = account.openOrders.filter((order) => order.symbol === parsed.symbol).map((order) => ({ client_order_id: order.clientOrderId, side: order.side, quantity: order.quantity, notional: order.notional, status: order.status }));
    marketSession = { is_open: account.market.isOpen, market: 'US_EQUITIES', next_open: account.market.nextOpen, next_close: account.market.nextClose };
    if (!account.exposure.complete) addUnavailable('account.exposure', 'unavailable_account_state');
    if (!account.exposure.complete) blockers.push('incomplete_exposure');
    if (!account.market.isOpen) { addUnavailable('market_session', 'pre_market'); blockers.push('market_closed'); }
    addUnavailable('account.realized_pnl', 'unsupported');
    realizedPnl = null;
  } else if (account) {
    accountFreshness = 'stale';
    addUnavailable('account.financial_state', 'stale');
    addUnavailable('account.position', 'stale');
    addUnavailable('account.open_orders', 'stale');
    addUnavailable('account.exposure', 'stale');
    addUnavailable('market_session', 'stale');
  } else {
    addUnavailable('account.financial_state', 'unavailable_account_state');
    addUnavailable('account.position', 'unavailable_account_state');
    addUnavailable('account.open_orders', 'unavailable_account_state');
    addUnavailable('account.exposure', 'unavailable_account_state');
    addUnavailable('market_session', 'unavailable_account_state');
  }
  const capabilities = parsed.capabilities;
  if (!capabilities) { addUnavailable('symbol_capabilities', 'unsupported'); blockers.push('symbol_capabilities_unavailable'); }
  else if (!capabilities.tradable) blockers.push('symbol_not_tradable');
  if (!currentPrice) blockers.push('market_price_unavailable');
  if (!parsed.recentCycleState) addUnavailable('recent_cycle_state', 'no_feed');
  const sources: DecisionContext['provenance']['sources'] = [];
  for (const event of symbolEvents) {
    const eventId = event.type === 'trade' ? String(event.id)
      : event.type === 'trade_correction' ? `${event.originalTradeId}->${event.correctedTrade.id}`
        : event.type === 'trade_cancel' ? `${event.tradeId}:${event.action}`
          : `${event.type}:${event.sourceTime}`;
    sources.push({ sequence: sources.length, kind: `market_${event.type}`, source: market?.feed ?? 'unavailable', record_id: eventId, source_time: event.sourceTime, received_at: null });
  }
  if (market) sources.push({ sequence: sources.length, kind: 'market_snapshot', source: market.feed, record_id: `${market.symbol}:${market.sourceEventTime}`, source_time: market.sourceEventTime, received_at: market.receivedAt });
  if (account) sources.push({ sequence: sources.length, kind: 'account_snapshot', source: account.provenance.source, record_id: account.reconciledAt, source_time: account.market.timestamp, received_at: account.reconciledAt });
  if (parsed.capabilityProvenance) sources.push({ sequence: sources.length, kind: 'symbol_capabilities', source: parsed.capabilityProvenance.source, record_id: parsed.capabilityProvenance.recordId, source_time: parsed.capabilityProvenance.sourceTime, received_at: parsed.capabilityProvenance.receivedAt });
  if (parsed.recentCycleState) sources.push({ sequence: sources.length, kind: 'recent_cycle_state', source: 'decision_cycle', record_id: `${parsed.recentCycleState.status}:${parsed.recentCycleState.observedAt}`, source_time: parsed.recentCycleState.observedAt, received_at: parsed.recentCycleState.observedAt });

  unavailable.sort((a, b) => a.path.localeCompare(b.path) || a.reason.localeCompare(b.reason));
  const sourceInput = structuredClone(parsed);
  const inputHash = sha256(canonicalJson(sourceInput));
  const base = {
    cycle_id: parsed.cycleId,
    mode: 'paper' as const,
    symbol: parsed.symbol,
    schema_version: DECISION_CONTEXT_SCHEMA_VERSION,
    built_at: parsed.builtAt,
    as_of: parsed.asOf,
    transform_versions: { context: DECISION_CONTEXT_TRANSFORM_VERSION, arithmetic: 'decimal-half-even-8-v1' },
  };
  const decisionContextId = deterministicUuid(`${parsed.cycleId}:${inputHash}:${base.schema_version}:${DECISION_CONTEXT_TRANSFORM_VERSION}`);
  const context: DecisionContext = {
    decision_context_id: decisionContextId,
    ...base,
    eligible_for_inference: blockers.length === 0,
    blockers: [...new Set(blockers)].sort(),
    market: { feed: market?.feed ?? null, current_price: currentPrice, return_one_trade: returnOneTrade, return_five_trades: returnFiveTrades, trend, realized_variance: realizedVariance, observed_trade_volume: observedVolume, spread, spread_basis_points: spreadBps, data_age_ms: marketAgeMs, freshness: market ? marketFresh ? 'fresh' : 'stale' : 'unavailable' },
    account: { freshness: accountFreshness, reconciled_at: reconciledAt, equity, cash, buying_power: buyingPower, position, open_orders: openOrders, exposure, realized_pnl: realizedPnl },
    market_session: marketSession,
    symbol_capabilities: capabilities,
    recent_cycle_state: parsed.recentCycleState ? { status: parsed.recentCycleState.status, observed_at: parsed.recentCycleState.observedAt } : null,
    unavailable,
    provenance: { input_sha256: inputHash, sources },
  };
  const canonicalText = canonicalJson(context);
  const serializedBytes = Buffer.byteLength(canonicalText, 'utf8');
  if (serializedBytes > MAX_DECISION_CONTEXT_TOKENS) throw new Error('decision context exceeds the 4,000-token conservative byte budget');
  return { context, canonicalJson: canonicalText, contentHash: sha256(canonicalText), estimatedTokens: serializedBytes, tokenEstimateMethod: TOKEN_ESTIMATE_METHOD, sourceInput };
}
