import { readFile } from 'node:fs/promises';
import { encode } from '@msgpack/msgpack';
import { describe, expect, it } from 'vitest';
import { decodeMarketFrame, MarketFrameError, MarketReplay, MarketStateAccumulator, parseMarketBatch } from '../src/domain/market-state.js';

const fixture = JSON.parse(await readFile(new URL('../fixtures/market/replay-sample.json', import.meta.url), 'utf8'));
const msgpackFixtures = Object.fromEntries(await Promise.all(['batch', 'connected', 'subscription', 'error'].map(async (name) => [
  name,
  new Uint8Array(await readFile(new URL(`../fixtures/market/msgpack/${name}.bin`, import.meta.url))),
])));

function captureError(run: () => unknown): unknown {
  try { run(); }
  catch (error) { return error; }
  throw new Error('expected operation to throw');
}

describe('normalized market replay', () => {
  it('accumulates normalized live events atomically with freshness and duplicate ordering checks', () => {
    const accumulator = new MarketStateAccumulator('iex', 30_000);
    const trade = { type: 'trade' as const, symbol: 'AAPL', id: 11, price: 190, size: 2, sourceTime: '2025-01-02T14:30:00.000Z' };
    const quote = { type: 'quote' as const, symbol: 'AAPL', bid: 189.9, bidSize: 3, ask: 190.1, askSize: 4, sourceTime: '2025-01-02T14:30:00.100Z' };
    const state = accumulator.applyBatch([trade, quote], '2025-01-02T14:30:01.000Z');
    expect(state).toEqual([expect.objectContaining({ symbol: 'AAPL', feed: 'iex', freshness: 'fresh', lastTrade: { id: 11, price: 190, size: 2, sourceTime: trade.sourceTime }, quote: { bid: 189.9, bidSize: 3, ask: 190.1, askSize: 4, sourceTime: quote.sourceTime } })]);
    expect(() => accumulator.applyBatch([{ ...trade, id: 12 }, { ...quote, sourceTime: '2025-01-02T14:29:59.000Z' }], '2025-01-02T14:30:02.000Z')).toThrow(/duplicate or out-of-order/);
    expect(accumulator.snapshot('2025-01-02T14:30:01.000Z')).toEqual(state);
    expect(accumulator.snapshot('2025-01-02T14:30:32.000Z')[0]).toMatchObject({ freshness: 'stale', staleReason: 'receive_age_exceeded' });
  });

  it('normalizes batched Alpaca trade and quote frames without retaining wire fields', () => {
    const events = parseMarketBatch(fixture.events.slice(0, 2));
    expect(events.map(({ type }) => type)).toEqual(['trade', 'quote']);
    expect(events[0]!).toEqual({ type: 'trade', symbol: 'AAPL', id: 1, price: 190.25, size: 2, sourceTime: '2025-01-02T14:30:00.000Z' });
    expect('T' in events[0]!).toBe(false);
  });

  it('preserves structurally valid crossed quotes and suppresses unsupported provider discriminators', () => {
    const quote = fixture.events[1] as Record<string, unknown>;
    expect(parseMarketBatch([{ ...quote, bp: 190.4, ap: 190.3 }])).toEqual([{
      type: 'quote', symbol: 'AAPL', bid: 190.4, bidSize: 10, ask: 190.3, askSize: 12,
      sourceTime: '2025-01-02T14:30:01.000Z',
    }]);

    const error = captureError(() => parseMarketBatch([{ T: 'credential=provider-secret' }]));
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('unsupported market event type');
    expect((error as Error).message).not.toContain('credential=provider-secret');

    const duplicateError = captureError(() => parseMarketBatch([quote, quote])) as Error;
    expect(duplicateError.message).toBe('duplicate market event');
    expect(duplicateError.message).not.toContain('AAPL');
    expect(duplicateError.message).not.toContain('190.3');

    const olderQuote = { ...quote, t: '2025-01-02T14:30:00.000Z' };
    const orderingError = captureError(() => parseMarketBatch([quote, olderQuote])) as Error;
    expect(orderingError.message).toBe('out-of-order market event');
    expect(orderingError.message).not.toContain('AAPL');

    const malformedError = captureError(() => parseMarketBatch([{ T: 't', S: 'credential=provider-secret', i: 1, p: -1, s: 1, t: 'bad', x: 'D' }])) as Error;
    expect(malformedError.message).toBe('invalid market trade');
    expect(malformedError.message).not.toContain('credential=provider-secret');
  });

  it('bounds direct batches while restoring larger bounded fixtures in chunks', () => {
    const oversizedBatch = Array.from({ length: 101 }, (_, index) => ({
      T: 't', S: 'AAPL', i: index + 1, p: 190, s: 1,
      t: new Date(Date.parse('2025-01-02T14:30:00.000Z') + index * 1_000).toISOString(), x: 'D',
    }));
    const batchError = captureError(() => parseMarketBatch(oversizedBatch)) as Error;
    expect(batchError.message).toBe('market data batch exceeds the 100 message application limit');

    const replay = new MarketReplay({ feed: 'test', events: oversizedBatch }, () => new Date('2025-01-02T15:00:00.000Z'));
    for (let index = 0; index < oversizedBatch.length; index += 1) replay.step();
    const restored = new MarketReplay({ feed: 'test', events: oversizedBatch }, () => new Date('2025-01-02T15:00:00.000Z'));
    restored.restore(oversizedBatch.length, replay.snapshot());
    expect(restored.position).toBe(oversizedBatch.length);

    expect(() => new MarketReplay({ feed: 'test', events: Array.from({ length: 10_001 }, () => fixture.events[0]) }, () => new Date())).toThrow(/invalid replay options/);
  });

  it('keeps replay snapshots within the persistence symbol bound', () => {
    const events = Array.from({ length: 101 }, (_, index) => ({
      T: 't', S: `A${index}`, i: 1, p: 100, s: 1,
      t: new Date(Date.parse('2025-01-02T14:30:00.000Z') + index * 1_000).toISOString(), x: 'D',
    }));
    const replay = new MarketReplay({ feed: 'test', events }, () => new Date('2025-01-02T15:00:00.000Z'));
    for (let index = 0; index < 100; index += 1) replay.step();
    expect(replay.snapshot()).toHaveLength(100);
    expect(() => replay.step()).toThrow('market replay exceeds the 100 symbol state limit');
    expect(replay.position).toBe(100);
    expect(replay.snapshot()).toHaveLength(100);
  });

  it('replays with an injected clock, merges snapshots, and marks stale data deterministically', () => {
    let now = new Date('2025-01-02T14:30:10.000Z');
    const replay = new MarketReplay(fixture, () => now, 5_000);
    const trade = replay.step();
    expect(trade).toMatchObject({ symbol: 'AAPL', feed: 'test', freshness: 'fresh', lastTrade: { price: 190.25 } });
    const quote = replay.step();
    expect(quote).toMatchObject({ lastTrade: { price: 190.25 }, quote: { bid: 190.2, ask: 190.3 } });
    expect(replay.step()).toMatchObject({ lastTrade: { price: 190.4 }, quote: { bid: 190.2 } });
    expect(replay.step()).toBeNull();
    now = new Date('2025-01-02T14:30:16.000Z');
    expect(replay.snapshot()[0]).toMatchObject({ freshness: 'stale', staleReason: 'receive_age_exceeded' });
  });

  it('isolates replay events from later caller mutations', () => {
    const callerFixture = { feed: 'test', events: structuredClone(fixture.events.slice(0, 2)) as unknown[] };
    const replay = new MarketReplay(callerFixture, () => new Date('2025-01-02T14:30:10.000Z'));
    (callerFixture.events[0] as Record<string, unknown>).p = 999;
    callerFixture.events.push(fixture.events[2]);
    expect(replay.step()).toMatchObject({ lastTrade: { price: 190.25 } });
    replay.step();
    expect(replay.position).toBe(2);
    expect(replay.step()).toBeNull();
  });

  it('fails malformed, duplicate, and out-of-order data without advancing replay position', () => {
    expect(() => parseMarketBatch([{ T: 't', S: 'AAPL', i: 1, p: -1, s: 1, t: 'bad', x: 'D' }])).toThrow();
    const duplicate = new MarketReplay({ feed: 'test', events: [fixture.events[0], fixture.events[0]] }, () => new Date());
    duplicate.step();
    expect(() => duplicate.step()).toThrow(/duplicate/);
    expect(duplicate.position).toBe(1);
    const outOfOrder = new MarketReplay({ feed: 'test', events: [fixture.events[1], fixture.events[0]] }, () => new Date());
    outOfOrder.step();
    expect(() => outOfOrder.step()).toThrow(/out-of-order/);
    expect(outOfOrder.position).toBe(1);
    expect(() => parseMarketBatch([fixture.events[1], fixture.events[1]])).toThrow(/duplicate/);
    expect(() => parseMarketBatch([fixture.events[1], fixture.events[0]])).toThrow(/out-of-order/);
    const duplicateQuote = new MarketReplay({ feed: 'test', events: [fixture.events[1], fixture.events[1]] }, () => new Date());
    duplicateQuote.step();
    expect(() => duplicateQuote.step()).toThrow(/duplicate/);
    expect(duplicateQuote.position).toBe(1);
  });

  it('normalizes automatic trade corrections and cancellations and updates the current last trade', () => {
    const rawTrade = { T: 't', S: 'AAPL', i: 17, p: 190, s: 2, t: '2025-01-02T14:30:00.000Z', x: 'D' };
    const correction = { T: 'c', S: 'AAPL', oi: 17, op: 190, os: 2, oc: [], ci: 18, cp: 190.2, cs: 3, cc: [], t: '2025-01-02T14:30:00.100Z', x: 'D' };
    const cancel = { T: 'x', S: 'AAPL', i: 18, x: 'D', p: 190.2, s: 3, a: 'C', t: '2025-01-02T14:30:00.200Z' };
    const events = parseMarketBatch([rawTrade, correction, cancel]);
    expect(events[1]).toEqual({ type: 'trade_correction', symbol: 'AAPL', originalTradeId: 17, correctedTrade: { id: 18, price: 190.2, size: 3 }, sourceTime: correction.t });
    const replay = new MarketReplay({ feed: 'iex', events: [rawTrade, correction, cancel] }, () => new Date('2025-01-02T14:30:01.000Z'));
    expect(replay.step()?.lastTrade).toMatchObject({ id: 17, price: 190 });
    expect(replay.step()?.lastTrade).toMatchObject({ id: 18, price: 190.2, size: 3 });
    expect(replay.step()?.lastTrade).toBeNull();
    const laterTrade = { ...rawTrade, i: 18, p: 190.3, t: '2025-01-02T14:30:00.100Z' };
    const errorMessage = { ...cancel, i: 18, a: 'E', t: '2025-01-02T14:30:00.300Z' };
    const errorReplay = new MarketReplay({ feed: 'iex', events: [rawTrade, laterTrade, errorMessage] }, () => new Date('2025-01-02T14:30:01.000Z'));
    errorReplay.step();
    errorReplay.step();
    expect(errorReplay.step()?.lastTrade).toBeNull();
  });
});

