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
    expect(config.llm1RequestTimeoutMs).toBe(15_000);
    expect(config.llm1MinimumIntervalMs).toBe(30_000);
    expect(config.llm1MaxCompletionTokens).toBe(1_200);
    expect(config.jevRequestTimeoutMs).toBe(12_000);
    expect(config.jevMinimumIntervalMs).toBe(30_000);
    expect(config.jevPolicy).toMatchObject({ version: 'paper-jev-abstention-v1', calibrated: false });
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
    await expect(loadConfig({ DATABASE_URL: 'postgres://local/test', OPENROUTER_BASE_URL: 'https://provider.example/api/v1' })).rejects.toThrow(/official HTTPS OpenRouter/);
    await expect(loadConfig({ DATABASE_URL: 'postgres://local/test', OPENROUTER_BASE_URL: 'http://openrouter.ai/api/v1' })).rejects.toThrow(/official HTTPS OpenRouter/);
  });

  it('bounds LLM1 completion length and timeout configuration', async () => {
    expect((await loadConfig({ DATABASE_URL: 'postgres://local/test', LLM1_REQUEST_TIMEOUT_MS: '5000', LLM1_MAX_COMPLETION_TOKENS: '900' })).llm1RequestTimeoutMs).toBe(5_000);
    await expect(loadConfig({ DATABASE_URL: 'postgres://local/test', LLM1_REQUEST_TIMEOUT_MS: '500' })).rejects.toThrow();
    await expect(loadConfig({ DATABASE_URL: 'postgres://local/test', LLM1_MAX_COMPLETION_TOKENS: '9000' })).rejects.toThrow();
  });

  it('bounds LLM1 application request spacing configuration', async () => {
    expect((await loadConfig({ DATABASE_URL: 'postgres://local/test', LLM1_MINIMUM_INTERVAL_MS: '60000' })).llm1MinimumIntervalMs).toBe(60_000);
    await expect(loadConfig({ DATABASE_URL: 'postgres://local/test', LLM1_MINIMUM_INTERVAL_MS: '100' })).rejects.toThrow();
    await expect(loadConfig({ DATABASE_URL: 'postgres://local/test', LLM1_MINIMUM_INTERVAL_MS: '120001' })).rejects.toThrow();
  });

  it('bounds Jev timeout and application request spacing', async () => {
    expect((await loadConfig({ DATABASE_URL: 'postgres://local/test', JEV_REQUEST_TIMEOUT_MS: '5000', JEV_MINIMUM_INTERVAL_MS: '60000' })).jevMinimumIntervalMs).toBe(60_000);
    await expect(loadConfig({ DATABASE_URL: 'postgres://local/test', JEV_REQUEST_TIMEOUT_MS: '500' })).rejects.toThrow();
    await expect(loadConfig({ DATABASE_URL: 'postgres://local/test', JEV_MINIMUM_INTERVAL_MS: '100' })).rejects.toThrow();
  });

  it('restricts the analysis model to a bounded provider/model identifier', async () => {
    expect((await loadConfig({ DATABASE_URL: 'postgres://local/test', ANALYSIS_MODEL: 'provider/model-v2.1' })).analysisModel).toBe('provider/model-v2.1');
    await expect(loadConfig({ DATABASE_URL: 'postgres://local/test', ANALYSIS_MODEL: 'provider/model?api_key=secret' })).rejects.toThrow(/provider\/model identifier/);
    await expect(loadConfig({ DATABASE_URL: 'postgres://local/test', OPENROUTER_API_KEY: 'provider/secret', ANALYSIS_MODEL: 'provider/provider/secret' })).rejects.toThrow(/must not contain provider credentials/);
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
