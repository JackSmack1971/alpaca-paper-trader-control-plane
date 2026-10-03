import { readStdinJson } from '../../scripts/control-plane/lib.mjs';

try {
  const input = readStdinJson();
  if (input.hook_event_name !== 'PreToolUse' || input.tool_name !== 'Bash') process.exit(0);
  const command = String(input.tool_input?.command ?? '');
  const blocked = [
    { re: /(^|[;&|]\s*)git\s+reset\s+--hard\b/i, reason: 'git reset --hard can discard user work' },
    { re: /(^|[;&|]\s*)git\s+clean\s+[^\n]*(?:-f|--force)/i, reason: 'git clean --force can delete untracked user work' },
    { re: /(^|[;&|]\s*)git\s+push\s+[^\n]*(?:--force(?:-with-lease)?|-f)\b/i, reason: 'force-push is forbidden by repository policy' },
    { re: /(^|[;&|]\s*)git\s+checkout\s+--\s+(?:\.|:\/)/i, reason: 'bulk checkout restore can discard worktree changes' },
    { re: /(^|[;&|]\s*)git\s+restore\s+(?:--worktree\s+)?(?:\.|:\/)/i, reason: 'bulk restore can discard worktree changes' }
  ];
  const hit = blocked.find(item => item.re.test(command));
  if (!hit) process.exit(0);
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `${hit.reason}. Use a scoped, reversible alternative or obtain an explicit operator decision.` } }));
} catch (error) {
  process.stderr.write(`pre-tool-use guard failed: ${error.message}\n`);
  process.exit(1);
}
