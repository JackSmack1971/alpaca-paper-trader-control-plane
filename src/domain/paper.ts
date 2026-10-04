export const TRADING_MODE = 'paper' as const;
export const ALPACA_PAPER_BASE_URL = 'https://paper-api.alpaca.markets' as const;

export function assertPaperOnly(
  mode: string = TRADING_MODE,
  tradingBaseUrl: string = ALPACA_PAPER_BASE_URL
): asserts mode is typeof TRADING_MODE {
  if (mode !== TRADING_MODE || tradingBaseUrl !== ALPACA_PAPER_BASE_URL) {
    throw new Error('PAPER-only invariant violated');
  }
}
