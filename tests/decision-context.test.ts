import { describe, expect, it } from 'vitest';
import { LocalTestHarness } from '../src/domain/local-test-harness.js';
import { buildDecisionContext, canonicalJson, MAX_DECISION_CONTEXT_TOKENS, TOKEN_ESTIMATE_METHOD, type DecisionContextInput } from '../src/domain/decision-context.js';
import { loadLocalFixtures } from '../src/infra/local-fixtures.js';

const cycleId = '00000000-0000-4000-8000-000000000101';

async function readyInput(): Promise<DecisionContextInput> {
  const harness = new LocalTestHarness(await loadLocalFixtures());
  harness.advance(3);
  const state = harness.state();
  const { freshness: _accountFreshness, ...accountSnapshot } = state.account;
  const market = state.market.find((item) => item.symbol === 'AAPL')!;
  const asOf = new Date(Math.max(Date.parse(state.now), Date.parse(market.sourceEventTime))).toISOString();
  return {
    cycleId,
    symbol: 'AAPL',
    builtAt: asOf,
    asOf,
    market,
    marketHistory: harness.marketFixtureEvents(0, state.replayCursor),
    marketFreshnessMs: 30_000,
    account: accountSnapshot,
    accountFreshnessMs: 60_000,
    capabilities: { tradable: true, shortable: true, fractional: true },
    capabilityProvenance: { source: 'fixture', recordId: 'asset:AAPL', sourceTime: null, receivedAt: asOf },
    recentCycleState: null,
  };
}

