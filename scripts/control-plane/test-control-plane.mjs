import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { canonicalText, classifyPlatform, loadJson, objectDigest, sha256 } from './lib.mjs';
import { auditAssignments } from './audit-worktree-assignments.mjs';
import { ensureTaskBundle } from './task-evidence.mjs';
import { validateRequiredLaneEvidence } from './validate-closeout.mjs';

const repo = process.cwd();
const node = process.execPath;
const run = (args, cwd = repo, input = undefined, env = process.env) => spawnSync(node, args, { cwd, encoding:'utf8', input, env });

assert.equal(canonicalText(Buffer.from('one\r\ntwo\r')), 'one\ntwo\n');
assert.equal(sha256(canonicalText(Buffer.from('same\r\ntext'))), sha256(canonicalText(Buffer.from('same\ntext'))));
assert.equal(objectDigest({b:1,a:2}), objectDigest({a:2,b:1}));
assert.equal(classifyPlatform('win32', {}, ''), 'native-windows');
assert.equal(classifyPlatform('linux', {WSL_DISTRO_NAME:'Ubuntu'}, 'Linux'), 'wsl');
assert.equal(classifyPlatform('linux', {}, 'Linux version'), 'linux');

const staticCheck = run(['scripts/control-plane/validate.mjs']);
assert.equal(staticCheck.status, 0, staticCheck.stderr || staticCheck.stdout);
const rootConfig = fs.readFileSync(path.join(repo,'.codex/config.toml'),'utf8');
for (const role of ['phase_mapper','task_router','provider_researcher','implementer','reviewer','verifier','evaluator','security_auditor','summarizer']) assert.match(rootConfig, new RegExp(`\\[agents\\.${role}\\]`));
assert.doesNotMatch(rootConfig,/\bdefaultShell\s*=/);
const hookConfig = JSON.parse(fs.readFileSync(path.join(repo,'.codex/hooks.json'),'utf8'));
assert.ok(hookConfig.hooks.PreToolUse.some(group => group.matcher === '.*'));
for (const groups of Object.values(hookConfig.hooks)) for (const group of groups) for (const hook of group.hooks) if (hook.type === 'command') assert.match(hook.commandWindows,/^cmd\.exe \/d \/c \.codex\\hooks\\run-hook\.cmd /i);
const assignmentAudit = auditAssignments(repo, [
  { assignment_id:'missing', unit_of_work:'missing-worktree', active:true, worktree:path.join(repo,'.codex/worktrees/missing'), branch:'codex/missing' },
  { assignment_id:'mismatch', unit_of_work:'wrong-branch', active:true, worktree:repo, branch:'codex/other' }
], [{ path:repo, branch:'main' }]);
assert.equal(assignmentAudit.status,'REVIEW_REQUIRED');
assert.deepEqual(assignmentAudit.diagnostics.map(item => item.issues), [['path-missing','branch-missing'],['branch-mismatch','branch-missing']]);
const causalGuide = fs.readFileSync(path.join(repo,'docs/control-plane/causal-debugging.md'),'utf8');
for (const phrase of ['hypothesis','minimal reproduction','baseline','one causal','focused regression','verify-fixed']) assert.ok(causalGuide.toLowerCase().includes(phrase),`causal debugging guide must cover ${phrase}`);
assert.match(causalGuide,/Do not add `defaultShell`/);

