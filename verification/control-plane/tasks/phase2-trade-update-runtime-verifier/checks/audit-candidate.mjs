import path from 'node:path';
import fs from 'node:fs';
import { findRepoRoot, loadJson, objectDigest, sha256 } from '../../../../../scripts/control-plane/lib.mjs';
import { buildCandidate } from '../../../../../scripts/control-plane/candidate-id.mjs';
const root = findRepoRoot(process.cwd());
const task = 'phase2-trade-update-runtime-verifier';
const bundleId = '49ed08744e4a244211a60d19758f97124498cf90a5a768898917df9449fc4e63';
const candidateId = '9ddc7a48a8a1f1c9dfebb19a95d45389b6105d1bc6f21f3664c136aa928d5da0';
const dir = path.join(root, 'verification/control-plane/tasks', task);
const candidate = loadJson(path.join(dir, 'candidates', `${candidateId}.json`));
const identity = { ...candidate }; delete identity.candidate_id;
if (candidate.task_id !== task || candidate.task_bundle_id !== bundleId || objectDigest(identity) !== candidateId) throw new Error('candidate identity or task binding mismatch');
const snapshot = path.join(root, 'verification/control-plane/snapshots', `${candidate.snapshot_id}.json`);
const recomputed = buildCandidate(root, snapshot, task);
if (recomputed.candidate_id !== candidateId || recomputed.tracked_diff_sha256 !== candidate.tracked_diff_sha256) throw new Error('recomputed candidate or tracked diff mismatch');
const mismatches = [];
for (const entry of candidate.untracked) {
  const p = path.join(root, entry.path);
  if (!fs.existsSync(p) || sha256(fs.readFileSync(p)) !== entry.sha256) mismatches.push(entry.path);
}
if (mismatches.length) throw new Error(`manifest hash mismatch: ${mismatches.join(', ')}`);
const ids = ['candidate-freeze-redirect-guard', 'candidate-offline-final', 'live-local-controls-redirect-guard'];
const checks = ids.map(id => loadJson(path.join(dir, 'checks', `${id}.json`)));
for (const check of checks) if (check.status !== 'PASS' || check.exit_code !== 0 || check.task_id !== task || check.bundle_id !== bundleId || !fs.existsSync(path.join(root, check.log_path))) throw new Error(`check binding/status/log invalid: ${check.id}`);
console.log(JSON.stringify({status:'PASS',candidate_id:candidateId,manifest_entries:candidate.untracked.length,manifest_mismatches:0,tracked_diff_matches:true,checks:checks.map(({id,status,exit_code})=>({id,status,exit_code}))}));

