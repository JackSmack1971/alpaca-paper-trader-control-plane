import fs from 'node:fs';
import path from 'node:path';
import { findRepoRoot, loadJson, parseArg, repoPath, writeJsonAtomic } from './lib.mjs';
import { ensureTaskBundle, validateTaskId } from './task-evidence.mjs';

try {
  const args = process.argv.slice(2);
  const root = findRepoRoot(parseArg(args, '--repo-root') ?? process.cwd());
  const policy = loadJson(path.join(root, 'docs/control-plane/policy.json'));
  const taskId = validateTaskId(parseArg(args, '--task-id', { required: true }));
  const legacyResultsPath = parseArg(args, '--legacy-results') ?? 'verification/test-results.json';
  const legacyResults = loadJson(repoPath(root, legacyResultsPath));
  if (legacyResults.task_id !== taskId || legacyResults.schema_version !== policy.evidence_schema_versions.task_acceptance_legacy || !Array.isArray(legacyResults.criteria)) throw new Error('legacy results must use the configured legacy schema and identify the requested task');
  const intakePath = `verification/control-plane/task-routing/${taskId}.intake.json`;
  const routePath = `verification/control-plane/task-routing/${taskId}.json`;
  const intake = loadJson(repoPath(root, intakePath));
  const route = loadJson(repoPath(root, routePath));
  if (intake.id !== taskId || route.task_id !== taskId) throw new Error('legacy intake and route do not identify the requested task');
  const checkIds = [...new Set(legacyResults.criteria.filter(item => item.status === 'PASS').map(item => item.evidence?.check_id).filter(Boolean))];
  const sourceChecks = checkIds.map(id => {
    if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(id)) throw new Error(`invalid legacy check id ${id}`);
    const source = `verification/control-plane/check-results/${id}.json`;
    return { id, source, record: loadJson(repoPath(root, source)) };
  });
  const bundle = ensureTaskBundle(root, taskId, intake);
  const resultsTarget = path.join(bundle.directory, 'test-results.json');
  if (fs.existsSync(resultsTarget)) throw new Error(`task ${taskId} already has task-scoped acceptance results`);
  const convertedChecks = new Map();
  for (const check of sourceChecks) {
    const record = { ...check.record, schema_version: policy.evidence_schema_versions.check_result, task_id: taskId, bundle_id: bundle.bundle_id, legacy_source_path: check.source };
    const sourceLog = check.record.log_path ? repoPath(root, check.record.log_path) : null;
    const targetLog = path.join(bundle.directory, 'checks', `${check.id}.log`);
    if (sourceLog && fs.existsSync(sourceLog)) {
      fs.mkdirSync(path.dirname(targetLog), { recursive: true });
      fs.copyFileSync(sourceLog, targetLog);
    }
    if (sourceLog && fs.existsSync(sourceLog)) record.log_path = path.relative(root, targetLog).replaceAll('\\','/');
    const target = path.join(bundle.directory, 'checks', `${check.id}.json`);
    writeJsonAtomic(target, record);
    convertedChecks.set(check.id, record);
  }
  const criteria = legacyResults.criteria.map(item => {
    const next = { ...item };
    if (next.status === 'PASS' && next.evidence?.check_id) {
      const check = convertedChecks.get(next.evidence.check_id);
      if (!check) throw new Error(`missing legacy check ${next.evidence.check_id}`);
      next.evidence = { ...next.evidence, check_path: `verification/control-plane/tasks/${taskId}/checks/${next.evidence.check_id}.json`, exit_code: check.exit_code };
    }
    return next;
  });
  const migrated = { ...legacyResults, schema_version: policy.evidence_schema_versions.task_acceptance, task_id: taskId, bundle_id: bundle.bundle_id, criteria };
  writeJsonAtomic(resultsTarget, migrated);
  const migratedRoute = { ...route, schema_version: policy.evidence_schema_versions.task_route_migrated, bundle_id: bundle.bundle_id, evidence_bundle: bundle.relative, default_fail_contract: `${bundle.relative}/test-results.json`, intake_path: `${bundle.relative}/intake.json` };
  writeJsonAtomic(path.join(bundle.directory, 'route.json'), migratedRoute);
  console.log(JSON.stringify({ task_id: taskId, task_bundle_id: bundle.bundle_id, results: `${bundle.relative}/test-results.json`, migrated_checks: checkIds.length, legacy_source_preserved: legacyResultsPath }, null, 2));
} catch (error) {
  console.error(`task results migration failed: ${error.message}`);
  process.exit(2);
}
