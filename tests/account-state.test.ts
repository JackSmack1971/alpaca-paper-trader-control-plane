import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { normalizeAccountState } from '../src/domain/account-state.js';

const fixture = JSON.parse(await readFile(new URL('../fixtures/account/reconciliation-sample.json', import.meta.url), 'utf8'));
const reconciledAt = '2025-01-02T15:00:02.000Z';

describe('credential-free account reconciliation normalization', () => {
  it('maps account, positions, open orders and market clock into application-owned state', () => {
    const state = normalizeAccountState(fixture, reconciledAt, 'fixture');
    expect(state).toEqual({
      mode: 'paper',
      account: {
        equity: '100000', cash: '2500', buyingPower: '10000', currency: 'USD', status: 'ACTIVE',
        restrictions: { tradingBlocked: false, accountBlocked: false, shortingEnabled: true },
      },
      positions: [
        { symbol: 'AAPL', side: 'long', quantity: '3.5', averageEntryPrice: '188', currentPrice: '190.4', marketValue: '666.4' },
        { symbol: 'TSLA', side: 'short', quantity: '2', averageEntryPrice: '250', currentPrice: '240.25', marketValue: '-480.5' },
      ],
      openOrders: [{
        orderId: '00000000-0000-4000-8000-000000000010', clientOrderId: 'fixture-open-order-1', symbol: 'MSFT',
        side: 'buy', quantity: '1.25', notional: null, status: 'accepted', submittedAt: '2025-01-02T14:55:00.000Z',
      }],
      exposure: { long: '666.4', short: '480.5', gross: '1146.9', complete: true, unpricedSymbols: [] },
      market: { timestamp: '2025-01-02T15:00:00.000Z', isOpen: true, nextOpen: '2025-01-03T14:30:00.000Z', nextClose: '2025-01-02T21:00:00.000Z' },
      reconciledAt,
      provenance: { source: 'fixture', groups: ['account', 'positions', 'open_orders', 'market_clock'] },
    });
    expect(JSON.stringify(state)).not.toContain('account_number');
    expect(JSON.stringify(state)).not.toContain('buying_power');
  });

  it('uses exact decimal arithmetic beyond Number precision and marks unpriced exposure incomplete', () => {
    const large = structuredClone(fixture);
    large.positions = [{ symbol: 'BIG', qty: '9007199254740993', side: 'long', avg_entry_price: '0.1', current_price: '0.1', market_value: null }];
    const state = normalizeAccountState(large, reconciledAt);
    expect(state.exposure).toMatchObject({ long: '900719925474099.3', short: '0', gross: '900719925474099.3', complete: true });
    large.positions[0].current_price = null;
    const incomplete = normalizeAccountState(large, reconciledAt);
    expect(incomplete.exposure).toEqual({ long: '0', short: '0', gross: '0', complete: false, unpricedSymbols: ['BIG'] });
  });

  it('repeats byte-stably with fixture inputs and an injected reconciliation timestamp', () => {
    const first = normalizeAccountState(fixture, reconciledAt, 'fixture');
    const second = normalizeAccountState(fixture, reconciledAt, 'fixture');
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it('preserves notional-only open orders without inventing a share quantity', () => {
    const notional = structuredClone(fixture);
    notional.open_orders = [{ ...notional.open_orders[0], qty: null, notional: '250.00' }];
    const state = normalizeAccountState(notional, reconciledAt);
    expect(state.openOrders[0]).toMatchObject({ quantity: null, notional: '250' });
    expect(() => normalizeAccountState({ ...notional, open_orders: [{ ...notional.open_orders[0], qty: null, notional: null }] }, reconciledAt)).toThrow();
  });

  it.each([
    ['numeric money', (value: any) => { value.account.cash = 12; }],
    ['exponent money', (value: any) => { value.account.equity = '1e5'; }],
    ['invalid side', (value: any) => { value.positions[0].side = 'flat'; }],
    ['invalid timestamp', (value: any) => { value.clock.timestamp = 'not-time'; }],
    ['duplicate symbol', (value: any) => { value.positions.push({ ...value.positions[0] }); }],
    ['duplicate order identity', (value: any) => { value.open_orders.push({ ...value.open_orders[0] }); }],
    ['order without quantity or notional', (value: any) => { value.open_orders[0].qty = null; value.open_orders[0].notional = null; }],
    ['long position with negative market value', (value: any) => { value.positions[1].market_value = '-480.50'; }],
    ['short position with positive market value', (value: any) => { value.positions[0].market_value = '480.50'; }],
    ['inverted next open', (value: any) => { value.clock.next_open = value.clock.timestamp; }],
  ])('rejects %s without producing a partial state', (_label, mutate) => {
    const invalid = structuredClone(fixture);
    mutate(invalid);
    expect(() => normalizeAccountState(invalid, reconciledAt)).toThrow();
  });
});
