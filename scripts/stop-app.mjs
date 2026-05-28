#!/usr/bin/env node
// Stop a running scaffolded app for <project>/<feature>.
//
// Usage: node scripts/stop-app.mjs <project> <feature>
//
// Behaviour:
//   - Reads generated-apps/registry.json, finds entry "<project>-<feature>".
//   - If the entry has a live pid, sends SIGTERM (then SIGKILL after 2s if alive).
//   - Marks the entry's status as "stopped", clears pid, and rewrites the registry.
//     The entry stays (port + appPath preserved) so a subsequent start can reuse them.
//   - Prints the updated registry entry on stdout.
//   - Idempotent: stopping an already-stopped app prints the entry and exits 0.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const REGISTRY_PATH = join(ROOT, "generated-apps", "registry.json");

function readRegistry() {
  if (!existsSync(REGISTRY_PATH)) return {};
  try { return JSON.parse(readFileSync(REGISTRY_PATH, "utf8") || "{}"); } catch { return {}; }
}
function writeRegistry(reg) {
  writeFileSync(REGISTRY_PATH, JSON.stringify(reg, null, 2) + "\n");
}
function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function main() {
  const [, , project, feature] = process.argv;
  if (!project || !feature) {
    console.error("usage: stop-app.mjs <project> <feature>");
    process.exit(2);
  }
  const key = `${project}-${feature}`;
  const reg = readRegistry();
  const entry = reg[key];
  if (!entry) {
    console.error(`No registry entry for ${key}.`);
    process.exit(1);
  }

  if (entry.pid && pidAlive(entry.pid)) {
    try { process.kill(entry.pid, "SIGTERM"); } catch {}
    // Grace period, then escalate.
    for (let i = 0; i < 20; i += 1) {
      if (!pidAlive(entry.pid)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    if (pidAlive(entry.pid)) {
      try { process.kill(entry.pid, "SIGKILL"); } catch {}
    }
  }

  reg[key] = {
    ...entry,
    pid: null,
    status: "stopped",
    updatedAt: new Date().toISOString(),
  };
  writeRegistry(reg);
  process.stdout.write(JSON.stringify(reg[key], null, 2) + "\n");
}

main().catch((e) => {
  console.error(e?.stack || String(e));
  process.exit(1);
});
