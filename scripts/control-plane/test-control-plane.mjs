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
for (const role of ['phase_mapper','provider_researcher','implementer','reviewer','verifier','evaluator']) assert.match(rootConfig, new RegExp(`\\[agents\\.${role}\\]`));

const hookAllow = run(['.codex/hooks/pre-tool-use.mjs'], repo, JSON.stringify({hook_event_name:'PreToolUse',tool_name:'Bash',tool_input:{command:'git status'}}));
assert.equal(hookAllow.status, 0);
assert.equal(hookAllow.stdout, '');
const hookDeny = run(['.codex/hooks/pre-tool-use.mjs'], repo, JSON.stringify({hook_event_name:'PreToolUse',tool_name:'Bash',tool_input:{command:'git reset --hard HEAD'}}));
assert.equal(hookDeny.status, 0);
assert.equal(JSON.parse(hookDeny.stdout).hookSpecificOutput.permissionDecision, 'deny');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'alpaca-cp-'));
const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), 'alpaca-codex-bin-'));
const sibling = `${temp}-worktree`;
try {
  fs.cpSync(repo, temp, { recursive:true, filter: src => !src.includes(`${path.sep}.git${path.sep}`) });
  spawnSync('git',['init'],{cwd:temp,encoding:'utf8'});
  spawnSync('git',['config','user.email','control-plane@example.invalid'],{cwd:temp});
  spawnSync('git',['config','user.name','Control Plane Test'],{cwd:temp});
  spawnSync('git',['add','.'],{cwd:temp});
  spawnSync('git',['commit','-m','baseline'],{cwd:temp,encoding:'utf8'});

  const preflight = run(['scripts/control-plane/preflight.mjs'], temp);
  assert.equal(preflight.status,0,preflight.stderr || preflight.stdout);
  assert.equal(JSON.parse(preflight.stdout).status,'READY');

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

  // Live qualification is separate from static validation and fails closed without Codex/runtime evidence.
  const unqualified = run(['scripts/control-plane/qualify-control-plane.mjs'], temp);
  assert.notEqual(unqualified.status, 0, 'qualification must not pass without live Codex/runtime evidence');
  const unqualifiedRecord = JSON.parse(unqualified.stdout);
  assert.equal(unqualifiedRecord.status, 'UNVERIFIED');
  fs.writeFileSync(path.join(temp, phase.report_file), 'Phase status: COMPLETE\n');
  let advanced = run(['scripts/control-plane/advance-phase.mjs','--phase','1'], temp);
  assert.notEqual(advanced.status, 0, 'prose-only COMPLETE must not advance');
  assert.match(advanced.stderr, /missing machine closeout manifest/);

  // A trusted SessionStart observation plus current Codex runtime probes can produce QUALIFIED.
  const fakeCodex = path.join(fakeBin, 'fake-codex.mjs');
  fs.writeFileSync(fakeCodex, `#!/usr/bin/env node\nconst a=process.argv.slice(2);\nif(a[0]==='--version'){console.log('codex-cli 0.test');process.exit(0)}\nif(a[0]==='--strict-config'&&a[1]==='features'&&a[2]==='list'){console.log('features-ok');process.exit(0)}\nif(a[0]==='sandbox'){console.log('PROFILE_OK');process.exit(0)}\nif(a[0]==='execpolicy'){console.log(JSON.stringify({decision:'forbidden'}));process.exit(0)}\nif(a[0]==='mcp'&&a[1]==='list'){console.log('[]');process.exit(0)}\nconsole.error('unsupported fake codex args',a);process.exit(2)\n`);
  fs.chmodSync(fakeCodex,0o755);
  fs.writeFileSync(path.join(fakeBin,'codex'), `#!/bin/sh\nexec "${process.execPath}" "${fakeCodex}" "$@"\n`);
  fs.chmodSync(path.join(fakeBin,'codex'),0o755);
  fs.writeFileSync(path.join(fakeBin,'codex.cmd'), `@"${process.execPath}" "${fakeCodex}" %*\r\n`);
  const qualifiedEnv = {...process.env, PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ''}`};
  const sessionStart = run(['.codex/hooks/session-start.mjs'], temp, JSON.stringify({hook_event_name:'SessionStart',source:'startup',cwd:temp,session_id:'test-session',model:'test-model',permission_mode:'default'}), qualifiedEnv);
  assert.equal(sessionStart.status,0,sessionStart.stderr);
  const qualifiedRun = run(['scripts/control-plane/qualify-control-plane.mjs'], temp, undefined, qualifiedEnv);
  assert.equal(qualifiedRun.status,0,qualifiedRun.stderr || qualifiedRun.stdout);
  const qualification = JSON.parse(qualifiedRun.stdout);
  assert.equal(qualification.status,'QUALIFIED');
  assert.equal(qualification.runtime_checks.strict_config.ok,true);
  assert.equal(qualification.runtime_checks.permission_profile.ok,true);
  assert.equal(qualification.runtime_checks.rules.ok,true);

  // Candidate identity changes for engineering files but ignores control-plane evidence files.
  const snapshotRun = run(['scripts/control-plane/snapshot-control-plane.mjs','--qualification','verification/control-plane/qualification.json'], temp);
  assert.equal(snapshotRun.status,0,snapshotRun.stderr);
  const snapshot = JSON.parse(snapshotRun.stdout);
  const snapshotRel = `verification/control-plane/snapshots/${snapshot.snapshot_id}.json`;
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
    schema_version:2, phase:1, charter_digest:charterDigest, goal_digest:goalDigest,
    qualification_id:qualification.qualification_id, qualification_artifact:'verification/control-plane/qualification.json',
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
  fs.rmSync(fakeBin,{recursive:true,force:true});
  fs.rmSync(temp,{recursive:true,force:true});
}
console.log('PASS: control-plane regression suite');
