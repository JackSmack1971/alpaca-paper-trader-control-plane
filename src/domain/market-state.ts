import { z } from 'zod';
import { decode as decodeMessagePack } from '@msgpack/msgpack';

const positivePrice = z.number().finite().positive().max(Number.MAX_SAFE_INTEGER);
const positiveSize = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const time = z.string().datetime({ offset: true });
const stockSymbol = z.string().regex(/^[A-Z][A-Z0-9.-]{0,9}$/);
const subscriptionChannels = new Set(['trades', 'quotes', 'bars', 'dailyBars', 'updatedBars', 'corrections', 'cancelErrors', 'lulds', 'statuses', 'imbalances']);

const tradeWire = z.object({
  T: z.literal('t'), S: stockSymbol, i: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  p: positivePrice, s: positiveSize, t: time, x: z.string().min(1),
}).passthrough();
const quoteWire = z.object({
  T: z.literal('q'), S: stockSymbol,
  bp: positivePrice, bs: positiveSize, ap: positivePrice, as: positiveSize, t: time,
}).passthrough();
const tradeCorrectionWire = z.object({
  T: z.literal('c'), S: stockSymbol,
  oi: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), op: positivePrice, os: positiveSize,
  oc: z.array(z.string()).max(20), ci: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  cp: positivePrice, cs: positiveSize, cc: z.array(z.string()).max(20), t: time,
}).passthrough();
const tradeCancelWire = z.object({
  T: z.literal('x'), S: stockSymbol, i: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  x: z.string().min(1), p: positivePrice, s: positiveSize, a: z.enum(['C', 'E']), t: time,
}).passthrough();

export type MarketState = {
  symbol: string;
  feed: string;
  lastTrade: { id?: number; price: number; size: number; sourceTime: string } | null;
  quote: { bid: number; bidSize: number; ask: number; askSize: number; sourceTime: string } | null;
  sourceEventTime: string;
  receivedAt: string;
  freshness: 'fresh' | 'stale';
  staleReason: string | null;
};

export type MarketEvent =
  | { type: 'trade'; symbol: string; id: number; price: number; size: number; sourceTime: string }
  | { type: 'quote'; symbol: string; bid: number; bidSize: number; ask: number; askSize: number; sourceTime: string }
  | { type: 'trade_correction'; symbol: string; originalTradeId: number; correctedTrade: { id: number; price: number; size: number }; sourceTime: string }
  | { type: 'trade_cancel'; symbol: string; tradeId: number; action: 'C' | 'E'; sourceTime: string };

export type MarketControl =
  | { type: 'success'; message: 'connected' | 'authenticated' }
  | { type: 'subscription'; subscriptions: Record<string, string[]> }
  | { type: 'error'; code: number; name: MarketStreamErrorName };

export type MarketStreamErrorName =
  | 'invalid_syntax'
  | 'not_authenticated'
  | 'authentication_failed'
  | 'already_authenticated'
  | 'authentication_timeout'
  | 'symbol_limit_exceeded'
  | 'connection_limit_exceeded'
  | 'slow_client'
  | 'insufficient_subscription'
  | 'invalid_feed_action'
  | 'provider_internal_error'
  | 'provider_stream_error';

const MAX_FRAME_BYTES = 256 * 1024;
const MAX_DATA_MESSAGES = 100;
const MAX_REPLAY_EVENTS = 10_000;
export const MAX_MARKET_STATES = 100;
export const MAX_RECENT_MARKET_EVENT_IDENTITIES = 10_000;
const MAX_SUBSCRIPTION_CHANNELS = 32;
const MAX_SUBSCRIPTION_SYMBOLS = 100;
const MAX_CHANNEL_OR_SYMBOL_LENGTH = 32;

const knownStreamErrors: Record<number, Exclude<MarketStreamErrorName, 'provider_stream_error'>> = {
  400: 'invalid_syntax',
  401: 'not_authenticated',
  402: 'authentication_failed',
  403: 'already_authenticated',
  404: 'authentication_timeout',
  405: 'symbol_limit_exceeded',
  406: 'connection_limit_exceeded',
  407: 'slow_client',
  409: 'insufficient_subscription',
  410: 'invalid_feed_action',
  500: 'provider_internal_error',
};

export class MarketFrameError extends Error {
  constructor(readonly code: 'malformed_json' | 'malformed_msgpack' | 'unsupported_codec' | 'invalid_frame' | 'invalid_frame_depth' | 'mixed_control_data' | 'invalid_control' | 'frame_too_large' | 'too_many_messages', message: string) {
    super(message);
    this.name = 'MarketFrameError';
  }
}

