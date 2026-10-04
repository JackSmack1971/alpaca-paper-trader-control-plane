import fs from 'node:fs';
import path from 'node:path';
import { loadJson, objectDigest, repoPath, sha256, stableStringify, writeJsonAtomic } from './lib.mjs';

export function validateTaskId(id) {
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(String(id ?? ''))) throw new Error('task id must be a stable lowercase slug');
  return id;
}

export function taskBundleRelative(id) {
  validateTaskId(id);
  return `verification/control-plane/tasks/${id}`;
}

export function taskBundlePath(root, id) {
  return repoPath(root, taskBundleRelative(id));
}

export function ensureTaskBundle(root, id, intake) {
  const policy = loadJson(repoPath(root, 'docs/control-plane/policy.json'));
  const directory = taskBundlePath(root, id);
  fs.mkdirSync(directory, { recursive: true });
  const manifestPath = path.join(directory, 'bundle.json');
  const intakeDigest = objectDigest(intake);
  const bundleId = sha256(stableStringify({ schema_version: policy.evidence_schema_versions.task_bundle, task_id: id, intake_digest: intakeDigest }));
  if (fs.existsSync(manifestPath)) {
    const existing = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (existing.task_id !== id || existing.bundle_id !== bundleId) throw new Error(`task id ${id} already belongs to a different intake`);
  } else {
    writeJsonAtomic(manifestPath, {
      schema_version: policy.evidence_schema_versions.task_bundle, task_id: id, bundle_id: bundleId, intake_digest: intakeDigest,
      artifacts: {
        intake: 'intake.json', route: 'route.json', candidates: 'candidates/', acceptance: 'test-results.json',
        checks: 'checks/', review: 'review.<candidate_id>.json', security_review: 'security-review.<candidate_id>.json', verifier: 'verifier.<candidate_id>.json', verification: 'verification.<candidate_id>.json', evaluation: 'evaluation.<candidate_id>.json'
      }
    });
  }
  writeJsonAtomic(path.join(directory, 'intake.json'), intake);
  return { directory, relative: taskBundleRelative(id), bundle_id: bundleId, intake_digest: intakeDigest };
}

export function loadTaskBundle(root, id) {
  const policy = loadJson(repoPath(root, 'docs/control-plane/policy.json'));
  const directory = taskBundlePath(root, id);
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'bundle.json'), 'utf8'));
  if (manifest.schema_version !== policy.evidence_schema_versions.task_bundle || manifest.task_id !== id || !manifest.bundle_id || !manifest.intake_digest) throw new Error(`invalid task evidence bundle for ${id}`);
  const intake = JSON.parse(fs.readFileSync(path.join(directory, 'intake.json'), 'utf8'));
  if (objectDigest(intake) !== manifest.intake_digest) throw new Error(`task intake digest mismatch for ${id}`);
  return { directory, manifest, intake };
}
