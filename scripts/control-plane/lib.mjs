import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

export const CONTROL_PLANE_SCHEMA = 2;
export const EVIDENCE_PREFIXES = ['verification/control-plane/', 'verification/phase-reports/'];

export function canonicalText(bytes) {
  return Buffer.isBuffer(bytes) ? bytes.toString('utf8').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n') : String(bytes).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
}

export function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

export function objectDigest(value) {
  return sha256(stableStringify(value));
}

export function canonicalFileDigest(file) {
  return sha256(canonicalText(fs.readFileSync(file)));
}

export function loadJson(file) {
  return JSON.parse(canonicalText(fs.readFileSync(file)));
}

export function writeJsonAtomic(file, value) {
  const target = path.resolve(file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  fs.renameSync(temp, target);
}

export function repoPath(root, relative) {
  const base = path.resolve(root);
  const resolved = path.resolve(base, relative);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) throw new Error(`path escapes repository: ${relative}`);
  return resolved;
}

export function toPosix(relative) {
  return relative.split(path.sep).join('/');
}

export function findRepoRoot(start = process.cwd()) {
  const git = spawnSync('git', ['-C', path.resolve(start), 'rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  if (git.status === 0 && git.stdout.trim()) return path.resolve(git.stdout.trim());
  let dir = path.resolve(start);
  while (true) {
    if (fs.existsSync(path.join(dir, 'docs', 'PROJECT_CHARTER.md')) && fs.existsSync(path.join(dir, 'docs', 'control-plane', 'phase-state.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`unable to locate repository root from ${start}`);
    dir = parent;
  }
}

export function run(command, args = [], options = {}) {
  return spawnSync(command, args, { cwd: options.cwd, encoding: 'utf8', input: options.input, env: options.env ?? process.env });
}

export function git(root, ...args) {
  return run('git', ['-C', root, ...args]);
}

export function requireGit(root) {
  const result = git(root, 'rev-parse', '--show-toplevel');
  if (result.status !== 0) throw new Error(result.stderr.trim() || 'not a Git repository');
  return path.resolve(result.stdout.trim());
}

export function currentHead(root) {
  const result = git(root, 'rev-parse', 'HEAD');
  if (result.status !== 0) throw new Error(result.stderr.trim() || 'cannot resolve Git HEAD');
  return result.stdout.trim();
}

export function currentBranch(root) {
  const result = git(root, 'branch', '--show-current');
  if (result.status !== 0) throw new Error(result.stderr.trim() || 'cannot resolve Git branch');
  return result.stdout.trim() || null;
}

export function isEvidencePath(relative) {
  const p = toPosix(relative).replace(/^\.\//, '');
  return EVIDENCE_PREFIXES.some(prefix => p.startsWith(prefix));
}

export function statusEntries(root, { includeEvidence = false } = {}) {
  const result = git(root, 'status', '--porcelain=v1', '-z', '--untracked-files=all');
  if (result.status !== 0) throw new Error(result.stderr.trim() || 'cannot read Git status');
  const raw = result.stdout.split('\0').filter(Boolean);
  const entries = [];
  for (let i = 0; i < raw.length; i++) {
    const record = raw[i];
    const code = record.slice(0, 2);
    let file = record.slice(3);
    if ((code.includes('R') || code.includes('C')) && raw[i + 1]) file = raw[++i];
    const normalized = toPosix(file);
    if (!includeEvidence && isEvidencePath(normalized)) continue;
    entries.push({ code, path: normalized });
  }
  return entries;
}

export function classifyPlatform(platform, env = {}, procVersion = '') {
  if (platform === 'win32') return 'native-windows';
  if (platform === 'linux' && (env.WSL_DISTRO_NAME || /microsoft/i.test(procVersion))) return 'wsl';
  if (platform === 'linux') return 'linux';
  return platform;
}

export function platformKind() {
  const procVersion = fs.existsSync('/proc/version') ? fs.readFileSync('/proc/version','utf8') : '';
  return classifyPlatform(process.platform, process.env, procVersion);
}

export function gitCommonDir(root) {
  const result = git(root, 'rev-parse', '--git-common-dir');
  if (result.status !== 0 || !result.stdout.trim()) throw new Error(result.stderr.trim() || 'cannot resolve Git common directory');
  const value = result.stdout.trim();
  return path.resolve(root, value);
}

export function loadPhaseState(root) {
  const file = repoPath(root, 'docs/control-plane/phase-state.json');
  const state = loadJson(file);
  const issues = [];
  if (!Number.isInteger(state.schema_version)) issues.push('schema_version must be an integer');
  if (!Array.isArray(state.phases) || state.phases.length === 0) issues.push('phases must be a non-empty array');
  const active = Array.isArray(state.phases) ? state.phases.filter(p => p?.status === 'active') : [];
  if (state.active_phase === null) {
    if (active.length) issues.push('active_phase is null but an active phase exists');
  } else if (!Number.isInteger(state.active_phase) || active.length !== 1 || active[0]?.id !== state.active_phase) {
    issues.push('active phase/status mismatch');
  }
  if (issues.length) throw new Error(`invalid phase state: ${issues.join('; ')}`);
  return state;
}

export function activePhase(state) {
  if (state.active_phase === null) return null;
  const phase = state.phases.find(p => p.id === state.active_phase);
  if (!phase) throw new Error(`active phase ${state.active_phase} missing from phase list`);
  return phase;
}

export function readStdinJson() {
  const text = fs.readFileSync(0, 'utf8');
  if (!text.trim()) return {};
  return JSON.parse(text);
}

export function parseArg(args, name, { required = false } = {}) {
  const index = args.indexOf(name);
  if (index < 0 || index + 1 >= args.length) {
    if (required) throw new Error(`missing ${name}`);
    return null;
  }
  return args[index + 1];
}

export function fileDigestMap(root, relatives) {
  const result = {};
  for (const rel of [...relatives].sort()) {
    const file = repoPath(root, rel);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error(`missing control-plane source: ${rel}`);
    result[rel] = canonicalFileDigest(file);
  }
  return result;
}
