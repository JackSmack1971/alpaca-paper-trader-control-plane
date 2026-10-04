import fs from 'node:fs';
import path from 'node:path';
import { buildCandidate } from './candidate-id.mjs';
import { activePhase, canonicalFileDigest, loadJson, loadPhaseState, objectDigest, repoPath } from './lib.mjs';
import { loadTaskBundle, validateTaskId } from './task-evidence.mjs';

export function validateRequiredLaneEvidence(taskBundle, candidateId, taskId, taskBundleId, risk, manifest) {
  for (const lane of risk.required_lanes ?? []) {
    const manifestKey = lane === 'security-review' ? 'security_review' : lane;
    const record = manifest[manifestKey];
    if (!record || record.verdict !== 'PASS' || record.candidate_id !== candidateId || record.task_id !== taskId || record.task_bundle_id !== taskBundleId || typeof record.evidence !== 'string' || !record.evidence.trim()) throw new Error(`required post-diff lane ${lane} must PASS the same candidate and task bundle with evidence`);
    const stored = loadJson(path.join(taskBundle.directory, `${lane}.${candidateId}.json`));
    if (objectDigest(stored) !== objectDigest(record)) throw new Error(`manifest evidence differs from required ${lane} task artifact`);
  }
}

export function validateCloseout(root, phaseNumber, manifestPath) {
  const fail = message => { throw new Error(`invalid closeout manifest: ${message}`); };
  const reportsRoot = repoPath(root, 'verification/phase-reports');
  const resolvedManifest = path.resolve(manifestPath);
  if (resolvedManifest !== reportsRoot && !resolvedManifest.startsWith(reportsRoot + path.sep)) fail('manifest must live under verification/phase-reports/');
  const state = loadPhaseState(root);
  const policy = loadJson(path.join(root, 'docs/control-plane/policy.json'));
  if (state.active_phase !== phaseNumber) throw new Error(`phase ${phaseNumber} is not active`);
  const phase = activePhase(state);
  const manifest = loadJson(resolvedManifest);
  if (manifest.schema_version !== policy.evidence_schema_versions.closeout_manifest || manifest.phase !== phaseNumber || manifest.phase_status !== 'COMPLETE') fail('closeout schema version, active phase, and COMPLETE are required');
  let taskBundle;
  try {
    validateTaskId(manifest.task_id);
    taskBundle = loadTaskBundle(root, manifest.task_id);
  } catch (error) { fail(`closeout must bind a valid task evidence bundle: ${error.message}`); }
  if (manifest.task_bundle_id !== taskBundle.manifest.bundle_id) fail('task_bundle_id does not match the selected task evidence bundle');
  if (!/^[a-f0-9]{64}$/.test(String(manifest.candidate_id ?? ''))) fail('candidate_id must be a SHA-256 identity');
  const taskRoute = loadJson(path.join(taskBundle.directory, 'route.json'));
  if (taskRoute.task_id !== manifest.task_id || taskRoute.bundle_id !== manifest.task_bundle_id || taskRoute.evidence_bundle !== `verification/control-plane/tasks/${manifest.task_id}`) fail('task route does not bind the selected evidence bundle');
  const taskCandidate = loadJson(path.join(taskBundle.directory, 'candidates', `${manifest.candidate_id}.json`));
  if (taskCandidate.candidate_id !== manifest.candidate_id || taskCandidate.task_bundle_id !== manifest.task_bundle_id) fail('EVIDENCE_STALE: task evidence bundle candidate does not match closeout');
  const taskResults = loadJson(path.join(taskBundle.directory, 'test-results.json'));
  if (taskResults.schema_version !== policy.evidence_schema_versions.task_acceptance || taskResults.task_id !== manifest.task_id || taskResults.bundle_id !== manifest.task_bundle_id || taskResults.status !== policy.verification_statuses.criterion[0] || !Array.isArray(taskResults.criteria) || !taskResults.criteria.length) fail('task acceptance/test results are missing, incomplete, or belong to another task');
  for (const item of taskResults.criteria) {
    if (item.status === policy.verification_statuses.criterion[2]) {
      if (!item.rationale?.trim()) fail(`task criterion ${item.criterion_id} needs a NOT_APPLICABLE rationale`);
    } else if (item.status === policy.verification_statuses.criterion[0]) {
      if (!item.evidence?.check_id || item.evidence.exit_code !== 0) fail(`task criterion ${item.criterion_id} has no executed check evidence`);
      if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(item.evidence.check_id)) fail(`task criterion ${item.criterion_id} has an invalid check identity`);
      const check = loadJson(path.join(taskBundle.directory, 'checks', `${item.evidence.check_id}.json`));
      if (check.task_id !== manifest.task_id || check.bundle_id !== manifest.task_bundle_id || check.status !== 'PASS' || check.exit_code !== 0 || !check.completed_at) fail(`task criterion ${item.criterion_id} references invalid or foreign check evidence`);
    } else fail(`task criterion ${item.criterion_id} is not complete`);
  }

  const charter = canonicalFileDigest(path.join(root, 'docs/PROJECT_CHARTER.md'));
  const goal = canonicalFileDigest(path.join(root, phase.goal_file));
  if (manifest.charter_digest !== charter) fail('charter_digest does not match current charter');
  if (manifest.goal_digest !== goal) fail('goal_digest does not match current active goal');

  if (typeof manifest.snapshot_artifact !== 'string' || !manifest.snapshot_artifact.startsWith('verification/control-plane/snapshots/')) fail('snapshot_artifact must be a repository snapshot evidence path');
  let snapshotPath;
  try {
    snapshotPath = repoPath(root, manifest.snapshot_artifact);
  } catch (error) {
    fail(error.message);
  }
  if (!fs.existsSync(snapshotPath)) fail('snapshot_artifact must exist');
  const snapshot = loadJson(snapshotPath);

  const { snapshot_id: snapshotId, ...snapshotPayload } = snapshot;
  if (snapshot.schema_version !== policy.evidence_schema_versions.snapshot || !snapshotId || objectDigest(snapshotPayload) !== snapshotId) fail('execution snapshot integrity check failed');
  if (snapshotId !== manifest.snapshot_id) fail('snapshot identity does not match manifest');
  if (snapshot.active_phase !== phaseNumber || snapshot.goal_digest !== goal || snapshot.charter_digest !== charter) fail('snapshot does not bind current phase/goal/charter');
  for (const [rel, digest] of Object.entries(snapshot.source_digests ?? {})) {
    let current;
    try { current = canonicalFileDigest(repoPath(root, rel)); } catch (error) { fail(`SNAPSHOT_STALE: ${rel}: ${error.message}`); }
    if (current !== digest) fail(`SNAPSHOT_STALE: control-plane source changed after snapshot: ${rel}`);
  }

  const expectedCandidate = buildCandidate(root, snapshotPath, manifest.task_id);
  if (expectedCandidate.candidate_id !== manifest.candidate_id) fail('EVIDENCE_STALE: current candidate differs from manifest candidate_id');
  const frozenRisk = taskCandidate.post_diff_risk;
  const routeRisk = taskRoute.signals?.post_diff_risk;
  if (!frozenRisk?.classification_id || routeRisk?.classification_id !== frozenRisk.classification_id) fail('post-diff risk classification is missing or differs from the frozen candidate');
  if (objectDigest([...(routeRisk.required_lanes ?? [])].sort()) !== objectDigest([...(frozenRisk.required_lanes ?? [])].sort())) fail('required post-diff evidence lanes differ between route and frozen candidate');

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
    if (!record || record.verdict !== 'PASS' || record.candidate_id !== manifest.candidate_id || record.task_id !== manifest.task_id || record.task_bundle_id !== manifest.task_bundle_id || typeof record.evidence !== 'string' || !record.evidence.trim()) fail(`${role} must PASS the same candidate_id and task evidence bundle with evidence`);
    let stored;
    try { stored = loadJson(path.join(taskBundle.directory, `${role}.${manifest.candidate_id}.json`)); } catch { fail(`${role} evidence is missing from the task bundle`); }
    if (objectDigest(stored) !== objectDigest(record)) fail(`${role} manifest evidence differs from the task bundle artifact`);
  }
  try { validateRequiredLaneEvidence(taskBundle, manifest.candidate_id, manifest.task_id, manifest.task_bundle_id, frozenRisk, manifest); }
  catch (error) { fail(error.message); }
  const verificationArtifact = loadJson(path.join(taskBundle.directory, `verification.${manifest.candidate_id}.json`));
  if (verificationArtifact.status !== 'PASS' || verificationArtifact.task_id !== manifest.task_id || verificationArtifact.task_bundle_id !== manifest.task_bundle_id || verificationArtifact.candidate_id !== manifest.candidate_id || objectDigest(verificationArtifact.commands) !== objectDigest(manifest.verification)) fail('verification evidence must match the task bundle and closeout command records');
  if (!Array.isArray(manifest.unresolved_blockers) || manifest.unresolved_blockers.length !== 0) fail('unresolved_blockers must be empty');
  return { manifest, phase, snapshot, candidate: expectedCandidate, contract };
}
