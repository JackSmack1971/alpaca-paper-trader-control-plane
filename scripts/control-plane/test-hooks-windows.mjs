import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const hooks = JSON.parse(fs.readFileSync(path.join(root, '.codex/hooks.json'), 'utf8')).hooks;
const expected = {
  SessionStart: 'cmd.exe /d /c .codex\\hooks\\run-hook.cmd session-start',
  PreToolUse: 'cmd.exe /d /c .codex\\hooks\\run-hook.cmd pre-tool-use',
  PostToolUse: 'cmd.exe /d /c .codex\\hooks\\run-hook.cmd post-tool-use'
};

function invoke(event, group, input) {
  const handler = hooks[event][group].hooks[0];
  assert.equal(handler.commandWindows, expected[event]);
  const payload = JSON.stringify(input).replaceAll("'", "''");
  const powershell = `$payload = '${payload}'; $payload | cmd.exe /d /s /c '"${handler.commandWindows}"'`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', powershell], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}

if (process.platform === 'win32') {
  const observationPath = path.join(root, 'verification/control-plane/runtime/current.json');
  const previousObservation = fs.existsSync(observationPath) ? fs.readFileSync(observationPath) : null;
  try {
    assert.equal(JSON.parse(invoke('SessionStart', 0, { hook_event_name: 'SessionStart', source: 'startup', cwd: root, session_id: 'windows-hook-regression', model: 'test-model', permission_mode: 'default' })).continue, true);
    assert.equal(invoke('PreToolUse', 0, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git status' } }), '');
    assert.equal(JSON.parse(invoke('PreToolUse', 0, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git reset --hard HEAD' } })).hookSpecificOutput.permissionDecision, 'deny');
    const mcpBudget = JSON.parse(fs.readFileSync(path.join(root, 'docs/control-plane/policy.json'), 'utf8')).mcp.maximum_result_utf8_bytes;
    assert.equal(JSON.parse(invoke('PostToolUse', 1, { hook_event_name: 'PostToolUse', tool_name: 'mcp__test__query', tool_response: 'x'.repeat(mcpBudget) })).continue, false);
    assert.match(JSON.parse(invoke('PostToolUse', 0, { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_response: { exit_code: 7 } })).hookSpecificOutput.additionalContext, /FAIL \(exit_code=7\)/);
  } finally {
    if (previousObservation) fs.writeFileSync(observationPath, previousObservation);
    else fs.rmSync(observationPath, { force: true });
  }
  console.log('PASS: Windows hook commands preserve SessionStart, PreToolUse, and PostToolUse behavior.');
} else console.log('SKIP: Windows hook process integration requires Windows.');
