import path from 'node:path';
import { findRepoRoot, loadJson, parseArg, repoPath, writeJsonAtomic } from './lib.mjs';
import { loadTaskBundle, validateTaskId } from './task-evidence.mjs';

try {
  const args = process.argv.slice(2);
  const root = findRepoRoot(parseArg(args, '--repo-root') ?? process.cwd());
  const policy = loadJson(path.join(root, 'docs/control-plane/policy.json'));
  const taskId = validateTaskId(parseArg(args, '--task-id', { required: true }));
  const bundle = loadTaskBundle(root, taskId);
  const resultPath = parseArg(args, '--results') ?? `verification/control-plane/tasks/${taskId}/test-results.json`;
  const resolvedResults = repoPath(root, resultPath);
  const contract = loadJson(resolvedResults);
  const criterionId = parseArg(args, '--criterion', { required: true });
  const item = contract.criteria?.find(x => x.criterion_id === criterionId);
  if (!item) throw new Error(`unknown criterion ${criterionId}`);

  const rationale = parseArg(args, '--not-applicable');
  if (rationale) {
    item.status = policy.verification_statuses.criterion[2];
    item.disposition = policy.verification_statuses.criterion[2];
    item.rationale = rationale;
    item.evidence = null;
  } else {
    const checkId = parseArg(args, '--check-id', { required: true });
    if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(checkId)) throw new Error('invalid --check-id');
    const checkPath = path.join(bundle.directory, 'checks', `${checkId}.json`);
    const check = loadJson(checkPath);
    if (check.id !== checkId || check.task_id !== taskId || check.bundle_id !== bundle.manifest.bundle_id || check.status !== policy.verification_statuses.check[0] || check.exit_code !== 0 || !check.completed_at) throw new Error(`check ${checkId} has no completed numeric exit_code 0 for task ${taskId}`);
    item.status = policy.verification_statuses.criterion[0];
    item.disposition = policy.verification_statuses.criterion[0];
    item.evidence = { check_id: checkId, check_path: path.relative(root, checkPath).replaceAll('\\', '/'), exit_code: check.exit_code };
    delete item.rationale;
  }
  contract.status = contract.criteria.every(x => x.status === policy.verification_statuses.criterion[0] || x.status === policy.verification_statuses.criterion[2]) ? policy.verification_statuses.criterion[0] : policy.verification_statuses.criterion[1];
  writeJsonAtomic(resolvedResults, contract);
  console.log(JSON.stringify({ criterion_id: criterionId, status: item.status, contract_status: contract.status }, null, 2));
} catch (error) {
  console.error(`test result update failed: ${error.message}`);
  process.exit(2);
}
