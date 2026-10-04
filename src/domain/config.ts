import { z } from 'zod';

const decimal = z.string().regex(/^(0|[1-9]\d*)(\.\d+)?$/, 'must be a non-negative decimal string');

export const appConfigSchema = z.object({
  mode: z.literal('paper'),
  host: z.string().min(1).default('127.0.0.1'),
  localTestMode: z.boolean().default(false),
  port: z.coerce.number().int().min(1).max(65535).default(3000),
  databaseUrl: z.string().url(),
  alpacaKeyId: z.string().optional(),
  alpacaSecretKey: z.string().optional(),
  openRouterApiKey: z.string().optional(),
  universe: z.array(z.string().regex(/^[A-Z][A-Z0-9.-]{0,9}$/)).min(1).max(100),
  analysisModel: z.string().max(256).refine((value) => value === '' || /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\/[A-Za-z0-9][A-Za-z0-9._:+-]{0,127}$/.test(value), 'must be empty or a provider/model identifier'),
  reviewModel: z.string(),
  llm1RequestTimeoutMs: z.number().int().min(1_000).max(30_000),
  llm1MinimumIntervalMs: z.number().int().min(30_000).max(120_000),
  llm1MaxCompletionTokens: z.number().int().min(64).max(4_096),
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
  decisionCadenceSeconds: z.number().int().positive(),
  accountStateStaleAfterSeconds: z.number().int().min(1).max(3600),
  accountReconciliationSeconds: z.number().int().min(10).max(3600),
  accountRequestTimeoutMs: z.number().int().min(1000).max(30000),
  accountRetryBaseSeconds: z.number().int().min(1).max(300),
  accountRetryMaxSeconds: z.number().int().min(1).max(3600),
  maxPositionPct: decimal,
  maxDailyLossPct: decimal,
  alpacaDataFeed: z.enum(['iex', 'sip', 'delayed_sip']),
  alpacaMarketDataPlan: z.enum(['basic', 'algo_trader_plus']).default('basic'),
  alpacaMarketDataCodec: z.enum(['json', 'msgpack']).default('json'),
  alpacaStreamRetry: z.object({ maxReconnects: z.number().int().min(0).max(10), baseDelayMs: z.number().int().positive(), maxDelayMs: z.number().int().positive() }),
  openRouterBaseUrl: z.string().url().refine((value) => {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'openrouter.ai' && url.port === '' && url.pathname.replace(/\/$/, '') === '/api/v1' && url.username === '' && url.password === '' && url.search === '' && url.hash === '';
  }, 'must be the official HTTPS OpenRouter API base URL without user information, query parameters or fragments')
}).superRefine((value, ctx) => {
  if (Boolean(value.alpacaKeyId) !== Boolean(value.alpacaSecretKey)) {
    ctx.addIssue({ code: 'custom', path: ['alpacaKeyId'], message: 'Alpaca key ID and secret must be configured together' });
  }
  if (value.openRouterApiKey && value.analysisModel.includes(value.openRouterApiKey)) {
    ctx.addIssue({ code: 'custom', path: ['analysisModel'], message: 'analysis model must not contain provider credentials' });
  }
  if (new Set(value.universe).size !== value.universe.length) {
    ctx.addIssue({ code: 'custom', path: ['universe'], message: 'symbols must be unique' });
  }
  if (value.alpacaMarketDataPlan === 'basic' && value.universe.length > 30) {
    ctx.addIssue({ code: 'custom', path: ['universe'], message: 'Basic plan supports at most 30 stock stream symbols' });
  }
  if (value.alpacaStreamRetry.maxDelayMs < value.alpacaStreamRetry.baseDelayMs) {
    ctx.addIssue({ code: 'custom', path: ['alpacaStreamRetry'], message: 'maximum reconnect delay must be at least the base delay' });
  }
  if (value.accountRetryMaxSeconds < value.accountRetryBaseSeconds) {
    ctx.addIssue({ code: 'custom', path: ['accountRetryMaxSeconds'], message: 'maximum account retry delay must be at least the base delay' });
  }
  let databaseHost = '';
  try { databaseHost = new URL(value.databaseUrl).hostname.toLowerCase(); } catch { /* the base schema reports invalid URLs */ }
  const loopbackDatabase = ['localhost', '127.0.0.1', '[::1]'].includes(databaseHost);
  if (value.localTestMode && (!['127.0.0.1', '::1', 'localhost'].includes(value.host.toLowerCase()) || !loopbackDatabase || value.alpacaKeyId || value.alpacaSecretKey || value.openRouterApiKey)) {
    ctx.addIssue({ code: 'custom', path: ['localTestMode'], message: 'local test mode requires loopback application and database hosts and no provider credentials' });
  }
});

export type AppConfig = z.infer<typeof appConfigSchema>;
