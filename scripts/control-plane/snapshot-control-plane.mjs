import path from 'node:path';
import { activePhase, canonicalFileDigest, currentBranch, currentHead, fileDigestMap, findRepoRoot, loadJson, loadPhaseState, objectDigest, parseArg, platformKind, statusEntries, writeJsonAtomic } from './lib.mjs';

try {
  const args = process.argv.slice(2);
  const root = findRepoRoot(parseArg(args, '--repo-root') ?? process.cwd());
  const dirty = statusEntries(root);
  if (dirty.length) throw new Error('non-evidence working-tree changes exist; establish a clean worktree before compiling a snapshot');

  const state = loadPhaseState(root);
  const phase = activePhase(state);
  if (!phase) throw new Error('no active phase');
  const components = loadJson(path.join(root, 'docs/control-plane/components.json'));
  const files = [
    'AGENTS.md', 'docs/PROJECT_CHARTER.md', 'docs/control-plane/phase-state.json',
    'docs/control-plane/phase-contracts.json', 'docs/control-plane/components.json', 'docs/control-plane/capabilities.json',
    '.codex/config.toml', '.codex/hooks.json', '.codex/rules/default.rules',
    phase.goal_file,
    ...components.agents.map(x => `.codex/agents/${x}.toml`),
    ...components.skills.map(x => `.agents/skills/${x}/SKILL.md`)
  ];
  for (const hook of components.hook_scripts) files.push(hook);
  for (const script of components.lifecycle_scripts) files.push(script);

  const snapshot = {
    schema_version: 2,
    control_plane_schema: components.schema_version,
    created_at: new Date().toISOString(),
    platform: platformKind(),
    git_baseline: currentHead(root),
    git_branch: currentBranch(root),
    active_phase: phase.id,
    charter_digest: canonicalFileDigest(path.join(root, 'docs/PROJECT_CHARTER.md')),
    goal_digest: canonicalFileDigest(path.join(root, phase.goal_file)),
    phase_state_digest: canonicalFileDigest(path.join(root, 'docs/control-plane/phase-state.json')),
    source_digests: fileDigestMap(root, [...new Set(files)])
  };
  snapshot.snapshot_id = objectDigest(snapshot);
  const out = parseArg(args, '--out') ?? path.join(root, `verification/control-plane/snapshots/${snapshot.snapshot_id}.json`);
  writeJsonAtomic(out, snapshot);
  console.log(JSON.stringify(snapshot, null, 2));
} catch (error) {
  console.error(`snapshot failed: ${error.message}`);
  process.exit(2);
}
