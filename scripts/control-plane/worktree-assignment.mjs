import fs from 'node:fs';
import path from 'node:path';
import { currentHead, findRepoRoot, git, gitCommonDir, loadJson, objectDigest, parseArg, toPosix, writeJsonAtomic } from './lib.mjs';

function scopesOverlap(a, b) {
  const normalize = x => toPosix(x).replace(/^\.\//,'').replace(/\/$/,'');
  const aa = normalize(a), bb = normalize(b);
  return aa === '.' || bb === '.' || aa === bb || aa.startsWith(bb + '/') || bb.startsWith(aa + '/');
}

function registryDir(root) {
  return path.join(gitCommonDir(root), 'codex-control-plane', 'worktree-assignments');
}

function mirror(root, record) {
  writeJsonAtomic(path.join(root, 'verification/control-plane/worktrees', `${record.assignment_id}.json`), record);
}

try {
  const args = process.argv.slice(2);
  const root = findRepoRoot(parseArg(args, '--repo-root') ?? process.cwd());
  const shared = registryDir(root);
  fs.mkdirSync(shared, { recursive: true });

  const release = parseArg(args, '--release');
  if (release) {
    const file = path.join(shared, `${release}.json`);
    if (!fs.existsSync(file)) throw new Error(`unknown shared assignment ${release}`);
    const record = loadJson(file);
    if (record.active !== true) throw new Error(`assignment ${release} is already inactive`);
    record.active = false;
    record.released_at = new Date().toISOString();
    writeJsonAtomic(file, record);
    mirror(root, record);
    console.log(JSON.stringify(record, null, 2));
    process.exit(0);
  }

  const owner = parseArg(args, '--owner', { required: true });
  const unit = parseArg(args, '--unit', { required: true });
  const scope = (parseArg(args, '--scope', { required: true }) || '').split(',').map(x => x.trim()).filter(Boolean);
  if (!scope.length) throw new Error('--scope requires at least one repository-relative path');
  if (scope.some(x => path.isAbsolute(x) || toPosix(x).split('/').includes('..'))) throw new Error('--scope entries must be repository-relative and may not contain ..');

  const worktreeResult = git(root, 'rev-parse', '--show-toplevel');
  if (worktreeResult.status !== 0) throw new Error(worktreeResult.stderr.trim() || 'cannot resolve worktree');
  const worktree = path.resolve(worktreeResult.stdout.trim());
  const branchResult = git(root, 'branch', '--show-current');
  const branch = branchResult.status === 0 && branchResult.stdout.trim() ? branchResult.stdout.trim() : null;

  for (const name of fs.readdirSync(shared).filter(x => x.endsWith('.json'))) {
    const prior = loadJson(path.join(shared, name));
    if (prior.active !== true) continue;
    const sameWorktree = path.resolve(prior.worktree) === worktree;
    if (sameWorktree && prior.owner !== owner) throw new Error(`worktree already has active owner ${prior.owner} via assignment ${prior.assignment_id}`);
    if (!sameWorktree && prior.scope.some(a => scope.some(b => scopesOverlap(a,b)))) throw new Error(`write scope overlaps active assignment ${prior.assignment_id} owned by ${prior.owner}`);
  }

  const identity = { schema_version: 1, unit_of_work: unit, base_sha: currentHead(root), worktree, branch, owner, scope, integration_target: parseArg(args, '--integration-target') ?? null };
  const record = { ...identity, assignment_id: objectDigest(identity), active: true, created_at: new Date().toISOString() };
  writeJsonAtomic(path.join(shared, `${record.assignment_id}.json`), record);
  mirror(root, record);
  console.log(JSON.stringify(record, null, 2));
} catch (error) {
  console.error(`worktree assignment failed: ${error.message}`);
  process.exit(2);
}
