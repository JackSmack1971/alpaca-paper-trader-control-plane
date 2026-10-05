import { describe, expect, it } from 'vitest';
import { Llm1RequestRateLimiter } from '../src/services/llm1-rate-limiter.js';

describe('LLM1 request rate limiter', () => {
  it('spaces every admitted attempt using serialized process-local starts', async () => {
    let current = 0;
    const waits: number[] = [];
    const limiter = new Llm1RequestRateLimiter(() => current, async (ms) => { waits.push(ms); current += ms; });
    await Promise.all([limiter.acquire(30_000), limiter.acquire(30_000), limiter.acquire(30_000)]);
    expect(waits).toEqual([30_000, 30_000]);
    expect(current).toBe(60_000);
  });

  it('rejects intervals outside the configured application bound', async () => {
    const limiter = new Llm1RequestRateLimiter(() => 0, async () => undefined);
    await expect(limiter.acquire(29_999)).rejects.toThrow(/out of range/);
    await expect(limiter.acquire(120_001)).rejects.toThrow(/out of range/);
  });
});
