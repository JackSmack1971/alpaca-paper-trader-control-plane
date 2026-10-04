import WebSocket from 'ws';
import { assertPaperOnly, TRADING_MODE } from '../domain/paper.js';
import { decodeMarketFrame, MarketStateAccumulator, type MarketEvent, type MarketState } from '../domain/market-state.js';
import type { AppConfig } from '../domain/config.js';

const MAX_FRAME_BYTES = 256 * 1024;
const AUTH_TIMEOUT_MS = 10_000;
const RETRYABLE_PROVIDER_CODES = new Set([407, 500]);

export type MarketStreamStatus = {
  status: 'not_started' | 'connecting' | 'authenticating' | 'subscribing' | 'connected' | 'degraded' | 'stopped';
  feed: string;
  symbolCount: number;
  connectionAttempts: number;
  reconnects: number;
  eventsProcessed: number;
  invalidFrames: number;
  lastEventAt: string | null;
  lastError: string | null;
};

type SocketFactory = (url: string, options: WebSocket.ClientOptions) => WebSocket;
type Clock = () => Date;
type Scheduler = {
  setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  clearTimeout(handle: ReturnType<typeof setTimeout>): void;
};

export type AlpacaMarketStreamOptions = {
  keyId: string;
  secretKey: string;
  feed: 'iex' | 'sip' | 'delayed_sip';
  symbols: string[];
  plan: 'basic' | 'algo_trader_plus';
  codec?: 'json' | 'msgpack';
  maxReconnects: number;
  reconnectBaseDelayMs: number;
  reconnectMaxDelayMs: number;
  onEvents(events: MarketEvent[], receivedAt: string): void;
  socketFactory?: SocketFactory;
  clock?: Clock;
  scheduler?: Scheduler;
};

type ConfiguredStreamFields = Pick<AppConfig,
  'alpacaKeyId' | 'alpacaSecretKey' | 'alpacaDataFeed' | 'universe' | 'alpacaMarketDataPlan' | 'alpacaMarketDataCodec' | 'alpacaStreamRetry'>;
type StreamTestOverrides = Pick<AlpacaMarketStreamOptions, 'socketFactory' | 'clock' | 'scheduler'>;

/** Map validated application settings into the single process-owned stream adapter. */
export function createConfiguredAlpacaMarketStream(
  config: ConfiguredStreamFields,
  onEvents: AlpacaMarketStreamOptions['onEvents'],
  overrides: StreamTestOverrides = {},
): AlpacaMarketStream {
  if (!config.alpacaKeyId || !config.alpacaSecretKey) throw new Error('Alpaca market stream credentials are required');
  return new AlpacaMarketStream({
    keyId: config.alpacaKeyId,
    secretKey: config.alpacaSecretKey,
    feed: config.alpacaDataFeed,
    symbols: config.universe,
    plan: config.alpacaMarketDataPlan,
    codec: config.alpacaMarketDataCodec,
    maxReconnects: config.alpacaStreamRetry.maxReconnects,
    reconnectBaseDelayMs: config.alpacaStreamRetry.baseDelayMs,
    reconnectMaxDelayMs: config.alpacaStreamRetry.maxDelayMs,
    onEvents,
    ...overrides,
  });
}

const defaultSocketFactory: SocketFactory = (url, options) => new WebSocket(url, options);
const defaultScheduler: Scheduler = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle),
};
const terminalProviderErrors = new Set([400, 401, 402, 403, 404, 405, 406, 409, 410]);
let activeStreamOwner: AlpacaMarketStream | null = null;

export function alpacaStockStreamUrl(feed: AlpacaMarketStreamOptions['feed']): string {
  if (!['iex', 'sip', 'delayed_sip'].includes(feed)) throw new Error('unsupported Alpaca stock feed');
  return `wss://stream.data.alpaca.markets/v2/${feed}`;
}

/** One process-owned Alpaca stock stream. No global socket or network access is created by import. */
export class AlpacaMarketStream {
  private readonly socketFactory: SocketFactory;
  private readonly clock: Clock;
  private readonly scheduler: Scheduler;
  private readonly accumulator: MarketStateAccumulator;
  private socket: WebSocket | null = null;
  private authTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  private stopped = false;
  private terminalFailure = false;
  private authSent = false;
  private status: MarketStreamStatus;

