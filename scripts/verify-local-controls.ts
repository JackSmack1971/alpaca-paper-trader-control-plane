const base = process.env.LOCAL_CONTROL_URL ?? 'http://127.0.0.1:3000';
const url = new URL(base);
if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash) {
  throw new Error('LOCAL_CONTROL_URL must be an HTTP loopback URL without credentials, query, or fragment');
}

async function request(path: string, init?: RequestInit) {
  const response = await fetch(new URL(path, url), { ...init, redirect: 'error' });
  if (!response.ok) throw new Error(`local control request failed: ${response.status} ${path}`);
  return response.json() as Promise<any>;
}
async function rawRequest(path: string, init?: RequestInit) {
  return fetch(new URL(path, url), { ...init, redirect: 'error' });
}
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const marker = 'trace-query-secret-sentinel';
try {
  const initial = await request('/__local/reset', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert(initial.replayCursor === 0 && initial.account?.mode === 'paper', 'reset did not restore the PAPER fixture');
  assert(Array.isArray(initial.account.positions) && Array.isArray(initial.account.openOrders) && initial.account.exposure, 'normalized account snapshot is incomplete');
  const initialProviderAccount = await request('/__local/provider/account');
  const initialProviderPositions = await request('/__local/provider/positions');
  const initialProviderOrders = await request('/__local/provider/orders');
  assert(initialProviderAccount.simulated && initialProviderAccount.mode === 'paper' && initialProviderPositions.simulated && initialProviderPositions.mode === 'paper' && initialProviderOrders.simulated && initialProviderOrders.mode === 'paper', 'simulated account resources are missing PAPER markers');
  assert(initialProviderPositions.data.length === 2 && initialProviderPositions.data[0].symbol === 'TSLA' && initialProviderPositions.data[1].symbol === 'AAPL', 'simulated positions provider response differs from the checked-in fixture');
  assert(initialProviderOrders.data.length === 1 && initialProviderOrders.data[0].client_order_id === 'fixture-open-order-1', 'simulated orders provider response differs from the checked-in fixture');
  const initialAccountExpected = { account: { equity: '100000', }, positions: [{ symbol: 'AAPL', quantity: '3.5', marketValue: '666.4' }, { symbol: 'TSLA', quantity: '2', marketValue: '-480.5' }], openOrders: [{ clientOrderId: 'fixture-open-order-1', symbol: 'MSFT', quantity: '1.25' }], exposure: { long: '666.4', short: '480.5', gross: '1146.9', complete: true, unpricedSymbols: [] } };
  const initialAccountComparison = await request('/__local/assert-state', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expected: { account: initialAccountExpected } }) });
  assert(initialAccountComparison.simulated && initialAccountComparison.mode === 'paper' && initialAccountComparison.matched, 'fixture positions, orders, or exposure did not match expected state');
  const changedScenario = { account: structuredClone(initialProviderAccount.data), positions: structuredClone(initialProviderPositions.data), open_orders: structuredClone(initialProviderOrders.data), clock: structuredClone((await request('/__local/provider/clock')).data) };
  changedScenario.account.equity = '125000.50';
  changedScenario.positions[0].qty = '5';
  changedScenario.positions[0].market_value = '-1201.25';
  const scenarioResult = await request('/__local/scenario/account', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(changedScenario) });
  assert(scenarioResult.simulated && scenarioResult.mode === 'paper' && scenarioResult.status === 'replaced', 'validated simulated account scenario was not applied');
  const changedAccount = (await request('/__local/state')).account;
  assert(changedAccount.account.equity === '125000.5' && changedAccount.positions[1].quantity === '5' && changedAccount.exposure.short === '1201.25' && changedAccount.exposure.gross === '1867.65', 'simulated scenario did not update normalized equity, positions, and decimal exposure');
  const changedProviderPositions = await request('/__local/provider/positions');
  const changedProviderOrders = await request('/__local/provider/orders');
  assert(changedProviderPositions.simulated && changedProviderPositions.mode === 'paper' && changedProviderPositions.data[0].qty === '5', 'simulated PAPER positions response did not follow the replacement scenario');
  assert(changedProviderOrders.simulated && changedProviderOrders.mode === 'paper' && changedProviderOrders.data[0].client_order_id === 'fixture-open-order-1', 'simulated PAPER orders response did not follow the replacement scenario');
  const changedAccountComparison = await request('/__local/assert-state', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expected: { account: { account: { equity: '125000.5' }, positions: [{ symbol: 'AAPL', quantity: '3.5' }, { symbol: 'TSLA', quantity: '5' }], openOrders: [{ clientOrderId: 'fixture-open-order-1' }], exposure: { long: '666.4', short: '1201.25', gross: '1867.65', complete: true } } } }) });
  assert(changedAccountComparison.matched, 'replacement scenario expected-versus-observed account state comparison failed');
  const restoredAccount = await request('/__local/reset', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  const restoredAccountComparison = await request('/__local/assert-state', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expected: { account: initialAccountExpected } }) });
  assert(restoredAccount.replayCursor === 0 && restoredAccountComparison.matched, 'reset did not restore fixture positions, orders, and exposure');
  const freshnessReplay = await request('/__local/market/replay', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ steps: 1 }) });
  assert(freshnessReplay.market[0]?.freshness === 'fresh' && freshnessReplay.account.freshness.status === 'fresh', 'fixture replay did not start with fresh market and account state');
  await request('/__local/clock', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ now: '2025-01-02T14:30:31.000Z' }) });
  const staleMarket = await request('/__local/state');
  assert(staleMarket.market[0]?.freshness === 'stale' && staleMarket.market[0]?.staleReason === 'receive_age_exceeded', 'market replay did not become stale after its receive-age threshold');
  assert(staleMarket.account.freshness.status === 'fresh', 'account state became stale before its reconciliation-age threshold');
  await request('/__local/clock', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ now: '2025-01-02T14:31:01.000Z' }) });
  const staleAccount = await request('/__local/state');
  assert(staleAccount.account.freshness.status === 'stale' && staleAccount.account.freshness.ageMs === 61_000, 'account snapshot did not age to stale at the configured threshold');
  const recoveredAccount = await request('/__local/account/reconcile', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert(recoveredAccount.simulated && recoveredAccount.mode === 'paper' && recoveredAccount.state.account.freshness.status === 'fresh' && recoveredAccount.state.account.reconciledAt === recoveredAccount.state.now, 'simulated account reconciliation did not restore freshness at virtual time');
  const freshnessComparison = await request('/__local/assert-state', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expected: { account: { freshness: { status: 'fresh', ageMs: 0 } } } }) });
  assert(freshnessComparison.matched, 'expected-state comparison did not confirm reconciled account freshness');
  const freshnessSummary = { marketBecameStale: true, accountBecameStale: true, accountReconciled: true, expectedStateMatched: freshnessComparison.matched };
  await request('/__local/reset', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  const providerAccount = await request('/__local/provider/account');
  assert(providerAccount.simulated && providerAccount.mode === 'paper' && providerAccount.data.status === 'ACTIVE', 'synthetic PAPER account response is invalid');
  assert((await request('/__local/provider/health')).providers.account.status === 'ready', 'simulated account provider should start ready');
  const replay = await request('/__local/market/replay', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ steps: 2 }) });
  assert(replay.replayCursor === 2, 'bounded replay did not advance two events');
  const fixed = await request('/__local/clock', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ now: '2025-01-02T14:31:00.000Z' }) });
  assert(Date.parse(fixed.now) === Date.parse('2025-01-02T14:31:00Z'), 'virtual clock did not advance');
  const accountBeforeTradeUpdate = (await request('/__local/state')).account;
  const syntheticTradeUpdate = { stream: 'trade_updates', data: { event: 'partial_fill', execution_id: 'local-execution-1', timestamp: '2025-01-02T14:30:59.000Z', price: '190.25', qty: '2', position_qty: '2', order: { id: 'local-order-1', client_order_id: 'local-client-order-1', asset_id: 'local-asset-1', symbol: 'AAPL', side: 'buy', type: 'limit', status: 'partially_filled', order_class: 'simple', time_in_force: 'day', qty: '4', filled_qty: '2', filled_avg_price: '190.25' } } };
  const tradeUpdateResult = await request('/__local/trade-updates', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ updates: [syntheticTradeUpdate] }) });
  assert(tradeUpdateResult.simulated && tradeUpdateResult.mode === 'paper' && tradeUpdateResult.accepted === 1, 'synthetic trade update response is not marked simulated PAPER');
  assert(tradeUpdateResult.observations.updates[0].receivedAt === fixed.now, 'synthetic trade update did not use virtual receive time');
  const tradeUpdateState = await request('/__local/state');
  assert(tradeUpdateState.tradeUpdates.length === 1 && tradeUpdateState.account.positions.length === accountBeforeTradeUpdate.positions.length && tradeUpdateState.account.openOrders.length === accountBeforeTradeUpdate.openOrders.length, 'trade update observation changed account state');
  assert(JSON.stringify(tradeUpdateState.account.positions) === JSON.stringify(accountBeforeTradeUpdate.positions) && JSON.stringify(tradeUpdateState.account.openOrders) === JSON.stringify(accountBeforeTradeUpdate.openOrders), 'trade update observation changed canonical positions or open orders');
  const comparedTradeUpdate = await request('/__local/assert-state', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expected: { tradeUpdates: tradeUpdateState.tradeUpdates } }) });
  assert(comparedTradeUpdate.simulated && comparedTradeUpdate.mode === 'paper' && comparedTradeUpdate.matched, 'trade update expected-state comparison failed');
  const failure = await request('/__local/failures', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ target: 'market', kind: 'network' }) });
  assert(failure.status === 'armed', 'network failure was not armed');
  const failedMarket = await rawRequest('/__local/provider/market');
  assert(failedMarket.status === 503 && (await failedMarket.json() as { simulated: boolean }).simulated, 'injected network failure was not observed');
  assert((await request('/__local/provider/health')).providers.market.status === 'degraded', 'market provider health did not degrade');
  assert((await request('/__local/provider/market')).data.cursor === 2, 'simulated market provider did not recover after one-shot failure');
  assert((await request('/__local/provider/health')).providers.market.status === 'ready', 'market provider health did not recover');
  for (const [kind, expected] of [['rate_limit', 429], ['broker', 403]] as const) {
    await request('/__local/failures', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ target: 'account', kind }) });
    const failedAccount = await rawRequest('/__local/provider/account');
    assert(failedAccount.status === expected, `injected ${kind} failure was not observed`);
    assert((await request('/__local/provider/health')).providers.account.status === 'degraded', `account health did not degrade for ${kind}`);
    assert((await request('/__local/provider/account')).data.status === 'ACTIVE', `simulated account provider did not recover after ${kind}`);
    assert((await request('/__local/provider/health')).providers.account.status === 'ready', `account health did not recover after ${kind}`);
  }
  await request(`/health?marker=${encodeURIComponent(marker)}`);
  const traces = await request('/__local/traces?limit=100');
  const logs = await request('/__local/logs?limit=100');
  const recordText = JSON.stringify({ traces, logs });
  assert(!recordText.includes(marker) && traces.every((row: { route: string }) => !row.route.includes('?')), 'local trace/log leaked query data');
  assert(logs.some((row: { message: string; level: string }) => row.message === 'http_request_completed' && row.level === 'info'), 'application log records are missing');
  assert(logs.some((row: { message: string; level: string }) => row.message === 'simulated_provider_failure' && row.level === 'warn'), 'provider failure application log is missing');
  const knownTimes = new Set([Date.parse(initial.now), Date.parse(fixed.now)]);
  assert(logs.every((row: { at: string }) => knownTimes.has(Date.parse(row.at))) && logs.some((row: { at: string }) => Date.parse(row.at) === Date.parse(fixed.now)), 'local logs do not use virtual time');
  const reset = await request('/__local/reset', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert(reset.replayCursor === 0 && reset.tradeUpdates.length === 0, 'reset did not clear replay and trade-update observations');
  console.log(JSON.stringify({ status: 'PASS', replayCursor: replay.replayCursor, accountState: { fixtureCompared: initialAccountComparison.matched, scenarioChanged: changedAccountComparison.matched, resetRestored: restoredAccountComparison.matched }, freshness: freshnessSummary, simulatedPaper: providerAccount.mode, syntheticTradeUpdate: tradeUpdateResult.accepted, tradeUpdateStateMatched: comparedTradeUpdate.matched, injectedFailures: ['network', 'rate_limit', 'broker'], traceRecords: traces.length, logRecords: logs.length, resetCursor: reset.replayCursor, resetTradeUpdates: reset.tradeUpdates.length }));
} catch (error) {
  try { await request('/__local/reset', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }); } catch { /* preserve original diagnostic */ }
  throw error;
}
