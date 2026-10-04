import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { canonicalText, classifyPlatform, objectDigest, sha256 } from './lib.mjs';

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
for (const groups of Object.values(hookConfig.hooks)) for (const group of groups) for (const hook of group.hooks) if (hook.type === 'command') assert.match(hook.commandWindows,/^powershell -NoProfile -Command /i);
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
  fs.writeFileSync(hookJsonPath,goodHooks.replace('powershell -NoProfile -Command','cmd /c'), 'utf8');
  const badWindowsHook = run(['scripts/control-plane/validate.mjs'],temp);
  assert.notEqual(badWindowsHook.status,0,'non-PowerShell Windows hook wrapper must fail validation');
  fs.writeFileSync(hookJsonPath,goodHooks,'utf8');

  // Concurrent writers are gated through Git's shared common directory, not per-worktree untracked files.
  const firstAssignment = run(['scripts/control-plane/worktree-assignment.mjs','--owner','writer-a','--unit','u1','--scope','src'],temp);
  assert.equal(firstAssignment.status,0,firstAssignment.stderr);
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
  let candidateA = run(['scripts/control-plane/candidate-id.mjs','--snapshot',snapshotRel],temp);
  assert.equal(candidateA.status,0,candidateA.stderr);
  const idA = JSON.parse(candidateA.stdout).candidate_id;
  fs.mkdirSync(path.join(temp,'verification/control-plane/runtime'),{recursive:true});
  fs.writeFileSync(path.join(temp,'verification/control-plane/runtime/noise.json'),'{}');
  fs.writeFileSync(path.join(temp,'verification/phase-reports/phase-01.closeout.json'),'{}');
  let candidateEvidence = run(['scripts/control-plane/candidate-id.mjs','--snapshot',snapshotRel],temp);
  assert.equal(JSON.parse(candidateEvidence.stdout).candidate_id,idA,'evidence artifacts must not recursively mutate candidate identity');
  const originalReadme = fs.readFileSync(path.join(temp,'README.md'),'utf8');
  fs.writeFileSync(path.join(temp,'README.md'),originalReadme+'\nengineering change\n');
  let candidateB = run(['scripts/control-plane/candidate-id.mjs','--snapshot',snapshotRel],temp);
  assert.notEqual(JSON.parse(candidateB.stdout).candidate_id,idA,'engineering change must mutate candidate identity');

  // Closeout with stale candidate must fail before advancement.
  const contracts = JSON.parse(fs.readFileSync(path.join(temp,'docs/control-plane/phase-contracts.json'),'utf8'));
  const goalDigest = contracts.phases[0].goal_digest;
  const charterDigest = JSON.parse(fs.readFileSync(path.join(temp,'docs/control-plane/phase-state.json'),'utf8')).charter_sha256;
  const manifest = {
    schema_version:3, phase:1, charter_digest:charterDigest, goal_digest:goalDigest,
    snapshot_id:snapshot.snapshot_id, snapshot_artifact:snapshotRel, candidate_id:idA,
    acceptance:contracts.phases[0].criteria.map(c=>({criterion_id:c.id,disposition:'PASS',evidence:'test'})),
    verification:[{command:'node test',exit_code:0,evidence:'pass'}],
    review:{verdict:'PASS',candidate_id:idA,evidence:'review'}, verifier:{verdict:'PASS',candidate_id:idA,evidence:'verify'}, evaluation:{verdict:'PASS',candidate_id:idA,evidence:'eval'},
    unresolved_blockers:[], phase_status:'COMPLETE'
  };
  fs.writeFileSync(path.join(temp,'verification/phase-reports/phase-01.closeout.json'),JSON.stringify(manifest,null,2));
  const stale = run(['scripts/control-plane/validate-closeout-cli.mjs','--phase','1'],temp);
  assert.notEqual(stale.status,0);
  assert.match(stale.stderr,/EVIDENCE_STALE/);

  // Restoring the engineering candidate makes the same evidence identity valid and permits exactly one transition.
  fs.writeFileSync(path.join(temp,'README.md'),originalReadme);
  const restored = run(['scripts/control-plane/candidate-id.mjs','--snapshot',snapshotRel],temp);
  assert.equal(JSON.parse(restored.stdout).candidate_id,idA);

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
