import fs from 'node:fs';
import path from 'node:path';
import { EVIDENCE_PREFIXES, git, isEvidencePath, loadJson, objectDigest, repoPath, sha256, toPosix, writeJsonAtomic } from './lib.mjs';
import { loadTaskBundle } from './task-evidence.mjs';

function gitText(root, ...args) {
  const result = git(root, ...args);
  if (result.status !== 0) throw new Error(result.stderr.trim() || `git ${args[0]} failed`);
  return result.stdout;
}

function excluded(pathname) {
  return EVIDENCE_PREFIXES.some(prefix => pathname.startsWith(prefix));
}

function riskRank(route) {
  if (route?.initial_risk_level && rank[route.initial_risk_level] !== undefined) return route.initial_risk_level;
  if (route?.signals?.post_diff_risk?.effective_level && rank[route.signals.post_diff_risk.effective_level] !== undefined) return route.signals.post_diff_risk.effective_level;
  if (route?.signals?.post_diff_risk?.level) return route.signals.post_diff_risk.level;
  if (route?.signals?.high_radius || route?.roles?.includes('security_auditor')) return 'high';
  if (route?.signals?.high_complexity || route?.roles?.includes('reviewer')) return 'medium';
  return 'low';
}

const rank = { low: 0, medium: 1, high: 2, critical: 3 };

