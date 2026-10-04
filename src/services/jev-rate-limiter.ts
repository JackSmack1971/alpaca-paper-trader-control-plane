/** Process-local start-spacing limiter; its interval is application policy, not an OpenRouter quota claim. */
export class JevRequestRateLimiter {
  private nextAllowedAt = 0;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly now: () => number = Date.now, private readonly delay: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms))) {}

  async acquire(minimumIntervalMs: number): Promise<void> {
    if (!Number.isInteger(minimumIntervalMs) || minimumIntervalMs < 30_000 || minimumIntervalMs > 120_000) throw new Error('Jev minimum request interval is out of range');
    const scheduled = this.queue.then(async () => {
      const waitMs = Math.max(0, this.nextAllowedAt - this.now());
      if (waitMs > 0) await this.delay(waitMs);
      this.nextAllowedAt = this.now() + minimumIntervalMs;
    });
    this.queue = scheduled.catch(() => undefined);
    await scheduled;
  }
}

export const jevRequestRateLimiter = new JevRequestRateLimiter();
