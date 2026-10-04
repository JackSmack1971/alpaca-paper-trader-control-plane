import { z } from 'zod';

const decimalText = z.string().max(64).regex(/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/, 'must be a base-10 decimal string');
const positiveDecimalText = decimalText.refine((value) => parseDecimal(value).units > 0n, 'must be positive');
const timestamp = z.string().datetime({ offset: true });
const symbol = z.string().regex(/^[A-Z][A-Z0-9.-]{0,19}$/);

const accountWire = z.object({
  id: z.string().uuid(),
  status: z.string().min(1),
  currency: z.string().length(3),
  equity: decimalText,
  cash: decimalText,
  buying_power: decimalText,
  trading_blocked: z.boolean(),
  account_blocked: z.boolean(),
  shorting_enabled: z.boolean(),
}).passthrough();

const positionWire = z.object({
  symbol,
  qty: positiveDecimalText,
  side: z.enum(['long', 'short']),
  avg_entry_price: positiveDecimalText,
  current_price: positiveDecimalText.nullable(),
  market_value: decimalText.nullable(),
}).passthrough();

const orderWire = z.object({
  id: z.string().uuid(),
  client_order_id: z.string().min(1).max(128),
  symbol,
  side: z.enum(['buy', 'sell']),
  qty: positiveDecimalText.nullable().optional(),
  notional: positiveDecimalText.nullable().optional(),
  status: z.string().min(1),
  created_at: timestamp,
}).passthrough().refine((order) => order.qty != null || order.notional != null, 'order must provide quantity or notional');

const clockWire = z.object({
  timestamp,
  is_open: z.boolean(),
  next_open: timestamp,
  next_close: timestamp,
}).passthrough();

const reconciliationWire = z.object({
  account: accountWire,
  positions: z.array(positionWire),
  open_orders: z.array(orderWire),
  clock: clockWire,
}).passthrough();

type Decimal = { units: bigint; scale: number };

function parseDecimal(value: string): Decimal {
  const match = /^(-?)(0|[1-9]\d*)(?:\.(\d+))?$/.exec(value);
  if (!match) throw new Error('invalid decimal');
  const fraction = match[3] ?? '';
  if (fraction.length > 18 || match[2]!.length > 40) throw new Error('decimal precision or magnitude is out of range');
  const magnitude = BigInt(`${match[2]}${fraction}`);
  return { units: match[1] === '-' ? -magnitude : magnitude, scale: fraction.length };
}

function align(value: Decimal, scale: number): bigint {
  return value.units * (10n ** BigInt(scale - value.scale));
}

function add(left: Decimal, right: Decimal): Decimal {
  const scale = Math.max(left.scale, right.scale);
  return { units: align(left, scale) + align(right, scale), scale };
}

function multiply(left: Decimal, right: Decimal): Decimal {
  return { units: left.units * right.units, scale: left.scale + right.scale };
}