describe('Alpaca JSON market frames', () => {
  it('decodes UTF-8 JSON bytes and batched data through the normalized batch parser', () => {
    const decoded = decodeMarketFrame(new TextEncoder().encode(JSON.stringify(fixture.events.slice(0, 2))));
    expect(decoded.controls).toEqual([]);
    expect(decoded.events).toEqual(parseMarketBatch(fixture.events.slice(0, 2)));
  });

  it('keeps success and subscription controls separate from market data', () => {
    expect(decodeMarketFrame('[{"T":"success","msg":"authenticated"}]')).toEqual({ events: [], controls: [{ type: 'success', message: 'authenticated' }] });
    expect(decodeMarketFrame('[{"T":"subscription","trades":["AAPL"],"quotes":[]}]')).toEqual({ events: [], controls: [{ type: 'subscription', subscriptions: { trades: ['AAPL'], quotes: [] } }] });
  });

  it('preserves documented error codes as application-owned names and suppresses provider text', () => {
    const errors = [
      [400, 'invalid_syntax'],
      [401, 'not_authenticated'],
      [402, 'authentication_failed'],
      [403, 'already_authenticated'],
      [404, 'authentication_timeout'],
      [405, 'symbol_limit_exceeded'],
      [406, 'connection_limit_exceeded'],
      [407, 'slow_client'],
      [409, 'insufficient_subscription'],
      [410, 'invalid_feed_action'],
      [500, 'provider_internal_error'],
      [450, 'provider_stream_error'],
    ];
    for (const [code, name] of errors) {
      const decoded = decodeMarketFrame(JSON.stringify([{ T: 'error', code, msg: 'token=private password: secret-value' }]));
      expect(decoded.controls[0]).toEqual({ type: 'error', code, name });
      expect(JSON.stringify(decoded)).not.toMatch(/private|secret-value|token=/i);
    }
  });

  it('rejects error codes outside the safe integer 400–599 range', () => {
    for (const code of [399, 600, 405.5, Number.MAX_SAFE_INTEGER + 1, '405', null]) {
      expect(captureError(() => decodeMarketFrame(JSON.stringify([{ T: 'error', code, msg: 'credential=hidden' }])))).toMatchObject({ name: 'MarketFrameError', code: 'invalid_control' });
    }
  });

  it('accepts frames at the byte and message limits and rejects limit plus one', () => {
    const oneEvent = fixture.events[0] as Record<string, unknown>;
    const baseFrame = JSON.stringify([{ ...oneEvent, padding: '' }]);
    const exactFrame = JSON.stringify([{ ...oneEvent, padding: 'a'.repeat(256 * 1024 - new TextEncoder().encode(baseFrame).byteLength) }]);
    expect(new TextEncoder().encode(exactFrame).byteLength).toBe(256 * 1024);
    expect(decodeMarketFrame(exactFrame).events).toHaveLength(1);
    expect(captureError(() => decodeMarketFrame(`${exactFrame} `))).toMatchObject({ name: 'MarketFrameError', code: 'frame_too_large' });
    expect(captureError(() => decodeMarketFrame(' '.repeat(256 * 1024 + 1)))).toMatchObject({ name: 'MarketFrameError', code: 'frame_too_large' });
    expect(captureError(() => decodeMarketFrame('€'.repeat(87_382)))).toMatchObject({ name: 'MarketFrameError', code: 'frame_too_large' });

    const atMessageLimit = Array.from({ length: 100 }, (_, id) => ({ ...oneEvent, i: id + 1 }));
    expect(decodeMarketFrame(JSON.stringify(atMessageLimit)).events).toHaveLength(100);
    expect(captureError(() => decodeMarketFrame(JSON.stringify([...atMessageLimit, { ...oneEvent, i: 101 }])))).toMatchObject({ name: 'MarketFrameError', code: 'too_many_messages' });
  });

  it('accepts documented subscription channels and bounds validated symbol lists', () => {
    const channels = Object.fromEntries(['trades', 'quotes', 'bars', 'dailyBars', 'updatedBars', 'corrections', 'cancelErrors', 'lulds', 'statuses', 'imbalances'].map((channel) => [channel, ['AAPL', '*']]));
    expect(decodeMarketFrame(JSON.stringify([{ T: 'subscription', ...channels }])).controls).toHaveLength(1);
    expect(decodeMarketFrame(JSON.stringify([{ T: 'subscription', trades: Array.from({ length: 100 }, () => 'AAPL') }])).controls).toHaveLength(1);

    const invalidSubscriptions = [
      { 'secret=private': ['AAPL'] },
      { trades: Array.from({ length: 101 }, () => 'AAPL') },
      { ['c'.repeat(33)]: [] },
      { trades: ['S'.repeat(33)] },
      { trades: ['token=private'] },
      { 'token=private': [] },
      { trades: ['aapl'] },
    ];
    for (const control of invalidSubscriptions) {
      expect(captureError(() => decodeMarketFrame(JSON.stringify([{ T: 'subscription', ...control }])))).toMatchObject({ name: 'MarketFrameError', code: 'invalid_control' });
    }
  });

  it('rejects unsafe IDs, non-integer or unsafe sizes, and extreme prices', () => {
    const trade = fixture.events[0] as Record<string, unknown>;
    const quote = fixture.events[1] as Record<string, unknown>;
    for (const event of [
      { ...trade, i: Number.MAX_SAFE_INTEGER + 1 },
      { ...trade, s: 1.5 },
      { ...trade, s: Number.MAX_SAFE_INTEGER + 1 },
      { ...trade, p: Number.MAX_SAFE_INTEGER + 1 },
      { ...trade, p: 1e308 },
      { ...quote, bs: 1.5 },
      { ...quote, as: Number.MAX_SAFE_INTEGER + 1 },
      { ...quote, ap: Number.MAX_SAFE_INTEGER + 1 },
    ]) {
      expect(() => parseMarketBatch([event])).toThrow();
    }
    expect(parseMarketBatch([{ ...trade, p: Number.MAX_SAFE_INTEGER, s: Number.MAX_SAFE_INTEGER, i: Number.MAX_SAFE_INTEGER }])).toHaveLength(1);
  });

  it('rejects malformed JSON, unsupported codecs, mixed controls, and malformed control shapes explicitly', () => {
    const failure = (input: string | Uint8Array, codec?: 'json' | 'msgpack') => {
      try { decodeMarketFrame(input, codec); throw new Error('expected frame rejection'); }
      catch (error) { return error; }
    };
    expect(failure('{')).toMatchObject({ name: 'MarketFrameError', code: 'malformed_json' });
    expect(failure(new Uint8Array([0xc3, 0x28]))).toMatchObject({ name: 'MarketFrameError', code: 'malformed_json' });
    expect(failure(new Uint8Array([0xc1]), 'msgpack')).toMatchObject({ name: 'MarketFrameError', code: 'malformed_msgpack' });
    expect(captureError(() => decodeMarketFrame('[]', 'credential=hidden' as 'json'))).toMatchObject({ code: 'unsupported_codec', message: 'unsupported market frame codec' });
    expect(failure(JSON.stringify([{ T: 'success', msg: 'connected' }, fixture.events[0]]))).toMatchObject({ name: 'MarketFrameError', code: 'mixed_control_data' });
    expect(failure('[{"T":"success","msg":"unexpected"}]')).toBeInstanceOf(MarketFrameError);
    expect(failure('[{"T":"subscription","trades":"AAPL"}]')).toMatchObject({ name: 'MarketFrameError', code: 'invalid_control' });
  });
});

