import path from 'node:path';
import { findRepoRoot, loadJson, parseArg, repoPath, writeJsonAtomic } from './lib.mjs';

try {
  const args = process.argv.slice(2);
  const root = findRepoRoot(parseArg(args, '--repo-root') ?? process.cwd());
  const criteriaPath = parseArg(args, '--criteria', { required: true });
  const outPath = parseArg(args, '--out') ?? 'verification/test-results.json';
  const source = loadJson(repoPath(root, criteriaPath));
  const criteria = Array.isArray(source) ? source : source.criteria;
  if (!Array.isArray(criteria) || criteria.length === 0) throw new Error('criteria JSON must be a non-empty array (or an object with a criteria array)');
  const seen = new Set();
  const results = criteria.map(item => {
    const id = typeof item === 'string' ? item : item?.id;
    if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(id) || seen.has(id)) throw new Error(`invalid or duplicate criterion id: ${id}`);
    seen.add(id);
    return { criterion_id: id, status: 'FAIL', disposition: 'PENDING', evidence: null };
  });
  const record = { schema_version: 1, status: 'FAIL', criteria: results, generated_at: new Date().toISOString() };
  const resolvedOut = repoPath(root, outPath);
  writeJsonAtomic(resolvedOut, record);
  console.log(JSON.stringify({ status: record.status, path: resolvedOut, criteria: results.length }, null, 2));
} catch (error) {
  console.error(`default-fail contract initialization failed: ${error.message}`);
  process.exit(2);
}
