import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const observationPath = path.join(repo, 'verification/control-plane/runtime/current.json');
const hookPath = path.join(repo, '.codex/hooks/session-start.mjs');

const result = spawnSync(process.execPath, [hookPath], {
  cwd: repo,
  encoding: 'utf8',
  input: JSON.stringify({
    hook_event_name: 'SessionStart',
    source: 'startup',
    cwd: repo,
    session_id: `runtime-observation-test-${process.pid}`,
    model: 'test-model',
    permission_mode: 'default'
  })
});

assert.equal(result.status, 0, result.stderr || result.stdout);
const hookResult = JSON.parse(result.stdout);
assert.equal(hookResult.continue, true);

const observation = JSON.parse(fs.readFileSync(observationPath, 'utf8'));
assert.equal(observation.schema_version, 1);
assert.equal(observation.source, 'codex-session-start-hook');
assert.equal(observation.project_layer_loaded, true);
assert.equal(observation.permission_mode, 'default');
assert.equal(observation.active_phase, 1);
assert.match(observation.captured_at, /^\d{4}-\d{2}-\d{2}T.*Z$/);
assert.equal(typeof observation.session_id_sha256, 'string');
assert.equal(observation.session_id_sha256.length, 64);
assert.equal(JSON.stringify(observation).includes(`runtime-observation-test-${process.pid}`), false);

console.log(`PASS: SessionStart runtime observation recorded at ${path.relative(repo, observationPath)}`);