describe('Alpaca MessagePack market frames', () => {
  it('normalizes binary batched events identically to equivalent JSON frames', () => {
    const wire = fixture.events.slice(0, 2);
    expect(decodeMarketFrame(msgpackFixtures.batch!, 'msgpack')).toEqual(decodeMarketFrame(JSON.stringify(wire)));
  });

  it('decodes singleton success, subscription, and redacted error controls', () => {
    expect(decodeMarketFrame(msgpackFixtures.connected!, 'msgpack').controls)
      .toEqual([{ type: 'success', message: 'connected' }]);
    expect(decodeMarketFrame(msgpackFixtures.subscription!, 'msgpack').controls)
      .toEqual([{ type: 'subscription', subscriptions: { trades: ['AAPL'], quotes: [] } }]);
    const error = decodeMarketFrame(msgpackFixtures.error!, 'msgpack');
    expect(error.controls).toEqual([{ type: 'error', code: 406, name: 'connection_limit_exceeded' }]);
    expect(JSON.stringify(error)).not.toContain('provider-private-text');
  });

  it('rejects malformed, wrong-type, oversized, too-deep, and mixed MessagePack frames', () => {
    expect(captureError(() => decodeMarketFrame(new Uint8Array([0xc1]), 'msgpack'))).toMatchObject({ code: 'malformed_msgpack' });
    expect(captureError(() => decodeMarketFrame('[{}]', 'msgpack'))).toMatchObject({ code: 'unsupported_codec' });
    expect(captureError(() => decodeMarketFrame(encode([{ T: 'success', msg: 'connected' }, fixture.events[0]]), 'msgpack')))
      .toMatchObject({ code: 'mixed_control_data' });
    expect(captureError(() => decodeMarketFrame(encode([{ T: 'success', msg: 'private control' }]), 'msgpack')))
      .toMatchObject({ code: 'invalid_control' });
    expect(captureError(() => decodeMarketFrame(new Uint8Array(256 * 1024 + 1), 'msgpack'))).toMatchObject({ code: 'frame_too_large' });
    let deeplyNested: unknown = [{ T: 'success', msg: 'connected' }];
    for (let index = 0; index < 20; index += 1) deeplyNested = [deeplyNested];
    expect(captureError(() => decodeMarketFrame(encode(deeplyNested), 'msgpack'))).toMatchObject({ code: 'invalid_frame_depth' });
  });

  it('enforces the data message limit for binary frames', () => {
    const event = fixture.events[0] as Record<string, unknown>;
    expect(decodeMarketFrame(encode(Array.from({ length: 100 }, (_, index) => ({ ...event, i: index + 1 }))), 'msgpack').events).toHaveLength(100);
    expect(captureError(() => decodeMarketFrame(encode(Array.from({ length: 101 }, (_, index) => ({ ...event, i: index + 1 }))), 'msgpack')))
      .toMatchObject({ code: 'too_many_messages' });
  });
});