  constructor(private readonly options: AlpacaMarketStreamOptions) {
    assertPaperOnly(TRADING_MODE);
    if (!options.keyId || !options.secretKey) throw new Error('Alpaca market stream credentials are required');
    const symbols = [...new Set(options.symbols)];
    if (symbols.length !== options.symbols.length || symbols.length < 1 || symbols.length > 100 || symbols.some((symbol) => !/^[A-Z][A-Z0-9.-]{0,9}$/.test(symbol))) {
      throw new Error('invalid Alpaca market stream universe');
    }
    if (options.plan === 'basic' && symbols.length > 30) throw new Error('Basic plan supports at most 30 stock stream symbols');
    if (!Number.isInteger(options.maxReconnects) || options.maxReconnects < 0 || options.maxReconnects > 10 ||
      !Number.isInteger(options.reconnectBaseDelayMs) || options.reconnectBaseDelayMs < 1 ||
      !Number.isInteger(options.reconnectMaxDelayMs) || options.reconnectMaxDelayMs < options.reconnectBaseDelayMs) {
      throw new Error('invalid Alpaca market stream retry policy');
    }
    if (options.codec !== undefined && options.codec !== 'json' && options.codec !== 'msgpack') throw new Error('invalid Alpaca market stream codec');
    this.options = { ...options, symbols };
    alpacaStockStreamUrl(options.feed);
    this.socketFactory = options.socketFactory ?? defaultSocketFactory;
    this.clock = options.clock ?? (() => new Date());
    this.scheduler = options.scheduler ?? defaultScheduler;
    this.accumulator = new MarketStateAccumulator(options.feed);
    this.status = {
      status: 'not_started', feed: options.feed, symbolCount: symbols.length,
      connectionAttempts: 0, reconnects: 0, eventsProcessed: 0, invalidFrames: 0,
      lastEventAt: null, lastError: null,
    };
  }

  start(): void {
    if (this.started || this.stopped) return;
    if (activeStreamOwner && activeStreamOwner !== this) throw new Error('an Alpaca market stream is already owned by this process');
    activeStreamOwner = this;
    this.started = true;
    this.openSocket();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.clearAuthTimer();
    if (this.reconnectTimer) this.scheduler.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (activeStreamOwner === this) activeStreamOwner = null;
    const socket = this.socket;
    this.socket = null;
    this.status.status = 'stopped';
    try { socket?.close(1000); } catch { /* provider close details are intentionally suppressed */ }
  }

  snapshot(): MarketStreamStatus { return { ...this.status }; }

  restoreLocalReplay(events: unknown[], states: MarketState[]): void { this.accumulator.restoreReplay(events, states); }

  resetLocalSession(): void {
    this.stop();
    this.started = false;
    this.stopped = false;
    this.terminalFailure = false;
    this.authSent = false;
    this.accumulator.reset();
    this.status = {
      status: 'not_started', feed: this.options.feed, symbolCount: this.options.symbols.length,
      connectionAttempts: 0, reconnects: 0, eventsProcessed: 0, invalidFrames: 0,
      lastEventAt: null, lastError: null,
    };
    this.start();
  }

  marketStates(): MarketState[] {
    return this.accumulator.snapshot(this.clock().toISOString());
  }

  private openSocket(): void {
    if (this.stopped || this.terminalFailure) return;
    this.status.connectionAttempts += 1;
    this.status.status = 'connecting';
    let socket: WebSocket;
    try {
      socket = this.socketFactory(alpacaStockStreamUrl(this.options.feed), {
        headers: { 'Content-Type': this.options.codec === 'msgpack' ? 'application/msgpack' : 'application/json' },
        maxPayload: MAX_FRAME_BYTES,
        perMessageDeflate: false,
      });
    } catch {
      this.status.lastError = 'socket_open_failed';
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    socket.on('open', () => {
      if (this.socket !== socket || this.stopped) return;
      this.status.status = 'authenticating';
      this.status.lastError = null;
      this.authSent = false;
      this.authTimer = this.scheduler.setTimeout(() => {
        if (this.socket !== socket || this.status.status === 'connected') return;
        this.failTerminal('authentication_timeout');
      }, AUTH_TIMEOUT_MS);
    });
    socket.on('message', (data, isBinary) => {
      if (this.socket !== socket || this.stopped) return;
      const codec = this.options.codec ?? 'json';
      if (isBinary !== (codec === 'msgpack')) { this.rejectFrame(); return; }
      const input = typeof data === 'string' ? data : Buffer.isBuffer(data) ? data : Buffer.concat(Array.isArray(data) ? data : [Buffer.from(data)]);
      this.onMessage(input, codec);
    });
    socket.on('error', () => {
      if (this.socket !== socket || this.stopped) return;
      this.status.status = 'degraded';
      this.status.lastError = 'socket_transport_error';
      try { socket.close(); }
      catch {
        if (this.socket === socket) this.socket = null;
        this.scheduleReconnect();
      }
    });
    socket.on('close', () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.clearAuthTimer();
      if (this.stopped || this.terminalFailure) {
        if (activeStreamOwner === this) activeStreamOwner = null;
        return;
      }
      if (!this.status.lastError) this.status.lastError = 'connection_closed';
      this.status.status = 'degraded';
      this.scheduleReconnect();
    });
  }

