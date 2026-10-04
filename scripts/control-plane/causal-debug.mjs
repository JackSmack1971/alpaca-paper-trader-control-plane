import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { findRepoRoot, git, isEvidencePath, loadJson, parseArg, repoPath, sha256, writeJsonAtomic } from './lib.mjs';

const args = process.argv.slice(2);
const root = findRepoRoot(parseArg(args, '--repo-root') ?? process.cwd());
const tasksDir = repoPath(root, 'verification/control-plane/debug-tasks');
const activePath = path.join(tasksDir, 'active.json');
const taskPath = id => path.join(tasksDir, `${id}.json`);
const validId = id => /^[a-z0-9][a-z0-9-]{0,79}$/.test(id ?? '');
const load = id => JSON.parse(fs.readFileSync(taskPath(id), 'utf8'));
const save = task => writeJsonAtomic(taskPath(task.id), task);
function scopeDigest(scopes) {
  const entries = [];
  const visit = (absolute, relative) => {
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) throw new Error(`registered scope contains a symlink: ${relative}`);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(absolute).sort()) visit(path.join(absolute, name), `${relative}/${name}`);
    } else if (stat.isFile()) entries.push([relative, fs.readFileSync(absolute)]);
  };
  for (const scope of scopes) {
    const absolute = repoPath(root, scope);
    if (!fs.existsSync(absolute)) throw new Error(`registered scope does not exist: ${scope}`);
    let cursor = root;
    for (const segment of path.relative(root, absolute).split(path.sep).filter(Boolean)) {
      cursor = path.join(cursor, segment);
      if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error(`registered scope has a symbolic-link ancestor: ${scope}`);
    }
    visit(absolute, scope);
  }
  return sha256(entries.map(([name, content]) => `${name}\0${Buffer.isBuffer(content) ? sha256(content) : content}`).join('\n'));
}
function sourceTreeDigest() {
  const listed = git(root, 'ls-files', '-co', '--exclude-standard', '-z');
  if (listed.status !== 0) throw new Error(listed.stderr.trim() || 'cannot enumerate source tree');
  const entries = [];
  for (const relative of listed.stdout.split('\0').filter(Boolean).map(value => value.split(path.sep).join('/')).sort()) {
    if (isEvidencePath(relative) && !relative.startsWith('verification/control-plane/debug-tasks/')) continue;
    const absolute = repoPath(root, relative);
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) {
      const target = fs.realpathSync(absolute);
      const relTarget = path.relative(root, target);
      if (relTarget === '..' || relTarget.startsWith(`..${path.sep}`) || path.isAbsolute(relTarget)) throw new Error(`source tree contains an external symlink: ${relative}`);
      entries.push([relative, `symlink:${relTarget.split(path.sep).join('/')}`, sha256(fs.readFileSync(target))]);
    } else if (stat.isFile()) entries.push([relative, 'file', sha256(fs.readFileSync(absolute))]);
  }
  return sha256(JSON.stringify(entries));
}
function runCase(casePath, scopes) {
  const coverageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'causal-debug-coverage-'));
  try {
    const errorRecordPath = path.join(coverageDir, 'uncaught-error.json');
    const preloadPath = path.join(coverageDir, 'capture-error.mjs');
    fs.writeFileSync(preloadPath, `import fs from 'node:fs'; process.on('uncaughtExceptionMonitor', error => fs.writeFileSync(${JSON.stringify(errorRecordPath)}, JSON.stringify({ name: error.name, message: error.message, stack: error.stack })));\n`);
    const child = spawnSync(process.execPath, ['--import', pathToFileURL(preloadPath).href, casePath], { cwd: root, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, windowsHide: true, env: { ...process.env, NODE_V8_COVERAGE: coverageDir } });
    const uncaughtError = fs.existsSync(errorRecordPath) ? JSON.parse(fs.readFileSync(errorRecordPath, 'utf8')) : null;
    let scopeExecuted = false;
    for (const name of fs.readdirSync(coverageDir)) {
      if (!name.endsWith('.json')) continue;
      const report = JSON.parse(fs.readFileSync(path.join(coverageDir, name), 'utf8'));
      scopeExecuted ||= report.result.some(entry => {
        let filename;
        try { filename = entry.url.startsWith('file:') ? new URL(entry.url) : null; } catch { return false; }
        if (!filename) return false;
        let sourcePath;
        try { sourcePath = path.resolve(root, decodeURIComponent(filename.pathname).replace(/^\/(\w:)/, '$1')); } catch { return false; }
        const relative = path.relative(root, sourcePath).replaceAll('\\', '/');
        return scopes.some(scope => relative === scope || relative.startsWith(`${scope}/`)) && entry.functions.some(fn => fn.ranges.some(range => range.count > 0));
      });
    }
    const scopeFrame = uncaughtError && scopes.some(scope => {
      const scopeUrl = pathToFileURL(path.resolve(root, scope)).href;
      return uncaughtError.stack?.includes(scopeUrl);
    });
    return { child, scopeExecuted, uncaughtError, scopeFrame: Boolean(scopeFrame) };
  } finally { fs.rmSync(coverageDir, { recursive: true, force: true }); }
}

