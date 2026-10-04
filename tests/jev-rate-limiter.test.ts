import { describe, expect, it } from 'vitest';
import { JevRequestRateLimiter } from '../src/services/jev-rate-limiter.js';

describe('Jev process-local rate limiter', () => {
  it('spaces serial and concurrent request starts by the configured application interval', async () => {
    let now = 0;
    const waits: number[] = [];
    const limiter = new JevRequestRateLimiter(() => now, async (ms) => { waits.push(ms); now += ms; });
    await limiter.acquire(30_000);
    expect(now).toBe(0);
    await Promise.all([limiter.acquire(30_000), limiter.acquire(30_000)]);
    expect(waits).toEqual([30_000, 30_000]);
    expect(now).toBe(60_000);
  });

  it('rejects unbounded or too-fast application settings', async () => {
    const limiter = new JevRequestRateLimiter(() => 0, async () => undefined);
    await expect(limiter.acquire(29_999)).rejects.toThrow(/out of range/);
    await expect(limiter.acquire(120_001)).rejects.toThrow(/out of range/);
  });
});