  private onMessage(data: string | Buffer, codec: 'json' | 'msgpack'): void {
    let decoded;
    try {
      decoded = decodeMarketFrame(data, codec);
    } catch {
      this.rejectFrame();
      return;
    }

    for (const control of decoded.controls) {
      if (control.type === 'success' && control.message === 'connected') {
        if (this.status.status !== 'authenticating' || this.authSent) continue;
        try {
          this.socket?.send(JSON.stringify({ action: 'auth', key: this.options.keyId, secret: this.options.secretKey }));
          this.authSent = true;
        }
        catch { this.failTerminal('authentication_send_failed'); }
      } else if (control.type === 'success' && control.message === 'authenticated') {
        if (this.status.status !== 'authenticating') continue;
        this.clearAuthTimer();
        this.status.status = 'subscribing';
        try { this.socket?.send(JSON.stringify({ action: 'subscribe', trades: this.options.symbols, quotes: this.options.symbols })); }
        catch {
          this.status.lastError = 'subscription_send_failed';
          this.status.status = 'degraded';
          this.socket?.close();
        }
      } else if (control.type === 'subscription') {
        const actualTrades = control.subscriptions.trades ?? [];
        const actualQuotes = control.subscriptions.quotes ?? [];
        const missing = this.options.symbols.some((symbol) => !actualTrades.includes(symbol) || !actualQuotes.includes(symbol));
        if (missing) { this.failTerminal('subscription_incomplete'); continue; }
        this.status.status = 'connected';
        this.status.lastError = null;
      } else if (control.type === 'error') {
        this.status.lastError = `alpaca_${control.name}`;
        this.status.status = 'degraded';
        if (terminalProviderErrors.has(control.code)) this.failTerminal(`alpaca_${control.name}`);
        else if (RETRYABLE_PROVIDER_CODES.has(control.code)) this.socket?.close();
      }
    }

    if (decoded.events.length) {
      if (this.status.status !== 'connected') {
        this.status.invalidFrames += 1;
        this.status.lastError = 'data_before_subscription';
        return;
      }
      const at = this.clock().toISOString();
      try {
        this.accumulator.applyBatch(decoded.events, at);
      } catch {
        this.status.invalidFrames += 1;
        this.status.lastError = 'market_event_rejected';
        this.status.status = 'degraded';
        return;
      }
      this.status.eventsProcessed += decoded.events.length;
      this.status.lastEventAt = at;
      if (this.status.status === 'connected') this.status.lastError = null;
      try { this.options.onEvents(decoded.events, at); }
      catch { this.status.lastError = 'market_consumer_error'; this.status.status = 'degraded'; }
    }
  }

  private rejectFrame(): void {
    this.status.invalidFrames += 1;
    this.status.lastError = 'invalid_market_frame';
  }

  private failTerminal(error: string): void {
    this.terminalFailure = true;
    this.status.status = 'degraded';
    this.status.lastError = error;
    this.clearAuthTimer();
    const socket = this.socket;
    if (!socket) { if (activeStreamOwner === this) activeStreamOwner = null; return; }
    try { socket.close(); }
    catch {
      this.socket = null;
      if (activeStreamOwner === this) activeStreamOwner = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.terminalFailure || this.reconnectTimer) return;
    if (this.status.reconnects >= this.options.maxReconnects) {
      this.status.status = 'degraded';
      this.status.lastError = 'reconnect_limit_reached';
      if (activeStreamOwner === this) activeStreamOwner = null;
      return;
    }
    this.status.reconnects += 1;
    const exponent = this.status.reconnects - 1;
    const delay = Math.min(this.options.reconnectBaseDelayMs * (2 ** exponent), this.options.reconnectMaxDelayMs);
    this.reconnectTimer = this.scheduler.setTimeout(() => {
      this.reconnectTimer = null;
      this.openSocket();
    }, delay);
  }

  private clearAuthTimer(): void {
    if (this.authTimer) this.scheduler.clearTimeout(this.authTimer);
    this.authTimer = null;
  }
}
