import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EVIDENCE_PREFIXES, currentHead, findRepoRoot, git, isEvidencePath, loadJson, objectDigest, parseArg, repoPath, sha256, toPosix, writeJsonAtomic } from './lib.mjs';

function listUntracked(root) {
  const result = git(root, 'ls-files', '--others', '--exclude-standard', '-z');
  if (result.status !== 0) throw new Error(result.stderr.trim() || 'cannot list untracked files');
  return result.stdout.split('\0').filter(Boolean).map(toPosix).filter(p => !isEvidencePath(p)).sort();
}

export function buildCandidate(root, snapshotPath) {
  const snapshot = loadJson(snapshotPath);
  if (snapshot.schema_version !== 2 || !snapshot.snapshot_id || !snapshot.git_baseline || !snapshot.goal_digest) throw new Error('invalid execution snapshot');
  const exclusions = EVIDENCE_PREFIXES.map(prefix => `:(exclude)${prefix}**`);
  const diff = git(root, 'diff', '--binary', '--full-index', '--no-ext-diff', snapshot.git_baseline, '--', '.', ...exclusions);
  if (diff.status !== 0) throw new Error(diff.stderr.trim() || 'cannot compute candidate diff');
  const untracked = listUntracked(root).map(rel => ({ path: rel, sha256: sha256(fs.readFileSync(repoPath(root, rel))) }));
  const record = {
    schema_version: 1,
    baseline_commit: snapshot.git_baseline,
    current_head: currentHead(root),
    goal_digest: snapshot.goal_digest,
    snapshot_id: snapshot.snapshot_id,
    tracked_diff_sha256: sha256(diff.stdout),
    untracked
  };
  record.candidate_id = objectDigest(record);
  return record;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    const args = process.argv.slice(2);
    const root = findRepoRoot(parseArg(args, '--repo-root') ?? process.cwd());
    const snapshotArg = parseArg(args, '--snapshot', { required: true });
    const snapshotPath = path.isAbsolute(snapshotArg) ? snapshotArg : path.join(root, snapshotArg);
    const record = buildCandidate(root, snapshotPath);
    const out = parseArg(args, '--out');
    if (out) writeJsonAtomic(path.isAbsolute(out) ? out : path.join(root, out), record);
    console.log(JSON.stringify(record, null, 2));
  } catch (error) {
    console.error(`candidate identity failed: ${error.message}`);
    process.exit(2);
  }
}
