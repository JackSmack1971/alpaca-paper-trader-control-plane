import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { findRepoRoot, loadJson, parseArg, repoPath, writeJsonAtomic } from './lib.mjs';
import { ensureTaskBundle, validateTaskId } from './task-evidence.mjs';

try {
  const args = process.argv.slice(2);
  const root = findRepoRoot(parseArg(args, '--repo-root') ?? process.cwd());
  const policy = loadJson(path.join(root, 'docs/control-plane/policy.json'));
  const intakeArg = parseArg(args, '--intake', { required: true });
  const intakePath = repoPath(root, intakeArg);
  const intake = loadJson(intakePath);
  const id = String(intake.id ?? '');
  validateTaskId(id);
  if (!['syntax','documentation','dependency','sequential-same-file','feature','bugfix','research'].includes(intake.task_kind)) throw new Error('task_kind must identify the work class');
  if (!['low','high'].includes(intake.uncertainty)) throw new Error('uncertainty must be low or high');
  if (!Array.isArray(intake.files) || intake.files.some(file => typeof file !== 'string')) throw new Error('files must be an array of repository paths');
  if (!Number.isInteger(intake.architectural_file_count) || intake.architectural_file_count < 0) throw new Error('architectural_file_count must be a non-negative integer');
  if (!Number.isInteger(intake.expected_code_lines) || intake.expected_code_lines < 0) throw new Error('expected_code_lines must be a non-negative integer');
  if (!Array.isArray(intake.blast_radius)) throw new Error('blast_radius must be an array');
  const allowedAreas = new Set(policy.routing.critical_areas);
  if (intake.blast_radius.some(area => typeof area !== 'string' || !allowedAreas.has(area))) throw new Error('blast_radius contains an unsupported area');
  if (!['deterministic','difficult'].includes(intake.verification_difficulty)) throw new Error('verification_difficulty must be deterministic or difficult');
  if (typeof intake.implementation_required !== 'boolean' || typeof intake.research_required !== 'boolean') throw new Error('implementation_required and research_required must be booleans');

  const highRadius = intake.blast_radius.some(area => allowedAreas.has(area));
  const routineTask = policy.routing.routine_task_kinds.includes(intake.task_kind);
  const highComplexity = !routineTask && (intake.architectural_file_count > policy.routing.complexity.architectural_file_count_gt || intake.expected_code_lines > policy.routing.complexity.expected_code_lines_gt || (policy.routing.complexity.difficult_verification_triggers && intake.verification_difficulty === 'difficult'));
  const reviewTriggered = highRadius || highComplexity;
  let route;
  let roles;
  if (intake.task_kind === 'research' && intake.implementation_required !== true) {
    route = 'isolated-read-only-research';
    roles = ['provider_researcher'];
  } else if (routineTask && !highRadius) {
    route = 'single-builder-routine';
    roles = ['implementer'];
  } else if (highRadius && highComplexity) {
    route = 'planner-builder-independent-evaluator';
    roles = ['phase_mapper','implementer','reviewer','security_auditor','verifier','evaluator'];
  } else if (highRadius) {
    route = 'builder-with-independent-security-review';
    roles = ['implementer','security_auditor','verifier','evaluator'];
  } else if (intake.uncertainty === 'high') {
    route = 'read-only-explore-then-builder';
    const explorer = intake.research_required === true ? 'provider_researcher' : 'phase_mapper';
    roles = [explorer, ...(intake.implementation_required === true ? ['implementer'] : []), ...(reviewTriggered ? ['reviewer'] : [])];
  } else if (highComplexity) {
    route = 'single-builder-with-independent-review';
    roles = ['implementer','reviewer','verifier'];
  } else {
    route = 'single-builder';
    roles = ['implementer'];
  }

  // A default-fail contract is mandatory whenever the selected route carries
  // independent review/adjudication, and for every high-radius task even when
  // its current route is read-only research.
  const acceptanceContractRequired = highRadius || roles.some(role => ['reviewer','security_auditor','verifier','evaluator'].includes(role));
  let criteriaItems = null;
  if (acceptanceContractRequired) {
    const criteria = intake.acceptance_criteria;
    if (!Array.isArray(criteria) || criteria.length === 0) throw new Error('high-radius or independently reviewed intake requires acceptance_criteria before code generation');
    const seen = new Set();
    criteriaItems = criteria.map(value => {
      const criterionId = typeof value === 'string' ? value : value?.id;
      if (typeof criterionId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(criterionId) || seen.has(criterionId)) throw new Error(`invalid or duplicate acceptance criterion: ${criterionId}`);
      seen.add(criterionId);
      return { criterion_id: criterionId, status: policy.verification_statuses.criterion[1], disposition: 'PENDING', evidence: null };
    });
  }

  const delegatedRoles = new Set(policy.routing.delegated_roles);
  const worktreeRequired = roles.some(role => delegatedRoles.has(role)) || route === 'isolated-read-only-research';
  let executionRoot = root;
  let preservedIntake = intakeArg.replaceAll('\\', '/');
  let assignmentOwner = null;
  if (worktreeRequired) {
    const scope = intake.files.length ? intake.files.join(',') : '.';
    assignmentOwner = roles.includes('implementer') ? 'implementer' : roles[0];
    const created = spawnSync(process.execPath, [path.join(root, 'scripts/control-plane/create-worktree.mjs'), '--name', id, '--owner', assignmentOwner, '--unit', id, '--scope', scope], { cwd: root, encoding: 'utf8', windowsHide: true });
    if (created.status !== 0) throw new Error((created.stderr || created.stdout || 'worktree creation failed').trim());
    const worktreeRecord = JSON.parse(created.stdout);
    executionRoot = worktreeRecord.worktree;
  }

  const bundle = ensureTaskBundle(executionRoot, id, intake);
  const taskIntakePath = repoPath(executionRoot, `${bundle.relative}/intake.json`);
  preservedIntake = path.relative(executionRoot, taskIntakePath).replaceAll('\\', '/');

  let defaultFailContract = null;
  if (criteriaItems) {
    const contractPath = path.join(bundle.directory, 'test-results.json');
    if (fs.existsSync(contractPath)) throw new Error(`task ${id} already has acceptance results; refusing to overwrite them`);
    const contract = { schema_version: policy.evidence_schema_versions.task_acceptance, task_id: id, bundle_id: bundle.bundle_id, status: policy.verification_statuses.criterion[1], criteria: criteriaItems, generated_at: new Date().toISOString() };
    writeJsonAtomic(contractPath, contract);
    defaultFailContract = `${bundle.relative}/test-results.json`;
  }

  const result = {
    schema_version: policy.evidence_schema_versions.task_route,
    task_id: id,
    route,
    signals: { task_kind: intake.task_kind, uncertainty: intake.uncertainty, file_count: intake.files.length, architectural_file_count: intake.architectural_file_count, expected_code_lines: intake.expected_code_lines, high_radius: highRadius, high_complexity: highComplexity, independent_review_triggered: reviewTriggered },
    roles,
    worktree_required: worktreeRequired,
    assignment_owner: assignmentOwner,
    acceptance_contract_required: acceptanceContractRequired,
    default_fail_contract: defaultFailContract,
    bundle_id: bundle.bundle_id,
    evidence_bundle: bundle.relative,
    intake_path: preservedIntake,
    execution_root: executionRoot
  };
  const outPath = repoPath(executionRoot, `${bundle.relative}/route.json`);
  writeJsonAtomic(outPath, result);
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(`task routing failed: ${error.message}`);
  process.exit(2);
}
