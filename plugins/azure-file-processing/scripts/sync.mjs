#!/usr/bin/env node
// Mirrors projects/<project>/ between the local tree and the `workspace` blob
// container. Invoked as a subprocess by repo-root hooks, which cannot import
// this plugin's dependencies.
//
// This script imports TypeScript modules (.ts files from src/), so it must run
// through the plugin's own tsx binary, not bare `node`. Bare `node` will fail
// with ERR_MODULE_NOT_FOUND. Invoke as:
//   ./node_modules/.bin/tsx scripts/sync.mjs <project> --up|--down|--status [--prefix P] [--dry-run] [--root R]
// Or from the repo root, with the full path:
//   plugins/azure-file-processing/node_modules/.bin/tsx scripts/sync.mjs <project> --up|--down|--status [...options]
import { resolve } from "node:path";
import { loadConfig } from "../src/shared/config.js";
import { getStorage } from "../src/shared/storage.js";
import { syncUp, syncDown, syncStatus } from "../src/workspace/sync.js";

const argv = process.argv.slice(2);
const project = argv[0];
const has = (f) => argv.includes(f);
const val = (f, d) => { const i = argv.indexOf(f); return i === -1 ? d : argv[i + 1]; };

const fail = (why) => { console.error(`sync failed: ${why}`); process.exit(2); };

if (!project || project.startsWith("--")) fail("usage: ./node_modules/.bin/tsx scripts/sync.mjs <project> --up|--down|--status [--prefix P] [--dry-run] [--root R]");
const directions = ["--up", "--down", "--status"].filter(has);
if (directions.length !== 1) fail("pass exactly one of --up, --down or --status");

const root = resolve(val("--root", process.env.WORKSPACE_PATH || process.cwd()));
const prefix = val("--prefix", undefined);
const dryRun = has("--dry-run");

const cfg = loadConfig();
const s = getStorage(cfg);

// Suppress the sync functions' log output to stdout; redirect to stderr instead.
// The sync functions call log.info() which writes JSON to stdout, but the CLI
// contract is one JSON line of output on stdout (the result).
const originalWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, encoding, callback) => {
  const str = typeof chunk === 'string' ? chunk : chunk.toString(encoding);
  // Capture log lines (JSON with level field) and send to stderr; pass through everything else
  try {
    const parsed = JSON.parse(str.trim());
    if (parsed.level && (parsed.level === 'info' || parsed.level === 'warn')) {
      process.stderr.write(chunk, encoding, callback);
      return true;
    }
  } catch {
    // Not JSON, or parsing failed; pass through normally
  }
  return originalWrite(chunk, encoding, callback);
};

try {
  if (has("--status")) {
    const st = await syncStatus(s, root, project, prefix);
    console.log(JSON.stringify({ ok: true, direction: "status", project, ...st }));
  } else if (has("--up")) {
    const r = await syncUp(s, root, project, { prefix, dryRun });
    console.log(JSON.stringify({ ok: true, direction: "up", project, dryRun, ...r }));
  } else {
    const r = await syncDown(s, root, project, { prefix, dryRun });
    console.log(JSON.stringify({ ok: true, direction: "down", project, dryRun, ...r }));
  }
} catch (e) {
  // Never print file contents; the message alone.
  fail(String(e?.message ?? e).slice(0, 400));
}
