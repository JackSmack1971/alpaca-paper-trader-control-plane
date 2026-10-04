import { readStdinJson } from '../../scripts/control-plane/lib.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { findRepoRoot } from '../../scripts/control-plane/lib.mjs';

function deny(reason) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }));
  process.exit(0);
}

function scopeDigest(repo, scopes) {
  const entries = [];
  const visit = (absolute, relative) => {
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) throw new Error(`registered debug scope contains a symlink: ${relative}`);
    if (stat.isDirectory()) for (const name of fs.readdirSync(absolute).sort()) visit(path.join(absolute, name), `${relative}/${name}`);
    else if (stat.isFile()) entries.push([relative, crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex')]);
  };
  for (const scope of scopes) {
    const absolute = path.resolve(repo, scope);
    let cursor = repo;
    for (const segment of path.relative(repo, absolute).split(path.sep).filter(Boolean)) {
      cursor = path.join(cursor, segment);
      if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error(`registered debug scope has a symbolic-link ancestor: ${scope}`);
    }
    visit(absolute, scope);
  }
  const payload = entries.map(([name, value]) => `${name}\0${value}`).join('\n');
  return crypto.createHash('sha256').update(payload).digest('hex');
}

function sourceMutation(input) {
  const name = String(input.tool_name ?? '').toLowerCase();
  const data = input.tool_input ?? {};
  const command = String(data.command ?? data.script ?? '');
  if (command) {
    if (/(?:^|[;&|]\s*)(?:set-content|add-content|out-file|new-item|remove-item|move-item|copy-item|rename-item|ni|sc|ac|ri|mv|cp|rm|del|erase|sed|perl|python\s+-c|node\s+-e|git\s+(?:apply|checkout\s+--|restore))\b|(?:^|[^<])>>?\s*[^\s;&|]+/i.test(command)) return { command: true, paths: null, commandText: command };
    return null;
  }
  const paths = [];
  const walk = (value, depth = 0, key = '') => {
    if (depth > 8 || value == null) return;
    if (Array.isArray(value)) { for (const child of value) walk(child, depth + 1, key); return; }
    if (typeof value === 'object') {
      for (const [childKey, child] of Object.entries(value)) {
        const normalized = childKey.toLowerCase().replace(/[-_]/g, '');
        if (/^(?:file|filepath|path|filename|target|targetfile|destination|dest)$/.test(normalized)) {
          if (typeof child === 'string') paths.push(child);
          else if (Array.isArray(child)) for (const item of child) if (typeof item === 'string') paths.push(item);
        }
        walk(child, depth + 1, childKey);
      }
      return;
    }
    if (/^(?:patch|diff|oldstring|newstring|oldtext|newtext|newcontent|content|contents|text|replacement|edits?|write|create|delete|append|insert|overwrite|update|changes?)$/i.test(key)) paths.push('__UNSCOPED_MUTATION__');
  };
  walk(data);
  const writeTool = /^(?:edit|write|create|delete|patch|apply.?patch|edit.?file|write.?file|create.?file|delete.?file|replace.?text|file.?edit)$/i.test(name);
  const mutationIntent = paths.includes('__UNSCOPED_MUTATION__');
  if (paths.some(item => item !== '__UNSCOPED_MUTATION__') && (writeTool || paths.includes('__UNSCOPED_MUTATION__'))) {
    for (let i = paths.length - 1; i >= 0; i--) if (paths[i] === '__UNSCOPED_MUTATION__') paths.splice(i, 1);
  }
  return writeTool || mutationIntent ? { command: false, paths: paths.filter(item => item !== '__UNSCOPED_MUTATION__').length ? paths.filter(item => item !== '__UNSCOPED_MUTATION__') : null } : null;
}

function allowedDebugCommand(command, taskId) {
  if (/[\r\n;&|<>$`(){}%!'`]/.test(command)) return false;
  const normalized = command.replaceAll('\\', '/');
  const escapedId = taskId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const prefix = `^\\s*node(?:\\.exe)?\\s+(?:\\.?/)?scripts/control-plane/causal-debug\\.mjs\\s+`;
  const id = `--id\\s+["']?${escapedId}["']?`;
  const signature = `--signature\\s+["']?[^"'\\x60$;&|<>()[\\]{}%!\\r\\n]+["']?\\s*$`;
  return new RegExp(`${prefix}complete\\s+${id}\\s*$`, 'i').test(normalized)
    || new RegExp(`${prefix}(?:reproduce|verify-fixed)\\s+${id}\\s+--case\\s+verification/reproductions/${escapedId}\\.mjs\\s+${signature}`, 'i').test(normalized);
}

try {
  const input = readStdinJson();
  if (input.hook_event_name !== 'PreToolUse') process.exit(0);
  const repo = findRepoRoot(input.cwd ?? process.cwd());
  const activeTaskPath = path.join(repo, 'verification/control-plane/debug-tasks/active.json');
  const tasksDir = path.dirname(activeTaskPath);
  let active = fs.existsSync(activeTaskPath) ? JSON.parse(fs.readFileSync(activeTaskPath, 'utf8')) : null;
  if (!active && fs.existsSync(tasksDir)) {
    const pending = fs.readdirSync(tasksDir).filter(name => name.endsWith('.json') && name !== 'active.json').map(name => JSON.parse(fs.readFileSync(path.join(tasksDir, name), 'utf8'))).filter(task => !['COMPLETE','CANCELLED'].includes(task.status));
    if (pending.length) active = { task_id: pending[0].id };
  }
  if (active) {
    const taskPath = path.join(tasksDir, `${active.task_id}.json`);
    if (!fs.existsSync(taskPath)) deny(`SOURCE EDIT DENIED: debugging task marker ${active.task_id} is missing or corrupted; restore task state before continuing.`);
    const task = JSON.parse(fs.readFileSync(taskPath, 'utf8'));
    const command = String(input.tool_input?.command ?? input.tool_input?.script ?? '');
    const mutation = sourceMutation(input);
    if (command && !allowedDebugCommand(command, task.id)) deny(`SOURCE EDIT DENIED for debugging task ${task.id}: shell commands cannot be safely scoped while debugging. Use path-addressed edits; only the task's causal-debug reproduce, verify-fixed, and complete commands are allowed.`);
    if (mutation) {
      const caseFile = task.case_file;
      const paths = mutation.paths ?? [];
      if (task.status === 'AWAITING_REPRODUCTION' && paths.length > 0 && paths.every(candidate => path.resolve(repo, candidate) === path.resolve(repo, caseFile))) process.exit(0);
      if (task.status !== 'REPRODUCED') deny(`SOURCE EDIT DENIED for debugging task ${task.id}: first run the registered minimal executable case and match the exact error signature. Raw output is never persisted.`);
      let currentScopeDigest;
      try { currentScopeDigest = scopeDigest(repo, task.scopes); }
      catch { deny(`SOURCE EDIT DENIED for debugging task ${task.id}: registered scope contains a symbolic link and cannot be safely bounded. Register a real, non-symlink source path.`); }
      if (task.reproduction?.scope_sha256 !== currentScopeDigest) deny(`SOURCE EDIT DENIED for debugging task ${task.id}: registered scope changed after reproduction. Rerun the minimal reproduction against the current baseline before editing.`);
      if (mutation.command) deny(`SOURCE EDIT DENIED for debugging task ${task.id}: shell command payloads do not expose a safely parsed target path. Use a path-addressed edit tool within: ${task.scopes.join(', ')}.`);
      if (!mutation.paths || mutation.paths.includes('__UNSCOPED_MUTATION__')) deny(`SOURCE EDIT DENIED for debugging task ${task.id}: this tool payload does not expose a file path that can be checked against the registered scope. Use a path-addressed edit tool within: ${task.scopes.join(', ')}.`);
      const allowed = mutation.paths.every(candidate => {
        const resolved = path.resolve(repo, candidate);
        const relative = path.relative(repo, resolved).replaceAll('\\', '/');
        return task.scopes.some(scope => relative === scope || relative.startsWith(`${scope}/`));
      });
      if (!allowed) deny(`SOURCE EDIT DENIED for debugging task ${task.id}: edit paths must remain inside registered scope (${task.scopes.join(', ')}).`);
      else {
        task.status = 'AWAITING_REPRODUCTION';
        task.last_edit_gate = { consumed_at: new Date().toISOString(), tool: String(input.tool_name ?? '') };
        fs.writeFileSync(taskPath, JSON.stringify(task, null, 2) + '\n', 'utf8');
      }
    }
  }
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
