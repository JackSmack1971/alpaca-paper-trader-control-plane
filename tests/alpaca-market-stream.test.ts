import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type WebSocket from 'ws';
import { encode } from '@msgpack/msgpack';
import { AlpacaMarketStream, alpacaStockStreamUrl, createConfiguredAlpacaMarketStream } from '../src/infra/alpaca-market-stream.js';
import { createLocalAlpacaMarketStream } from '../src/infra/local-alpaca-market-transport.js';

class FakeSocket extends EventEmitter {
  readyState = 0;
  sent: string[] = [];
  close = vi.fn(() => { this.readyState = 3; this.emit('close', 1000, Buffer.alloc(0)); });
  send(value: string) { this.sent.push(value); }
  open() { this.readyState = 1; this.emit('open'); }
  message(value: string | Uint8Array, binary = false) { this.emit('message', binary ? Buffer.from(value) : value, binary); }
}

function createStream(overrides: Partial<ConstructorParameters<typeof AlpacaMarketStream>[0]> = {}) {
  const sockets: FakeSocket[] = [];
  const connections: Array<{ url: string; options: WebSocket.ClientOptions }> = [];
  const stream = new AlpacaMarketStream({
    keyId: 'key-sentinel', secretKey: 'secret-sentinel', feed: 'iex', symbols: ['SPY', 'AAPL'], plan: 'basic',
    maxReconnects: 2, reconnectBaseDelayMs: 250, reconnectMaxDelayMs: 1000, onEvents: () => undefined,
    socketFactory: (url, options) => {
      connections.push({ url, options });
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
    clock: () => new Date('2025-01-02T14:30:00.000Z'),
    ...overrides,
  });
  return { stream, sockets, connections };
}

describe('Alpaca stock market stream adapter', () => {
  afterEach(() => vi.useRealTimers());

  it('uses one JSON connection, authenticates before subscribing, and stores normalized batched events', () => {
    const events = vi.fn();
    const { stream, sockets, connections } = createStream({ onEvents: events });
    expect(alpacaStockStreamUrl('iex')).toBe('wss://stream.data.alpaca.markets/v2/iex');
    stream.start();
    stream.start();
    expect(connections).toHaveLength(1);
    expect(connections[0]!.options.headers).toMatchObject({ 'Content-Type': 'application/json' });
    expect(connections[0]!.options.maxPayload).toBe(256 * 1024);
    const socket = sockets[0]!;
    socket.open();
    expect(socket.sent).toEqual([]);
    socket.message('[{"T":"success","msg":"connected"}]');
    expect(JSON.parse(socket.sent[0]!)).toEqual({ action: 'auth', key: 'key-sentinel', secret: 'secret-sentinel' });
    socket.message('[{"T":"success","msg":"authenticated"}]');
    expect(JSON.parse(socket.sent[1]!)).toEqual({ action: 'subscribe', trades: ['SPY', 'AAPL'], quotes: ['SPY', 'AAPL'] });
    expect(stream.snapshot().status).toBe('subscribing');
    socket.message('[{"T":"subscription","trades":["SPY","AAPL"],"quotes":["SPY","AAPL"]}]');
    socket.message('[{"T":"t","S":"SPY","i":1,"p":500,"s":2,"t":"2025-01-02T14:30:00.000Z","x":"D"},{"T":"q","S":"SPY","bp":499.9,"bs":3,"ap":500.1,"as":4,"t":"2025-01-02T14:30:00.100Z"}]');
    expect(stream.snapshot()).toMatchObject({ status: 'connected', symbolCount: 2, eventsProcessed: 2, invalidFrames: 0, lastError: null });
    expect(events).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ type: 'trade', symbol: 'SPY' }), expect.objectContaining({ type: 'quote', symbol: 'SPY' })]), '2025-01-02T14:30:00.000Z');
    expect(stream.marketStates()).toEqual([expect.objectContaining({ symbol: 'SPY', feed: 'iex', lastTrade: { id: 1, price: 500, size: 2, sourceTime: '2025-01-02T14:30:00.000Z' }, quote: { bid: 499.9, bidSize: 3, ask: 500.1, askSize: 4, sourceTime: '2025-01-02T14:30:00.100Z' } })]);
    socket.message('[{"T":"c","S":"SPY","oi":1,"op":500,"os":2,"oc":[],"ci":2,"cp":500.2,"cs":3,"cc":[],"t":"2025-01-02T14:30:00.200Z","x":"D"}]');
    expect(stream.marketStates()[0]!.lastTrade).toMatchObject({ id: 2, price: 500.2, size: 3 });
    socket.message('[{"T":"x","S":"SPY","i":2,"x":"D","p":500.2,"s":3,"a":"C","t":"2025-01-02T14:30:00.300Z"}]');
    expect(stream.marketStates()[0]!.lastTrade).toBeNull();
    expect(stream.snapshot().eventsProcessed).toBe(4);
    expect(JSON.stringify(stream.snapshot())).not.toContain('sentinel');
    stream.stop();
    expect(stream.snapshot().status).toBe('stopped');
  });

  it('counts and drops malformed and binary frames without exposing payloads', () => {
    const { stream, sockets } = createStream();
    stream.start();
    const socket = sockets[0]!;
    socket.open();
    socket.message('{"secret":"secret-sentinel"}');
    socket.message('[{"T":"t","S":"SPY","i":1,"p":500,"s":2,"t":"2025-01-02T14:30:00.000Z","x":"D"}]', true);
    expect(stream.snapshot()).toMatchObject({ invalidFrames: 2, eventsProcessed: 0, lastError: 'invalid_market_frame' });
    expect(JSON.stringify(stream.snapshot())).not.toContain('secret-sentinel');
    stream.stop();
  });

  it('requests and decodes configured MessagePack binary frames while rejecting codec mismatches', () => {
    const { stream, sockets, connections } = createStream({ codec: 'msgpack' });
    stream.start();
    expect(connections[0]!.options.headers).toMatchObject({ 'Content-Type': 'application/msgpack' });
    const socket = sockets[0]!;
    socket.open();
    socket.message(encode([{ T: 'success', msg: 'connected' }]), true);
    socket.message('[{"T":"success","msg":"authenticated"}]');
    expect(stream.snapshot()).toMatchObject({ status: 'authenticating', invalidFrames: 1, lastError: 'invalid_market_frame' });
    socket.message(encode([{ T: 'success', msg: 'authenticated' }]), true);
    socket.message(encode([{ T: 'subscription', trades: ['SPY', 'AAPL'], quotes: ['SPY', 'AAPL'] }]), true);
    socket.message(encode([{ T: 't', S: 'SPY', i: 1, p: 500, s: 2, t: '2025-01-02T14:30:00.000Z', x: 'D' }]), true);
    expect(stream.snapshot()).toMatchObject({ status: 'connected', eventsProcessed: 1, invalidFrames: 1 });
    expect(stream.marketStates()[0]!.lastTrade).toMatchObject({ id: 1, price: 500 });
    expect(JSON.stringify(stream.snapshot())).not.toContain('sentinel');
    stream.stop();
  });

  it('wires validated application codec configuration into the production stream factory', () => {
    const sockets: FakeSocket[] = [];
    const config = {
      alpacaKeyId: 'key-sentinel', alpacaSecretKey: 'secret-sentinel', alpacaDataFeed: 'iex', universe: ['SPY'],
      alpacaMarketDataPlan: 'basic', alpacaMarketDataCodec: 'msgpack',
      alpacaStreamRetry: { maxReconnects: 1, baseDelayMs: 100, maxDelayMs: 200 },
    } satisfies Parameters<typeof createConfiguredAlpacaMarketStream>[0];
    const stream = createConfiguredAlpacaMarketStream(config, () => undefined, {
      socketFactory: (_url, _options) => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
    });
    stream.start();
    expect(sockets).toHaveLength(1);
    sockets[0]!.open();
    sockets[0]!.message(encode([{ T: 'success', msg: 'connected' }]), true);
    sockets[0]!.message(encode([{ T: 'success', msg: 'authenticated' }]), true);
    sockets[0]!.message(encode([{ T: 'subscription', trades: ['SPY'], quotes: ['SPY'] }]), true);
    expect(stream.snapshot()).toMatchObject({ status: 'connected', invalidFrames: 0 });
    stream.stop();
  });

  it('runs the production stream handshake through a fixed in-memory local PAPER transport', async () => {
    const local = createLocalAlpacaMarketStream({
      alpacaDataFeed: 'iex', universe: ['SPY'], alpacaMarketDataPlan: 'basic', alpacaMarketDataCodec: 'json',
      alpacaStreamRetry: { maxReconnects: 2, baseDelayMs: 250, maxDelayMs: 1000 },
    }, () => new Date('2025-01-02T14:30:00.000Z'));
    local.stream.start();
    await local.transport.waitUntilReady();
    expect(local.stream.snapshot()).toMatchObject({ status: 'connected', symbolCount: 1, invalidFrames: 0 });
    expect(local.transport.snapshot()).toMatchObject({ simulated: true, mode: 'paper', connections: 1, clientFrames: 2 });
    expect(JSON.stringify(local.transport.snapshot())).not.toContain(local.transport.secretKey);
    expect(() => local.transport.socketFactory('wss://unapproved.invalid/v2/iex', {
      headers: { 'Content-Type': 'application/json' }, perMessageDeflate: false,
    })).toThrow('local market transport rejected unexpected socket configuration');
    local.stream.stop();
  });

  it('keeps authentication timeout terminal and does not retry connection or symbol limits', () => {
    vi.useFakeTimers();
    const { stream, sockets, connections } = createStream();
    stream.start();
    sockets[0]!.open();
    vi.advanceTimersByTime(10_000);
    expect(stream.snapshot()).toMatchObject({ status: 'degraded', lastError: 'authentication_timeout', reconnects: 0 });
    expect(sockets[0]!.close).toHaveBeenCalledOnce();
    expect(connections).toHaveLength(1);
    stream.stop();

    for (const [code, error] of [[405, 'alpaca_symbol_limit_exceeded'], [406, 'alpaca_connection_limit_exceeded']] as const) {
      const attempt = createStream();
      attempt.stream.start();
      attempt.sockets[0]!.open();
      attempt.sockets[0]!.message(JSON.stringify([{ T: 'error', code, msg: 'provider private detail' }]));
      expect(attempt.stream.snapshot()).toMatchObject({ status: 'degraded', lastError: error, reconnects: 0 });
      expect(JSON.stringify(attempt.stream.snapshot())).not.toContain('provider private detail');
      attempt.stream.stop();
    }
  });

  it('applies a bounded exponential reconnect policy for transport closures', () => {
    vi.useFakeTimers();
    const { stream, sockets, connections } = createStream({ maxReconnects: 1 });
    stream.start();
    sockets[0]!.emit('close', 1006, Buffer.alloc(0));
    vi.advanceTimersByTime(249);
    expect(connections).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(connections).toHaveLength(2);
    sockets[1]!.emit('close', 1006, Buffer.alloc(0));
    expect(stream.snapshot()).toMatchObject({ status: 'degraded', reconnects: 1, lastError: 'reconnect_limit_reached' });
    vi.advanceTimersByTime(10_000);
    expect(connections).toHaveLength(2);
    stream.stop();
  });

  it('rejects unsupported feeds and account plans that exceed their documented capacity', () => {
    expect(() => alpacaStockStreamUrl('unsupported' as 'iex')).toThrow('unsupported Alpaca stock feed');
    const tooManyBasic = Array.from({ length: 31 }, (_, index) => `S${index}`);
    expect(() => createStream({ symbols: tooManyBasic }).stream).toThrow('Basic plan supports at most 30');
    expect(() => createStream({ plan: 'algo_trader_plus', symbols: Array.from({ length: 101 }, (_, index) => `S${index}`) }).stream).toThrow('invalid Alpaca market stream universe');
  });

  it('enforces one active process owner and rejects incomplete subscription acknowledgements', () => {
    const first = createStream();
    const second = createStream();
    first.stream.start();
    expect(() => second.stream.start()).toThrow('an Alpaca market stream is already owned by this process');
    first.sockets[0]!.open();
    first.sockets[0]!.message('[{"T":"success","msg":"connected"}]');
    first.sockets[0]!.message('[{"T":"success","msg":"authenticated"}]');
    first.sockets[0]!.message('[{"T":"subscription","trades":["SPY"],"quotes":["SPY"]}]');
    expect(first.stream.snapshot()).toMatchObject({ status: 'degraded', lastError: 'subscription_incomplete', reconnects: 0 });
    expect(first.sockets[0]!.close).toHaveBeenCalledOnce();
    first.stream.stop();
    second.stream.start();
    expect(second.connections).toHaveLength(1);
    second.stream.stop();
  });
});
