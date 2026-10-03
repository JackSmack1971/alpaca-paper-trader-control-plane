#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const REQUIRED_HEADINGS = [
  "## Sources",
  "## Findings",
  "### CURRENT",
  "### DERIVED",
  "### RECOMMENDED",
  "### SPECULATIVE",
  "## Conflicts / unknowns",
  "## Implementation consequences",
  "## Qualification procedure if needed",
];

const PLACEHOLDERS = [
  "<topic>",
  "YYYY-MM-DD",
  "<one precise question>",
  "<official URL>",
];

function fail(message) {
  console.error(`[FAIL] ${message}`);
  process.exitCode = 1;
}

function pass(message) {
  console.log(`[PASS] ${message}`);
}

function usage() {
  console.error("Usage: node validate-research-artifact.mjs <docs/research/phase-XX/topic.md>");
  process.exit(2);
}

const artifactArg = process.argv[2];
if (!artifactArg || process.argv.length !== 3) usage();

const artifactPath = path.resolve(artifactArg);
if (!fs.existsSync(artifactPath) || !fs.statSync(artifactPath).isFile()) {
  console.error(`[FAIL] artifact does not exist: ${artifactPath}`);
  process.exit(1);
}

const normalized = artifactPath.split(path.sep).join("/");
const pathMatch = normalized.match(/\/docs\/research\/phase-(\d{2})\/[^/]+\.md$/);
if (!pathMatch) {
  fail("artifact path must end with docs/research/phase-XX/<topic>.md");
} else {
  pass("artifact path matches phase research layout");
}

const text = fs.readFileSync(artifactPath, "utf8").replace(/\r\n/g, "\n");
const lines = text.split("\n");

if (/^# External contract research:\s*\S.+$/m.test(text)) {
  pass("research title is populated");
} else {
  fail("missing populated '# External contract research: ...' title");
}

const dateMatch = text.match(/^- Date retrieved:\s*(\d{4}-\d{2}-\d{2})\s*$/m);
if (!dateMatch || Number.isNaN(Date.parse(`${dateMatch?.[1] ?? ""}T00:00:00Z`))) {
  fail("Date retrieved must be a valid YYYY-MM-DD value");
} else {
  pass(`retrieval date is valid (${dateMatch[1]})`);
}

const phaseMatch = text.match(/^- Active phase:\s*(\d+)\s*$/m);
if (!phaseMatch) {
  fail("Active phase must be an integer");
} else {
  const expected = pathMatch ? Number(pathMatch[1]) : null;
  const actual = Number(phaseMatch[1]);
  if (expected !== null && actual !== expected) {
    fail(`Active phase ${actual} does not match path phase-${pathMatch[1]}`);
  } else {
    pass(`active phase is consistent (${actual})`);
  }
}

const questionMatch = text.match(/^- Contract question:\s*(.+)$/m);
if (!questionMatch || questionMatch[1].trim().length < 12) {
  fail("Contract question must be populated and precise enough to inspect");
} else {
  pass("contract question is populated");
}

for (const heading of REQUIRED_HEADINGS) {
  if (!lines.includes(heading)) fail(`missing required heading: ${heading}`);
}
if (REQUIRED_HEADINGS.every((heading) => lines.includes(heading))) {
  pass("all required sections are present");
}

const remainingPlaceholders = PLACEHOLDERS.filter((token) => text.includes(token));
if (remainingPlaceholders.length) {
  fail(`template placeholders remain: ${remainingPlaceholders.join(", ")}`);
} else {
  pass("no template placeholders remain");
}

function sectionBody(startHeading, nextHeadings) {
  const start = lines.indexOf(startHeading);
  if (start < 0) return "";
  let end = lines.length;
  for (const candidate of nextHeadings) {
    const index = lines.indexOf(candidate, start + 1);
    if (index >= 0 && index < end) end = index;
  }
  return lines.slice(start + 1, end).join("\n").trim();
}

const sourcesBody = sectionBody("## Sources", ["## Findings"]);
const sourceRows = sourcesBody
  .split("\n")
  .filter((line) => /^\|/.test(line.trim()))
  .filter((line) => !/^\|\s*Source\s*\|/i.test(line.trim()))
  .filter((line) => !/^\|\s*[-: ]+\|/.test(line.trim()));

if (sourceRows.length < 1) {
  fail("Sources must contain at least one populated evidence row");
} else if (!sourceRows.some((row) => /https?:\/\//i.test(row) || /observed/i.test(row))) {
  fail("Sources need at least one URL or explicitly identified observed-evidence row");
} else {
  pass(`sources contain ${sourceRows.length} populated evidence row(s)`);
}

const sectionPairs = [
  ["### CURRENT", ["### DERIVED"]],
  ["### DERIVED", ["### RECOMMENDED"]],
  ["### RECOMMENDED", ["### SPECULATIVE"]],
  ["### SPECULATIVE", ["## Conflicts / unknowns"]],
  ["## Conflicts / unknowns", ["## Implementation consequences"]],
  ["## Implementation consequences", ["## Qualification procedure if needed"]],
  ["## Qualification procedure if needed", []],
];

for (const [heading, next] of sectionPairs) {
  const body = sectionBody(heading, next);
  if (!body) fail(`${heading} must be explicitly completed (use 'None' or 'Not needed' when appropriate)`);
}
if (sectionPairs.every(([heading, next]) => sectionBody(heading, next))) {
  pass("all evidence/consequence sections are explicitly completed");
}

const highConfidenceSecretPatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /Authorization:\s*Bearer\s+[A-Za-z0-9._~+/=-]{16,}/i,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/,
];

if (highConfidenceSecretPatterns.some((pattern) => pattern.test(text))) {
  fail("artifact appears to contain a high-confidence secret/token pattern");
} else {
  pass("no high-confidence secret/token pattern detected");
}

if (process.exitCode) {
  console.error("Research artifact validation failed.");
} else {
  console.log("Research artifact validation passed.");
}
