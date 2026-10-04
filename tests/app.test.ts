import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/api/app.js';
import { loadConfig } from '../src/infra/config.js';

const config = await loadConfig({ DATABASE_URL: 'postgres://local/test' });

describe('HTTP health and status observation', () => {
  it('shows PAPER mode and an available local database', async () => {
    const pool = { query: vi.fn().mockResolvedValue({ rowCount: 1 }) } as unknown as Pool;
    const app = createApp(config, pool);
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['x-paper-mode']).toBe('true');
    expect(response.json()).toMatchObject({ status: 'ok', mode: 'paper', capabilities: { database: 'connected' } });
    const account = await app.inject({ method: 'GET', url: '/account' });
    expect(account.statusCode).toBe(200);
    expect(account.headers['x-paper-mode']).toBe('true');
    expect(account.json()).toMatchObject({ mode: 'paper', status: 'not_configured', account: null });
    await app.close();
  });

  it('shows database failure, labels providers truthfully, and exposes no order route', async () => {
    const pool = { query: vi.fn().mockRejectedValue(new Error('connection failure')) } as unknown as Pool;
    const app = createApp(config, pool);
    const health = await app.inject({ method: 'GET', url: '/health' });
    const absentRoute = await app.inject({ method: 'POST', url: '/orders' });
    expect(health.statusCode).toBe(503);
    expect(health.json()).toMatchObject({
      mode: 'paper',
      capabilities: {
        database: 'unavailable',
        alpacaPaper: { status: 'not_configured' },
        openrouter: { status: 'not_configured' },
      },
    });
    expect(absentRoute.statusCode).toBe(404);
    expect(absentRoute.headers['x-paper-mode']).toBe('true');
    await app.close();
  });
});
