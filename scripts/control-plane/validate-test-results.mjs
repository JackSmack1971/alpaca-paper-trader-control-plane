import path from 'node:path';
import { findRepoRoot, loadJson, parseArg, repoPath } from './lib.mjs';

try {
  const args = process.argv.slice(2);
  const root = findRepoRoot(parseArg(args, '--repo-root') ?? process.cwd());
  const resultPath = parseArg(args, '--results') ?? 'verification/test-results.json';
  const contract = loadJson(repoPath(root, resultPath));
  const failures = [];
  const ids = new Set();
  if (contract.schema_version !== 1 || !Array.isArray(contract.criteria) || contract.criteria.length === 0) failures.push('malformed default-fail contract');
  for (const item of contract.criteria ?? []) {
    if (!item.criterion_id || ids.has(item.criterion_id)) failures.push('missing or duplicate criterion id');
    ids.add(item.criterion_id);
    if (item.status === 'PASS') {
      const evidence = item.evidence;
      if (!evidence?.check_id || evidence.exit_code !== 0) { failures.push(`${item.criterion_id} has no numeric pass evidence`); continue; }
      if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(evidence.check_id)) { failures.push(`${item.criterion_id} has an invalid check id`); continue; }
      const check = loadJson(path.join(root, 'verification/control-plane/check-results', `${evidence.check_id}.json`));
      if (check.id !== evidence.check_id || check.status !== 'PASS' || check.exit_code !== 0 || !check.completed_at) failures.push(`${item.criterion_id} check result is missing, failed, or incomplete`);
      const expectedPath = `verification/control-plane/check-results/${evidence.check_id}.json`;
      if (evidence.check_path !== expectedPath) failures.push(`${item.criterion_id} evidence path does not match its check id`);
    } else if (item.status === 'NOT_APPLICABLE') {
      if (!item.rationale?.trim()) failures.push(`${item.criterion_id} needs a NOT_APPLICABLE rationale`);
    } else failures.push(`${item.criterion_id} remains ${item.status ?? 'unset'}`);
  }
  const expectedStatus = failures.length ? 'FAIL' : 'PASS';
  if (contract.status !== expectedStatus) failures.push(`contract status must be ${expectedStatus}`);
  if (failures.length) { for (const failure of failures) console.error(`FAIL: ${failure}`); process.exit(1); }
  console.log(`PASS: ${ids.size} structured criteria have valid evidence.`);
} catch (error) {
  console.error(`test results validation failed: ${error.message}`);
  process.exit(2);
}
