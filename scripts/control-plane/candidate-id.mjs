import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EVIDENCE_PREFIXES, currentHead, findRepoRoot, git, isEvidencePath, loadJson, objectDigest, parseArg, repoPath, sha256, toPosix, writeJsonAtomic } from './lib.mjs';
import { loadTaskBundle, validateTaskId } from './task-evidence.mjs';
import { classifyPostDiff, reconcilePostDiffRisk } from './post-diff-risk.mjs';

function listUntracked(root) {
  const result = git(root, 'ls-files', '--others', '--exclude-standard', '-z');
  if (result.status !== 0) throw new Error(result.stderr.trim() || 'cannot list untracked files');
  return result.stdout.split('\0').filter(Boolean).map(toPosix).filter(p => !isEvidencePath(p)).sort();
}

export function buildCandidate(root, snapshotPath, taskId) {
  validateTaskId(taskId);
  const taskBundle = loadTaskBundle(root, taskId);
  const policy = loadJson(repoPath(root, 'docs/control-plane/policy.json'));
  const snapshot = loadJson(snapshotPath);
  if (snapshot.schema_version !== policy.evidence_schema_versions.snapshot || !snapshot.snapshot_id || !snapshot.git_baseline || !snapshot.goal_digest) throw new Error('invalid execution snapshot');
  const exclusions = EVIDENCE_PREFIXES.map(prefix => `:(exclude)${prefix}**`);
  const diff = git(root, 'diff', '--binary', '--full-index', '--no-ext-diff', snapshot.git_baseline, '--', '.', ...exclusions);
  if (diff.status !== 0) throw new Error(diff.stderr.trim() || 'cannot compute candidate diff');
  const untracked = listUntracked(root).map(rel => ({ path: rel, sha256: sha256(fs.readFileSync(repoPath(root, rel))) }));
  const observedRisk = classifyPostDiff(root, snapshot);
  const effectiveRoute = loadJson(path.join(taskBundle.directory, 'route.json'));
  const roleLanes = { reviewer:'review', security_auditor:'security-review', verifier:'verifier', evaluator:'evaluation' };
  const postDiffRisk = {
    ...observedRisk,
    required_lanes: [...new Set([...observedRisk.required_lanes, ...(effectiveRoute.roles ?? []).map(role => roleLanes[role]).filter(Boolean)])].sort(),
    initial_level: effectiveRoute.initial_risk_level ?? effectiveRoute.signals?.post_diff_risk?.initial_level ?? 'low',
    effective_level: effectiveRoute.signals?.post_diff_risk?.effective_level ?? observedRisk.level,
    escalated: effectiveRoute.signals?.post_diff_risk?.escalated ?? false
  };
  const record = {
    schema_version: policy.evidence_schema_versions.candidate,
    baseline_commit: snapshot.git_baseline,
    current_head: currentHead(root),
    goal_digest: snapshot.goal_digest,
    snapshot_id: snapshot.snapshot_id,
    task_id: taskId,
    task_bundle_id: taskBundle.manifest.bundle_id,
    tracked_diff_sha256: sha256(diff.stdout),
    untracked,
    post_diff_risk: postDiffRisk
  };
  record.candidate_id = objectDigest(record);
  return record;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    const args = process.argv.slice(2);
    const root = findRepoRoot(parseArg(args, '--repo-root') ?? process.cwd());
    const snapshotArg = parseArg(args, '--snapshot', { required: true });
    const taskId = parseArg(args, '--task-id', { required: true });
    const snapshotPath = path.isAbsolute(snapshotArg) ? snapshotArg : path.join(root, snapshotArg);
    const snapshot = loadJson(snapshotPath);
    const postDiffRisk = reconcilePostDiffRisk(root, taskId, snapshot);
    const record = buildCandidate(root, snapshotPath, taskId);
    const out = parseArg(args, '--out') ?? `verification/control-plane/tasks/${taskId}/candidates/${record.candidate_id}.json`;
    writeJsonAtomic(path.isAbsolute(out) ? out : path.join(root, out), record);
    console.log(JSON.stringify({ ...record, reconciled_post_diff_risk: postDiffRisk }, null, 2));
  } catch (error) {
    console.error(`candidate identity failed: ${error.message}`);
    process.exit(2);
  }
}
