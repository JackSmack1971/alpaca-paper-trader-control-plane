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
  analysisModel: z.string(),
  reviewModel: z.string(),
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
    return url.username === '' && url.password === '' && url.search === '' && url.hash === '';
  }, 'must not contain user information, query parameters or fragments')
}).superRefine((value, ctx) => {
  if (Boolean(value.alpacaKeyId) !== Boolean(value.alpacaSecretKey)) {
    ctx.addIssue({ code: 'custom', path: ['alpacaKeyId'], message: 'Alpaca key ID and secret must be configured together' });
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
