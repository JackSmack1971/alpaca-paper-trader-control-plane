import fs from 'node:fs';
import path from 'node:path';
import { canonicalFileDigest, findRepoRoot, loadPhaseState, activePhase, objectDigest, readStdinJson, writeJsonAtomic } from '../../scripts/control-plane/lib.mjs';

try {
  const input = readStdinJson();
  const root = findRepoRoot(input.cwd ?? process.cwd());
  const state = loadPhaseState(root);
  const phase = activePhase(state);
  const charterPath = path.join(root, 'docs/PROJECT_CHARTER.md');
  const digest = canonicalFileDigest(charterPath);
  const mismatch = digest !== state.charter_sha256;
  const observation = {
    schema_version: 1,
    source: 'codex-session-start-hook',
    captured_at: new Date().toISOString(),
    project_layer_loaded: true,
    permission_mode: input.permission_mode ?? null,
    model: input.model ?? null,
    session_id_sha256: input.session_id ? objectDigest({ session_id: input.session_id }) : null,
    config_digest: canonicalFileDigest(path.join(root, '.codex/config.toml')),
    hook_digest: canonicalFileDigest(path.join(root, '.codex/hooks.json')),
    rules_digest: canonicalFileDigest(path.join(root, '.codex/rules/default.rules')),
    components_digest: canonicalFileDigest(path.join(root, 'docs/control-plane/components.json')),
    charter_digest: digest,
    active_phase: phase?.id ?? null
  };
  writeJsonAtomic(path.join(root, 'verification/control-plane/runtime/current.json'), observation);
  const additionalContext = [
    `CONTROL PLANE: active phase = ${phase?.id ?? 'unknown'} ${phase?.title ?? ''}`,
    phase ? `Active goal file: ${phase.goal_file}` : '',
    'Runtime observation recorded at verification/control-plane/runtime/current.json.',
    'Run node scripts/control-plane/qualify-control-plane.mjs before compiling an execution snapshot.',
    mismatch ? 'BLOCKER: charter digest differs from phase-state.json. Do not implement until provenance is reconciled.' : '',
    'Never claim a verification rung or test passed unless it actually ran successfully.'
  ].filter(Boolean).join('\n');
  process.stdout.write(JSON.stringify({
    continue: !mismatch,
    ...(mismatch ? { stopReason: 'Charter provenance mismatch' } : {}),
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext }
  }));
} catch (error) {
  process.stderr.write(`control-plane session hook failed: ${error.message}\n`);
  process.exit(1);
}