/** Decode one bounded Alpaca JSON or MessagePack WebSocket frame without coupling controls to market events. */
export function decodeMarketFrame(input: string | Uint8Array, codec: 'json' | 'msgpack' = 'json'): { events: MarketEvent[]; controls: MarketControl[] } {
  if (codec !== 'json' && codec !== 'msgpack') throw new MarketFrameError('unsupported_codec', 'unsupported market frame codec');
  if (typeof input === 'string' && codec !== 'json') throw new MarketFrameError('unsupported_codec', 'MessagePack market frames must be binary');
  const frameBytes = typeof input === 'string' ? new TextEncoder().encode(input).byteLength : input.byteLength;
  if (frameBytes > MAX_FRAME_BYTES) throw new MarketFrameError('frame_too_large', 'market frame exceeds the 256 KiB application limit');
  let frame: unknown;
  if (codec === 'json') {
    try { frame = JSON.parse(typeof input === 'string' ? input : new TextDecoder('utf-8', { fatal: true }).decode(input)); }
    catch { throw new MarketFrameError('malformed_json', 'market frame is not valid UTF-8 JSON'); }
  } else {
    if (typeof input === 'string') throw new MarketFrameError('unsupported_codec', 'MessagePack market frames must be binary');
    try {
      frame = decodeMessagePack(input, { maxStrLength: 4096, maxBinLength: 1024, maxArrayLength: 256, maxMapLength: 64, maxExtLength: 0 });
    } catch { throw new MarketFrameError('malformed_msgpack', 'market frame is not valid bounded MessagePack'); }
    if (hasExcessiveFrameDepth(frame)) throw new MarketFrameError('invalid_frame_depth', 'market frame exceeds the application nesting limit');
  }
  if (!Array.isArray(frame) || frame.length === 0) throw new MarketFrameError('invalid_frame', 'market frame must be a non-empty array');
  const controls = frame.filter((item) => item !== null && typeof item === 'object' && ['success', 'subscription', 'error'].includes(String((item as { T?: unknown }).T)));
  if (controls.length && (controls.length !== 1 || frame.length !== 1)) throw new MarketFrameError('mixed_control_data', 'control messages must be singleton frames');
  if (controls.length) {
    const control = z.record(z.string(), z.unknown()).parse(controls[0]);
    if (control.T === 'success' && (control.msg === 'connected' || control.msg === 'authenticated')) return { events: [], controls: [{ type: 'success', message: control.msg }] };
    if (control.T === 'subscription') {
      const entries = Object.entries(control).filter(([key]) => key !== 'T');
      if (entries.length > MAX_SUBSCRIPTION_CHANNELS || entries.some(([channel, value]) =>
        !subscriptionChannels.has(channel) || channel.length > MAX_CHANNEL_OR_SYMBOL_LENGTH ||
        !Array.isArray(value) || value.length > MAX_SUBSCRIPTION_SYMBOLS ||
        value.some((symbol) => typeof symbol !== 'string' || symbol.length === 0 || symbol.length > MAX_CHANNEL_OR_SYMBOL_LENGTH ||
          (symbol !== '*' && !/^[A-Z][A-Z0-9.-]{0,9}$/.test(symbol))))) {
        throw new MarketFrameError('invalid_control', 'subscription control exceeds application limits or has invalid lists');
      }
      return { events: [], controls: [{ type: 'subscription', subscriptions: Object.fromEntries(entries) as Record<string, string[]> }] };
    }
    if (control.T === 'error' && typeof control.code === 'number' && Number.isSafeInteger(control.code) && control.code >= 400 && control.code <= 599) {
      return { events: [], controls: [{ type: 'error', code: control.code, name: knownStreamErrors[control.code] ?? 'provider_stream_error' }] };
    }
    throw new MarketFrameError('invalid_control', 'unsupported or malformed market control message');
  }
  if (frame.length > MAX_DATA_MESSAGES) throw new MarketFrameError('too_many_messages', 'market frame exceeds the 100 message application limit');
  try { return { events: parseMarketBatch(frame), controls: [] }; }
  catch { throw new MarketFrameError('invalid_frame', 'invalid market data frame'); }
}

function hasExcessiveFrameDepth(root: unknown): boolean {
  const pending: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }];
  while (pending.length) {
    const current = pending.pop()!;
    if (current.depth > 16) return true;
    if (Array.isArray(current.value)) {
      for (const value of current.value) pending.push({ value, depth: current.depth + 1 });
    } else if (current.value !== null && typeof current.value === 'object') {
      for (const value of Object.values(current.value)) pending.push({ value, depth: current.depth + 1 });
    }
  }
  return false;
}

