# Causal debugging workflow

Use this workflow when a task is explicitly debugging a reported failure. Normal feature work does not require task registration.

1. Record a concise hypothesis, the exact error signature, and the smallest source scope that could contain the cause. Create `verification/reproductions/<slug>.mjs` first as the minimal reproduction. The case should call the relevant project code with the failing input; it must not manufacture the expected error string. Keep secrets out of case inputs and output.
2. Register the prepared case and source scope before changing source:

   ```text
   node scripts/control-plane/causal-debug.mjs register --id <slug> --case verification/reproductions/<slug>.mjs --scope <repo-relative-source-path> --signature <exact-error-signature>
   ```

   Registration stores only a SHA-256 digest of the signature, case digest, and allowed paths. Scopes must be real paths with no symbolic links. The case is frozen by its digest once registered.
3. Run the registered case:

   ```text
   node scripts/control-plane/causal-debug.mjs reproduce --id <slug> --case verification/reproductions/<slug>.mjs --signature <exact-error-signature>
   ```

   The runner invokes the case with Node; callers cannot substitute an executable or arguments. It must complete with a nonzero exit and emit the exact signature in stdout or stderr. A temporary Node monitor records uncaught error metadata outside the repository, and V8 coverage must show code executed inside the registered scope. The uncaught error message and stack must contain the exact signature and a scoped frame. The runner also hashes source, registered scope, and the case before and after execution; persistent changes prevent unlocking edits. Only exit status, match and integrity booleans, digests, and timestamps are retained; raw output is not written. A different error or successful exit does not unlock edits.
4. Confirm the failure against the baseline. Change one causal factor in the registered scope, then rerun the same case and focused regression checks before another source mutation. Each accepted source-changing tool call consumes the reproduction evidence; reproduce again before the next edit.
5. When the fix appears complete, run the same case through `verify-fixed`. It must exit zero and omit the reported signature. Then run `node scripts/control-plane/causal-debug.mjs complete --id <slug>` to close the registration. If the error still reproduces, the task stays open and a fresh reproduction is required before another edit.

## Hook enforcement boundary

The PreToolUse hook uses a generic tool-name matcher and inspects the JSON payload Codex supplies. It denies path-addressed edits until a matching reproduction exists, rejects edits outside the registered scope, consumes evidence for one accepted edit call, and fails closed when a write payload has no usable target path. While a debug task is active, shell commands are denied unless they invoke that task's `reproduce`, `verify-fixed`, or `complete` lifecycle command without shell chaining or redirection. Use path-addressed editing tools for the single scoped causal change.

This is a guard over observed Codex calls, not an operating-system write sandbox. Codex does not guarantee that every native editor integration or opaque tool exposes its target path or intent in the hook payload. Registered scope paths containing symbolic links are rejected. Direct filesystem writes outside Codex, ignored files, transient source changes that are reverted before the runner exits, writes outside the repository, and sessions where project hooks are disabled cannot be proven safe from this payload. The runner does not sandbox the case process; it only detects persistent in-repository source changes. Keep runtime filesystem permissions enabled and review hook configuration before trusting it.

## Native Windows hooks

Every command hook declares `commandWindows` using a `powershell -NoProfile -Command` wrapper. This is the supported project-level Windows command path. Do not add `defaultShell` to Codex TOML or invent a `settings.json` key; the current official project configuration contract uses `.codex/config.toml`, and the hook schema's `commandWindows` supplies the Windows-specific command. User-level shell preferences remain outside this repository's authority.