try {
  const action = args[0];
  fs.mkdirSync(tasksDir, { recursive: true });
  if (action === 'register') {
    const id = parseArg(args, '--id', { required: true });
    const signature = parseArg(args, '--signature', { required: true });
    const caseFile = parseArg(args, '--case', { required: true });
    const scopes = args.flatMap((value, i) => value === '--scope' && args[i + 1] ? [args[i + 1]] : []);
    const expectedCaseFile = `verification/reproductions/${id}.mjs`;
    if (!validId(id) || !signature.trim() || !scopes.length || caseFile !== expectedCaseFile) throw new Error(`usage: causal-debug.mjs register --id <slug> --case ${expectedCaseFile} --scope <source-path> [--scope <path>...] --signature <exact error signature>`);
    if (fs.existsSync(activePath)) throw new Error('another causal-debug task is active; complete it before registering a new one');
    const normalizedScopes = [...new Set(scopes.map(scope => {
      const absolute = repoPath(root, scope);
      return path.relative(root, absolute).replaceAll('\\', '/');
    }))];
    const casePath = repoPath(root, caseFile);
    const caseSha256 = fs.existsSync(casePath) ? sha256(fs.readFileSync(casePath)) : null;
    const policy = loadJson(path.join(root, 'docs/control-plane/policy.json'));
    const task = { schema_version: policy.evidence_schema_versions.causal_debug_task, id, status: 'AWAITING_REPRODUCTION', case_file: caseFile, case_sha256: caseSha256, scopes: normalizedScopes, signature_sha256: sha256(signature), reproduction: null, registered_at: new Date().toISOString() };
    task.registered_scope_sha256 = scopeDigest(normalizedScopes);
    save(task);
    writeJsonAtomic(activePath, { task_id: id });
    console.log(JSON.stringify({ id, status: task.status, case_file: caseFile, scopes: normalizedScopes, signature_stored: false }));
  } else if (action === 'reproduce') {
    const id = parseArg(args, '--id', { required: true });
    const task = load(id);
    const caseFile = parseArg(args, '--case', { required: true });
    if (caseFile !== task.case_file) throw new Error(`reproduce must execute the registered minimal case: ${task.case_file}`);
    const casePath = repoPath(root, caseFile);
    if (!fs.existsSync(casePath) || !fs.statSync(casePath).isFile() || fs.lstatSync(casePath).isSymbolicLink()) throw new Error(`registered reproduction case is missing or not a regular file: ${caseFile}`);
    const caseBefore = sha256(fs.readFileSync(casePath));
    if (task.case_sha256 && task.case_sha256 !== caseBefore) throw new Error('registered reproduction case changed; register a new debug task before reproducing');
    if (task.last_edit_gate && task.status === 'AWAITING_REPRODUCTION') task.case_sha256 = caseBefore;
    const scopeBefore = scopeDigest(task.scopes);
    if (!task.last_edit_gate && task.registered_scope_sha256 !== scopeBefore) throw new Error('registered source scope changed before the first reproduction; restore baseline source or register a fresh task');
    const sourceBefore = sourceTreeDigest();
    const { child, scopeExecuted, uncaughtError, scopeFrame } = runCase(casePath, task.scopes);
    const output = `${child.stdout ?? ''}\n${child.stderr ?? ''}`;
    let activeIntact = fs.existsSync(activePath) && JSON.parse(fs.readFileSync(activePath, 'utf8')).task_id === id;
    if (!activeIntact) writeJsonAtomic(activePath, { task_id: id });
    const taskIntact = fs.existsSync(taskPath(id));
    if (!taskIntact) save(task);
    const sourceUnchanged = activeIntact && taskIntact && sourceBefore === sourceTreeDigest();
    const scopeAfter = scopeDigest(task.scopes);
    const caseAfter = fs.existsSync(casePath) && sha256(fs.readFileSync(casePath)) === caseBefore;
    const signature = parseArg(args, '--signature');
    if (!signature) throw new Error('reproduce requires --signature <exact error signature> so the observed trace can be matched without storing it');
    const exitCode = Number.isInteger(child.status) ? child.status : null;
    const matched = sha256(signature) === task.signature_sha256 && output.includes(signature) && uncaughtError?.message?.includes(signature) && scopeExecuted && scopeFrame;
    const processCompleted = exitCode !== null && child.signal === null && !child.error;
    const scopeUnchanged = scopeBefore === scopeAfter;
    task.case_sha256 = caseAfter ? caseBefore : null;
    task.reproduction = { case_sha256: caseBefore, exit_code: exitCode, process_completed: processCompleted, signature_matched: matched, source_unchanged: sourceUnchanged, scope_unchanged: scopeUnchanged, scope_sha256: scopeAfter, completed_at: new Date().toISOString() };
    task.status = processCompleted && exitCode !== 0 && matched && sourceUnchanged && scopeUnchanged && caseAfter ? 'REPRODUCED' : 'AWAITING_REPRODUCTION';
    save(task);
    const result = { id, status: task.status, exit_code: exitCode, process_completed: processCompleted, exact_signature_matched: matched, uncaught_error_observed: Boolean(uncaughtError), scope_code_executed: scopeExecuted, scoped_error_frame: scopeFrame, source_unchanged: sourceUnchanged, scope_unchanged: scopeUnchanged, case_unchanged: caseAfter, raw_output_stored: false };
    console.log(JSON.stringify(result));
    if (task.status !== 'REPRODUCED') process.exitCode = 1;
  } else if (action === 'complete') {
    const id = parseArg(args, '--id', { required: true });
    const task = load(id);
    if (task.status !== 'FIX_VERIFIED') throw new Error('cannot complete: run verify-fixed after the scoped fix and confirm the command succeeds without the reported signature');
    task.status = 'COMPLETE';
    task.completed_at = new Date().toISOString();
    save(task);
    fs.rmSync(activePath, { force: true });
    console.log(JSON.stringify({ id, status: task.status }));
  } else if (action === 'verify-fixed') {
    const id = parseArg(args, '--id', { required: true });
    const task = load(id);
    if (task.status !== 'AWAITING_REPRODUCTION' || !task.last_edit_gate) throw new Error('verify-fixed is available only after at least one scoped source edit');
    const caseFile = parseArg(args, '--case', { required: true });
    if (caseFile !== task.case_file) throw new Error(`verify-fixed must execute the registered minimal case: ${task.case_file}`);
    const casePath = repoPath(root, caseFile);
    if (!fs.existsSync(casePath) || !fs.statSync(casePath).isFile() || fs.lstatSync(casePath).isSymbolicLink()) throw new Error(`registered reproduction case is missing or not a regular file: ${caseFile}`);
    const caseBefore = sha256(fs.readFileSync(casePath));
    if (caseBefore !== task.case_sha256) throw new Error('registered reproduction case changed since it was verified; reproduce it before verification');
    const scopeBefore = scopeDigest(task.scopes);
    const sourceBefore = sourceTreeDigest();
    const { child, scopeExecuted } = runCase(casePath, task.scopes);
    const output = `${child.stdout ?? ''}\n${child.stderr ?? ''}`;
    let activeIntact = fs.existsSync(activePath) && JSON.parse(fs.readFileSync(activePath, 'utf8')).task_id === id;
    if (!activeIntact) writeJsonAtomic(activePath, { task_id: id });
    const taskIntact = fs.existsSync(taskPath(id));
    if (!taskIntact) save(task);
    const sourceUnchanged = activeIntact && taskIntact && sourceBefore === sourceTreeDigest();
    const scopeAfter = scopeDigest(task.scopes);
    const exitCode = Number.isInteger(child.status) ? child.status : null;
    const signature = parseArg(args, '--signature');
    if (!signature || sha256(signature) !== task.signature_sha256) throw new Error('verify-fixed requires the original --signature value');
    const processCompleted = exitCode !== null && child.signal === null && !child.error;
    const scopeUnchanged = scopeBefore === scopeAfter;
    const resolved = processCompleted && exitCode === 0 && !output.includes(signature) && scopeExecuted && sourceUnchanged && scopeUnchanged;
    task.fix_verification = { case_sha256: caseBefore, exit_code: exitCode, process_completed: processCompleted, signature_absent: !output.includes(signature), source_unchanged: sourceUnchanged, scope_unchanged: scopeUnchanged, scope_sha256: scopeAfter, completed_at: new Date().toISOString() };
    task.status = resolved ? 'FIX_VERIFIED' : 'AWAITING_REPRODUCTION';
    save(task);
    console.log(JSON.stringify({ id, status: task.status, exit_code: exitCode, process_completed: processCompleted, reported_signature_absent: !output.includes(signature), source_unchanged: sourceUnchanged, scope_unchanged: scopeUnchanged, raw_output_stored: false }));
    if (!resolved) process.exitCode = 1;
  } else {
    throw new Error('expected register, reproduce, verify-fixed, or complete');
  }
} catch (error) {
  console.error(`causal-debug failed: ${error.message}`);
  process.exit(2);
}