export function parseMarketBatch(input: unknown): MarketEvent[] {
  if (!Array.isArray(input)) throw new Error('invalid market data batch');
  if (input.length > MAX_DATA_MESSAGES) throw new Error('market data batch exceeds the 100 message application limit');
  return parseMarketBatchChunk(input, new Set<string>(), new Map<string, number>());
}

function parseMarketBatchChunk(batch: unknown[], identities: Set<string>, watermarks: Map<string, number>): MarketEvent[] {
  return batch.map((raw): MarketEvent => {
    const header = z.object({ T: z.string() }).passthrough().safeParse(raw);
    if (!header.success) throw new Error('invalid market event');
    const discriminator = header.data.T;
    let event: MarketEvent;
    if (discriminator === 't') {
      const parsed = tradeWire.safeParse(raw);
      if (!parsed.success) throw new Error('invalid market trade');
      const e = parsed.data;
      event = { type: 'trade', symbol: e.S, id: e.i, price: e.p, size: e.s, sourceTime: e.t };
    } else if (discriminator === 'q') {
      const parsed = quoteWire.safeParse(raw);
      if (!parsed.success) throw new Error('invalid market quote');
      const e = parsed.data;
      event = { type: 'quote', symbol: e.S, bid: e.bp, bidSize: e.bs, ask: e.ap, askSize: e.as, sourceTime: e.t };
    } else if (discriminator === 'c') {
      const parsed = tradeCorrectionWire.safeParse(raw);
      if (!parsed.success) throw new Error('invalid market trade correction');
      const e = parsed.data;
      event = { type: 'trade_correction', symbol: e.S, originalTradeId: e.oi, correctedTrade: { id: e.ci, price: e.cp, size: e.cs }, sourceTime: e.t };
    } else if (discriminator === 'x') {
      const parsed = tradeCancelWire.safeParse(raw);
      if (!parsed.success) throw new Error('invalid market trade cancel');
      const e = parsed.data;
      event = { type: 'trade_cancel', symbol: e.S, tradeId: e.i, action: e.a, sourceTime: e.t };
    } else {
      throw new Error('unsupported market event type');
    }
    const identity = marketEventIdentity(event);
    if (identities.has(identity)) throw new Error('duplicate market event');
    const sourceTime = Date.parse(event.sourceTime);
    if (sourceTime < (watermarks.get(event.symbol) ?? Number.NEGATIVE_INFINITY)) {
      throw new Error('out-of-order market event');
    }
    identities.add(identity);
    watermarks.set(event.symbol, sourceTime);
    return event;
  });
}

function marketEventIdentity(event: MarketEvent): string {
  switch (event.type) {
    case 'trade': return `trade:${event.symbol}:${event.id}`;
    case 'quote': return `quote:${event.symbol}:${event.sourceTime}:${event.bid}:${event.bidSize}:${event.ask}:${event.askSize}`;
    case 'trade_correction': return `correction:${event.symbol}:${event.originalTradeId}:${event.correctedTrade.id}`;
    case 'trade_cancel': return `cancel:${event.symbol}:${event.tradeId}:${event.action}:${event.sourceTime}`;
  }
}

function applyMarketEvent(previous: MarketState | undefined, event: MarketEvent, feed: string, receivedAt: string): MarketState {
  let lastTrade = previous?.lastTrade ?? null;
  let quote = previous?.quote ?? null;
  if (event.type === 'trade') lastTrade = { id: event.id, price: event.price, size: event.size, sourceTime: event.sourceTime };
  else if (event.type === 'quote') quote = { bid: event.bid, bidSize: event.bidSize, ask: event.ask, askSize: event.askSize, sourceTime: event.sourceTime };
  else if (event.type === 'trade_correction' && lastTrade?.id === event.originalTradeId) {
    lastTrade = { id: event.correctedTrade.id, price: event.correctedTrade.price, size: event.correctedTrade.size, sourceTime: event.sourceTime };
  } else if (event.type === 'trade_cancel' && event.action === 'C' && lastTrade?.id === event.tradeId) lastTrade = null;
  return { symbol: event.symbol, feed, lastTrade, quote, sourceEventTime: event.sourceTime, receivedAt, freshness: 'fresh', staleReason: null };
}

function parseMarketSequence(events: unknown[]): MarketEvent[] {
  const identities = new Set<string>();
  const watermarks = new Map<string, number>();
  const parsed: MarketEvent[] = [];
  for (let offset = 0; offset < events.length; offset += MAX_DATA_MESSAGES) {
    parsed.push(...parseMarketBatchChunk(events.slice(offset, offset + MAX_DATA_MESSAGES), identities, watermarks));
  }
  return parsed;
}

