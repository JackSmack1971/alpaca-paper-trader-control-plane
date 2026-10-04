import { spawn, type ChildProcess } from 'node:child_process';
import { strict as assert } from 'node:assert';

const port = Number(process.env.LOCAL_RESTART_VERIFY_PORT ?? 31887);
const origin = `http://127.0.0.1:${port}`;
const databaseUrl = process.env.DATABASE_URL ?? 'postgres://postgres@127.0.0.1:55432/alpaca_paper_dev';
let child: ChildProcess | undefined;

function start() {
  const env: NodeJS.ProcessEnv = { ...process.env, HOST: '127.0.0.1', PORT: String(port), LOCAL_TEST_MODE: 'true', DATABASE_URL: databaseUrl };
  delete env.ALPACA_KEY_ID;
  delete env.ALPACA_SECRET_KEY;
  delete env.OPENROUTER_API_KEY;
  child = spawn(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'src/main.ts'], { cwd: process.cwd(), env, stdio: 'ignore', windowsHide: true });
}

async function stop() {
  if (!child || child.exitCode !== null) return;
  const current = child;
  current.kill('SIGTERM');
  await Promise.race([
    new Promise<void>((resolve) => current.once('exit', () => resolve())),
    new Promise<void>((_, reject) => setTimeout(() => reject(new Error('application process did not stop')), 10_000)),
  ]);
  child = undefined;
}

async function request(path: string, init?: RequestInit): Promise<any> {
  const response = await fetch(new URL(path, origin), init);
  const body = await response.json();
  assert.equal(response.status, 200, `${path} returned HTTP ${response.status}`);
  return body;
}

async function waitReady() {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child?.exitCode !== null) throw new Error('application exited during startup');
    try { return await request('/__local/state'); } catch { await new Promise((resolve) => setTimeout(resolve, 200)); }
  }
  throw new Error('application did not become ready');
}

try {
  start();
  await waitReady();
  await request('/__local/reset', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  const replayed = await request('/__local/market/replay', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ steps: 3 }) });
  assert.equal(replayed.replayCursor, 3);
  const expected = await request('/__local/clock', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ now: '2025-01-02T14:00:00.000Z' }) });
  assert.equal(expected.replayCursor, 3);
  await stop();

  start();
  const observed = await waitReady();
  assert.equal(observed.now, expected.now);
  assert.equal(observed.replayCursor, expected.replayCursor);
  assert.deepEqual(observed.market, expected.market);
  assert.deepEqual(observed.account, expected.account);
  assert.equal(observed.reconciliation.status, 'restored');
  assert.equal(observed.reconciliation.source, 'postgres_snapshot');
  assert.ok(observed.reconciliation.revision >= expected.reconciliation.revision);
  await request('/__local/reset', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  await stop();
  console.log(JSON.stringify({ status: 'PASS', mode: 'paper', credentialFree: true, virtualTimeRewind: true, restartRestored: ['virtual_time', 'replay_cursor', 'normalized_market', 'normalized_account'], revision: observed.reconciliation.revision }));
} catch (error) {
  await stop().catch(() => undefined);
  throw error;
}
