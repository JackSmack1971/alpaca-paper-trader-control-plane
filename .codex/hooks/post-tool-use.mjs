import fs from 'node:fs';
import path from 'node:path';
import { findRepoRoot, loadJson, readStdinJson } from '../../scripts/control-plane/lib.mjs';

function visit(value, fn, depth = 0) {
  if (depth > 8) return;
  fn(value);
  if (Array.isArray(value)) for (const item of value) visit(item, fn, depth + 1);
  else if (value && typeof value === 'object') for (const item of Object.values(value)) visit(item, fn, depth + 1);
}

function explicitExitCode(response) {
  let found = null;
  visit(response, value => {
    if (found !== null || !value || typeof value !== 'object') return;
    for (const key of ['exit_code', 'exitCode']) if (Number.isInteger(value[key])) { found = value[key]; break; }
  });
  return found;
}

function findMarker(response) {
  let marker = null;
  visit(response, value => {
    if (marker || typeof value !== 'string') return;
    const match = value.match(/CONTROL_PLANE_CHECK_RESULT:(\{[^\r\n]*\})/);
    if (match) { try { marker = JSON.parse(match[1]); } catch { /* malformed marker is ignored */ } }
  });
  return marker;
}

try {
  const input = readStdinJson();
  if (input.hook_event_name !== 'PostToolUse') process.exit(0);
  const repo = findRepoRoot(input.cwd ?? process.cwd());
  const policy = loadJson(path.join(repo, 'docs/control-plane/policy.json'));
  const mcpResultBudgetBytes = policy.mcp.maximum_result_utf8_bytes;
  const toolName = String(input.tool_name ?? '');

  if (toolName === 'Bash') {
    const command = String(input.tool_input?.command ?? '');
    const wrapper = command.match(/verify-command\.mjs\s+--id\s+([a-z0-9][a-z0-9-]{0,79})\s+--(?:\s|$)/i);
    if (wrapper) {
      let record = null;
      const resultPath = path.join(repo, 'verification/control-plane/check-results', `${wrapper[1]}.json`);
      try { record = JSON.parse(fs.readFileSync(resultPath, 'utf8')); } catch { /* missing record remains unknown */ }
      const marker = findMarker(input.tool_response);
      const valid = record?.id === wrapper[1] && record?.status === policy.verification_statuses.check[0] && record?.exit_code === 0 && record?.completed_at && marker?.id === wrapper[1] && marker?.exit_code === 0 && marker?.status === policy.verification_statuses.check[0];
      if (valid) {
        process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: `DETERMINISTIC CHECK STATUS: PASS (id=${wrapper[1]}, exit_code=0).` } }));
      } else {
        const status = record?.status === policy.verification_statuses.check[1] || marker?.status === policy.verification_statuses.check[1] || Number.isInteger(record?.exit_code) && record.exit_code !== 0 ? policy.verification_statuses.check[1] : policy.verification_statuses.check[2];
        process.stdout.write(JSON.stringify({ continue: false, hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: `DETERMINISTIC CHECK STATUS: ${status}. Only a completed structured result with numeric exit_code 0 is PASS.` } }));
      }
      process.exit(0);
    }

    const verificationCommand = /\b(build|compile|typecheck|lint|test|vitest|jest|pytest|tsc)\b/i.test(command);
    if (verificationCommand) {
      const code = explicitExitCode(input.tool_response);
      if (code === null) process.stdout.write(JSON.stringify({ continue: false, hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'DETERMINISTIC CHECK STATUS: UNKNOWN. This PostToolUse payload has no numeric exit code. Rerun through scripts/control-plane/verify-command.mjs; command output alone is not a pass.' } }));
      else if (code !== 0) process.stdout.write(JSON.stringify({ continue: false, hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: `DETERMINISTIC CHECK STATUS: FAIL (exit_code=${code}).` } }));
      else process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'DETERMINISTIC CHECK STATUS: PASS (numeric exit_code=0).' } }));
    }
    process.exit(0);
  }

  if (/^mcp__/.test(toolName)) {
    const bytes = Buffer.byteLength(JSON.stringify(input.tool_response ?? null), 'utf8');
    if (bytes > mcpResultBudgetBytes) {
      process.stdout.write(JSON.stringify({ continue: false, hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: `MCP result was dropped because its serialized UTF-8 size exceeded the ${mcpResultBudgetBytes.toLocaleString('en-US')}-byte context budget. Repeat with a narrower filter, selected fields, and a smaller page.` } }));
    }
  }
} catch (error) {
  process.stderr.write(`post-tool-use guard failed: ${error.message}\n`);
  process.exit(2);
}