export type ReplayFixture = { feed: string; events: unknown[] };

/** Deterministic offline replay. Clock injection controls receive time and freshness. */
export class MarketReplay {
  private cursor = 0;
  private readonly states = new Map<string, MarketState>();
  private readonly seenEvents = new Set<string>();
  private readonly fixture: ReplayFixture;

  constructor(
    fixture: ReplayFixture,
    private readonly clock: () => Date,
    private readonly staleAfterMs = 30_000,
  ) {
    if (!fixture.feed || !Number.isFinite(staleAfterMs) || staleAfterMs < 0 || !Array.isArray(fixture.events) || fixture.events.length > MAX_REPLAY_EVENTS) throw new Error('invalid replay options');
    this.fixture = { feed: fixture.feed, events: structuredClone(fixture.events) };
  }

  step(): MarketState | null {
    if (this.cursor >= this.fixture.events.length) return null;
    const raw = this.fixture.events[this.cursor];
    const event = parseMarketBatch([raw])[0];
    if (!event) throw new Error('market event batch unexpectedly empty');
    const key = marketEventIdentity(event);
    if (this.seenEvents.has(key)) throw new Error('duplicate market event');
    const previous = this.states.get(event.symbol);
    if (previous && Date.parse(event.sourceTime) < Date.parse(previous.sourceEventTime)) {
      throw new Error('out-of-order market event');
    }
    if (!previous && this.states.size >= MAX_MARKET_STATES) throw new Error('market replay exceeds the 100 symbol state limit');
    const receivedAt = this.clock();
    if (!Number.isFinite(receivedAt.getTime())) throw new Error('clock returned an invalid date');
    const state = applyMarketEvent(previous, event, this.fixture.feed, receivedAt.toISOString());
    this.cursor += 1;
    this.seenEvents.add(key);
    this.states.set(event.symbol, state);
    return state;
  }

  snapshot(): MarketState[] {
    const now = this.clock().getTime();
    return [...this.states.values()].sort((a, b) => a.symbol.localeCompare(b.symbol)).map((state) => {
      const stale = now - Date.parse(state.receivedAt) > this.staleAfterMs;
      return { ...state, freshness: stale ? 'stale' : 'fresh', staleReason: stale ? 'receive_age_exceeded' : null };
    });
  }

  restore(cursor: number, states: MarketState[]): void {
    if (!Number.isInteger(cursor) || cursor < 0 || cursor > this.fixture.events.length || !Array.isArray(states) || states.length > MAX_REPLAY_EVENTS) throw new Error('invalid replay cursor');
    const bySymbol = new Map<string, MarketState>();
    for (const state of states) {
      if (bySymbol.has(state.symbol) || !state.symbol || !Number.isFinite(Date.parse(state.receivedAt)) || !Number.isFinite(Date.parse(state.sourceEventTime))) throw new Error('invalid persisted market state');
      bySymbol.set(state.symbol, { ...state });
    }
    const events = parseMarketSequence(this.fixture.events.slice(0, cursor));
    const expected = new Map<string, MarketState>();
    for (const event of events) {
      expected.set(event.symbol, applyMarketEvent(expected.get(event.symbol), event, this.fixture.feed, event.sourceTime));
    }
    if (bySymbol.size !== expected.size) throw new Error('persisted market state does not match replay cursor');
    for (const [symbol, expectedState] of expected) {
      const actual = bySymbol.get(symbol);
      const actualTrade = actual?.lastTrade;
      const expectedTrade = expectedState.lastTrade;
      const tradeMatches = actualTrade === null && expectedTrade === null || Boolean(actualTrade && expectedTrade && actualTrade.price === expectedTrade.price && actualTrade.size === expectedTrade.size && actualTrade.sourceTime === expectedTrade.sourceTime && (actualTrade.id === undefined || actualTrade.id === expectedTrade.id));
      if (!actual || actual.feed !== expectedState.feed || actual.sourceEventTime !== expectedState.sourceEventTime ||
        !tradeMatches || JSON.stringify(actual.quote) !== JSON.stringify(expectedState.quote)) {
        throw new Error('persisted market state does not match replay cursor');
      }
      if (actualTrade && expectedTrade && actualTrade.id === undefined && expectedTrade.id !== undefined) {
        bySymbol.set(symbol, { ...actual, lastTrade: { ...actualTrade, id: expectedTrade.id } });
      }
    }
    this.cursor = cursor;
    this.states.clear();
    for (const [symbol, state] of bySymbol) this.states.set(symbol, state);
    this.seenEvents.clear();
    for (const event of events) this.seenEvents.add(marketEventIdentity(event));
  }

