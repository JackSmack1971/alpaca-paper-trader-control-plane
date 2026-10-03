# Codex compatibility baseline

Checked against current OpenAI documentation on **2026-10-03**.

This package intentionally uses current documented surfaces rather than older aliases where possible:

- Project instructions: `AGENTS.md` / `AGENTS.override.md`; project chain root -> cwd; 32 KiB default combined budget.
- Repository Skills: `.agents/skills/<skill>/SKILL.md`; progressive disclosure; optional `agents/openai.yaml`.
- Project custom agents: `[agents.<role>]` declarations in `.codex/config.toml` with `config_file` pointing to role-specific config layers; role descriptions live on the declaration, while role files carry config such as `developer_instructions` and `default_permissions`.
- Subagent concurrency: `agents.max_concurrent_threads_per_session`; `agents.max_threads` is a legacy alias.
- Multi-agent enablement: `agents.enabled` / stable multi-agent feature.
- Approval policy: `on-request`, `never`, or granular table. Explicit `approval_policy = "untrusted"` is no longer supported; `on-failure` is deprecated.
- Permission profiles: `default_permissions` + `[permissions]` are separate from legacy `sandbox_mode`; do not mix them in the same effective config.
- Web search: top-level `web_search = "live"` for fresh provider documentation.
- Hooks: project `.codex/hooks.json`, with trust review required for non-managed hooks.
- Rules: project `.codex/rules/*.rules`; rules affect commands requesting outside-sandbox execution and do not themselves grant filesystem/network authority.
- Goal mode: `/goal` is a persistent objective. Keep the goal concise and point to repository files for durable detail.

Primary references:
- https://learn.chatgpt.com/docs/agent-configuration/agents-md
- https://learn.chatgpt.com/docs/build-skills
- https://learn.chatgpt.com/docs/agent-configuration/subagents
- https://learn.chatgpt.com/docs/permissions
- https://learn.chatgpt.com/docs/agent-configuration/rules
- https://learn.chatgpt.com/docs/hooks
- https://learn.chatgpt.com/docs/config-file/config-reference
- https://learn.chatgpt.com/docs/reference/slash-commands

Re-check these surfaces before changing the control plane because Codex evolves quickly.

## Control-plane v1.1 runtime notes

- Permission profiles use `default_permissions` and named `[permissions.*]` profiles; legacy `sandbox_mode` is rejected by validation.
- Project-local config/hooks/rules load only for trusted repositories. SessionStart hook execution is therefore used as one runtime observation, not as an immutable authorization boundary. Qualification additionally uses current documented CLI probes (`--strict-config`, `codex sandbox --permission-profile`, and `codex execpolicy check`) and fails closed if they cannot be executed successfully.
- PreToolUse uses the current supported `hookSpecificOutput.permissionDecision = "deny"` shape for Bash guardrails. Hook errors are not treated as a security boundary.
- Native Windows should use Codex's strongest available Windows sandbox configuration at the user/managed layer; this repository does not try to rewrite machine-level settings.
