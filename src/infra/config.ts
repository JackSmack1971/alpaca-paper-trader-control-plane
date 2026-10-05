import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { appConfigSchema, type AppConfig } from '../domain/config.js';

const defaultsSchema = z.object({
  universe: z.array(z.string()),
  models: z.object({ analysis: z.string(), review: z.string() }),
  decision: z.object({ cadenceSeconds: z.number() }),
  risk: z.object({ maxPositionPct: z.string(), maxDailyLossPct: z.string() }),
  providers: z.object({
    alpacaDataFeed: z.string(),
    alpacaMarketDataPlan: z.enum(['basic', 'algo_trader_plus']).default('basic'),
    alpacaMarketDataCodec: z.enum(['json', 'msgpack']).default('json'),
    accountStateStaleAfterSeconds: z.number().int().min(1).max(3600).default(60),
    accountReconciliationSeconds: z.number().int().min(10).max(3600).default(60),
    accountRequestTimeoutMs: z.number().int().min(1000).max(30000).default(10000),
    accountRetryBaseSeconds: z.number().int().min(1).max(300).default(5),
    accountRetryMaxSeconds: z.number().int().min(1).max(3600).default(60),
    alpacaStreamRetry: z.object({ maxReconnects: z.number(), baseDelayMs: z.number(), maxDelayMs: z.number() }).default({ maxReconnects: 3, baseDelayMs: 250, maxDelayMs: 2000 }),
    openrouterBaseUrl: z.string(),
    llm1RequestTimeoutMs: z.number().int().min(1_000).max(30_000).default(15_000),
    llm1MinimumIntervalMs: z.number().int().min(30_000).max(120_000).default(30_000),
    llm1MaxCompletionTokens: z.number().int().min(64).max(4_096).default(1_200),
    jevRequestTimeoutMs: z.number().int().min(1_000).max(30_000),
    jevMinimumIntervalMs: z.number().int().min(30_000).max(120_000),
    jevPolicy: z.object({
      version: z.string().min(1).max(64),
      calibrated: z.literal(false),
      minChoiceConfidence: z.number().finite().min(0).max(1),
      minChoiceTopProbability: z.number().finite().min(0).max(1),
      minChoiceMargin: z.number().finite().min(0).max(1),
      minNecessaryPreconditionsProbability: z.number().finite().min(0).max(1),
    }).strict(),
  })
});

export async function loadConfig(env: NodeJS.ProcessEnv = process.env): Promise<AppConfig> {
  const defaultsPath = resolve(env.APP_CONFIG_FILE ?? 'config/default.json');
  const defaults = defaultsSchema.parse(JSON.parse(await readFile(defaultsPath, 'utf8')));
  return appConfigSchema.parse({
    mode: 'paper',
    host: env.HOST,
    localTestMode: env.LOCAL_TEST_MODE === 'true',
    port: env.PORT,
    databaseUrl: env.DATABASE_URL,
    alpacaKeyId: env.ALPACA_KEY_ID,
    alpacaSecretKey: env.ALPACA_SECRET_KEY,
    openRouterApiKey: env.OPENROUTER_API_KEY,
    universe: env.ASSET_UNIVERSE?.split(',').map((symbol) => symbol.trim().toUpperCase()) ?? defaults.universe,
    analysisModel: env.ANALYSIS_MODEL ?? defaults.models.analysis,
    reviewModel: env.REVIEW_MODEL ?? defaults.models.review,
    llm1RequestTimeoutMs: Number(env.LLM1_REQUEST_TIMEOUT_MS ?? defaults.providers.llm1RequestTimeoutMs),
    llm1MinimumIntervalMs: Number(env.LLM1_MINIMUM_INTERVAL_MS ?? defaults.providers.llm1MinimumIntervalMs),
    llm1MaxCompletionTokens: Number(env.LLM1_MAX_COMPLETION_TOKENS ?? defaults.providers.llm1MaxCompletionTokens),
    jevRequestTimeoutMs: Number(env.JEV_REQUEST_TIMEOUT_MS ?? defaults.providers.jevRequestTimeoutMs),
    jevMinimumIntervalMs: Number(env.JEV_MINIMUM_INTERVAL_MS ?? defaults.providers.jevMinimumIntervalMs),
    jevPolicy: defaults.providers.jevPolicy,
    decisionCadenceSeconds: Number(env.DECISION_CADENCE_SECONDS ?? defaults.decision.cadenceSeconds),
    accountStateStaleAfterSeconds: Number(env.ACCOUNT_STATE_STALE_AFTER_SECONDS ?? defaults.providers.accountStateStaleAfterSeconds),
    accountReconciliationSeconds: Number(env.ACCOUNT_RECONCILIATION_SECONDS ?? defaults.providers.accountReconciliationSeconds),
    accountRequestTimeoutMs: Number(env.ACCOUNT_REQUEST_TIMEOUT_MS ?? defaults.providers.accountRequestTimeoutMs),
    accountRetryBaseSeconds: Number(env.ACCOUNT_RETRY_BASE_SECONDS ?? defaults.providers.accountRetryBaseSeconds),
    accountRetryMaxSeconds: Number(env.ACCOUNT_RETRY_MAX_SECONDS ?? defaults.providers.accountRetryMaxSeconds),
    maxPositionPct: env.MAX_POSITION_PCT ?? defaults.risk.maxPositionPct,
    maxDailyLossPct: env.MAX_DAILY_LOSS_PCT ?? defaults.risk.maxDailyLossPct,
    alpacaDataFeed: env.ALPACA_DATA_FEED ?? defaults.providers.alpacaDataFeed,
    alpacaMarketDataPlan: env.ALPACA_MARKET_DATA_PLAN ?? defaults.providers.alpacaMarketDataPlan,
    alpacaMarketDataCodec: env.ALPACA_MARKET_DATA_CODEC ?? defaults.providers.alpacaMarketDataCodec,
    alpacaStreamRetry: {
      maxReconnects: Number(env.ALPACA_STREAM_MAX_RECONNECTS ?? defaults.providers.alpacaStreamRetry.maxReconnects),
      baseDelayMs: Number(env.ALPACA_STREAM_RETRY_BASE_MS ?? defaults.providers.alpacaStreamRetry.baseDelayMs),
      maxDelayMs: Number(env.ALPACA_STREAM_RETRY_MAX_MS ?? defaults.providers.alpacaStreamRetry.maxDelayMs),
    },
    openRouterBaseUrl: env.OPENROUTER_BASE_URL ?? defaults.providers.openrouterBaseUrl
  });
}

export function publicConfig(config: AppConfig) {
  const { databaseUrl: _databaseUrl, alpacaKeyId, alpacaSecretKey, openRouterApiKey, openRouterBaseUrl: _openRouterBaseUrl, ...safe } = config;
  return {
    ...safe,
    openRouterBaseUrl: 'redacted',
    credentials: {
      alpaca: alpacaKeyId && alpacaSecretKey ? 'present' : 'missing',
      openrouter: openRouterApiKey ? 'present' : 'missing'
    }
  };
}

export function configDigest(config: AppConfig): string {
  return createHash('sha256').update(JSON.stringify({ ...publicConfig(config), openRouterBaseUrl: config.openRouterBaseUrl })).digest('hex');
}