describe('deterministic decision context', () => {
  it('produces byte-identical canonical payload, context ID, and digest for identical recorded inputs', async () => {
    const input = await readyInput();
    const first = buildDecisionContext(input);
    const second = buildDecisionContext(structuredClone(input));
    expect(first.canonicalJson).toBe(second.canonicalJson);
    expect(first.contentHash).toBe(second.contentHash);
    expect(first.context.decision_context_id).toBe(second.context.decision_context_id);
    expect(first.context.provenance.input_sha256).toBe(second.context.provenance.input_sha256);
    expect(first.context.transform_versions).toEqual({ context: 'decision-context-transform-2', arithmetic: 'decimal-half-even-8-v1' });
    expect(canonicalJson({ z: 1, a: 2 })).toBe('{"a":2,"z":1}');
  });

  it('uses exact decimal arithmetic for return, spread, exposure, and unrealized P&L', async () => {
    const built = buildDecisionContext(await readyInput());
    expect(built.context.market).toMatchObject({
      current_price: '190.4',
      return_one_trade: '0.00078844',
      return_five_trades: null,
      trend: null,
      realized_variance: null,
      observed_trade_volume: '3',
      spread: '0.1',
      spread_basis_points: '5.26',
      freshness: 'fresh',
    });
    expect(built.context.account).toMatchObject({
      freshness: 'fresh',
      equity: '100000',
      cash: '2500',
      buying_power: '10000',
      position: { side: 'long', quantity: '3.5', unrealized_pnl: '8.4' },
      exposure: { long: '666.4', short: '480.5', gross: '1146.9', complete: true },
      realized_pnl: null,
    });
    expect(built.context.unavailable).toContainEqual({ path: 'market.return_five_trades', reason: 'insufficient_history' });
    expect(built.context.unavailable).toContainEqual({ path: 'account.realized_pnl', reason: 'unsupported' });
    expect(built.context.provenance.sources.map((source) => source.record_id)).toEqual(expect.arrayContaining(['1', '2', 'AAPL:2025-01-02T14:30:02.000Z']));
    expect(built.context.provenance.sources).toContainEqual({ sequence: expect.any(Number), kind: 'symbol_capabilities', source: 'fixture', record_id: 'asset:AAPL', source_time: null, received_at: built.context.as_of });
    expect(built.context.eligible_for_inference).toBe(false);
    expect(built.context.blockers).toEqual(expect.arrayContaining(['insufficient_return_history', 'insufficient_trend_history', 'insufficient_volatility_history']));
  });

  it('rounds exact half-way returns to even at the documented eight decimal places', async () => {
    const input = await readyInput();
    input.marketHistory = [
      { T: 't', i: 10, S: 'AAPL', x: 'D', p: 200_000_000, s: 1, t: input.asOf },
      { T: 't', i: 11, S: 'AAPL', x: 'D', p: 200_000_001, s: 1, t: new Date(Date.parse(input.asOf) + 1).toISOString() },
    ];
    input.asOf = new Date(Date.parse(input.asOf) + 1).toISOString();
    input.builtAt = input.asOf;
    input.market = { ...input.market!, sourceEventTime: input.asOf, receivedAt: input.asOf, lastTrade: { id: 11, price: 200_000_001, size: 1, sourceTime: input.asOf }, quote: null };
    expect(buildDecisionContext(input).context.market.return_one_trade).toBe('0');
  });

  it('keeps missing account and market facts null and blocks inference instead of manufacturing zeroes', () => {
    const at = '2025-01-02T14:30:00.000Z';
    const input: DecisionContextInput = { cycleId, symbol: 'AAPL', builtAt: at, asOf: at, market: null, marketHistory: [], marketFreshnessMs: 30_000, account: null, accountFreshnessMs: 60_000, capabilities: null, capabilityProvenance: null, recentCycleState: null };
    const built = buildDecisionContext(input);
    expect(built.context.eligible_for_inference).toBe(false);
    expect(built.context.blockers).toEqual(expect.arrayContaining(['account_unavailable', 'market_price_unavailable', 'market_unavailable', 'symbol_capabilities_unavailable']));
    expect(built.context.market.current_price).toBeNull();
    expect(built.context.account.equity).toBeNull();
    expect(built.context.account.open_orders).toBeNull();
    expect(built.context.account.exposure).toBeNull();
    expect(built.context.unavailable).toEqual(expect.arrayContaining([
      { path: 'account', reason: 'unavailable_account_state' },
      { path: 'market', reason: 'no_feed' },
      { path: 'symbol_capabilities', reason: 'unsupported' },
    ]));
  });

  it('marks stale market and account inputs unusable and rejects future source observations', async () => {
    const input = await readyInput();
    input.asOf = '2025-01-02T14:31:00.001Z';
    input.builtAt = input.asOf;
    input.accountFreshnessMs = 60_000;
    const built = buildDecisionContext(input);
    expect(built.context.eligible_for_inference).toBe(false);
    expect(built.context.market).toMatchObject({ freshness: 'stale', current_price: null, return_one_trade: null });
    expect(built.context.account).toMatchObject({ freshness: 'stale', equity: null, exposure: null, open_orders: null });
    expect(built.context.unavailable).toContainEqual({ path: 'market', reason: 'stale' });
    expect(built.context.unavailable).toContainEqual({ path: 'account', reason: 'stale' });
    const future = await readyInput();
    future.asOf = '2025-01-02T14:30:01.000Z';
    future.builtAt = '2025-01-02T14:30:01.000Z';
    expect(() => buildDecisionContext(future)).toThrow(/future/);
  });

  it('preserves an explicit stale marker even when the market receive timestamp is recent', async () => {
    const input = await readyInput();
    input.market = { ...input.market!, freshness: 'stale', staleReason: 'receive_age_exceeded' };
    const built = buildDecisionContext(input);

    expect(built.context.eligible_for_inference).toBe(false);
    expect(built.context.blockers).toContain('stale_market');
    expect(built.context.market).toMatchObject({ freshness: 'stale', current_price: null, return_one_trade: null });
    expect(built.context.unavailable).toContainEqual({ path: 'market', reason: 'stale' });
  });

  it('marks recently received market data stale when its source event is too old', async () => {
    const input = await readyInput();
    input.market = { ...input.market!, sourceEventTime: '2025-01-02T14:29:00.000Z' };
    const built = buildDecisionContext(input);

    expect(built.context.eligible_for_inference).toBe(false);
    expect(built.context.market.freshness).toBe('stale');
    expect(built.context.market.current_price).toBeNull();
    expect(built.context.market.data_age_ms).toBeGreaterThan(input.marketFreshnessMs);
    expect(built.context.blockers).toContain('stale_market');
  });

  it('rejects malformed normalized market and account snapshots before deriving context', async () => {
    const malformedMarket = await readyInput();
    malformedMarket.market = { ...malformedMarket.market!, lastTrade: { ...malformedMarket.market!.lastTrade!, price: '190.40' as unknown as number } };
    expect(() => buildDecisionContext(malformedMarket)).toThrow(/invalid normalized market input/);

    const malformedAccount = await readyInput();
    malformedAccount.account = { ...malformedAccount.account!, account: { ...malformedAccount.account!.account, cash: {} as unknown as string } };
    expect(() => buildDecisionContext(malformedAccount)).toThrow(/invalid normalized account input/);
  });

  it('blocks inference when required market, account, session, or capability facts are incomplete', async () => {
    const input = await readyInput();
    input.capabilities = null;
    input.capabilityProvenance = null;
    input.account = { ...input.account!, exposure: { ...input.account!.exposure, complete: false, unpricedSymbols: ['AAPL'] } };
    input.account.market.isOpen = false;
    const built = buildDecisionContext(input);
    expect(built.context.eligible_for_inference).toBe(false);
    expect(built.context.blockers).toEqual(expect.arrayContaining(['symbol_capabilities_unavailable', 'incomplete_exposure', 'market_closed']));
    expect(built.context.unavailable).toContainEqual({ path: 'market_session', reason: 'pre_market' });

    const tooSparse = await readyInput();
    tooSparse.marketHistory = [tooSparse.marketHistory[0]];
    expect(buildDecisionContext(tooSparse).context.blockers).toContain('insufficient_market_history');
  });

  it('applies trade corrections and cancellations and leaves unknown receive provenance null', async () => {
    const input = await readyInput();
    const start = Date.parse(input.asOf);
    const time = (offset: number) => new Date(start + offset).toISOString();
    input.asOf = time(3);
    input.builtAt = input.asOf;
    input.marketHistory = [
      { T: 't', i: 1, S: 'AAPL', x: 'D', p: 190.25, s: 2, t: time(0) },
      { T: 'c', oi: 1, ci: 10, S: 'AAPL', x: 'D', op: 190.25, os: 2, oc: [], cp: 190.3, cs: 3, cc: [], t: time(1) },
      { T: 't', i: 2, S: 'AAPL', x: 'D', p: 190.4, s: 1, t: time(2) },
      { T: 'x', i: 2, S: 'AAPL', x: 'D', p: 190.4, s: 1, a: 'C', t: time(3) },
    ];
    input.market = { ...input.market!, sourceEventTime: input.asOf, receivedAt: input.asOf, lastTrade: null };
    const built = buildDecisionContext(input);
    expect(built.context.market).toMatchObject({ current_price: '190.3', observed_trade_volume: '3' });
    expect(built.context.provenance.sources.filter((source) => source.kind.startsWith('market_trade')).every((source) => source.received_at === null)).toBe(true);
    expect(built.context.provenance.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'market_trade_correction', record_id: '1->10', received_at: null }),
      expect.objectContaining({ kind: 'market_trade_cancel', record_id: '2:C', received_at: null }),
    ]));

    const errorInput = await readyInput();
    const errorAt = new Date(Date.parse(errorInput.asOf) + 2).toISOString();
    errorInput.asOf = errorAt;
    errorInput.builtAt = errorAt;
    errorInput.marketHistory = [
      { T: 't', i: 30, S: 'AAPL', x: 'D', p: 190.25, s: 2, t: new Date(Date.parse(errorAt) - 1).toISOString() },
      { T: 'x', i: 30, S: 'AAPL', x: 'D', p: 190.25, s: 2, a: 'E', t: errorAt },
    ];
    errorInput.market = { ...errorInput.market!, sourceEventTime: errorAt, receivedAt: errorAt, lastTrade: null };
    const errorBuilt = buildDecisionContext(errorInput);
    expect(errorBuilt.context.market.current_price).toBeNull();
    expect(errorBuilt.context.market.observed_trade_volume).toBeNull();
    expect(errorBuilt.context.blockers).toContain('market_price_unavailable');
  });

  it('sums individually safe trade sizes without overflowing JavaScript number arithmetic', async () => {
    const input = await readyInput();
    input.marketHistory = [
      { T: 't', i: 10, S: 'AAPL', x: 'D', p: 190, s: Number.MAX_SAFE_INTEGER, t: input.asOf },
      { T: 't', i: 11, S: 'AAPL', x: 'D', p: 191, s: Number.MAX_SAFE_INTEGER, t: new Date(Date.parse(input.asOf) + 1).toISOString() },
    ];
    input.asOf = new Date(Date.parse(input.asOf) + 1).toISOString();
    input.builtAt = input.asOf;
    input.market = { ...input.market!, sourceEventTime: input.asOf, receivedAt: input.asOf, lastTrade: { id: 11, price: 191, size: Number.MAX_SAFE_INTEGER, sourceTime: input.asOf } };
    expect(buildDecisionContext(input).context.market.observed_trade_volume).toBe('18014398509481982');
  });

  it('marks a fully populated recent market/account context as inference-ready', async () => {
    const input = await readyInput();
    const end = Date.parse(input.asOf);
    input.marketHistory = Array.from({ length: 6 }, (_, index) => ({
      T: 't', i: 100 + index, S: 'AAPL', x: 'D', p: 190 + index, s: index + 1,
      t: new Date(end - (5 - index) * 1_000).toISOString(),
    }));
    const lastAt = new Date(end).toISOString();
    input.market = { ...input.market!, sourceEventTime: lastAt, receivedAt: lastAt, lastTrade: { id: 105, price: 195, size: 6, sourceTime: lastAt } };
    input.capabilities = { tradable: true, shortable: true, fractional: true };
    const built = buildDecisionContext(input);
    expect(built.context.eligible_for_inference).toBe(true);
    expect(built.context.blockers).toEqual([]);
    expect(built.context.market).toMatchObject({ return_one_trade: '0.00515464', return_five_trades: '0.02631579', trend: 'up' });
  });

  it('rejects invalid symbols, crossed quotes, and serialized contexts above the conservative byte budget', async () => {
    const invalid = await readyInput();
    invalid.symbol = 'aapl';
    expect(() => buildDecisionContext(invalid)).toThrow();
    const crossed = await readyInput();
    crossed.market = { ...crossed.market!, quote: { bid: 191, bidSize: 2, ask: 190, askSize: 2, sourceTime: crossed.asOf } };
    expect(() => buildDecisionContext(crossed)).toThrow(/ask is below bid/);
    const large = await readyInput();
    large.account = structuredClone(large.account!);
    large.account!.openOrders = Array.from({ length: 20 }, (_, index) => ({
      orderId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      clientOrderId: `simulated-order-${index}-${'x'.repeat(100)}`,
      symbol: 'AAPL', side: 'buy' as const, quantity: '1', notional: null, status: 'accepted',
      submittedAt: large.asOf,
    }));
    expect(() => buildDecisionContext(large)).toThrow(/4,000-token/);
    const bounded = buildDecisionContext(await readyInput());
    expect(bounded.tokenEstimateMethod).toBe(TOKEN_ESTIMATE_METHOD);
    expect(bounded.estimatedTokens).toBe(Buffer.byteLength(bounded.canonicalJson, 'utf8'));
    expect(bounded.estimatedTokens).toBeLessThanOrEqual(MAX_DECISION_CONTEXT_TOKENS);
  });
});
