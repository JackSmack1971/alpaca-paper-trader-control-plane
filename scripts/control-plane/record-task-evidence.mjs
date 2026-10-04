import path from 'node:path';
import { findRepoRoot, loadJson, objectDigest, parseArg, repoPath, writeJsonAtomic } from './lib.mjs';
import { loadTaskBundle, validateTaskId } from './task-evidence.mjs';

try {
  const args = process.argv.slice(2);
  const root = findRepoRoot(parseArg(args, '--repo-root') ?? process.cwd());
  const taskId = validateTaskId(parseArg(args, '--task-id', { required: true }));
  const kind = parseArg(args, '--kind', { required: true });
  if (!['review','security-review','verifier','verification','evaluation'].includes(kind)) throw new Error('--kind must be review, security-review, verifier, verification, or evaluation');
  const bundle = loadTaskBundle(root, taskId);
  const record = loadJson(repoPath(root, parseArg(args, '--record', { required: true })));
  if (!/^[a-f0-9]{64}$/.test(String(record.candidate_id ?? ''))) throw new Error('record candidate_id must be a SHA-256 identity');
  const candidatePath = path.join(bundle.directory, 'candidates', `${record.candidate_id}.json`);
  const candidate = loadJson(candidatePath);
  if (record.task_id !== taskId || record.task_bundle_id !== bundle.manifest.bundle_id || record.candidate_id !== candidate.candidate_id) throw new Error('record must bind the current task, evidence bundle, and frozen candidate');
  if (kind === 'verification' ? (record.status !== 'PASS' || !Array.isArray(record.commands)) : record.verdict !== 'PASS') throw new Error(`${kind} evidence must have PASS status`);
  const file = path.join(bundle.directory, `${kind}.${candidate.candidate_id}.json`);
  writeJsonAtomic(file, record);
  console.log(JSON.stringify({ task_id: taskId, task_bundle_id: bundle.manifest.bundle_id, kind, path: path.relative(root, file).replaceAll('\\','/'), digest: objectDigest(record) }, null, 2));
} catch (error) {
  console.error(`task evidence recording failed: ${error.message}`);
  process.exit(2);
}
