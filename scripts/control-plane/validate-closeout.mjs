import fs from 'node:fs';
import path from 'node:path';
import { buildCandidate } from './candidate-id.mjs';
import { activePhase, canonicalFileDigest, loadJson, loadPhaseState, objectDigest, repoPath } from './lib.mjs';

export function validateCloseout(root, phaseNumber, manifestPath) {
  const fail = message => { throw new Error(`invalid closeout manifest: ${message}`); };
  const reportsRoot = repoPath(root, 'verification/phase-reports');
  const resolvedManifest = path.resolve(manifestPath);
  if (resolvedManifest !== reportsRoot && !resolvedManifest.startsWith(reportsRoot + path.sep)) fail('manifest must live under verification/phase-reports/');
  const state = loadPhaseState(root);
  if (state.active_phase !== phaseNumber) throw new Error(`phase ${phaseNumber} is not active`);
  const phase = activePhase(state);
  const manifest = loadJson(resolvedManifest);
  if (manifest.schema_version !== 2 || manifest.phase !== phaseNumber || manifest.phase_status !== 'COMPLETE') fail('schema_version=2, active phase, and COMPLETE are required');

  const charter = canonicalFileDigest(path.join(root, 'docs/PROJECT_CHARTER.md'));
  const goal = canonicalFileDigest(path.join(root, phase.goal_file));
  if (manifest.charter_digest !== charter) fail('charter_digest does not match current charter');
  if (manifest.goal_digest !== goal) fail('goal_digest does not match current active goal');

  if (typeof manifest.qualification_artifact !== 'string' || !manifest.qualification_artifact.startsWith('verification/control-plane/')) fail('qualification_artifact must be repository control-plane evidence');
  if (typeof manifest.snapshot_artifact !== 'string' || !manifest.snapshot_artifact.startsWith('verification/control-plane/snapshots/')) fail('snapshot_artifact must be a repository snapshot evidence path');
  let qualificationPath, snapshotPath;
  try {
    qualificationPath = repoPath(root, manifest.qualification_artifact);
    snapshotPath = repoPath(root, manifest.snapshot_artifact);
  } catch (error) {
    fail(error.message);
  }
  if (!fs.existsSync(qualificationPath) || !fs.existsSync(snapshotPath)) fail('qualification_artifact and snapshot_artifact must exist');
  const qualification = loadJson(qualificationPath);
  const snapshot = loadJson(snapshotPath);
  const { qualification_id: qualificationId, ...qualificationPayload } = qualification;
  if (!qualificationId || objectDigest(qualificationPayload) !== qualificationId) fail('qualification artifact integrity check failed');
  if (qualification.status !== 'QUALIFIED' || qualificationId !== manifest.qualification_id) fail('qualification is missing, stale, or not QUALIFIED');
  if (qualification.issues?.length) fail('QUALIFIED artifact contains unresolved issues');
  if (qualification.project_runtime?.project_layer_loaded !== true || qualification.project_runtime?.permission_mode !== 'default') fail('qualification does not bind the default trusted project runtime posture');
  for (const check of ['strict_config','permission_profile','rules']) if (qualification.runtime_checks?.[check]?.ok !== true) fail(`qualification runtime check ${check} is not proven`);

  const { snapshot_id: snapshotId, ...snapshotPayload } = snapshot;
  if (!snapshotId || objectDigest(snapshotPayload) !== snapshotId) fail('snapshot artifact integrity check failed');
  if (snapshotId !== manifest.snapshot_id || snapshot.qualification_id !== manifest.qualification_id) fail('snapshot identity does not reconcile with qualification');
  if (snapshot.git_baseline !== qualification.git_head) fail('snapshot baseline differs from qualified Git HEAD');
  if (snapshot.active_phase !== phaseNumber || snapshot.goal_digest !== goal || snapshot.charter_digest !== charter) fail('snapshot does not bind current phase/goal/charter');
  for (const [rel, digest] of Object.entries(snapshot.source_digests ?? {})) {
    let current;
    try { current = canonicalFileDigest(repoPath(root, rel)); } catch (error) { fail(`SNAPSHOT_STALE: ${rel}: ${error.message}`); }
    if (current !== digest) fail(`SNAPSHOT_STALE: control-plane source changed after snapshot: ${rel}`);
  }

  const expectedCandidate = buildCandidate(root, snapshotPath);
  if (expectedCandidate.candidate_id !== manifest.candidate_id) fail('EVIDENCE_STALE: current candidate differs from manifest candidate_id');

  const contracts = loadJson(path.join(root, 'docs/control-plane/phase-contracts.json'));
  const contract = contracts.phases.find(p => p.phase === phaseNumber);
  if (!contract || contract.goal_digest !== goal) fail('machine phase contract is missing or stale');
  const expectedCriteria = contract.criteria.map(c => c.id).sort();
  if (!Array.isArray(manifest.acceptance)) fail('acceptance must be an array');
  const seen = manifest.acceptance.map(x => x?.criterion_id).sort();
  if (JSON.stringify(seen) !== JSON.stringify(expectedCriteria)) fail(`acceptance criteria must exactly match phase contract: ${expectedCriteria.join(', ')}`);
  const allowed = new Set(['PASS', 'NOT_APPLICABLE']);
  for (const item of manifest.acceptance) {
    if (!allowed.has(item.disposition)) fail(`criterion ${item.criterion_id} is ${item.disposition}`);
    if (item.disposition === 'PASS' && (!item.evidence || typeof item.evidence !== 'string')) fail(`PASS criterion ${item.criterion_id} requires evidence`);
    if (item.disposition === 'NOT_APPLICABLE' && (!item.rationale || typeof item.rationale !== 'string')) fail(`NOT_APPLICABLE criterion ${item.criterion_id} requires rationale`);
  }

  if (!Array.isArray(manifest.verification) || !manifest.verification.length) fail('verification evidence is required');
  for (const item of manifest.verification) {
    if (!item || typeof item.command !== 'string' || !item.command.trim() || item.exit_code !== 0 || typeof item.evidence !== 'string' || !item.evidence.trim()) fail('every verification item requires an executed command, exit_code 0, and evidence');
  }
  for (const role of ['review', 'verifier', 'evaluation']) {
    const record = manifest[role];
    if (!record || record.verdict !== 'PASS' || record.candidate_id !== manifest.candidate_id || typeof record.evidence !== 'string' || !record.evidence.trim()) fail(`${role} must PASS the same candidate_id with evidence`);
  }
  if (!Array.isArray(manifest.unresolved_blockers) || manifest.unresolved_blockers.length !== 0) fail('unresolved_blockers must be empty');
  return { manifest, phase, qualification, snapshot, candidate: expectedCandidate, contract };
}