  get position(): number { return this.cursor; }
}

/** Bounded application-owned state accumulator for normalized live stream events. */
export class MarketStateAccumulator {
  private readonly states = new Map<string, MarketState>();
  private readonly identities = new Set<string>();
  private readonly identityOrder: string[] = [];

  constructor(private readonly feed: string, private readonly staleAfterMs = 30_000) {
    if (!feed || !Number.isFinite(staleAfterMs) || staleAfterMs < 0) throw new Error('invalid market state accumulator options');
  }

  applyBatch(events: MarketEvent[], receivedAt: string): MarketState[] {
    const receiveTime = Date.parse(receivedAt);
    if (!Array.isArray(events) || events.length > MAX_DATA_MESSAGES || !Number.isFinite(receiveTime)) throw new Error('invalid normalized market batch');
    const stagedIdentities = new Set<string>();
    const watermarks = new Map([...this.states].map(([symbol, state]) => [symbol, Date.parse(state.sourceEventTime)]));
    const staged = events.map((event) => {
      const key = marketEventIdentity(event);
      const sourceTime = Date.parse(event.sourceTime);
      if (!Number.isFinite(sourceTime) || this.identities.has(key) || stagedIdentities.has(key) || sourceTime < (watermarks.get(event.symbol) ?? Number.NEGATIVE_INFINITY)) {
        throw new Error('duplicate or out-of-order market event');
      }
      stagedIdentities.add(key);
      watermarks.set(event.symbol, sourceTime);
      return { event, key };
    });
    const newSymbols = new Set(staged.map(({ event }) => event.symbol).filter((symbol) => !this.states.has(symbol)));
    if (this.states.size + newSymbols.size > MAX_MARKET_STATES) throw new Error('market state exceeds the 100 symbol limit');

    for (const { event, key } of staged) {
      const previous = this.states.get(event.symbol);
      const state = applyMarketEvent(previous, event, this.feed, new Date(receiveTime).toISOString());
      this.states.set(event.symbol, state);
      this.identities.add(key);
      this.identityOrder.push(key);
      if (this.identityOrder.length > MAX_RECENT_MARKET_EVENT_IDENTITIES) this.identities.delete(this.identityOrder.shift()!);
    }
    return this.snapshot(receivedAt);
  }

  reset(): void {
    this.states.clear();
    this.identities.clear();
    this.identityOrder.length = 0;
  }

  /** Restore a bounded replay prefix after the harness has independently checked its persisted state. */
  restoreReplay(events: unknown[], states: MarketState[]): void {
    if (!Array.isArray(events) || events.length > MAX_REPLAY_EVENTS || !Array.isArray(states) || states.length > MAX_MARKET_STATES) throw new Error('invalid persisted market replay');
    const parsed = parseMarketSequence(events);
    const expected = new Map<string, MarketState>();
    for (const event of parsed) expected.set(event.symbol, applyMarketEvent(expected.get(event.symbol), event, this.feed, event.sourceTime));
    const restored = new Map<string, MarketState>();
    for (const state of states) {
      if (restored.has(state.symbol) || state.feed !== this.feed || !Number.isFinite(Date.parse(state.receivedAt)) || !Number.isFinite(Date.parse(state.sourceEventTime)) || !['fresh', 'stale'].includes(state.freshness)) throw new Error('invalid persisted market state');
      const baseline = expected.get(state.symbol);
      if (!baseline || baseline.sourceEventTime !== state.sourceEventTime || JSON.stringify(baseline.lastTrade) !== JSON.stringify(state.lastTrade) || JSON.stringify(baseline.quote) !== JSON.stringify(state.quote)) {
        throw new Error('persisted market state does not match replay events');
      }
      restored.set(state.symbol, structuredClone(state));
    }
    if (restored.size !== expected.size) throw new Error('persisted market state does not match replay events');
    this.reset();
    for (const [symbol, state] of restored) this.states.set(symbol, state);
    for (const event of parsed) {
      const key = marketEventIdentity(event);
      this.identities.add(key);
      this.identityOrder.push(key);
    }
  }

  snapshot(now: string): MarketState[] {
    const nowTime = Date.parse(now);
    if (!Number.isFinite(nowTime)) throw new Error('invalid market snapshot time');
    return [...this.states.values()].sort((a, b) => a.symbol.localeCompare(b.symbol)).map((state) => {
      const stale = nowTime - Date.parse(state.receivedAt) > this.staleAfterMs;
      return { ...state, freshness: stale ? 'stale' : 'fresh', staleReason: stale ? 'receive_age_exceeded' : null };
    });
  }
}
