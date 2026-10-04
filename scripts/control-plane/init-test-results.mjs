import fs from 'node:fs';
import path from 'node:path';
import { findRepoRoot, loadJson, parseArg, repoPath, writeJsonAtomic } from './lib.mjs';
import { loadTaskBundle, validateTaskId } from './task-evidence.mjs';

try {
  const args = process.argv.slice(2);
  const root = findRepoRoot(parseArg(args, '--repo-root') ?? process.cwd());
  const policy = loadJson(path.join(root, 'docs/control-plane/policy.json'));
  const criteriaPath = parseArg(args, '--criteria', { required: true });
  const taskId = validateTaskId(parseArg(args, '--task-id', { required: true }));
  loadTaskBundle(root, taskId);
  const outPath = parseArg(args, '--out') ?? `verification/control-plane/tasks/${taskId}/test-results.json`;
  const source = loadJson(repoPath(root, criteriaPath));
  const criteria = Array.isArray(source) ? source : source.criteria;
  if (!Array.isArray(criteria) || criteria.length === 0) throw new Error('criteria JSON must be a non-empty array (or an object with a criteria array)');
  const seen = new Set();
  const results = criteria.map(item => {
    const id = typeof item === 'string' ? item : item?.id;
    if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(id) || seen.has(id)) throw new Error(`invalid or duplicate criterion id: ${id}`);
    seen.add(id);
    return { criterion_id: id, status: policy.verification_statuses.criterion[1], disposition: 'PENDING', evidence: null };
  });
  const bundle = loadTaskBundle(root, taskId);
  const record = { schema_version: policy.evidence_schema_versions.task_acceptance, task_id: taskId, bundle_id: bundle.manifest.bundle_id, status: policy.verification_statuses.criterion[1], criteria: results, generated_at: new Date().toISOString() };
  const resolvedOut = repoPath(root, outPath);
  if (fs.existsSync(resolvedOut)) throw new Error(`task ${taskId} already has acceptance results; refusing to overwrite durable evidence`);
  writeJsonAtomic(resolvedOut, record);
  console.log(JSON.stringify({ status: record.status, path: resolvedOut, criteria: results.length }, null, 2));
} catch (error) {
  console.error(`default-fail contract initialization failed: ${error.message}`);
  process.exit(2);
}
