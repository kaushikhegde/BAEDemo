#!/usr/bin/env node
/**
 * Lift `adoTarget` out of every `projects/<p>/.published.json` and into the
 * `projects.ado_target` column that 009_project_ado_target.sql added.
 *
 *   node scripts/backfill-ado-target.mjs                # a PLAN — writes nothing
 *   node scripts/backfill-ado-target.mjs --apply        # do it
 *   node scripts/backfill-ado-target.mjs --project SAPN # narrow it
 *
 * Until that migration, where a project publishes existed ONLY in that file.
 * `POST /api/projects` read it back to tell "this name is taken" from "this
 * project was created but its Azure DevOps setup failed — re-post to finish
 * it", which made a directory the system of record for something the database
 * owns. Projects created before the change still carry their target only on
 * disk, so that route would read null and treat a fully set-up project as
 * incomplete.
 *
 * Disk lifts INTO the database and never the reverse — the same rule
 * `sync-documents.mjs` follows for documents, for the same reason: this is a
 * one-time correction of a record that should always have been a column.
 *
 * Idempotent, and conservative about what it will overwrite. A project whose
 * row ALREADY has a target is left alone and reported, even when the file
 * disagrees: the column is the record now, and a stale `.published.json` (an
 * old clone, a restored tree) must not be able to redirect a client's
 * publishing. Re-point one of those by hand with
 * `PATCH /projects/{id} {"adoTarget": …}` after checking which is right.
 */
import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");
const flag = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };

try {
  const env = await readFile(path.join(ROOT, ".env"), "utf8");
  for (const line of env.split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
} catch { /* no .env is fine if the token is exported */ }

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
    headers: {
      "content-type": "application/json", accept: "application/json",
      authorization: `Bearer ${TOKEN}`,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) throw new Error(`${method} ${p} → ${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`.trim());
  return res.status === 204 ? null : res.json();
};

/** The target recorded on disk for one project, or null. */
const targetOnDisk = async (project) => {
  try {
    const p = JSON.parse(await readFile(path.join(ROOT, "projects", project, ".published.json"), "utf8"));
    return p?.adoTarget?.project ? p.adoTarget : null;
  } catch { return null; }
};

const only = flag("project");

const folders = (await readdir(path.join(ROOT, "projects"), { withFileTypes: true }).catch(() => []))
  .filter(e => e.isDirectory() && !e.name.startsWith("."))
  .map(e => e.name)
  .filter(n => !only || n === only)
  .sort();

const rows = await api("GET", "/projects");
const byName = new Map(rows.map(r => [r.name, r]));

const plan = [];
for (const project of folders) {
  const disk = await targetOnDisk(project);
  const row = byName.get(project);

  if (!row) {
    // The project itself is missing from the database. That is a bigger gap
    // than this script's job and has its own fix, so it is named rather than
    // silently skipped — a backfill that reports "nothing to do" for a project
    // it could not see is how the original problem stayed hidden.
    plan.push({ project, action: "no row", detail: "not in the database — `npm run sync:docs -- --apply` creates it" });
    continue;
  }
  if (row.ado_target?.project) {
    const same = disk && disk.project === row.ado_target.project && disk.org === row.ado_target.org;
    plan.push({
      project, action: "already set",
      detail: disk && !same
        ? `column says ${row.ado_target.org}/${row.ado_target.project}, file says ${disk.org}/${disk.project} — LEFT ALONE, check by hand`
        : `${row.ado_target.org}/${row.ado_target.project}`,
    });
    continue;
  }
  if (!disk) {
    plan.push({ project, action: "incomplete", detail: "no target on disk either — re-post /api/projects to set one up" });
    continue;
  }
  plan.push({ project, action: "backfill", detail: `${disk.org}/${disk.project} (${disk.workItemType ?? "no work item type"})`, id: row.id, target: disk });
}

const width = Math.max(0, ...plan.map(p => p.project.length));
for (const p of plan) {
  console.log(`${p.project.padEnd(width)}  ${p.action.padEnd(12)}  ${p.detail}`);
}

const todo = plan.filter(p => p.action === "backfill");
if (!todo.length) {
  console.log(`\nNothing to backfill.`);
  process.exit(0);
}

if (!APPLY) {
  console.log(`\n${todo.length} project(s) would be updated. Re-run with --apply.`);
  process.exit(0);
}

let applied = 0;
for (const p of todo) {
  try {
    await api("PATCH", `/projects/${p.id}`, { adoTarget: p.target });
    console.log(`✓ ${p.project}`);
    applied++;
  } catch (e) {
    console.error(`✗ ${p.project}: ${e.message}`);
  }
}
console.log(`\n${applied}/${todo.length} updated.`);
process.exit(applied === todo.length ? 0 : 1);
