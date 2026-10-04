import { EventEmitter } from 'node:events';
import { encode } from '@msgpack/msgpack';
import type WebSocket from 'ws';
import { AlpacaMarketStream, alpacaStockStreamUrl } from './alpaca-market-stream.js';
import type { AppConfig } from '../domain/config.js';

type Codec = 'json' | 'msgpack';
type WireEvent = Record<string, unknown>;

class LocalSocket extends EventEmitter {
  readyState = 0;
  private closed = false;

  constructor(private readonly owner: LocalAlpacaMarketTransport) {
    super();
    queueMicrotask(() => {
      if (this.closed) return;
      this.readyState = 1;
      this.emit('open');
      this.serverFrame([{ T: 'success', msg: 'connected' }]);
    });
  }

  send(payload: string) { this.owner.onClientFrame(this, payload); }
  close(code = 1000) {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    this.emit('close', code, Buffer.alloc(0));
  }
  serverFrame(frame: unknown[]) {
    if (this.closed) return;
    const binary = this.owner.codec === 'msgpack';
    const payload = binary ? encode(frame) : JSON.stringify(frame);
    this.emit('message', binary ? Buffer.from(payload) : payload, binary);
  }
  isClosed() { return this.closed; }
}

/** WebSocket-compatible in-memory PAPER stream server; it never constructs a real socket. */
export class LocalAlpacaMarketTransport {
  readonly codec: Codec;
  readonly feed: AppConfig['alpacaDataFeed'];
  readonly symbols: string[];
  readonly keyId = 'local-simulated-market-key';
  readonly secretKey = 'local-simulated-market-secret';
  private socket: LocalSocket | null = null;
  private timerSequence = 0;
  private readonly timers = new Map<number, () => void>();
  private resolveReady: (() => void) | null = null;
  private readyPromise = new Promise<void>((resolve) => { this.resolveReady = resolve; });
  connections = 0;
  eventsSent = 0;
  readonly sentFrames: string[] = [];

  constructor(feed: AppConfig['alpacaDataFeed'], symbols: string[], codec: Codec) {
    this.feed = feed;
    this.symbols = [...symbols];
    this.codec = codec;
  }

  readonly scheduler = {
    setTimeout: (callback: () => void, _delayMs: number) => {
      const id = ++this.timerSequence;
      this.timers.set(id, callback);
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout: (handle: ReturnType<typeof setTimeout>) => { this.timers.delete(Number(handle)); },
  };

  readonly socketFactory = (url: string, options: WebSocket.ClientOptions): WebSocket => {
    const expected = alpacaStockStreamUrl(this.feed);
    const contentType = this.codec === 'msgpack' ? 'application/msgpack' : 'application/json';
    if (url !== expected || options.headers?.['Content-Type'] !== contentType || options.perMessageDeflate !== false) {
      throw new Error('local market transport rejected unexpected socket configuration');
    }
    this.connections += 1;
    this.readyPromise = new Promise<void>((resolve) => { this.resolveReady = resolve; });
    const socket = new LocalSocket(this);
    this.socket = socket;
    return socket as unknown as WebSocket;
  };

  onClientFrame(socket: LocalSocket, payload: string) {
    if (socket !== this.socket || socket.isClosed()) return;
    this.sentFrames.push(payload);
    let action: unknown;
    try { action = JSON.parse(payload); } catch { socket.serverFrame([{ T: 'error', code: 400, msg: 'simulated' }]); return; }
    if (action && typeof action === 'object' && (action as { action?: unknown }).action === 'auth') {
      const auth = action as { key?: unknown; secret?: unknown };
      if (auth.key !== this.keyId || auth.secret !== this.secretKey) {
        socket.serverFrame([{ T: 'error', code: 402, msg: 'simulated' }]);
        return;
      }
      queueMicrotask(() => socket.serverFrame([{ T: 'success', msg: 'authenticated' }]));
      return;
    }
    if (action && typeof action === 'object' && (action as { action?: unknown }).action === 'subscribe') {
      const request = action as { trades?: unknown; quotes?: unknown };
      const sameSymbols = (value: unknown) => Array.isArray(value) && value.length === this.symbols.length && value.every((item, index) => item === this.symbols[index]);
      if (!sameSymbols(request.trades) || !sameSymbols(request.quotes)) {
        socket.serverFrame([{ T: 'error', code: 403, msg: 'simulated' }]);
        return;
      }
      queueMicrotask(() => {
        socket.serverFrame([{ T: 'subscription', trades: this.symbols, quotes: this.symbols }]);
        this.resolveReady?.();
        this.resolveReady = null;
      });
      return;
    }
    socket.serverFrame([{ T: 'error', code: 410, msg: 'simulated' }]);
  }

  async waitUntilReady() { await this.readyPromise; }

  emitEvents(events: WireEvent[]) {
    if (!this.socket || this.socket.isClosed()) throw new Error('local market socket is disconnected');
    if (!Array.isArray(events) || events.length < 1 || events.length > 100) throw new Error('local market frame must contain 1 to 100 messages');
    this.socket.serverFrame(events);
    this.eventsSent += events.length;
  }

  emitError(code: 402 | 407 | 500) { this.socket?.serverFrame([{ T: 'error', code, msg: 'simulated' }]); }
  disconnect() { this.socket?.close(1006); }

  async flushTimers(maxCallbacks = 20) {
    let executed = 0;
    while (this.timers.size && executed < maxCallbacks) {
      const [id, callback] = this.timers.entries().next().value as [number, () => void];
      this.timers.delete(id);
      callback();
      executed += 1;
      await Promise.resolve();
      await Promise.resolve();
    }
    if (this.timers.size) throw new Error('local market scheduler callback limit exceeded');
    return executed;
  }

  reset() {
    this.socket?.close(1000);
    this.socket = null;
    this.timers.clear();
    this.sentFrames.length = 0;
    this.connections = 0;
    this.eventsSent = 0;
    this.readyPromise = new Promise<void>((resolve) => { this.resolveReady = resolve; });
  }

  snapshot() { return { simulated: true as const, mode: 'paper' as const, feed: this.feed, codec: this.codec, connections: this.connections, clientFrames: this.sentFrames.length, eventsSent: this.eventsSent }; }
}

type LocalMarketConfig = Pick<AppConfig, 'alpacaDataFeed' | 'universe' | 'alpacaMarketDataPlan' | 'alpacaMarketDataCodec' | 'alpacaStreamRetry'>;

export function createLocalAlpacaMarketStream(config: LocalMarketConfig, now: () => Date) {
  const transport = new LocalAlpacaMarketTransport(config.alpacaDataFeed, config.universe, config.alpacaMarketDataCodec);
  const stream = new AlpacaMarketStream({
    keyId: transport.keyId,
    secretKey: transport.secretKey,
    feed: config.alpacaDataFeed,
    symbols: config.universe,
    plan: config.alpacaMarketDataPlan,
    codec: config.alpacaMarketDataCodec,
    maxReconnects: config.alpacaStreamRetry.maxReconnects,
    reconnectBaseDelayMs: config.alpacaStreamRetry.baseDelayMs,
    reconnectMaxDelayMs: config.alpacaStreamRetry.maxDelayMs,
    onEvents: () => undefined,
    socketFactory: transport.socketFactory,
    clock: now,
    scheduler: transport.scheduler,
  });
  return { stream, transport };
}
