import path from 'node:path';
import { activePhase, canonicalFileDigest, currentBranch, currentHead, findRepoRoot, loadPhaseState, statusEntries } from './lib.mjs';

try {
  const root = findRepoRoot(process.argv[2] ?? process.cwd());
  const state = loadPhaseState(root);
  const phase = activePhase(state);
  if (!phase) throw new Error('no active phase');
  const charter = canonicalFileDigest(path.join(root, 'docs/PROJECT_CHARTER.md'));
  if (charter !== state.charter_sha256) throw new Error('charter digest mismatch');
  const dirty = statusEntries(root);
  const result = {
    status: dirty.length ? 'BLOCKED' : 'READY',
    repo_root: root,
    head: currentHead(root),
    branch: currentBranch(root),
    active_phase: phase.id,
    active_phase_title: phase.title,
    goal_file: phase.goal_file,
    report_file: phase.report_file,
    charter_sha256: charter,
    dirty_non_evidence: dirty,
    issues: dirty.length ? ['working tree contains non-evidence changes; use a clean worktree or reconcile ownership before execution'] : []
  };
  console.log(JSON.stringify(result, null, 2));
  process.exit(dirty.length ? 2 : 0);
} catch (error) {
  console.log(JSON.stringify({ status: 'BLOCKED', issues: [error.message] }, null, 2));
  process.exit(2);
}
