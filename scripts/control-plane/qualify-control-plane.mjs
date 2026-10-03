import fs from 'node:fs';
import path from 'node:path';
import { canonicalFileDigest, currentHead, findRepoRoot, loadJson, objectDigest, parseArg, platformKind, run, statusEntries, writeJsonAtomic } from './lib.mjs';

function normalizedVersion(output) {
  return String(output || '').trim().replace(/\s+/g, ' ');
}

try {
  const args = process.argv.slice(2);
  const root = findRepoRoot(parseArg(args, '--repo-root') ?? process.cwd());
  const observationPath = parseArg(args, '--runtime-observation') ?? path.join(root, 'verification/control-plane/runtime/current.json');
  const outPath = parseArg(args, '--out') ?? path.join(root, 'verification/control-plane/qualification.json');
  const issues = [];

  const staticCheck = run(process.execPath, [path.join(root, 'scripts/control-plane/validate.mjs')], { cwd: root });
  if (staticCheck.status !== 0) issues.push(`static validation failed: ${(staticCheck.stderr || staticCheck.stdout).trim()}`);

  const codex = run('codex', ['--version'], { cwd: root });
  const codexVersion = codex.status === 0 ? normalizedVersion(codex.stdout) : null;
  if (!codexVersion) issues.push('Codex executable/version is unavailable in this runtime');

  const runtimeChecks = { strict_config: null, permission_profile: null, rules: null };
  if (codexVersion) {
    const strict = run('codex', ['--strict-config', 'features', 'list'], { cwd: root });
    runtimeChecks.strict_config = { ok: strict.status === 0, output_sha256: strict.status === 0 ? objectDigest({ output: normalizedVersion(strict.stdout) }) : null };
    if (strict.status !== 0) issues.push(`Codex strict-config check failed: ${(strict.stderr || strict.stdout).trim()}`);

    const platform = platformKind();
    const sandboxTarget = platform === 'native-windows' ? 'windows' : platform === 'darwin' ? 'macos' : (platform === 'linux' || platform === 'wsl') ? 'linux' : null;
    if (!sandboxTarget) {
      issues.push(`no Codex sandbox qualification probe is defined for platform ${platform}`);
    } else {
      const probe = run('codex', ['sandbox', sandboxTarget, '--permission-profile', 'project-implement', '--cd', root, '--', process.execPath, '-e', "process.stdout.write('PROFILE_OK')"], { cwd: root });
      runtimeChecks.permission_profile = { ok: probe.status === 0 && probe.stdout.includes('PROFILE_OK'), platform: sandboxTarget };
      if (!runtimeChecks.permission_profile.ok) issues.push(`project-implement permission profile could not be resolved by Codex sandbox: ${(probe.stderr || probe.stdout).trim()}`);
    }

    const rules = run('codex', ['execpolicy', 'check', '--rules', path.join(root, '.codex/rules/default.rules'), '--', 'git', 'reset', '--hard', 'HEAD'], { cwd: root });
    runtimeChecks.rules = { ok: rules.status === 0, output_sha256: rules.status === 0 ? objectDigest({ output: normalizedVersion(rules.stdout) }) : null };
    if (rules.status !== 0) issues.push(`Codex execpolicy validation failed: ${(rules.stderr || rules.stdout).trim()}`);
  }

  let observation = null;
  if (!fs.existsSync(observationPath)) {
    issues.push(`runtime observation missing: ${path.relative(root, observationPath)}`);
  } else {
    try { observation = loadJson(observationPath); } catch (error) { issues.push(`runtime observation invalid: ${error.message}`); }
  }

  const configDigest = canonicalFileDigest(path.join(root, '.codex/config.toml'));
  const hookDigest = canonicalFileDigest(path.join(root, '.codex/hooks.json'));
  const rulesDigest = canonicalFileDigest(path.join(root, '.codex/rules/default.rules'));
  const components = loadJson(path.join(root, 'docs/control-plane/components.json'));
  const requiredAgents = components.agent_roles.map(role => role.id);
  const requiredSkills = loadJson(path.join(root, 'docs/control-plane/components.json')).skills;
  const capability = loadJson(path.join(root, 'docs/control-plane/capabilities.json'));
  const componentsDigest = canonicalFileDigest(path.join(root, 'docs/control-plane/components.json'));

  if (observation) {
    if (observation.schema_version !== 1 || observation.source !== 'codex-session-start-hook') issues.push('runtime observation has unsupported schema/source');
    if (observation.project_layer_loaded !== true) issues.push('runtime observation does not prove the trusted project layer loaded');
    if (observation.hook_digest !== hookDigest) issues.push('runtime observation is stale for current hook configuration');
    if (observation.config_digest !== configDigest) issues.push('runtime observation is stale for current project config');
    if (observation.rules_digest !== rulesDigest) issues.push('runtime observation is stale for current rules');
    if (observation.components_digest !== componentsDigest) issues.push('runtime observation is stale for current component registry');
    const knownPermissionModes = new Set(['default','acceptEdits','plan','dontAsk','bypassPermissions']);
    if (!knownPermissionModes.has(observation.permission_mode)) issues.push('runtime observation is missing a recognized permission_mode');
    else if (observation.permission_mode !== 'default') issues.push(`runtime permission mode is ${observation.permission_mode}; governed implementation requires default project approval posture`);
  }

  const requiredMcp = capability.mcp_servers.filter(s => s.required === true);
  let mcpList = null;
  if (requiredMcp.length && codexVersion) {
    const listed = run('codex', ['mcp', 'list'], { cwd: root });
    if (listed.status !== 0) issues.push(`required MCP configuration could not be inspected: ${(listed.stderr || listed.stdout).trim()}`);
    else {
      mcpList = normalizedVersion(listed.stdout);
      for (const server of requiredMcp) if (!new RegExp(`(^|\\s)${server.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`, 'i').test(listed.stdout)) issues.push(`required MCP server is not present in codex mcp list: ${server.id}`);
    }
  }

  const dirty = statusEntries(root);
  if (dirty.length) issues.push('working tree has non-evidence changes; qualification must bind a clean engineering baseline');

  const record = {
    schema_version: 1,
    status: issues.length ? 'UNVERIFIED' : 'QUALIFIED',
    captured_at: new Date().toISOString(),
    platform: platformKind(),
    codex_version: codexVersion,
    git_head: (() => { try { return currentHead(root); } catch { return null; } })(),
    project_runtime: observation ? {
      project_layer_loaded: observation.project_layer_loaded,
      permission_mode: observation.permission_mode ?? null,
      model: observation.model ?? null,
      observation_digest: objectDigest(observation)
    } : null,
    source_digests: { config: configDigest, hooks: hookDigest, rules: rulesDigest, components: componentsDigest },
    runtime_checks: runtimeChecks,
    required_agents: requiredAgents,
    required_skills: requiredSkills,
    capability_contract_digest: objectDigest(capability),
    mcp_required: requiredMcp.map(s => s.id),
    mcp_list_observation_sha256: mcpList ? objectDigest({ output: mcpList }) : null,
    issues
  };
  record.qualification_id = objectDigest(record);
  writeJsonAtomic(outPath, record);
  console.log(JSON.stringify(record, null, 2));
  process.exit(record.status === 'QUALIFIED' ? 0 : 2);
} catch (error) {
  console.error(`qualification failed: ${error.message}`);
  process.exit(2);
}