export function classifyPostDiff(root, snapshot) {
  const policy = loadJson(repoPath(root, 'docs/control-plane/policy.json'));
  if (!snapshot?.git_baseline) throw new Error('execution snapshot must include git_baseline');
  const diffArgs = ['diff', '--no-ext-diff', '--no-renames', '--unified=0', snapshot.git_baseline, '--', '.', ...EVIDENCE_PREFIXES.map(prefix => `:(exclude)${prefix}**`)];
  const patch = gitText(root, ...diffArgs);
  const nameStatus = gitText(root, 'diff', '--name-status', '--no-renames', snapshot.git_baseline, '--', '.', ...EVIDENCE_PREFIXES.map(prefix => `:(exclude)${prefix}**`));
  const files = new Map();
  for (const line of nameStatus.split(/\r?\n/).filter(Boolean)) {
    const [status, pathname] = line.split('\t');
    if (pathname) files.set(toPosix(pathname), { status, added: 0, deleted: 0 });
  }
  for (const line of gitText(root, 'diff', '--numstat', '--no-renames', snapshot.git_baseline, '--', '.', ...EVIDENCE_PREFIXES.map(prefix => `:(exclude)${prefix}**`)).split(/\r?\n/).filter(Boolean)) {
    const [added, deleted, pathname] = line.split('\t');
    if (pathname && files.has(pathname)) Object.assign(files.get(pathname), { added: Number(added) || 0, deleted: Number(deleted) || 0 });
  }
  const untracked = gitText(root, 'ls-files', '--others', '--exclude-standard', '-z').split('\0').filter(Boolean).map(toPosix).filter(p => !isEvidencePath(p) && !files.has(p));
  for (const pathname of untracked) {
    const absolute = repoPath(root, pathname);
    const text = fs.readFileSync(absolute, 'utf8');
    files.set(pathname, { status: 'A', added: text.split(/\r\n?|\n/).length, deleted: 0 });
  }
  for (const pathname of files.keys()) if (excluded(pathname)) files.delete(pathname);

  const paths = [...files.keys()].sort();
  const addedSensitiveLines = patch.split(/\r?\n/).filter(line => line.startsWith('+') && !line.startsWith('+++') && /(assertPaperOnly|authenticat|authoriz|credential|password|secret|access.?token|permission|encrypt|decrypt|\.env|allow.?list|deny.?list)/i.test(line));
  if (addedSensitiveLines.length) categories.add('security-sensitive');
  const addedLines = [...files.values()].reduce((sum, item) => sum + item.added, 0);
  const deletedLines = [...files.values()].reduce((sum, item) => sum + item.deleted, 0);
  const categories = new Set();
  const deleted = paths.filter(p => files.get(p).status === 'D');
  for (const p of paths) {
    const lower = p.toLowerCase();
    if (/^(migrations?|db\/migrations)\//.test(lower) || /(^|\/)(migrations?|schema)(\/|\.|-)/.test(lower)) categories.add('migration');
    if (/config|permission|policy|\.rules$|hooks?\.json|auth|access-control/.test(lower)) categories.add('permission-or-configuration');
    if (/security|auth|secret|credential|crypto|\.env|paper-only|safeguard|guard/.test(lower)) categories.add('security-sensitive');
    if (/^(src\/api|api\/|openapi|.*\.(openapi|proto)(\.yaml|\.yml|\.json)?$)/.test(lower) || /(^|\/)(routes?|contracts?|public-api)(\/|\.)/.test(lower)) categories.add('public-api');
    if (/(^|\/)(package\.json|pnpm-lock\.yaml|yarn\.lock|package-lock\.json|Cargo\.toml|go\.mod)$/.test(lower)) categories.add('dependency');
    if (/(^|\/)(__tests__|tests?|specs?)(\/|\.)|\.(test|spec)\.[^.]+$/.test(lower)) categories.add('test');
    if (/(^|\/)(AGENTS\.md|PROJECT_CHARTER\.md|phase-state\.json|phase-contracts\.json|policy\.json|components\.json|capabilities\.json|\.codex\/|\.agents\/skills\/)/i.test(p) || /^docs\/control-plane\//i.test(p)) categories.add('control-plane-or-charter');
  }
  const removedSafeguards = deleted.filter(p => /(test|spec|guard|security|auth|policy|paper-only|permission|safeguard)/i.test(p));
  const deletedGuardLines = patch.split(/\r?\n/).filter(line => line.startsWith('-') && !line.startsWith('---') && /(assertPaperOnly|paper.only|permission|authorization|authentication|secret|guard|deny|fail.closed|security)/i.test(line));
  if (removedSafeguards.length || deletedGuardLines.length) categories.add('safeguard-deletion');
  if (categories.has('security-sensitive') || categories.has('permission-or-configuration') || categories.has('migration') || categories.has('public-api') || categories.has('dependency') || categories.has('safeguard-deletion')) categories.add('high-impact-surface');

  const complexity = policy.routing.complexity;
  const magnitudeHigh = paths.length > complexity.architectural_file_count_gt || addedLines + deletedLines > complexity.expected_code_lines_gt;
  if (magnitudeHigh) categories.add('change-magnitude');
  const critical = categories.has('control-plane-or-charter') || categories.has('safeguard-deletion');
  const high = critical || categories.has('high-impact-surface') || magnitudeHigh;
  const level = critical ? 'critical' : high ? 'high' : 'low';
  const severity = rank[level];
  const roles = severity >= 3
    ? ['reviewer', 'security_auditor', 'verifier', 'evaluator']
    : severity >= 2
      ? ['reviewer', 'security_auditor', 'verifier', 'evaluator']
      : severity >= 1
        ? ['reviewer', 'verifier']
        : [];
  const patchDigest = sha256(patch);
  const requiredLanes = roles.map(role => ({ reviewer:'review', security_auditor:'security-review', verifier:'verifier', evaluator:'evaluation' })[role]);
  const result = { schema_version: 1, level, paths, changed_file_count: paths.length, added_lines: addedLines, deleted_lines: deletedLines, categories: [...categories].sort(), removed_safeguards: removedSafeguards.sort(), deleted_guard_line_count: deletedGuardLines.length, required_roles: roles, required_lanes: requiredLanes, patch_sha256: patchDigest };
  result.classification_id = objectDigest(result);
  return result;
}

export function reconcilePostDiffRisk(root, taskId, snapshot) {
  const bundle = loadTaskBundle(root, taskId);
  const routePath = path.join(bundle.directory, 'route.json');
  const route = loadJson(routePath);
  const observed = classifyPostDiff(root, snapshot);
  const initialLevel = riskRank(route);
  const previousEffective = route.signals?.post_diff_risk?.effective_level ?? initialLevel;
  const effectiveLevel = [initialLevel, previousEffective, observed.level].sort((a, b) => rank[b] - rank[a])[0];
  const effectiveRoles = [...new Set([...(route.roles ?? []), ...observed.required_roles])];
  const roleLanes = { reviewer:'review', security_auditor:'security-review', verifier:'verifier', evaluator:'evaluation' };
  const effectiveRisk = {
    ...observed,
    required_lanes: [...new Set([...observed.required_lanes, ...effectiveRoles.map(role => roleLanes[role]).filter(Boolean)])].sort(),
    initial_level: initialLevel,
    effective_level: effectiveLevel,
    escalated: rank[effectiveLevel] > rank[initialLevel]
  };
  route.initial_route = route.initial_route ?? route.route;
  route.initial_risk_level = route.initial_risk_level ?? initialLevel;
  route.route = rank[effectiveLevel] > rank[initialLevel] ? `post-diff-${effectiveLevel}-independent-review` : route.route;
  route.roles = effectiveRoles;
  route.acceptance_contract_required = route.acceptance_contract_required || effectiveRoles.some(role => ['reviewer','security_auditor','verifier','evaluator'].includes(role));
  route.default_fail_contract = route.acceptance_contract_required ? `${bundle.relative}/test-results.json` : null;
  route.signals = { ...route.signals, post_diff_risk: effectiveRisk };

  if (route.acceptance_contract_required) {
    const acceptancePath = path.join(bundle.directory, 'test-results.json');
    const contractCriteria = [
      { criterion_id: 'POST-DIFF-CLASSIFICATION', status: 'FAIL', disposition: 'PENDING', evidence: null },
      { criterion_id: 'POST-DIFF-REQUIRED-LANES', status: 'FAIL', disposition: 'PENDING', evidence: null }
    ];
    if (!fs.existsSync(acceptancePath)) {
      const policy = loadJson(repoPath(root, 'docs/control-plane/policy.json'));
      writeJsonAtomic(acceptancePath, { schema_version: policy.evidence_schema_versions.task_acceptance, task_id: taskId, bundle_id: bundle.manifest.bundle_id, status: 'FAIL', criteria: contractCriteria, generated_at: new Date().toISOString(), generated_by: 'post-diff-risk-reclassification' });
    } else {
      const contract = loadJson(acceptancePath);
      if (contract.task_id !== taskId || contract.bundle_id !== bundle.manifest.bundle_id || !Array.isArray(contract.criteria)) throw new Error('existing acceptance contract does not match task bundle');
      for (const required of contractCriteria) if (!contract.criteria.some(item => item.criterion_id === required.criterion_id)) contract.criteria.push(required);
      contract.status = 'FAIL';
      writeJsonAtomic(acceptancePath, contract);
    }
  }
  writeJsonAtomic(routePath, route);
  return route.signals.post_diff_risk;
}
