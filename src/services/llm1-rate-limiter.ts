/** Process-local start spacing; this application policy does not claim provider-quota compliance. */
export class Llm1RequestRateLimiter {
  private nextAllowedAt = 0;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly delay: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  ) {}

  async acquire(minimumIntervalMs: number): Promise<void> {
    if (!Number.isInteger(minimumIntervalMs) || minimumIntervalMs < 30_000 || minimumIntervalMs > 120_000) {
      throw new Error('LLM1 minimum request interval is out of range');
    }
    const scheduled = this.queue.then(async () => {
      const waitMs = Math.max(0, this.nextAllowedAt - this.now());
      if (waitMs > 0) await this.delay(waitMs);
      this.nextAllowedAt = this.now() + minimumIntervalMs;
    });
    this.queue = scheduled.catch(() => undefined);
    await scheduled;
  }
}

export const llm1RequestRateLimiter = new Llm1RequestRateLimiter();
