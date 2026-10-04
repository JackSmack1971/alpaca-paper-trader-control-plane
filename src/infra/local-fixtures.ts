import { open } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { LocalFixtures } from '../domain/local-test-harness.js';

const MAX_MARKET_FIXTURE_BYTES = 4 * 1024 * 1024;
const MAX_ACCOUNT_FIXTURE_BYTES = 1024 * 1024;
const boundedText = z.string().min(1).max(128);
const timestamp = z.string().datetime({ offset: true });
const tradeEvent = z.object({
  T: z.literal('t'), i: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), S: z.string().regex(/^[A-Z][A-Z0-9.-]{0,9}$/),
  x: z.string().min(1).max(32), p: z.number().finite().positive().max(Number.MAX_SAFE_INTEGER), s: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  c: z.array(z.string().max(8)).max(32).optional(), z: z.string().max(8).optional(), t: timestamp,
}).strict();
const quoteEvent = z.object({
  T: z.literal('q'), S: z.string().regex(/^[A-Z][A-Z0-9.-]{0,9}$/),
  bp: z.number().finite().positive().max(Number.MAX_SAFE_INTEGER), bs: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  ap: z.number().finite().positive().max(Number.MAX_SAFE_INTEGER), as: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), t: timestamp,
}).strict();
const marketSchema = z.object({ feed: z.string().min(1).max(32), events: z.array(z.union([tradeEvent, quoteEvent])).max(10_000) }).strict();
const accountSchema = z.object({
  account: z.object({
    id: z.string().uuid(), status: boundedText, currency: z.string().length(3), equity: boundedText, cash: boundedText, buying_power: boundedText,
    trading_blocked: z.boolean(), account_blocked: z.boolean(), shorting_enabled: z.boolean(),
  }).strict(),
  positions: z.array(z.object({
    symbol: z.string().regex(/^[A-Z][A-Z0-9.-]{0,19}$/), qty: boundedText, side: z.enum(['long', 'short']), avg_entry_price: boundedText,
    current_price: boundedText.nullable(), market_value: boundedText.nullable(),
  }).strict()).max(1000),
  open_orders: z.array(z.object({
    id: z.string().uuid(), client_order_id: boundedText, symbol: z.string().regex(/^[A-Z][A-Z0-9.-]{0,19}$/), side: z.enum(['buy', 'sell']),
    qty: boundedText.nullable().optional(), notional: boundedText.nullable().optional(), status: boundedText, created_at: timestamp, type: boundedText,
  }).strict().refine((order) => order.qty != null || order.notional != null)).max(1000),
  clock: z.object({ timestamp, is_open: z.boolean(), next_open: timestamp, next_close: timestamp, market: boundedText }).strict(),
}).strict();

async function readBoundedText(path: string, maxBytes: number): Promise<string> {
  const handle = await open(path, 'r');
  try {
    const chunk = Buffer.alloc(Math.min(64 * 1024, maxBytes + 1));
    const chunks: Buffer[] = [];
    let total = 0;
    let position = 0;
    while (total <= maxBytes) {
      const length = Math.min(chunk.length, maxBytes + 1 - total);
      const { bytesRead } = await handle.read(chunk, 0, length, position);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maxBytes) throw new Error('local fixture exceeds the byte limit');
      chunks.push(Buffer.from(chunk.subarray(0, bytesRead)));
      position += bytesRead;
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, total));
  } finally {
    await handle.close();
  }
}

export function parseLocalFixtureTexts(marketText: string, accountText: string): Omit<LocalFixtures, 'startTime'> {
  try {
    const market = marketSchema.safeParse(JSON.parse(marketText));
    const account = accountSchema.safeParse(JSON.parse(accountText));
    if (!market.success || !account.success) throw new Error('invalid local fixture schema');
    return { market: market.data, account: account.data };
  } catch {
    throw new Error('local fixtures are invalid');
  }
}

export async function loadLocalFixtures(): Promise<LocalFixtures> {
  try {
    const marketPath = fileURLToPath(new URL('../../fixtures/market/replay-sample.json', import.meta.url));
    const accountPath = fileURLToPath(new URL('../../fixtures/account/reconciliation-sample.json', import.meta.url));
    const [marketText, accountText] = await Promise.all([
      readBoundedText(marketPath, MAX_MARKET_FIXTURE_BYTES), readBoundedText(accountPath, MAX_ACCOUNT_FIXTURE_BYTES),
    ]);
    return { ...parseLocalFixtureTexts(marketText, accountText), startTime: '2025-01-02T14:30:00.000Z' };
  } catch {
    throw new Error('local fixtures are invalid');
  }
}
