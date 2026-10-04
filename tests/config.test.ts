import { describe, expect, it } from 'vitest';
import { assertPaperOnly, ALPACA_PAPER_BASE_URL, TRADING_MODE } from '../src/domain/paper.js';
import { assertLoopbackDatabase } from '../src/domain/dev-db.js';
import { loadConfig, publicConfig } from '../src/infra/config.js';

describe('configuration and PAPER boundary', () => {
  it('loads non-secret settings without optional provider credentials', async () => {
    const config = await loadConfig({ DATABASE_URL: 'postgres://local/test' });
    expect(config.mode).toBe('paper');
    expect(config.universe).toEqual(['SPY']);
    expect(config.localTestMode).toBe(false);
    expect(config.alpacaMarketDataPlan).toBe('basic');
    expect(config.alpacaMarketDataCodec).toBe('json');
    expect(config.accountStateStaleAfterSeconds).toBe(60);
    expect(config.alpacaStreamRetry).toEqual({ maxReconnects: 3, baseDelayMs: 250, maxDelayMs: 2000 });
    expect(publicConfig(config).credentials).toEqual({ alpaca: 'missing', openrouter: 'missing' });
  });

  it('enforces stock feed, unique symbols, and configured account stream limits', async () => {
    await expect(loadConfig({ DATABASE_URL: 'postgres://local/test', ALPACA_DATA_FEED: 'arbitrary-host' })).rejects.toThrow();
    await expect(loadConfig({ DATABASE_URL: 'postgres://local/test', ASSET_UNIVERSE: 'SPY,SPY' })).rejects.toThrow(/unique/);
    await expect(loadConfig({ DATABASE_URL: 'postgres://local/test', ASSET_UNIVERSE: Array.from({ length: 31 }, (_, index) => `S${index}`).join(',') })).rejects.toThrow(/30 stock stream symbols/);
    const plus = await loadConfig({ DATABASE_URL: 'postgres://local/test', ALPACA_MARKET_DATA_PLAN: 'algo_trader_plus', ASSET_UNIVERSE: Array.from({ length: 31 }, (_, index) => `S${index}`).join(',') });
    expect(plus.alpacaMarketDataPlan).toBe('algo_trader_plus');
  });

  it('selects only documented Alpaca market stream codecs', async () => {
    const msgpack = await loadConfig({ DATABASE_URL: 'postgres://local/test', ALPACA_MARKET_DATA_CODEC: 'msgpack' });
    expect(msgpack.alpacaMarketDataCodec).toBe('msgpack');
    await expect(loadConfig({ DATABASE_URL: 'postgres://local/test', ALPACA_MARKET_DATA_CODEC: 'binary' })).rejects.toThrow();
  });

  it('validates the account-state freshness threshold', async () => {
    const config = await loadConfig({ DATABASE_URL: 'postgres://local/test', ACCOUNT_STATE_STALE_AFTER_SECONDS: '15' });
    expect(config.accountStateStaleAfterSeconds).toBe(15);
    await expect(loadConfig({ DATABASE_URL: 'postgres://local/test', ACCOUNT_STATE_STALE_AFTER_SECONDS: '0' })).rejects.toThrow();
    await expect(loadConfig({ DATABASE_URL: 'postgres://local/test', ACCOUNT_STATE_STALE_AFTER_SECONDS: '3601' })).rejects.toThrow();
  });

  it('allows local controls only on loopback with no provider credentials', async () => {
    const config = await loadConfig({ DATABASE_URL: 'postgres://postgres@127.0.0.1/test', LOCAL_TEST_MODE: 'true' });
    expect(config.localTestMode).toBe(true);
    await expect(loadConfig({ DATABASE_URL: 'postgres://postgres@database.example/test', LOCAL_TEST_MODE: 'true' })).rejects.toThrow(/loopback/);
    await expect(loadConfig({ DATABASE_URL: 'postgres://postgres@127.0.0.1/test', LOCAL_TEST_MODE: 'true', HOST: '0.0.0.0' })).rejects.toThrow(/loopback/);
    await expect(loadConfig({ DATABASE_URL: 'postgres://postgres@127.0.0.1/test', LOCAL_TEST_MODE: 'true', OPENROUTER_API_KEY: 'secret' })).rejects.toThrow(/loopback/);
  });

  it('reports configured credentials without returning their values', async () => {
    const config = await loadConfig({
      DATABASE_URL: 'postgres://local/test',
      ALPACA_KEY_ID: 'alpaca-key-sentinel',
      ALPACA_SECRET_KEY: 'alpaca-secret-sentinel',
      OPENROUTER_API_KEY: 'openrouter-secret-sentinel',
    });
    const output = JSON.stringify(publicConfig(config));
    expect(publicConfig(config).credentials).toEqual({ alpaca: 'present', openrouter: 'present' });
    expect(output).not.toContain('alpaca-key-sentinel');
    expect(output).not.toContain('alpaca-secret-sentinel');
    expect(output).not.toContain('openrouter-secret-sentinel');
    expect(output).not.toContain(config.databaseUrl);
    expect(output).not.toContain(config.openRouterBaseUrl);
  });

  it('rejects provider URLs that can carry credentials in user info or query parameters', async () => {
    await expect(loadConfig({
      DATABASE_URL: 'postgres://local/test',
      OPENROUTER_BASE_URL: 'https://user:secret-sentinel@provider.example/v1?token=token-sentinel',
    })).rejects.toThrow();
  });

  it('rejects mode or endpoint changes', () => {
    expect(() => assertPaperOnly(TRADING_MODE, ALPACA_PAPER_BASE_URL)).not.toThrow();
    expect(() => assertPaperOnly('live')).toThrow(/PAPER-only/);
    expect(() => assertPaperOnly(TRADING_MODE, 'https://example.invalid')).toThrow(/PAPER-only/);
  });

  it('restricts development seeding to a loopback PostgreSQL database', () => {
    expect(() => assertLoopbackDatabase('postgres://postgres@127.0.0.1:55432/dev')).not.toThrow();
    expect(() => assertLoopbackDatabase('postgres://postgres@localhost/dev')).not.toThrow();
    expect(() => assertLoopbackDatabase('postgres://app@database.example/prod')).toThrow(/loopback/);
    expect(() => assertLoopbackDatabase('https://example.invalid')).toThrow(/PostgreSQL/);
  });
});
