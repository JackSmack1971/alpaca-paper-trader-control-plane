import path from 'node:path';
import { activePhase, canonicalFileDigest, currentBranch, currentHead, findRepoRoot, loadJson, loadPhaseState, workingTreeDigest } from './lib.mjs';

try {
  const root = findRepoRoot(process.argv[2] ?? process.cwd());
  const state = loadPhaseState(root);
  const phase = activePhase(state);
  if (!phase) throw new Error('no active phase');
  const policy = loadJson(path.join(root, 'docs/control-plane/policy.json'));
  const charter = canonicalFileDigest(path.join(root, 'docs/PROJECT_CHARTER.md'));
  if (charter !== state.charter_sha256) throw new Error('charter digest mismatch');
  const workingTree = workingTreeDigest(root);
  const dirty = workingTree.entries;
  const result = {
    status: policy.verification_statuses.preflight[0],
    repo_root: root,
    head: currentHead(root),
    branch: currentBranch(root),
    active_phase: phase.id,
    active_phase_title: phase.title,
    goal_file: phase.goal_file,
    report_file: phase.report_file,
    charter_sha256: charter,
    dirty_non_evidence: dirty,
    baseline_kind: 'current-main-working-tree',
    working_tree_sha256: workingTree.digest,
    issues: []
  };
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
} catch (error) {
  console.log(JSON.stringify({ status: 'BLOCKED', issues: [error.message] }, null, 2));
  process.exit(2);
}
