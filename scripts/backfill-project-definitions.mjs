#!/usr/bin/env node
// Copy each project's `description.md` into its database row where the row has
// none.
//
// The definition has two homes: `projects/<p>/description.md`, which every
// SKILL reads before any discovery document, and `projects.description`, which
// the assistant reads to decide whether to ASK for a definition. Until the
// fixes that accompany this script, three of the four ways to set one wrote
// only the file — the wizard's `POST /api/projects`, the assistant's own
// `save_project_definition` via `POST /api/project-description`, and editing
// the file by hand. Only `scyne project describe` wrote both.
//
// So an installation accumulates projects whose definitions reach every agent
// and are invisible to the assistant, which then asks for a definition the
// project plainly has, on every turn, forever. This lifts them.
//
//   node scripts/backfill-project-definitions.mjs           # a PLAN. writes nothing
//   node scripts/backfill-project-definitions.mjs --apply
//
// Auth: whatever `scyne login` already stored in ~/.scyne/config.json, else
// SCYNE_API_TOKEN from the root .env, else --token. The FILE is never touched —
// this only ever writes the column, and only where it is empty, so a row
// someone has deliberately edited is left alone.

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");
const FORCE = argv.includes("--force");
const flag = n => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };

// The root .env is the one file every process in this stack reads.
try {
  const env = await readFile(path.join(ROOT, ".env"), "utf8");
  for (const line of env.split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
} catch { /* no .env is fine if the token is exported */ }

// The same file `scyne login` writes, so anyone who can run the CLI can run
// this without minting a second credential — a backfill that first demands a
// token nobody knows how to make is one that does not get run.
let stored = {};
try {
  const home = process.env.SCYNE_HOME || path.join(homedir(), ".scyne");
  stored = JSON.parse(await readFile(path.join(home, "config.json"), "utf8"));
} catch { /* not logged in on this machine */ }

const BASE = flag("api") || stored.apiUrl || process.env.ORCHESTRATOR_API_URL || "http://127.0.0.1:3100";
const TOKEN = flag("token") || stored.token || process.env.SCYNE_API_TOKEN;
if (!TOKEN) {
  console.error("No credential. Run `scyne login`, or set SCYNE_API_TOKEN in .env, or pass --token <t>.");
  process.exit(2);
}

const api = async (method, p, body) => {
  const res = await fetch(BASE + p, {
    method,
    headers: { "content-type": "application/json", accept: "application/json",
               authorization: `Bearer ${TOKEN}` },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) throw new Error(`${method} ${p} → ${res.status} ${await res.text().catch(() => "")}`.trim());
  return res.status === 204 ? null : res.json();
};

let projects;
try {
  projects = await api("GET", "/projects");
} catch (e) {
  console.error(`Could not reach the orchestrator at ${BASE}: ${e.message}`);
  console.error("Is `npm run dev` running?");
  process.exit(2);
}

const rows = [];
for (const p of projects) {
  let file = null;
  try {
    file = (await readFile(path.join(ROOT, "projects", p.name, "description.md"), "utf8")).trim();
  } catch { /* no file — nothing to lift */ }

  const inDb = String(p.description ?? "").trim();
  const state =
    !file            ? "no file on disk"
    : inDb && !FORCE ? "already in the database"
    : inDb           ? "overwriting (--force)"
    :                  "TO WRITE";
  rows.push({ name: p.name, id: p.id, file, state });
}

const width = Math.max(7, ...rows.map(r => r.name.length));
for (const r of rows) {
  const note = r.state === "TO WRITE" ? `${r.file.length} chars from description.md` : r.state;
  console.log(`  ${r.name.padEnd(width)}  ${r.state === "TO WRITE" ? "→" : " "} ${note}`);
}

const todo = rows.filter(r => r.state === "TO WRITE" || r.state.startsWith("overwriting"));
if (!todo.length) {
  console.log(`\nNothing to backfill — every project with a description.md already has it in the database.`);
  process.exit(0);
}

if (!APPLY) {
  // A dry run by default, like `npm run migrate`: a half-remembered command
  // must not be able to rewrite what an installation believes about itself.
  console.log(`\n${todo.length} project(s) would be updated. Re-run with --apply to do it.`);
  process.exit(0);
}

let ok = 0, failed = 0;
for (const r of todo) {
  try {
    await api("PATCH", `/projects/${r.id}`, { description: r.file });
    ok++;
    console.log(`  ✓ ${r.name}`);
  } catch (e) {
    failed++;
    console.error(`  ✗ ${r.name}: ${e.message}`);
  }
}
console.log(`\n${ok} updated${failed ? `, ${failed} failed` : ""}.`);
process.exit(failed ? 1 : 0);
