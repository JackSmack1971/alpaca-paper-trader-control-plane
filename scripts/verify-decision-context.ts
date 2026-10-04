import { randomUUID } from 'node:crypto';
import { canonicalJson } from '../src/domain/decision-context.js';

const base = process.env.LOCAL_CONTROL_URL ?? 'http://127.0.0.1:3000';
const url = new URL(base);
if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash) {
  throw new Error('LOCAL_CONTROL_URL must be an HTTP loopback URL without credentials, query, or fragment');
}

async function call(path: string, init?: RequestInit): Promise<Response> {
  return fetch(new URL(path, url), { ...init, redirect: 'error' });
}
async function json(path: string, init?: RequestInit): Promise<any> {
  const response = await call(path, init);
  if (!response.ok) throw new Error(`decision context check failed: ${response.status} ${path}`);
  return response.json();
}
function post(body: unknown): RequestInit {
  return { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const cycleId = randomUUID();
try {
  await json('/__local/reset', post({}));
  const replay = await json('/__local/market/replay', post({ steps: 3 }));
  assert(replay.replayCursor === 3, 'three fixture events were not replayed');
  const first = await json('/__local/decision-context', post({ cycleId, symbol: 'AAPL' }));
  const second = await json('/__local/decision-context', post({ cycleId, symbol: 'AAPL' }));
  assert(first.status === 'persisted' && second.status === 'persisted', 'context was not persisted');
  assert(first.mode === 'paper' && first.simulated && first.context.mode === 'paper', 'context response is not marked simulated PAPER');
  assert(first.contentHash === second.contentHash && first.context.decision_context_id === second.context.decision_context_id, 'identical input was not idempotent');
  assert(first.tokenBudget.estimatedTokens <= first.tokenBudget.maxTokens && first.tokenBudget.method === 'utf8-bytes-upper-bound-v1', 'context budget was not enforced');
  const stored = await json(`/__local/decision-context/${cycleId}/replay`);
  assert(stored.status === 'replayed' && stored.contentHash === first.contentHash, 'persisted context did not replay to the stored hash');
  assert(stored.canonicalJson === canonicalJson(stored.context), 'replay did not return canonical context JSON');
  const unavailable = stored.context.unavailable;
  assert(unavailable.some((item: { path: string; reason: string }) => item.path === 'symbol_capabilities' && item.reason === 'unsupported'), 'unsupported capability provenance is missing');
  assert(unavailable.some((item: { path: string; reason: string }) => item.path === 'market.return_five_trades' && item.reason === 'insufficient_history'), 'sparse fixture history is not explicit');

  await json('/__local/reset', post({}));
  await json('/__local/market/replay', post({ steps: 1 }));
  const conflict = await call('/__local/decision-context', post({ cycleId, symbol: 'AAPL' }));
  assert(conflict.status === 409, 'changed persisted inputs did not conflict with the immutable cycle context');
  console.log(JSON.stringify({ status: 'PASS', simulated: true, mode: 'paper', replayedEvents: replay.replayCursor, persistedHash: first.contentHash, deterministicIdempotence: true, replayHashMatched: true, unavailableDataExplicit: true, changedInputConflict: conflict.status }));
} catch (error) {
  try { await json('/__local/reset', post({})); } catch { /* preserve original diagnostic */ }
  throw error;
}
