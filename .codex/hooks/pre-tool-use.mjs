import { readStdinJson } from '../../scripts/control-plane/lib.mjs';

try {
  const input = readStdinJson();
  if (input.hook_event_name !== 'PreToolUse') process.exit(0);
  const command = String(input.tool_input?.command ?? '');
  if (/^mcp__/.test(String(input.tool_name ?? ''))) {
    const keys = [];
    const strings = [];
    const hasValue = value => value != null && (typeof value === 'string' ? value.trim().length > 0 : Array.isArray(value) ? value.length > 0 : typeof value === 'object' ? Object.keys(value).length > 0 : true);
    const walk = (value, depth = 0) => {
      if (depth > 8 || value == null) return;
      if (Array.isArray(value)) { for (const child of value) walk(child, depth + 1); return; }
      if (typeof value === 'object') {
        for (const [key, child] of Object.entries(value)) { keys.push([key.toLowerCase().replace(/[-_]/g, ''), child]); walk(child, depth + 1); }
      } else if (typeof value === 'string') strings.push(value);
    };
    walk(input.tool_input);
    const bounded = keys.some(([key, value]) => ['limit','pagesize','perpage','first','take','maxresults'].includes(key) && Number.isInteger(Number(value)) && Number(value) > 0 && Number(value) <= 100)
      || strings.some(value => /\bLIMIT\s+(?:[1-9]\d?|100)\b/i.test(value));
    const scoped = keys.some(([key, value]) => ['filter','filters','where','search','keyword','path','id','ids','recordid','symbol','project','since','until','from','to','start','end'].includes(key) && hasValue(value))
      || strings.some(value => /\bWHERE\s+\S/i.test(value));
    const toolParts = String(input.tool_name ?? '').split('__');
    const operation = toolParts.length >= 3 ? toolParts.slice(2).join('__').replace(/([a-z0-9])([A-Z])/g, '$1_$2') : '';
    const collectionTool = /(?:^|_)(?:list|search|query|select|logs?|history|events?|rows?|records?|database|export|fetch(?:_all)?|get_all|read_(?:all|many|list|rows|records)|scan)(?:_|$)/i.test(operation);
    if (collectionTool && (!bounded || !scoped)) {
      const missing = [!scoped && 'a narrow filter', !bounded && 'a page size from 1 to 100'].filter(Boolean).join(' and ');
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `MCP collection calls require ${missing}.` } }));
      process.exit(0);
    }
    process.exit(0);
  }
  if (input.tool_name !== 'Bash') process.exit(0);
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