const hookAllow = run(['.codex/hooks/pre-tool-use.mjs'], repo, JSON.stringify({hook_event_name:'PreToolUse',tool_name:'Bash',tool_input:{command:'git status'}}));
assert.equal(hookAllow.status, 0);
assert.equal(hookAllow.stdout, '');
const hookDeny = run(['.codex/hooks/pre-tool-use.mjs'], repo, JSON.stringify({hook_event_name:'PreToolUse',tool_name:'Bash',tool_input:{command:'git reset --hard HEAD'}}));
assert.equal(hookDeny.status, 0);
assert.equal(JSON.parse(hookDeny.stdout).hookSpecificOutput.permissionDecision, 'deny');
const mcpUnbounded = run(['.codex/hooks/pre-tool-use.mjs'], repo, JSON.stringify({hook_event_name:'PreToolUse',tool_name:'mcp__db__query_rows',tool_input:{table:'orders'}}));
assert.equal(JSON.parse(mcpUnbounded.stdout).hookSpecificOutput.permissionDecision, 'deny');
const mcpBounded = run(['.codex/hooks/pre-tool-use.mjs'], repo, JSON.stringify({hook_event_name:'PreToolUse',tool_name:'mcp__db__query_rows',tool_input:{table:'orders',filter:{status:'open'},limit:50}}));
assert.equal(mcpBounded.stdout, '');
const mcpLimit = loadJson(path.join(repo,'docs/control-plane/policy.json')).mcp.maximum_result_utf8_bytes;
const mcpAtLimit = run(['.codex/hooks/post-tool-use.mjs'],repo,JSON.stringify({hook_event_name:'PostToolUse',tool_name:'mcp__db__query_rows',tool_response:'a'.repeat(mcpLimit - 2)}));
assert.equal(mcpAtLimit.stdout,'','serialized UTF-8 result at exactly 24,000 bytes must be allowed');
const mcpOverLimit = run(['.codex/hooks/post-tool-use.mjs'],repo,JSON.stringify({hook_event_name:'PostToolUse',tool_name:'mcp__db__query_rows',tool_response:'a'.repeat(mcpLimit - 1)}));
assert.equal(JSON.parse(mcpOverLimit.stdout).continue,false,'serialized UTF-8 result above 24,000 bytes must be dropped');
assert.match(JSON.parse(mcpOverLimit.stdout).hookSpecificOutput.additionalContext,/24,000-byte/);

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'alpaca-cp-'));
const sibling = `${temp}-worktree`;
try {
  fs.cpSync(repo, temp, { recursive:true, filter: src => path.basename(src) !== '.git' });
  spawnSync('git',['init'],{cwd:temp,encoding:'utf8'});
  spawnSync('git',['config','user.email','control-plane@example.invalid'],{cwd:temp});
  spawnSync('git',['config','user.name','Control Plane Test'],{cwd:temp});
  spawnSync('git',['add','.'],{cwd:temp});
  spawnSync('git',['commit','-m','baseline'],{cwd:temp,encoding:'utf8'});

  const preflight = run(['scripts/control-plane/preflight.mjs'], temp);
  assert.equal(preflight.status,0,preflight.stderr || preflight.stdout);
  assert.equal(JSON.parse(preflight.stdout).status,'READY');
  assert.equal(JSON.parse(preflight.stdout).baseline_kind,'current-main-working-tree');
  const ciWorkflowPath = path.join(temp,'.github/workflows/control-plane.yml');
  const ciWorkflowSource = fs.readFileSync(ciWorkflowPath,'utf8');
  fs.writeFileSync(ciWorkflowPath,ciWorkflowSource.replace('node scripts/control-plane/test-control-plane.mjs','node scripts/control-plane/test-hooks-windows.mjs'));
  const ciCoverageDrift = run(['scripts/control-plane/validate.mjs'],temp);
  assert.notEqual(ciCoverageDrift.status,0,'semantic validator must reject removal of required CI regression coverage');
  assert.match(ciCoverageDrift.stderr + ciCoverageDrift.stdout,/CI workflow missing required trust check: node scripts\/control-plane\/test-control-plane\.mjs/);
  fs.writeFileSync(ciWorkflowPath,ciWorkflowSource);
  const capabilityPath = path.join(temp,'docs/control-plane/capabilities.json');
  const capabilitySource = fs.readFileSync(capabilityPath,'utf8');
  fs.writeFileSync(capabilityPath,capabilitySource.replace('"maximum_utf8_bytes": 24000','"maximum_utf8_bytes": 25000'));
  const capabilityDrift = run(['scripts/control-plane/validate.mjs'],temp);
  assert.notEqual(capabilityDrift.status,0,'semantic validator must reject MCP capability drift');
  assert.match(capabilityDrift.stderr + capabilityDrift.stdout,/MCP policy in capabilities\.json differs from canonical policy/);
  fs.writeFileSync(capabilityPath,capabilitySource);
  const workflowPath = path.join(temp,'docs/control-plane/WORKFLOW.md');
  const workflowSource = fs.readFileSync(workflowPath,'utf8');
  fs.writeFileSync(workflowPath,workflowSource.replace('24,000 UTF-8 bytes','25,000 UTF-8 bytes'));
  const documentationDrift = run(['scripts/control-plane/validate.mjs'],temp);
  assert.notEqual(documentationDrift.status,0,'semantic validator must reject normative documentation drift');
  assert.match(documentationDrift.stderr + documentationDrift.stdout,/WORKFLOW\.md.*canonical|WORKFLOW\.md contradicts/);
  fs.writeFileSync(workflowPath,workflowSource);
  const phaseStatePath = path.join(temp,'docs/control-plane/phase-state.json');
  const phaseStateSource = fs.readFileSync(phaseStatePath,'utf8');
  const canonicalVersion = loadJson(path.join(temp,'docs/control-plane/policy.json')).control_plane_version;
  fs.writeFileSync(phaseStatePath,phaseStateSource.replace(`"control_plane_version": "${canonicalVersion}"`,`"control_plane_version": "${canonicalVersion}-drift"`));
  const versionDrift = run(['scripts/control-plane/validate.mjs'],temp);
  assert.notEqual(versionDrift.status,0,'semantic validator must reject a duplicated control-plane version drift');
  assert.match(versionDrift.stderr + versionDrift.stdout,/control-plane version differs from canonical policy/);
  fs.writeFileSync(phaseStatePath,phaseStateSource);
  const componentsPath = path.join(temp,'docs/control-plane/components.json');
  const componentsSource = fs.readFileSync(componentsPath,'utf8');
  const components = JSON.parse(componentsSource);
  components.agent_roles[0].default_permissions = 'project-implement';
  fs.writeFileSync(componentsPath,JSON.stringify(components,null,2)+'\n');
  const roleDrift = run(['scripts/control-plane/validate.mjs'],temp);
  assert.notEqual(roleDrift.status,0,'semantic validator must reject duplicated agent-role policy drift');
  assert.match(roleDrift.stderr + roleDrift.stdout,/agent role phase_mapper differs from canonical policy/);
  fs.writeFileSync(componentsPath,componentsSource);

  // Registered debugging blocks source edits until the exact failure is reproduced.
  const debugSignature = 'FixtureError: causal repro signature';
  const caseFile = 'verification/reproductions/debug-fixture.mjs';
  fs.mkdirSync(path.dirname(path.join(temp,caseFile)),{recursive:true});
  const fixtureSource = path.join(temp,'scripts/control-plane/example-bug.mjs');
  fs.writeFileSync(fixtureSource,`throw new Error(${JSON.stringify(debugSignature)})\n`);
  fs.writeFileSync(path.join(temp,caseFile),`import '../../scripts/control-plane/example-bug.mjs'\n`);
  const harmlessSource = path.join(temp,'scripts/control-plane/harmless.mjs');
  fs.writeFileSync(harmlessSource,`export const harmless = () => 1\n`);
  const forgedCase = 'verification/reproductions/forged-fixture.mjs';
  const fabricatedTrace = `    at fake (file:///${fixtureSource.replaceAll('\\','/')})`;
  fs.writeFileSync(path.join(temp,forgedCase),`import { harmless } from '../../scripts/control-plane/harmless.mjs'; harmless(); process.stderr.write(${JSON.stringify(`${debugSignature}\n${fabricatedTrace}`)}); process.exit(1)\n`);
  let forged = run(['scripts/control-plane/causal-debug.mjs','register','--id','forged-fixture','--case',forgedCase,'--scope','scripts/control-plane/example-bug.mjs','--signature',debugSignature],temp);
  assert.equal(forged.status,0,forged.stderr);
  forged = run(['scripts/control-plane/causal-debug.mjs','reproduce','--id','forged-fixture','--case',forgedCase,'--signature',debugSignature],temp);
  assert.equal(JSON.parse(forged.stdout).status,'AWAITING_REPRODUCTION','printing the expected signature without a scoped stack trace cannot prove reproduction');
  fs.rmSync(path.join(temp,'verification/control-plane/debug-tasks/active.json'),{force:true});
  const forgedTaskPath = path.join(temp,'verification/control-plane/debug-tasks/forged-fixture.json');
  const forgedTask = JSON.parse(fs.readFileSync(forgedTaskPath,'utf8')); forgedTask.status = 'CANCELLED'; fs.writeFileSync(forgedTaskPath,JSON.stringify(forgedTask,null,2)+'\n');
  fs.rmSync(path.join(temp,forgedCase),{force:true});
  let debug = run(['scripts/control-plane/causal-debug.mjs','register','--id','debug-fixture','--case',caseFile,'--scope','scripts/control-plane','--signature',debugSignature],temp);
  assert.equal(debug.status,0,debug.stderr);
  const concealedWrite = run(['.codex/hooks/pre-tool-use.mjs'],temp,JSON.stringify({hook_event_name:'PreToolUse',tool_name:'Bash',cwd:temp,tool_input:{command:'node scripts/edit-script.js'}}));
  assert.equal(JSON.parse(concealedWrite.stdout).hookSpecificOutput.permissionDecision,'deny','unknown shell wrappers are blocked during an active debug task');
  fs.rmSync(path.join(temp,'verification/control-plane/debug-tasks/active.json'));
  const markerBypass = run(['.codex/hooks/pre-tool-use.mjs'],temp,JSON.stringify({hook_event_name:'PreToolUse',tool_name:'Edit',cwd:temp,tool_input:{file_path:'scripts/control-plane/example-bug.mjs',old_string:'before',new_string:'after'}}));
  assert.equal(JSON.parse(markerBypass.stdout).hookSpecificOutput.permissionDecision,'deny','a missing active marker does not disable a pending task gate');
  fs.writeFileSync(path.join(temp,'verification/control-plane/debug-tasks/active.json'),JSON.stringify({task_id:'debug-fixture'})+'\n');
  const editPayload = patchPath => ({ hook_event_name:'PreToolUse',tool_name:'apply_patch',cwd:temp,tool_input:{file_path:patchPath,patch:'*** Begin Patch\n*** Update File: x\n'} });
  let gated = run(['.codex/hooks/pre-tool-use.mjs'],temp,JSON.stringify(editPayload('scripts/control-plane/example.mjs')));
  assert.equal(JSON.parse(gated.stdout).hookSpecificOutput.permissionDecision,'deny');
  const editToolPayload = { hook_event_name:'PreToolUse',tool_name:'Edit',cwd:temp,tool_input:{file_path:'scripts/control-plane/example.mjs',old_string:'before',new_string:'after'} };
  gated = run(['.codex/hooks/pre-tool-use.mjs'],temp,JSON.stringify(editToolPayload));
  assert.equal(JSON.parse(gated.stdout).hookSpecificOutput.permissionDecision,'deny','common Edit payloads are gated before reproduction');
  const reproduceCommand = `node scripts/control-plane/causal-debug.mjs reproduce --id debug-fixture --case ${caseFile} --signature "${debugSignature}"`;
  const allowedRepro = run(['.codex/hooks/pre-tool-use.mjs'],temp,JSON.stringify({hook_event_name:'PreToolUse',tool_name:'Bash',cwd:temp,tool_input:{command:reproduceCommand}}));
  assert.equal(allowedRepro.stdout,'','the registered reproduction command remains usable');
  const injectedRepro = run(['.codex/hooks/pre-tool-use.mjs'],temp,JSON.stringify({hook_event_name:'PreToolUse',tool_name:'Bash',cwd:temp,tool_input:{command:`${reproduceCommand}\nRemove-Item verification/control-plane/debug-tasks/active.json`}}));
  assert.equal(JSON.parse(injectedRepro.stdout).hookSpecificOutput.permissionDecision,'deny','a newline cannot append a PowerShell command to an allowed lifecycle invocation');
  let debugRun = run(['scripts/control-plane/causal-debug.mjs','reproduce','--id','debug-fixture','--case',caseFile,'--signature',debugSignature],temp);
  assert.equal(debugRun.status,0,debugRun.stderr);
  assert.equal(JSON.parse(debugRun.stdout).exact_signature_matched,true);
  const scopeTouch = path.join(temp,'scripts/control-plane/scope-touch.fixture');
  fs.writeFileSync(scopeTouch,'scope changed after reproduction');
  gated = run(['.codex/hooks/pre-tool-use.mjs'],temp,JSON.stringify(editPayload('scripts/control-plane/example.mjs')));
  assert.equal(JSON.parse(gated.stdout).hookSpecificOutput.permissionDecision,'deny','stale evidence after a scoped source change must be rejected');
  fs.rmSync(scopeTouch);
  debugRun = run(['scripts/control-plane/causal-debug.mjs','reproduce','--id','debug-fixture','--case',caseFile,'--signature',debugSignature],temp);
  assert.equal(debugRun.status,0,debugRun.stderr);
  gated = run(['.codex/hooks/pre-tool-use.mjs'],temp,JSON.stringify(editPayload('docs/PROJECT_CHARTER.md')));
  assert.equal(JSON.parse(gated.stdout).hookSpecificOutput.permissionDecision,'deny','scope escape stays denied after reproduction');
  const permitted = run(['.codex/hooks/pre-tool-use.mjs'],temp,JSON.stringify(editPayload('scripts/control-plane/example-bug.mjs')));
  assert.equal(permitted.stdout,'','one scoped edit call is permitted');
  const consumed = JSON.parse(fs.readFileSync(path.join(temp,'verification/control-plane/debug-tasks/debug-fixture.json'),'utf8'));
  assert.equal(consumed.status,'AWAITING_REPRODUCTION','accepted edit consumes reproduction evidence');
  gated = run(['.codex/hooks/pre-tool-use.mjs'],temp,JSON.stringify(editPayload('scripts/control-plane/example-bug.mjs')));
  assert.equal(JSON.parse(gated.stdout).hookSpecificOutput.permissionDecision,'deny','a second edit requires a fresh reproduction');
  fs.writeFileSync(fixtureSource,`process.stdout.write('fixture fixed')\n`);
  debugRun = run(['scripts/control-plane/causal-debug.mjs','verify-fixed','--id','debug-fixture','--case',caseFile,'--signature',debugSignature],temp);
  assert.equal(debugRun.status,0,debugRun.stderr);
  assert.equal(JSON.parse(debugRun.stdout).status,'FIX_VERIFIED');
  debugRun = run(['scripts/control-plane/causal-debug.mjs','complete','--id','debug-fixture'],temp);
  assert.equal(debugRun.status,0,debugRun.stderr);
  fs.rmSync(path.join(temp,caseFile),{force:true});
  fs.rmSync(fixtureSource,{force:true});
  fs.rmSync(harmlessSource,{force:true});
  const hookJsonPath = path.join(temp,'.codex/hooks.json');
  const goodHooks = fs.readFileSync(hookJsonPath,'utf8');
  const badHooks = JSON.parse(goodHooks);
  badHooks.hooks.SessionStart[0].hooks[0].commandWindows = 'cmd /c';
  fs.writeFileSync(hookJsonPath,JSON.stringify(badHooks,null,2), 'utf8');
  const badWindowsHook = run(['scripts/control-plane/validate.mjs'],temp);
  assert.notEqual(badWindowsHook.status,0,'unregistered Windows hook command must fail validation');
  fs.writeFileSync(hookJsonPath,goodHooks,'utf8');

  // Concurrent writers are gated through Git's shared common directory, not per-worktree untracked files.
  const staleRegistry = path.join(temp,'.git','codex-control-plane','worktree-assignments');
  fs.mkdirSync(staleRegistry,{recursive:true});
  fs.writeFileSync(path.join(staleRegistry,'stale-deleted-worktree.json'),JSON.stringify({assignment_id:'stale-deleted-worktree',active:true,worktree:path.join(temp,'.codex/worktrees/windows-causal-debug'),branch:'codex/windows-causal-debug',owner:'implementer',scope:['src'],unit_of_work:'windows-causal-debug'}));
  const firstAssignment = run(['scripts/control-plane/worktree-assignment.mjs','--owner','writer-a','--unit','u1','--scope','src'],temp);
  assert.equal(firstAssignment.status,0,firstAssignment.stderr,'stale ownership for a deleted worktree must not block current assignments');
  const firstAssignmentId = JSON.parse(firstAssignment.stdout).assignment_id;
  const sameWorktreeOtherOwner = run(['scripts/control-plane/worktree-assignment.mjs','--owner','writer-c','--unit','u3','--scope','tests'],temp);
  assert.notEqual(sameWorktreeOtherOwner.status,0,'a second writer may not share the same worktree');
  assert.match(sameWorktreeOtherOwner.stderr,/worktree already has active owner/);
  const added = spawnSync('git',['worktree','add','-b','cp-regression-sibling',sibling,'HEAD'],{cwd:temp,encoding:'utf8'});
  assert.equal(added.status,0,added.stderr);
  const overlap = run(['scripts/control-plane/worktree-assignment.mjs','--owner','writer-b','--unit','u2','--scope','src/services'],sibling);
  assert.notEqual(overlap.status,0,'overlapping sibling worktree assignment must be rejected');
  assert.match(overlap.stderr,/overlaps active assignment/);
  const released = run(['scripts/control-plane/worktree-assignment.mjs','--release',firstAssignmentId],temp);
  assert.equal(released.status,0,released.stderr);
  const afterRelease = run(['scripts/control-plane/worktree-assignment.mjs','--owner','writer-b','--unit','u2','--scope','src/services'],sibling);
  assert.equal(afterRelease.status,0,afterRelease.stderr);
  spawnSync('git',['worktree','remove','--force',sibling],{cwd:temp,encoding:'utf8'});

  const phase = JSON.parse(fs.readFileSync(path.join(temp,'docs/control-plane/phase-state.json'),'utf8')).phases[0];

  // Historical singleton evidence must not block or be reused by a new task.
  const historical = JSON.parse(fs.readFileSync(path.join(temp,'verification/test-results.json'),'utf8'));
  assert.equal(historical.status,'PASS');
  for (const [id,file] of [['routed-history','src/route-a.mjs'],['routed-new','docs/route-b.md']]) {
    const intake = { id, task_kind:'feature', uncertainty:'high', files:[file], architectural_file_count:4, expected_code_lines:100, blast_radius:['functional-correctness'], verification_difficulty:'difficult', implementation_required:true, research_required:true, acceptance_criteria:[{id:`${id}-criterion`}] };
    const intakePath = `verification/control-plane/task-routing/${id}.intake.json`;
    fs.mkdirSync(path.dirname(path.join(temp,intakePath)),{recursive:true});
    fs.writeFileSync(path.join(temp,intakePath),JSON.stringify(intake));
    const route = run(['scripts/control-plane/route-task.mjs','--intake',intakePath],temp);
    assert.equal(route.status,0,route.stderr || route.stdout,'a completed historical singleton must not abort a new high-risk task');
    const routed = JSON.parse(route.stdout);
    assert.equal(routed.default_fail_contract,`verification/control-plane/tasks/${id}/test-results.json`);
    const taskResults = JSON.parse(fs.readFileSync(path.join(routed.execution_root,routed.default_fail_contract),'utf8'));
    assert.equal(taskResults.status,'FAIL');
    assert.equal(taskResults.task_id,id);
  }
  const policyPath = path.join(temp,'docs/control-plane/policy.json');
  const routingPolicySource = fs.readFileSync(policyPath,'utf8');
  const routingPolicy = JSON.parse(routingPolicySource);
  routingPolicy.routing.complexity.architectural_file_count_gt = 10;
  routingPolicy.routing.complexity.expected_code_lines_gt = 200;
  routingPolicy.routing.complexity.difficult_verification_triggers = false;
  fs.writeFileSync(policyPath,JSON.stringify(routingPolicy,null,2)+'\n');
  const thresholdIntake = { id:'policy-routing-threshold', task_kind:'feature', uncertainty:'low', files:['src/policy.mjs'], architectural_file_count:4, expected_code_lines:100, blast_radius:['functional-correctness'], verification_difficulty:'difficult', implementation_required:true, research_required:false, acceptance_criteria:[{id:'policy-routing-threshold-criterion'}] };
  const thresholdIntakePath = 'verification/control-plane/task-routing/policy-routing-threshold.intake.json';
  fs.mkdirSync(path.dirname(path.join(temp,thresholdIntakePath)),{recursive:true});
  fs.writeFileSync(path.join(temp,thresholdIntakePath),JSON.stringify(thresholdIntake));
  const thresholdRoute = run(['scripts/control-plane/route-task.mjs','--intake',thresholdIntakePath],temp);
  assert.equal(thresholdRoute.status,0,thresholdRoute.stderr || thresholdRoute.stdout);
  assert.equal(JSON.parse(thresholdRoute.stdout).route,'builder-with-independent-security-review','runtime router must consume canonical complexity thresholds');
  const routeCases = [
    { id:'review-low-complexity-radius', task_kind:'feature', uncertainty:'low', files:['src/low-radius.mjs'], architectural_file_count:0, expected_code_lines:1, blast_radius:['functional-correctness'], verification_difficulty:'deterministic', implementation_required:true, research_required:false, expected_route:'builder-with-independent-security-review', contract:true },
    { id:'review-complexity-only', task_kind:'feature', uncertainty:'low', files:['src/complex.mjs'], architectural_file_count:11, expected_code_lines:1, blast_radius:[], verification_difficulty:'deterministic', implementation_required:true, research_required:false, expected_route:'single-builder-with-independent-review', contract:true },
    { id:'routine-lightweight', task_kind:'documentation', uncertainty:'low', files:['docs/routine.md'], architectural_file_count:0, expected_code_lines:1, blast_radius:[], verification_difficulty:'deterministic', implementation_required:true, research_required:false, expected_route:'single-builder-routine', contract:false }
  ];
  for (const item of routeCases) {
    const { expected_route, contract, ...intakeBase } = item;
    const intakePath = `verification/control-plane/task-routing/${item.id}.intake.json`;
    fs.writeFileSync(path.join(temp,intakePath),JSON.stringify({ ...intakeBase, acceptance_criteria:[{id:`${item.id}-criterion`}] }));
    const routedRun = run(['scripts/control-plane/route-task.mjs','--intake',intakePath],temp);
    assert.equal(routedRun.status,0,routedRun.stderr || routedRun.stdout);
    const routed = JSON.parse(routedRun.stdout);
    assert.equal(routed.route,expected_route);
    assert.equal(routed.acceptance_contract_required,contract);
    assert.equal(Boolean(routed.default_fail_contract),contract);
    if (contract) {
      const results = JSON.parse(fs.readFileSync(path.join(routed.execution_root,routed.default_fail_contract),'utf8'));
      assert.equal(results.status,'FAIL');
      assert.equal(results.criteria[0].criterion_id,`${item.id}-criterion`);
    }
    const missingCriteriaPath = `verification/control-plane/task-routing/${item.id}-missing.intake.json`;
    fs.writeFileSync(path.join(temp,missingCriteriaPath),JSON.stringify({ ...intakeBase, id:`${item.id}-missing` }));
    const missingCriteria = run(['scripts/control-plane/route-task.mjs','--intake',missingCriteriaPath],temp);
    if (contract) {
      assert.notEqual(missingCriteria.status,0,'reviewed routes must reject missing task acceptance criteria');
      assert.match(missingCriteria.stderr,/requires acceptance_criteria/);
    } else {
      assert.equal(missingCriteria.status,0,missingCriteria.stderr || missingCriteria.stdout,'routine work must not require acceptance criteria');
      const routineRoute = JSON.parse(missingCriteria.stdout);
      assert.equal(routineRoute.acceptance_contract_required,false);
      assert.equal(routineRoute.default_fail_contract,null);
    }
  }
  fs.writeFileSync(policyPath,routingPolicySource);
  assert.equal(JSON.parse(fs.readFileSync(path.join(temp,'verification/test-results.json'),'utf8')).status,'PASS','legacy evidence remains preserved and untouched');
  const legacyTaskId = 'legacy-migration-fixture';
  const legacyIntake = {id:legacyTaskId,task_kind:'feature',files:['src/legacy.mjs']};
  const legacyTaskDir = path.join(temp,'verification/control-plane/task-routing');
  fs.mkdirSync(legacyTaskDir,{recursive:true});
  fs.writeFileSync(path.join(legacyTaskDir,`${legacyTaskId}.intake.json`),JSON.stringify(legacyIntake));
  fs.writeFileSync(path.join(legacyTaskDir,`${legacyTaskId}.json`),JSON.stringify({schema_version:1,task_id:legacyTaskId,route:'single-builder',roles:['implementer']}));
  const legacyCheckDir = path.join(temp,'verification/control-plane/check-results');
  fs.mkdirSync(legacyCheckDir,{recursive:true});
  fs.writeFileSync(path.join(legacyCheckDir,'legacy-migration-check.json'),JSON.stringify({schema_version:1,id:'legacy-migration-check',status:'PASS',exit_code:0,completed_at:'2026-01-01T00:00:00Z',log_path:'verification/control-plane/check-results/legacy-migration-check.log'}));
  fs.writeFileSync(path.join(legacyCheckDir,'legacy-migration-check.log'),'legacy evidence log');
  const legacyResultsPath = `verification/control-plane/task-routing/${legacyTaskId}.legacy-results.json`;
  const legacyResults = {schema_version:1,task_id:legacyTaskId,status:'PASS',criteria:[{criterion_id:'LEGACY-1',status:'PASS',evidence:{check_id:'legacy-migration-check',check_path:'verification/control-plane/check-results/legacy-migration-check.json',exit_code:0}}]};
  fs.writeFileSync(path.join(temp,legacyResultsPath),JSON.stringify(legacyResults));
  const migrated = run(['scripts/control-plane/migrate-test-results.mjs','--task-id',legacyTaskId,'--legacy-results',legacyResultsPath],temp);
  assert.equal(migrated.status,0,migrated.stderr || migrated.stdout);
  const legacyAfter = JSON.parse(fs.readFileSync(path.join(temp,legacyResultsPath),'utf8'));
  assert.equal(legacyAfter.schema_version,1,'migration preserves the original legacy evidence');
  const migrationValidation = run(['scripts/control-plane/validate-test-results.mjs','--task-id',legacyTaskId],temp);
  assert.equal(migrationValidation.status,0,migrationValidation.stderr || migrationValidation.stdout);
  const intakeA = { id:'bundle-a', task_kind:'feature', files:['src/a.mjs'] };
  const intakeB = { id:'bundle-b', task_kind:'feature', files:['src/b.mjs'] };
  const bundleA = ensureTaskBundle(temp,'bundle-a',intakeA);
  const bundleB = ensureTaskBundle(temp,'bundle-b',intakeB);
  assert.notEqual(bundleA.bundle_id,bundleB.bundle_id,'different task identities must have isolated evidence bundle identities');
  const resultAPath = path.join(bundleA.directory,'test-results.json');
  const resultBPath = path.join(bundleB.directory,'test-results.json');
  fs.writeFileSync(resultAPath,JSON.stringify({schema_version:2,task_id:'bundle-a',bundle_id:bundleA.bundle_id,status:'FAIL',criteria:[{criterion_id:'A',status:'FAIL'}]}));
  fs.writeFileSync(resultBPath,JSON.stringify({schema_version:2,task_id:'bundle-b',bundle_id:bundleB.bundle_id,status:'FAIL',criteria:[{criterion_id:'B',status:'FAIL'}]}));
  assert.equal(JSON.parse(fs.readFileSync(resultAPath,'utf8')).criteria[0].criterion_id,'A');
  assert.equal(JSON.parse(fs.readFileSync(resultBPath,'utf8')).criteria[0].criterion_id,'B','parallel task evidence must not overwrite its sibling');

  // Immutable source snapshots do not require a live Codex runtime.
  const snapshotRun = run(['scripts/control-plane/snapshot-control-plane.mjs'], temp);
  assert.equal(snapshotRun.status,0,snapshotRun.stderr || snapshotRun.stdout);
  const snapshot = JSON.parse(snapshotRun.stdout);
  assert.equal(snapshot.schema_version,2);
  assert.equal(Object.hasOwn(snapshot,'qualification_id'),false);
  const snapshotRel = `verification/control-plane/snapshots/${snapshot.snapshot_id}.json`;
  fs.writeFileSync(path.join(temp, phase.report_file), 'Phase status: COMPLETE\n');
  let advanced = run(['scripts/control-plane/advance-phase.mjs','--phase','1'], temp);
  assert.notEqual(advanced.status, 0, 'prose-only COMPLETE must not advance');
  assert.match(advanced.stderr, /missing machine closeout manifest/);

  // Candidate identity changes for engineering files but ignores control-plane evidence files.
  const taskBundle = ensureTaskBundle(temp,'closeout-fixture',{id:'closeout-fixture',task_kind:'feature',files:['README.md']});
  fs.writeFileSync(path.join(taskBundle.directory,'route.json'),JSON.stringify({task_id:'closeout-fixture',bundle_id:taskBundle.bundle_id,evidence_bundle:'verification/control-plane/tasks/closeout-fixture'}));
  fs.writeFileSync(path.join(taskBundle.directory,'test-results.json'),JSON.stringify({schema_version:2,task_id:'closeout-fixture',bundle_id:taskBundle.bundle_id,status:'PASS',criteria:[{criterion_id:'fixture-not-needed',status:'NOT_APPLICABLE',rationale:'fixture closeout only'}]}));
  let candidateA = run(['scripts/control-plane/candidate-id.mjs','--snapshot',snapshotRel,'--task-id','closeout-fixture'],temp);
  assert.equal(candidateA.status,0,candidateA.stderr);
  const candidateRecordA = JSON.parse(candidateA.stdout);
  const idA = candidateRecordA.candidate_id;
  fs.mkdirSync(path.join(temp,'verification/control-plane/runtime'),{recursive:true});
  fs.writeFileSync(path.join(temp,'verification/control-plane/runtime/noise.json'),'{}');
  fs.writeFileSync(path.join(temp,'verification/phase-reports/phase-01.closeout.json'),'{}');
  let candidateEvidence = run(['scripts/control-plane/candidate-id.mjs','--snapshot',snapshotRel,'--task-id','closeout-fixture'],temp);
  assert.equal(JSON.parse(candidateEvidence.stdout).candidate_id,idA,'evidence artifacts must not recursively mutate candidate identity');
  const originalReadme = fs.readFileSync(path.join(temp,'README.md'),'utf8');
  fs.writeFileSync(path.join(temp,'README.md'),originalReadme+'\nengineering change\n');
  let candidateB = run(['scripts/control-plane/candidate-id.mjs','--snapshot',snapshotRel,'--task-id','closeout-fixture'],temp);
  assert.notEqual(JSON.parse(candidateB.stdout).candidate_id,idA,'engineering change must mutate candidate identity');

  // Closeout with stale candidate must fail before advancement.
  const contracts = JSON.parse(fs.readFileSync(path.join(temp,'docs/control-plane/phase-contracts.json'),'utf8'));
  const goalDigest = contracts.phases[0].goal_digest;
  const charterDigest = JSON.parse(fs.readFileSync(path.join(temp,'docs/control-plane/phase-state.json'),'utf8')).charter_sha256;
  const manifest = {
    schema_version:3, phase:1, charter_digest:charterDigest, goal_digest:goalDigest,
    snapshot_id:snapshot.snapshot_id, snapshot_artifact:snapshotRel, candidate_id:idA,
    task_id:'closeout-fixture', task_bundle_id:taskBundle.bundle_id,
    acceptance:contracts.phases[0].criteria.map(c=>({criterion_id:c.id,disposition:'PASS',evidence:'test'})),
    verification:[{command:'node test',exit_code:0,evidence:'pass'}],
    review:{verdict:'PASS',candidate_id:idA,task_id:'closeout-fixture',task_bundle_id:taskBundle.bundle_id,evidence:'review'}, verifier:{verdict:'PASS',candidate_id:idA,task_id:'closeout-fixture',task_bundle_id:taskBundle.bundle_id,evidence:'verify'}, evaluation:{verdict:'PASS',candidate_id:idA,task_id:'closeout-fixture',task_bundle_id:taskBundle.bundle_id,evidence:'eval'},
    unresolved_blockers:[], phase_status:'COMPLETE'
  };
  for (const role of ['review','verifier','evaluation']) fs.writeFileSync(path.join(taskBundle.directory,`${role}.${idA}.json`),JSON.stringify(manifest[role]));
  fs.mkdirSync(path.join(taskBundle.directory,'candidates'),{recursive:true});
  fs.writeFileSync(path.join(taskBundle.directory,'candidates',`${idA}.json`),JSON.stringify(candidateRecordA));
  fs.writeFileSync(path.join(taskBundle.directory,`verification.${idA}.json`),JSON.stringify({status:'PASS',task_id:'closeout-fixture',task_bundle_id:taskBundle.bundle_id,candidate_id:idA,commands:manifest.verification}));
  fs.writeFileSync(path.join(temp,'verification/phase-reports/phase-01.closeout.json'),JSON.stringify(manifest,null,2));
  const stale = run(['scripts/control-plane/validate-closeout-cli.mjs','--phase','1'],temp);
  assert.notEqual(stale.status,0);
  assert.match(stale.stderr,/EVIDENCE_STALE/);

  // Restoring the engineering candidate makes the same evidence identity valid and permits exactly one transition.
  fs.writeFileSync(path.join(temp,'README.md'),originalReadme);
  const restored = run(['scripts/control-plane/candidate-id.mjs','--snapshot',snapshotRel,'--task-id','closeout-fixture'],temp);
  assert.equal(JSON.parse(restored.stdout).candidate_id,idA);

  // Post-diff classification must raise low intake estimates before freeze.
  const underestimatedId = 'underestimated-risk-fixture';
  const underestimatedBundle = ensureTaskBundle(temp,underestimatedId,{id:underestimatedId,task_kind:'feature',uncertainty:'low',files:['src/feature.mjs'],architectural_file_count:0,expected_code_lines:1,blast_radius:[],verification_difficulty:'deterministic',implementation_required:true,research_required:false});
  fs.writeFileSync(path.join(underestimatedBundle.directory,'route.json'),JSON.stringify({schema_version:1,task_id:underestimatedId,bundle_id:underestimatedBundle.bundle_id,route:'single-builder',roles:['implementer'],acceptance_contract_required:false,signals:{high_radius:false,high_complexity:false},evidence_bundle:underestimatedBundle.relative}));
  const riskFiles = [
    ['migrations/009-risk-fixture.sql','ALTER TABLE accounts ADD COLUMN approved boolean;\n'],
    ['config/permissions-risk-fixture.json','{"allow_admin":true}\n'],
    ['src/api/public-risk-fixture.mjs','export function publicContract() {}\n'],
    ['tests/security-guard-risk-fixture.test.mjs','assertPaperOnly();\n'],
    ['package.json','{"dependencies":{"new-package":"1.0.0"}}\n'],
    ['docs/control-plane/risk-fixture.md','risk policy change\n']
  ];
  for (const [relative,content] of riskFiles) { fs.mkdirSync(path.dirname(path.join(temp,relative)),{recursive:true}); fs.writeFileSync(path.join(temp,relative),content); }
  const escalatedFreeze = run(['scripts/control-plane/candidate-id.mjs','--snapshot',snapshotRel,'--task-id',underestimatedId],temp);
  assert.equal(escalatedFreeze.status,0,escalatedFreeze.stderr || escalatedFreeze.stdout);
  const frozenRisk = JSON.parse(escalatedFreeze.stdout).reconciled_post_diff_risk;
  assert.equal(frozenRisk.initial_level,'low');
  assert.equal(frozenRisk.effective_level,'critical');
  assert.equal(frozenRisk.escalated,true,'materially underestimated control-plane work must be escalated deterministically');
  for (const category of ['migration','permission-or-configuration','security-sensitive','public-api','dependency','test','control-plane-or-charter','change-magnitude']) assert.ok(frozenRisk.categories.includes(category),`actual diff classifier must account for ${category}`);
  for (const lane of ['review','security-review','verifier','evaluation']) assert.ok(frozenRisk.required_lanes.includes(lane),`critical post-diff change requires ${lane} before candidate freeze`);
  const escalatedRoute = JSON.parse(fs.readFileSync(path.join(underestimatedBundle.directory,'route.json'),'utf8'));
  assert.ok(escalatedRoute.roles.includes('security_auditor'));
  assert.equal(escalatedRoute.acceptance_contract_required,true);
  const escalatedContract = JSON.parse(fs.readFileSync(path.join(underestimatedBundle.directory,'test-results.json'),'utf8'));
  assert.equal(escalatedContract.status,'FAIL','post-diff evidence requirements must default to fail');
  assert.ok(escalatedContract.criteria.some(item => item.criterion_id === 'POST-DIFF-REQUIRED-LANES'));
  assert.deepEqual(frozenRisk.categories,JSON.parse(run(['scripts/control-plane/candidate-id.mjs','--snapshot',snapshotRel,'--task-id',underestimatedId],temp).stdout).reconciled_post_diff_risk.categories,'reclassification is deterministic across repeated freeze attempts');
  for (const [relative] of riskFiles) fs.rmSync(path.join(temp,relative),{force:true});

  const highIntakeId = 'high-intake-risk-fixture';
  const highIntakeBundle = ensureTaskBundle(temp,highIntakeId,{id:highIntakeId,task_kind:'feature',uncertainty:'low',files:['src/sensitive.mjs'],architectural_file_count:0,expected_code_lines:1,blast_radius:['security-boundary'],verification_difficulty:'deterministic',implementation_required:true,research_required:false,acceptance_criteria:[{id:'intake-security-review'}]});
  fs.writeFileSync(path.join(highIntakeBundle.directory,'route.json'),JSON.stringify({schema_version:1,task_id:highIntakeId,bundle_id:highIntakeBundle.bundle_id,route:'builder-with-independent-security-review',roles:['implementer','reviewer','security_auditor','verifier','evaluator'],acceptance_contract_required:true,signals:{high_radius:true,high_complexity:false},evidence_bundle:highIntakeBundle.relative}));
  fs.writeFileSync(path.join(highIntakeBundle.directory,'test-results.json'),JSON.stringify({schema_version:2,task_id:highIntakeId,bundle_id:highIntakeBundle.bundle_id,status:'FAIL',criteria:[{criterion_id:'intake-security-review',status:'FAIL',disposition:'PENDING',evidence:null}]}));
  const preserveHigh = run(['scripts/control-plane/candidate-id.mjs','--snapshot',snapshotRel,'--task-id',highIntakeId],temp);
  assert.equal(preserveHigh.status,0,preserveHigh.stderr || preserveHigh.stdout);
  const preservedRisk = JSON.parse(preserveHigh.stdout).reconciled_post_diff_risk;
  assert.equal(preservedRisk.initial_level,'high');
  assert.equal(preservedRisk.effective_level,'high','a low observed diff must not downgrade high intake scrutiny');
  assert.deepEqual(preservedRisk.required_lanes,['evaluation','review','security-review','verifier']);

  const laneEvidenceDir = path.join(temp,'verification/control-plane/tasks/lane-gate-fixture');
  fs.mkdirSync(laneEvidenceDir,{recursive:true});
  const laneIdentity = { candidate_id:'a'.repeat(64),task_id:'lane-gate-fixture',task_bundle_id:'b'.repeat(64),verdict:'PASS',evidence:'independent evidence' };
  const laneManifest = { evaluation:laneIdentity,review:laneIdentity,verifier:laneIdentity };
  for (const lane of ['evaluation','review','verifier']) fs.writeFileSync(path.join(laneEvidenceDir,`${lane}.${laneIdentity.candidate_id}.json`),JSON.stringify(laneIdentity));
  assert.throws(() => validateRequiredLaneEvidence({directory:laneEvidenceDir},laneIdentity.candidate_id,laneIdentity.task_id,laneIdentity.task_bundle_id,{required_lanes:['evaluation','review','security-review','verifier']},laneManifest),/required post-diff lane security-review/,'closeout must reject a high-risk candidate when the security review lane is absent');
  laneManifest.security_review = laneIdentity;
  fs.writeFileSync(path.join(laneEvidenceDir,`security-review.${laneIdentity.candidate_id}.json`),JSON.stringify(laneIdentity));
  assert.doesNotThrow(() => validateRequiredLaneEvidence({directory:laneEvidenceDir},laneIdentity.candidate_id,laneIdentity.task_id,laneIdentity.task_bundle_id,{required_lanes:['evaluation','review','security-review','verifier']},laneManifest),'all required independent lanes bind to the same frozen candidate');

  const originalAgents = fs.readFileSync(path.join(temp,'AGENTS.md'),'utf8');
  fs.writeFileSync(path.join(temp,'AGENTS.md'),originalAgents+'\nauthority change\n');
  const staleSnapshot = run(['scripts/control-plane/validate-closeout-cli.mjs','--phase','1'],temp);
  assert.notEqual(staleSnapshot.status,0,'authority-source changes must invalidate the execution snapshot');
  assert.match(staleSnapshot.stderr,/SNAPSHOT_STALE/);
  fs.writeFileSync(path.join(temp,'AGENTS.md'),originalAgents);

  fs.writeFileSync(path.join(temp,'verification/phase-reports/phase-01.closeout.json'),JSON.stringify(manifest,null,2));
  const validCloseout = run(['scripts/control-plane/validate-closeout-cli.mjs','--phase','1'],temp);
  assert.equal(validCloseout.status,0,validCloseout.stderr);
  const oneAdvance = run(['scripts/control-plane/advance-phase.mjs','--phase','1'],temp);
  assert.equal(oneAdvance.status,0,oneAdvance.stderr);
  const advancedState = JSON.parse(fs.readFileSync(path.join(temp,'docs/control-plane/phase-state.json'),'utf8'));
  assert.equal(advancedState.active_phase,2);
  const doubleAdvance = run(['scripts/control-plane/advance-phase.mjs','--phase','1'],temp);
  assert.notEqual(doubleAdvance.status,0,'a completed phase cannot advance twice');

  // A safeguard deletion is detected from the actual name-status and removed lines.
  const guardPath = path.join(temp,'tests/safety.guard.test.mjs');
  fs.mkdirSync(path.dirname(guardPath),{recursive:true});
  fs.writeFileSync(guardPath,'assertPaperOnly();\nassert.equal(orderMode, "paper");\n');
  spawnSync('git',['add','tests/safety.guard.test.mjs'],{cwd:temp,encoding:'utf8'});
  const guardCommit = spawnSync('git',['commit','-m','add safeguard fixture'],{cwd:temp,encoding:'utf8'});
  assert.equal(guardCommit.status,0,guardCommit.stderr);
  const deletionSnapshot = run(['scripts/control-plane/snapshot-control-plane.mjs'],temp);
  assert.equal(deletionSnapshot.status,0,deletionSnapshot.stderr || deletionSnapshot.stdout);
  const deletionSnapshotRecord = JSON.parse(deletionSnapshot.stdout);
  const deletionSnapshotRel = `verification/control-plane/snapshots/${deletionSnapshotRecord.snapshot_id}.json`;
  fs.rmSync(guardPath);
  const deletionTaskId = 'deleted-safeguard-fixture';
  const deletionBundle = ensureTaskBundle(temp,deletionTaskId,{id:deletionTaskId,task_kind:'feature',uncertainty:'low',files:['tests/safety.guard.test.mjs'],architectural_file_count:0,expected_code_lines:1,blast_radius:[],verification_difficulty:'deterministic',implementation_required:true,research_required:false});
  fs.writeFileSync(path.join(deletionBundle.directory,'route.json'),JSON.stringify({schema_version:1,task_id:deletionTaskId,bundle_id:deletionBundle.bundle_id,route:'single-builder',roles:['implementer'],acceptance_contract_required:false,signals:{high_radius:false,high_complexity:false},evidence_bundle:deletionBundle.relative}));
  const deletionFreeze = run(['scripts/control-plane/candidate-id.mjs','--snapshot',deletionSnapshotRel,'--task-id',deletionTaskId],temp);
  assert.equal(deletionFreeze.status,0,deletionFreeze.stderr || deletionFreeze.stdout);
  const deletionRisk = JSON.parse(deletionFreeze.stdout).reconciled_post_diff_risk;
  assert.equal(deletionRisk.level,'critical');
  assert.ok(deletionRisk.categories.includes('safeguard-deletion'));
  assert.deepEqual(deletionRisk.removed_safeguards,['tests/safety.guard.test.mjs']);

  // CRLF Skill frontmatter remains valid under the source linker.
  const skill = path.join(temp,'.agents/skills/schema-migration/SKILL.md');
  fs.writeFileSync(skill, fs.readFileSync(skill,'utf8').replace(/\n/g,'\r\n'));
  const crlf = run(['scripts/control-plane/validate.mjs'],temp);
  assert.equal(crlf.status,0,crlf.stderr);
} finally {
  fs.rmSync(sibling,{recursive:true,force:true});
  fs.rmSync(temp,{recursive:true,force:true});
}
console.log('PASS: control-plane regression suite');
