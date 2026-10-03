import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { findRepoRoot, parseArg, writeJsonAtomic } from './lib.mjs';

try {
  const args = process.argv.slice(2);
  const root = findRepoRoot(parseArg(args, '--repo-root') ?? process.cwd());
  const id = parseArg(args, '--id', { required: true });
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(id)) throw new Error('--id must be a unique lowercase slug');
  const separator = args.indexOf('--');
  if (separator < 0 || !args[separator + 1]) throw new Error('usage: verify-command.mjs --id <unique-id> -- <executable> <args...>');
  const executable = args[separator + 1];
  const commandArgs = args.slice(separator + 2);
  const resultsDir = path.join(root, 'verification/control-plane/check-results');
  const resultPath = path.join(resultsDir, `${id}.json`);
  const logPath = path.join(resultsDir, `${id}.log`);
  fs.mkdirSync(resultsDir, { recursive: true });
  const record = { schema_version: 1, id, status: 'FAIL', exit_code: null, executable, args: commandArgs, log_path: path.relative(root, logPath).replaceAll('\\', '/'), started_at: new Date().toISOString(), completed_at: null };
  writeJsonAtomic(resultPath, record);

  const isCmd = process.platform === 'win32' && /\.(cmd|bat)$/i.test(executable);
  const child = spawnSync(executable, commandArgs, { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, windowsHide: true, shell: isCmd });
  const combinedOutput = `${child.stdout ?? ''}${child.stderr ? `\n${child.stderr}` : ''}`;
  fs.writeFileSync(logPath, combinedOutput, 'utf8');
  const outputBytes = Buffer.from(combinedOutput, 'utf8');
  const tailBytes = outputBytes.subarray(Math.max(0, outputBytes.length - 6_000));
  if (tailBytes.length) process.stdout.write(`CHECK OUTPUT TAIL (raw log kept at ${record.log_path}):\n${tailBytes.toString('utf8')}\n`);
  const exitCode = Number.isInteger(child.status) ? child.status : 1;
  record.status = exitCode === 0 ? 'PASS' : 'FAIL';
  record.exit_code = exitCode;
  record.signal = child.signal ?? null;
  record.error = child.error?.message ?? null;
  record.completed_at = new Date().toISOString();
  writeJsonAtomic(resultPath, record);

  const marker = { id, status: record.status, exit_code: record.exit_code, result_path: path.relative(root, resultPath).replaceAll('\\', '/') };
  process.stdout.write(`CONTROL_PLANE_CHECK_RESULT:${JSON.stringify(marker)}\n`);
  process.exitCode = exitCode;
} catch (error) {
  console.error(`verification command failed: ${error.message}`);
  process.exit(2);
}