function canonical(value: Decimal): string {
  let { units, scale } = value;
  while (scale > 0 && units % 10n === 0n) { units /= 10n; scale -= 1; }
  const negative = units < 0n;
  const digits = (negative ? -units : units).toString().padStart(scale + 1, '0');
  const result = scale === 0 ? digits : `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
  return negative && units !== 0n ? `-${result}` : result;
}

export type AccountState = {
  mode: 'paper';
  account: {
    equity: string;
    cash: string;
    buyingPower: string;
    currency: string;
    status: string;
    restrictions: { tradingBlocked: boolean; accountBlocked: boolean; shortingEnabled: boolean };
  };
  positions: Array<{
    symbol: string;
    side: 'long' | 'short';
    quantity: string;
    averageEntryPrice: string;
    currentPrice: string | null;
    marketValue: string | null;
  }>;
  openOrders: Array<{
    orderId: string;
    clientOrderId: string;
    symbol: string;
    side: 'buy' | 'sell';
    quantity: string | null;
    notional: string | null;
    status: string;
    submittedAt: string;
  }>;
  exposure: { long: string; short: string; gross: string; complete: boolean; unpricedSymbols: string[] };
  market: { timestamp: string; isOpen: boolean; nextOpen: string; nextClose: string };
  reconciledAt: string;
  provenance: { source: 'fixture' | 'alpaca_paper'; groups: ['account', 'positions', 'open_orders', 'market_clock'] };
};

export function normalizeAccountState(
  input: unknown,
  reconciledAt: string,
  source: 'fixture' | 'alpaca_paper' = 'fixture',
): AccountState {
  const observedAt = timestamp.parse(reconciledAt);
  const parsed = reconciliationWire.parse(input);
  if (Date.parse(parsed.clock.next_open) <= Date.parse(parsed.clock.timestamp) || Date.parse(parsed.clock.next_close) <= Date.parse(parsed.clock.timestamp)) {
    throw new Error('market clock next session times must follow its timestamp');
  }
  const symbols = new Set<string>();
  const positions = parsed.positions.map((position) => {
    if (symbols.has(position.symbol)) throw new Error(`duplicate position symbol: ${position.symbol}`);
    symbols.add(position.symbol);
    if (position.market_value !== null) {
      const signedMarketValue = parseDecimal(position.market_value).units;
      if ((position.side === 'long' && signedMarketValue < 0n) || (position.side === 'short' && signedMarketValue > 0n)) {
        throw new Error(`position market value sign conflicts with side: ${position.symbol}`);
      }
    }
    return {
      symbol: position.symbol,
      side: position.side,
      quantity: canonical(parseDecimal(position.qty)),
      averageEntryPrice: canonical(parseDecimal(position.avg_entry_price)),
      currentPrice: position.current_price === null ? null : canonical(parseDecimal(position.current_price)),
      marketValue: position.market_value === null ? null : canonical(parseDecimal(position.market_value)),
    };
  }).sort((a, b) => a.symbol.localeCompare(b.symbol));

  const orderIds = new Set<string>();
  const clientOrderIds = new Set<string>();
  const openOrders = parsed.open_orders.map((order) => {
    if (orderIds.has(order.id)) throw new Error(`duplicate order id: ${order.id}`);
    if (clientOrderIds.has(order.client_order_id)) throw new Error(`duplicate client order id: ${order.client_order_id}`);
    orderIds.add(order.id);
    clientOrderIds.add(order.client_order_id);
    return {
      orderId: order.id,
      clientOrderId: order.client_order_id,
      symbol: order.symbol,
      side: order.side,
      quantity: order.qty == null ? null : canonical(parseDecimal(order.qty)),
      notional: order.notional == null ? null : canonical(parseDecimal(order.notional)),
      status: order.status,
      submittedAt: order.created_at,
    };
  }).sort((a, b) => a.orderId.localeCompare(b.orderId));

  let long = { units: 0n, scale: 0 };
  let short = { units: 0n, scale: 0 };
  const unpricedSymbols: string[] = [];
  for (const position of positions) {
    let notional: Decimal | null = position.marketValue === null ? null : parseDecimal(position.marketValue);
    if (notional === null && position.currentPrice !== null) {
      notional = multiply(parseDecimal(position.quantity), parseDecimal(position.currentPrice));
    }
    if (notional === null) {
      unpricedSymbols.push(position.symbol);
      continue;
    }
    const absolute = { ...notional, units: notional.units < 0n ? -notional.units : notional.units };
    if (position.side === 'long') long = add(long, absolute);
    else short = add(short, absolute);
  }
  const gross = add(long, short);

  return {
    mode: 'paper',
    account: {
      equity: canonical(parseDecimal(parsed.account.equity)),
      cash: canonical(parseDecimal(parsed.account.cash)),
      buyingPower: canonical(parseDecimal(parsed.account.buying_power)),
      currency: parsed.account.currency.toUpperCase(),
      status: parsed.account.status,
      restrictions: {
        tradingBlocked: parsed.account.trading_blocked,
        accountBlocked: parsed.account.account_blocked,
        shortingEnabled: parsed.account.shorting_enabled,
      },
    },
    positions,
    openOrders,
    exposure: {
      long: canonical(long),
      short: canonical(short),
      gross: canonical(gross),
      complete: unpricedSymbols.length === 0,
      unpricedSymbols,
    },
    market: {
      timestamp: parsed.clock.timestamp,
      isOpen: parsed.clock.is_open,
      nextOpen: parsed.clock.next_open,
      nextClose: parsed.clock.next_close,
    },
    reconciledAt: observedAt,
    provenance: { source, groups: ['account', 'positions', 'open_orders', 'market_clock'] },
  };
}
