#!/usr/bin/env node
// Run WCAG 2.0 AA accessibility checks against a generated app.
//
// Usage:
//   node scripts/audit-a11y.mjs <project-feature-key>
//
// Behaviour:
//   1. Reads generated-apps/registry.json for the {port, appPath}.
//   2. Runs @axe-core/cli against the dev URL (WCAG 2.0 A + AA tags).
//   3. Runs pa11y against the dev URL (WCAG2AA standard, JSON reporter).
//   4. Writes generated-apps/<key>/audit.json with consolidated violations.
//
// Exit code is 0 on successful audit (even if violations exist); 1 only on tool failure.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const REGISTRY_PATH = join(ROOT, "generated-apps", "registry.json");

function usage() {
  console.error("usage: audit-a11y.mjs <project-feature-key>");
  process.exit(2);
}

function readRegistry() {
  if (!existsSync(REGISTRY_PATH)) throw new Error(`registry not found at ${REGISTRY_PATH}`);
  return JSON.parse(readFileSync(REGISTRY_PATH, "utf8") || "{}");
}

function runCapture(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", env: process.env });
  return { status: r.status ?? 0, stdout: r.stdout || "", stderr: r.stderr || "" };
}

function parseJsonSafe(s) {
  try { return JSON.parse(s); } catch { return null; }
}

async function main() {
  const [, , key] = process.argv;
  if (!key) usage();

  const reg = readRegistry();
  const entry = reg[key];
  if (!entry) throw new Error(`no registry entry for "${key}"`);

  const appPath = join(ROOT, entry.appPath);
  const devUrl = entry.devUrl || `http://127.0.0.1:${entry.port}`;
  const result = { key, devUrl, ranAt: new Date().toISOString(), tools: {} };

  // 1. axe-core CLI — WCAG 2.0 AA tags.
  const axeOut = mkdtempSync(join(tmpdir(), "axe-"));
  const axe = runCapture(
    "npx",
    ["-y", "@axe-core/cli", devUrl, "--tags", "wcag2a,wcag2aa", "--save", "axe.json", "--dir", axeOut, "--exit"],
    ROOT
  );
  const axeJsonPath = join(axeOut, "axe.json");
  const axeData = existsSync(axeJsonPath) ? parseJsonSafe(readFileSync(axeJsonPath, "utf8")) : null;
  result.tools.axe = {
    ok: axe.status === 0 || axe.status === 1, // 1 = violations found, still "ran"
    violations: axeData?.[0]?.violations || axeData?.violations || [],
    error: !axeData ? axe.stderr.slice(0, 500) : undefined,
  };

  // 2. pa11y — uses WCAG2AA standard by default; emits JSON.
  const pa11y = runCapture("npx", ["-y", "pa11y", devUrl, "--standard", "WCAG2AA", "--reporter", "json"], ROOT);
  result.tools.pa11y = {
    ok: pa11y.status === 0 || pa11y.status === 2, // 2 = issues found
    issues: parseJsonSafe(pa11y.stdout) || [],
    error: !pa11y.stdout ? pa11y.stderr.slice(0, 500) : undefined,
  };

  // Aggregate violation count.
  const axeCount = (result.tools.axe.violations || []).reduce((n, v) => n + (v.nodes?.length || 0), 0);
  const paCount = (result.tools.pa11y.issues || []).length;
  result.summary = { axe: axeCount, pa11y: paCount, total: axeCount + paCount };

  const outPath = join(appPath, "audit.json");
  writeFileSync(outPath, JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result.summary, null, 2));
  console.log(`wrote ${outPath}`);
}

main().catch((e) => { console.error("[audit] error:", e.message); process.exit(1); });
