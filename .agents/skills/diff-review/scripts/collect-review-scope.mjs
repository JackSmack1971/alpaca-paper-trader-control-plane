#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import process from "node:process";

function fail(message, code = 2) {
  console.error(`[diff-review] ${message}`);
  process.exit(code);
}

function runGit(args, { nul = false } = {}) {
  const result = spawnSync("git", args, {
    encoding: nul ? null : "utf8",
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) fail(`git ${args.join(" ")} failed: ${result.error.message}`);
  if (result.status !== 0) {
    const stderr = Buffer.isBuffer(result.stderr)
      ? result.stderr.toString("utf8")
      : result.stderr ?? "";
    fail(`git ${args.join(" ")} failed${stderr.trim() ? `: ${stderr.trim()}` : ""}`);
  }
  return nul ? result.stdout : result.stdout.trimEnd();
}

function parseArgs(argv) {
  const opts = { base: null, head: "HEAD", worktree: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--worktree") {
      opts.worktree = true;
    } else if (arg === "--base") {
      if (!argv[i + 1]) fail("--base requires a ref");
      opts.base = argv[++i];
    } else if (arg === "--head") {
      if (!argv[i + 1]) fail("--head requires a ref");
      opts.head = argv[++i];
    } else if (arg === "--help" || arg === "-h") {
      console.log(`Usage:\n  collect-review-scope.mjs --worktree\n  collect-review-scope.mjs --base <ref> [--head <ref>]\n  collect-review-scope.mjs --base <ref> --worktree\n\nThe script is read-only and prints JSON.`);
      process.exit(0);
    } else {
      fail(`unknown argument: ${arg}`);
    }
  }
  if (!opts.worktree && !opts.base) {
    fail("choose --worktree or provide --base <ref>");
  }
  if (opts.worktree && opts.head !== "HEAD") {
    fail("--head is only valid for committed-diff mode (without --worktree)");
  }
  return opts;
}

function resolveCommit(ref) {
  return runGit(["rev-parse", "--verify", `${ref}^{commit}`]);
}

function splitNul(buffer) {
  return buffer
    .toString("utf8")
    .split("\0")
    .filter((part) => part.length > 0);
}

function parseNameStatus(buffer) {
  const fields = splitNul(buffer);
  const entries = [];
  for (let i = 0; i < fields.length; ) {
    const status = fields[i++];
    const kind = status[0];
    if (kind === "R" || kind === "C") {
      const from = fields[i++];
      const to = fields[i++];
      if (from === undefined || to === undefined) fail("unexpected rename/copy diff encoding");
      entries.push({ status, from, path: to });
    } else {
      const path = fields[i++];
      if (path === undefined) fail("unexpected diff encoding");
      entries.push({ status, path });
    }
  }
  return entries;
}

const opts = parseArgs(process.argv.slice(2));
const repoRoot = runGit(["rev-parse", "--show-toplevel"]);
const headSha = resolveCommit(opts.head);
const baseRef = opts.base ?? "HEAD";
const baseSha = resolveCommit(baseRef);

let diffArgs;
let mode;
if (opts.worktree) {
  mode = opts.base ? "base-to-worktree" : "head-to-worktree";
  diffArgs = ["diff", "--name-status", "-z", baseRef, "--"];
} else {
  mode = "commit-range";
  diffArgs = ["diff", "--name-status", "-z", baseRef, opts.head, "--"];
}

const diffEntries = parseNameStatus(runGit(diffArgs, { nul: true }));
const statusShort = runGit(["status", "--short", "--untracked-files=all"]);
const untracked = opts.worktree
  ? splitNul(runGit(["ls-files", "--others", "--exclude-standard", "-z"], { nul: true }))
  : [];

const output = {
  repoRoot,
  mode,
  base: { ref: baseRef, sha: baseSha },
  head: { ref: opts.head, sha: headSha },
  diffEntries,
  untracked,
  workingTreeStatus: statusShort ? statusShort.split(/\r?\n/) : [],
};

process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
