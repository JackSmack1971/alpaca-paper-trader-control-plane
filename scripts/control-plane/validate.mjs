import fs from 'node:fs';
import path from 'node:path';
import { canonicalFileDigest, canonicalText, loadJson } from './lib.mjs';

const root = process.cwd();
const failures = [];
const warnings = [];
const exists = rel => fs.existsSync(path.join(root, rel));
const componentsPath = 'docs/control-plane/components.json';
const must = ['AGENTS.md','.codex/config.toml','.codex/hooks.json','.codex/rules/default.rules','docs/PROJECT_CHARTER.md','docs/control-plane/phase-state.json',componentsPath,'docs/control-plane/phase-contracts.json','docs/control-plane/capabilities.json','docs/control-plane/policy.json','.github/workflows/control-plane.yml'];
for (const rel of must) if (!exists(rel)) failures.push(`missing ${rel}`);
if (failures.length === 0) {
  const components = loadJson(componentsPath);
  const policy = loadJson('docs/control-plane/policy.json');
  const ciWorkflow = canonicalText(fs.readFileSync('.github/workflows/control-plane.yml'));
  for (const check of [
    'ubuntu-latest',
    'windows-latest',
    'node-version: 22',
    'node scripts/control-plane/validate.mjs',
    'node scripts/control-plane/test-control-plane.mjs',
    'node scripts/control-plane/test-runtime-observation.mjs',
    'node scripts/control-plane/test-hooks-windows.mjs',
    'git diff --check'
  ]) if (!ciWorkflow.includes(check)) failures.push(`CI workflow missing required trust check: ${check}`);
  if (!/if:\s*runner\.os\s*==\s*'Windows'/.test(ciWorkflow)) failures.push('CI workflow must run Windows PowerShell hook integration only on Windows');
  if (components.schema_version !== policy.evidence_schema_versions.components) failures.push('components.json schema_version differs from canonical policy');
  if (components.policy_file !== 'docs/control-plane/policy.json') failures.push('components.json must link the canonical policy file');
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  if (nodeMajor !== components.runtime.node_major) failures.push(`Node ${components.runtime.node_major} required; found ${process.versions.node}`);
  for (const name of components.agents) if (!exists(`.codex/agents/${name}.toml`)) failures.push(`missing agent ${name}`);
  for (const name of components.skills) if (!exists(`.agents/skills/${name}/SKILL.md`)) failures.push(`missing skill ${name}`);
  for (const rel of [...components.hook_scripts,...components.rule_files,...components.lifecycle_scripts]) if (!exists(rel)) failures.push(`missing linked component ${rel}`);

  const config = canonicalText(fs.readFileSync('.codex/config.toml'));
  if (/\bsandbox_mode\s*=/.test(config)) failures.push('legacy sandbox_mode is forbidden when permission profiles are used');
  if (!/default_permissions\s*=\s*"project-implement"/.test(config)) failures.push('root default_permissions must be project-implement');
  for (const profile of ['project-implement','project-verify']) if (!new RegExp(`\\[permissions\\.${profile.replace('-','\\-')}\\]`).test(config)) failures.push(`missing permission profile ${profile}`);
  if (!Array.isArray(components.agent_roles) || components.agent_roles.length !== policy.routing.roles.length || components.agent_roles.length !== components.agents.length) failures.push('components.json agent_roles must map every canonical agent role');
  for (const role of policy.routing.roles) {
    const componentRole = components.agent_roles?.find(item => item.id === role.id);
    if (!componentRole || componentRole.file !== role.file || componentRole.config_file !== role.config_file || componentRole.default_permissions !== role.default_permissions) failures.push(`agent role ${role.id} differs from canonical policy`);
    if (!components.agents.includes(path.basename(role.file, '.toml').replaceAll('_','-'))) failures.push(`agent role ${role.id} file is absent from components registry`);
  }
  for (const role of components.agent_roles ?? []) {
    if (!role?.id || !role?.file || !role?.config_file || !role?.default_permissions) { failures.push('malformed agent role identity'); continue; }
    if (!exists(role.file)) { failures.push(`missing agent role file ${role.file}`); continue; }
    const table = `[agents.${role.id}]`;
    if (!config.includes(table)) failures.push(`root config does not declare role ${role.id}`);
    const escaped = role.config_file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const roleBlock = config.split(table)[1]?.split(/\n\[/,1)[0] ?? '';
    if (!new RegExp(`config_file\\s*=\\s*\"${escaped}\"`).test(roleBlock)) failures.push(`role ${role.id} does not link config_file ${role.config_file}`);
    const text = canonicalText(fs.readFileSync(role.file));
    if (/\bsandbox_mode\s*=/.test(text)) failures.push(`${role.file} uses legacy sandbox_mode`);
    if (/^\s*(?:name|description)\s*=/m.test(text)) failures.push(`${role.file} contains role metadata that belongs in [agents.${role.id}]`);
    const permission = text.match(/^default_permissions\s*=\s*"([^"]+)"/m)?.[1];
    if (permission !== role.default_permissions) failures.push(`${role.file} default_permissions must be ${role.default_permissions}`);
  }

  for (const name of components.skills) {
    const text = canonicalText(fs.readFileSync(`.agents/skills/${name}/SKILL.md`));
    if (!/^---\n[\s\S]*?\n---(?:\n|$)/.test(text)) failures.push(`skill ${name} missing CRLF-safe YAML frontmatter`);
    const declared = text.match(/^name:\s*([^\n]+)$/m)?.[1]?.trim();
    if (declared !== name) failures.push(`skill directory/name mismatch: ${name} declares ${declared ?? 'nothing'}`);
    if (!/^description:/m.test(text)) failures.push(`skill ${name} missing description metadata`);
    for (const ref of text.matchAll(/\$([a-z0-9-]+)/g)) if (!components.skills.includes(ref[1])) failures.push(`skill ${name} references unknown skill $${ref[1]}`);
  }

  const state = loadJson('docs/control-plane/phase-state.json');
  if (state.control_plane_version !== policy.control_plane_version || components.control_plane_version !== policy.control_plane_version) failures.push('control-plane version differs from canonical policy');
  if (!Array.isArray(state.phases) || state.phases.length !== 10) failures.push('phase-state must contain 10 phases');
  const ids = state.phases?.map(p=>p.id) ?? [];
  if (JSON.stringify(ids) !== JSON.stringify([1,2,3,4,5,6,7,8,9,10])) failures.push('phase ids are not 1..10');
  const active = state.phases?.filter(p=>p.status==='active') ?? [];
  if (state.active_phase === null ? active.length !== 0 : active.length !== 1 || active[0]?.id !== state.active_phase) failures.push('active phase/status mismatch');
  const charter = canonicalFileDigest('docs/PROJECT_CHARTER.md');
  if (charter !== state.charter_sha256) failures.push('charter SHA-256 does not match phase-state provenance');
  for (const phase of state.phases ?? []) {
    if (!exists(phase.goal_file)) failures.push(`missing goal ${phase.goal_file}`);
    if (!phase.report_file?.startsWith('verification/phase-reports/')) failures.push(`invalid report path for phase ${phase.id}`);
  }

  const contracts = loadJson('docs/control-plane/phase-contracts.json');
  if (contracts.schema_version !== policy.evidence_schema_versions.phase_contracts || contracts.phases?.length !== 10) failures.push('phase-contracts schema/phase count differs from canonical policy');
  if (state.schema_version !== policy.evidence_schema_versions.phase_state) failures.push('phase-state schema_version differs from canonical policy');
  for (const phase of state.phases ?? []) {
    const contract = contracts.phases?.find(x => x.phase === phase.id);
    if (!contract) { failures.push(`missing phase contract ${phase.id}`); continue; }
    if (contract.goal_file !== phase.goal_file) failures.push(`phase contract ${phase.id} goal_file mismatch`);
    if (exists(phase.goal_file) && contract.goal_digest !== canonicalFileDigest(phase.goal_file)) failures.push(`phase contract ${phase.id} goal_digest is stale`);
    const criteria = contract.criteria ?? [];
    if (!criteria.length) failures.push(`phase contract ${phase.id} has no acceptance criteria`);
    const criterionIds = criteria.map(c => c.id);
    if (new Set(criterionIds).size !== criterionIds.length || criterionIds.some(id => !new RegExp(`^P${String(phase.id).padStart(2,'0')}-C\\d{2}$`).test(id))) failures.push(`phase contract ${phase.id} has invalid/duplicate criterion ids`);
  }

  const hooks = loadJson('.codex/hooks.json');
  if (!hooks.hooks?.SessionStart?.length) failures.push('SessionStart hook missing');
  if (!hooks.hooks?.PreToolUse?.length) failures.push('PreToolUse hook missing');
  if (!hooks.hooks?.PostToolUse?.length) failures.push('PostToolUse hook missing');
  for (const event of ['SessionStart','PreToolUse','PostToolUse']) for (const group of hooks.hooks?.[event] ?? []) for (const handler of group.hooks ?? []) {
    if (handler.type === 'command' && (!handler.command || !handler.commandWindows)) failures.push(`${event} command hook must define command and commandWindows`);
    if (handler.type === 'command' && handler.commandWindows && !/^cmd\.exe \/d \/c \.codex\\hooks\\run-hook\.cmd (?:session-start|pre-tool-use|post-tool-use)$/i.test(handler.commandWindows)) failures.push(`${event} Windows command hook must use the registered cmd.exe hook launcher`);
  }
  if (/\bdefaultShell\s*=/.test(config)) failures.push('unsupported defaultShell key must not be added to Codex config.toml');
  if (!(hooks.hooks?.PreToolUse ?? []).some(group => group.matcher === '.*')) failures.push('generic PreToolUse matcher required for mutation-gate tool-name coverage');
  if (!exists('scripts/control-plane/causal-debug.mjs')) failures.push('causal-debug lifecycle command missing');
  if (!exists('docs/control-plane/causal-debugging.md')) failures.push('causal debugging workflow documentation missing');
  if (!(hooks.hooks?.PostToolUse ?? []).some(group => /^\^mcp__/.test(group.matcher ?? ''))) failures.push('MCP PostToolUse size-limit hook missing');
  if (!(hooks.hooks?.PostToolUse ?? []).some(group => /^\^Bash\$/.test(group.matcher ?? ''))) failures.push('Bash PostToolUse exit-status hook missing');
  const capability = loadJson('docs/control-plane/capabilities.json');
  if (capability.schema_version !== policy.evidence_schema_versions.capabilities || !Array.isArray(capability.mcp_servers)) failures.push('capability registry is malformed or has a schema version that differs from canonical policy');
  if (capability.mcp_policy?.collection_calls?.require_filter !== policy.mcp.require_filter || capability.mcp_policy?.collection_calls?.require_page_size !== policy.mcp.require_page_size || capability.mcp_policy?.collection_calls?.maximum_page_size !== policy.mcp.maximum_page_size || capability.mcp_policy?.response_budget?.maximum_utf8_bytes !== policy.mcp.maximum_result_utf8_bytes || capability.mcp_policy?.response_budget?.oversize_behavior !== policy.mcp.oversize_behavior || 'maximum_tokens' in (capability.mcp_policy?.response_budget ?? {})) failures.push('MCP policy in capabilities.json differs from canonical policy');
  const workflow = canonicalText(fs.readFileSync('docs/control-plane/WORKFLOW.md'));
  const traceability = canonicalText(fs.readFileSync('docs/control-plane/TRACEABILITY.md'));
  const mcpSkill = canonicalText(fs.readFileSync('.agents/skills/mcp-bounds/SKILL.md'));
  const reportTemplate = canonicalText(fs.readFileSync('verification/phase-reports/TEMPLATE.md'));
  const projectReadme = canonicalText(fs.readFileSync('docs/control-plane/README.md'));
  const routingSkill = canonicalText(fs.readFileSync('.agents/skills/task-routing/SKILL.md'));
  const agentsGuide = canonicalText(fs.readFileSync('AGENTS.md'));
  const expectedBytes = policy.mcp.maximum_result_utf8_bytes.toLocaleString('en-US');
  for (const [name,text] of [['WORKFLOW.md',workflow],['TRACEABILITY.md',traceability],['mcp-bounds skill',mcpSkill]]) {
  if (!new RegExp(`(?<!\\d)${expectedBytes.replace(',', '[,_]?')}(?!\\d)[^\\n]*(?:UTF-8 )?bytes?`, 'i').test(text)) failures.push(`${name} must describe the canonical ${expectedBytes}-byte MCP result limit`);
    if (/25[,._]?000\s*(?:utf-8\s*)?bytes/i.test(text)) failures.push(`${name} contradicts the canonical MCP result limit`);
  }
  if (policy.routing.roles.length !== components.agents.length || policy.routing.roles.some(role => !components.agents.includes(path.basename(role.file, '.toml')))) failures.push('agent role inventory differs from canonical policy');
  if (!routingSkill.includes('docs/control-plane/policy.json') || /more than 50 lines|more than three architectural/i.test(routingSkill)) failures.push('task-routing skill must defer role/threshold policy to canonical policy');
  if (!projectReadme.includes('Version: defined by [`policy.json`](policy.json).')) failures.push('control-plane README must defer the version to canonical policy');
  if (!agentsGuide.includes(`${expectedBytes} UTF-8 bytes`) || !agentsGuide.includes('policy-defined `maximum_page_size`')) failures.push('AGENTS.md MCP bounds must match/reference canonical policy');
  if (!policy.verification_statuses?.check?.includes('PASS') || !policy.verification_statuses?.check?.includes('FAIL') || !policy.verification_statuses?.check?.includes('UNKNOWN')) failures.push('canonical verification status policy is incomplete');
  if (!new RegExp(`"schema_version":\\s*${policy.evidence_schema_versions.closeout_manifest}\\b`).test(reportTemplate)) failures.push('phase report template schema differs from canonical policy');
  if (!workflow.includes('machine manifest at the version in `policy.json`')) failures.push('WORKFLOW.md must defer manifest version to canonical policy');
  if (!traceability.includes('policy-versioned manifest')) failures.push('TRACEABILITY.md must defer manifest version to canonical policy');

  if (fs.statSync('AGENTS.md').size > 32768) failures.push('AGENTS.md exceeds project_doc_max_bytes');
  const nestedArchives = [];
  for (const entry of fs.readdirSync('.agents/skills', { withFileTypes:true })) if (entry.isFile() && /\.(zip|tar|tgz)$/i.test(entry.name)) nestedArchives.push(entry.name);
  if (nestedArchives.length) failures.push(`distribution archive(s) inside live Skill tree: ${nestedArchives.join(', ')}`);
}
for (const warning of warnings) console.warn(`WARN: ${warning}`);
if (failures.length) { for (const failure of failures) console.error(`FAIL: ${failure}`); process.exit(1); }
console.log('PASS: control-plane source validation/linking succeeded.');
