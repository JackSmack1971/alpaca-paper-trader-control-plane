import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { currentHead, findRepoRoot, parseArg, toPosix } from './lib.mjs';

function runGit(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || `git ${args[0]} failed`).trim());
  return result.stdout.trim();
}

try {
  const args = process.argv.slice(2);
  const root = findRepoRoot(parseArg(args, '--repo-root') ?? process.cwd());
  const name = parseArg(args, '--name', { required: true });
  if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(name)) throw new Error('--name must be a lowercase slug (letters, numbers, hyphens)');
  const owner = parseArg(args, '--owner', { required: true });
  const unit = parseArg(args, '--unit', { required: true });
  const scope = (parseArg(args, '--scope', { required: true }) ?? '').split(',').map(x => toPosix(x.trim()).replace(/^\.\//, '').replace(/\/$/, '')).filter(Boolean);
  if (!scope.length || scope.some(x => path.isAbsolute(x) || x.split('/').includes('..'))) throw new Error('--scope must contain repository-relative paths without ..');

  const worktreesRoot = path.resolve(root, '.codex', 'worktrees');
  const target = path.resolve(worktreesRoot, name);
  if (!target.startsWith(worktreesRoot + path.sep)) throw new Error('worktree path escapes .codex/worktrees');
  if (fs.existsSync(target)) throw new Error(`worktree destination already exists: ${target}`);
  const branch = `codex/${name}`;
  const base = parseArg(args, '--base') ?? 'HEAD';
  const baseSha = runGit(root, ['rev-parse', '--verify', `${base}^{commit}`]);

  fs.mkdirSync(worktreesRoot, { recursive: true });
  runGit(root, ['worktree', 'add', '-b', branch, target, baseSha]);
  try {
    const assignment = spawnSync(process.execPath, [path.join(root, 'scripts/control-plane/worktree-assignment.mjs'), '--repo-root', target, '--owner', owner, '--unit', unit, '--scope', scope.join(','), '--integration-target', root], { cwd: target, encoding: 'utf8', windowsHide: true });
    if (assignment.status !== 0) throw new Error((assignment.stderr || assignment.stdout || 'assignment registration failed').trim());
    console.log(JSON.stringify({ worktree: target, branch, base_sha: baseSha, assignment: JSON.parse(assignment.stdout) }, null, 2));
  } catch (error) {
    runGit(root, ['worktree', 'remove', '--force', target]);
    runGit(root, ['branch', '-D', branch]);
    throw error;
  }
} catch (error) {
  console.error(`worktree creation failed: ${error.message}`);
  process.exit(2);
}
