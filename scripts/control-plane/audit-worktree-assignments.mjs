import fs from 'node:fs';
import path from 'node:path';
import { findRepoRoot, git, gitCommonDir, loadJson } from './lib.mjs';

function parseWorktrees(output) {
  return output.trim().split(/\r?\n\r?\n/).filter(Boolean).map(block => {
    const fields = Object.fromEntries(block.split(/\r?\n/).map(line => {
      const index = line.indexOf(' ');
      return index < 0 ? [line, ''] : [line.slice(0, index), line.slice(index + 1)];
    }));
    return { path: fields.worktree, branch: fields.branch?.replace(/^refs\/heads\//, '') ?? null };
  });
}

export function auditAssignments(root, records, worktrees) {
  const keyPath = value => path.resolve(value).replaceAll('\\', '/').toLowerCase().replace(/\/$/, '');
  const diagnostics = [];
  for (const record of records.filter(item => item.active === true)) {
    const issues = [];
    if (typeof record.worktree !== 'string' || !fs.existsSync(record.worktree)) issues.push('path-missing');
    const registered = worktrees.find(item => item.path && keyPath(item.path) === keyPath(record.worktree ?? ''));
    if (!registered && !issues.includes('path-missing')) issues.push('worktree-not-registered');
    if (registered && (registered.branch ?? null) !== (record.branch ?? null)) issues.push('branch-mismatch');
    if (record.branch && git(root, 'show-ref', '--verify', '--quiet', `refs/heads/${record.branch}`).status !== 0) issues.push('branch-missing');
    if (issues.length) diagnostics.push({ assignment_id: record.assignment_id, unit_of_work: record.unit_of_work, worktree: record.worktree, expected_branch: record.branch ?? null, actual_branch: registered?.branch ?? null, issues });
  }
  return { status: diagnostics.length ? 'REVIEW_REQUIRED' : 'CLEAN', active_assignments: records.filter(item => item.active === true).length, diagnostics };
}

try {
  const root = findRepoRoot(process.cwd());
  const registry = path.join(gitCommonDir(root), 'codex-control-plane', 'worktree-assignments');
  const records = fs.existsSync(registry) ? fs.readdirSync(registry).filter(name => name.endsWith('.json')).map(name => loadJson(path.join(registry, name))) : [];
  const result = git(root, 'worktree', 'list', '--porcelain');
  if (result.status !== 0) throw new Error(result.stderr.trim() || 'cannot list Git worktrees');
  console.log(JSON.stringify(auditAssignments(root, records, parseWorktrees(result.stdout)), null, 2));
} catch (error) {
  console.error(`worktree assignment audit failed: ${error.message}`);
  process.exit(2);
}
