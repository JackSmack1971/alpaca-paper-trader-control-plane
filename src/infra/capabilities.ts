import { TRADING_MODE, assertPaperOnly } from '../domain/paper.js';
import type { AppConfig } from '../domain/config.js';

export type Capability = { status: 'connected' | 'unavailable' | 'not_configured'; detail: string };

export function providerCapabilities(config: AppConfig): Record<'alpacaPaper' | 'openrouter', Capability> {
  assertPaperOnly(TRADING_MODE);
  return {
    alpacaPaper: config.alpacaKeyId && config.alpacaSecretKey
      ? { status: 'unavailable', detail: 'Credentials are configured; connectivity has not been probed in Phase 1.' }
      : { status: 'not_configured', detail: 'Alpaca PAPER credentials are not configured.' },
    openrouter: config.openRouterApiKey
      ? { status: 'unavailable', detail: 'Credentials are configured; connectivity has not been probed in Phase 1.' }
      : { status: 'not_configured', detail: 'OpenRouter credentials are not configured.' }
  };
}
