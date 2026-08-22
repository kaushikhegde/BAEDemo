#!/usr/bin/env node
// Reconcile the folder tree into the database.
//
// This system keeps two records of what exists. The agents read a folder tree
// under `projects/`; `scyne`, the console, the platform API and spend reporting
// read the database. `cli/dual.ts` writes both for anything created THROUGH it,
// and the chatbot's routes now do the same — but that only governs writes made
// from now on, through those paths. Everything else still lands on disk alone:
//
//   * every document that existed before those fixes,
//   * `npm run convert`, which replaces a source with markdown and archives it,
//   * `stage.mjs`, an agent, or a person copying a file into `documents/`.
//
// Measured on the installation this was written against: 20 documents on disk,
// 2 rows, and three of four projects unknown to the database entirely. So
// `scyne doc list` reported nothing for a project the browser showed nine
// documents for.
//
// (Count the two real shapes only — `projects/<p>/documents/` and
// `projects/<p>/<f>/requirements/{SOP,Transcripts,Notes,UI}/`. A glob like
// `*/documents/*.md` also sweeps up `solutions/<Stage>/documents/`, which is 41
// STAGED COPIES here: working-folder material `stage.mjs` writes before an
// agent run, not documents anybody uploaded.)
//
// Disk WINS. It is what every stage actually reads — the 409 gates count `.md`
// there, the skills read the folder tree — so this lifts disk into the database
// and never the other way round.
//
//   node scripts/sync-documents.mjs                  # a PLAN. writes nothing
//   node scripts/sync-documents.mjs --apply
//   node scripts/sync-documents.mjs --project SAPN   # one project
//
// Idempotent: a second run reports nothing to do, because `put()` is content
// addressed and answers `changed: false` for bytes it already holds.
//
// Auth: whatever `scyne login` stored in ~/.scyne/config.json, else
// SCYNE_API_TOKEN from the root .env, else --token. Mirrors
// scripts/backfill-project-definitions.mjs.

import { readFile, readdir, stat } from "node:fs/promises";
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

// ---------------------------------------------------------------------------
// What a document IS on disk. The same two shapes the Docs tab reads, and the
// same exclusions: `templates/` is house style, `project/` is staged down on
// every run, `original-files/` is the archive, `outputs/` and `solutions/` are
// generated artefacts that belong to a stage rather than to an upload.
// ---------------------------------------------------------------------------
const DISCOVERY = ["SOP", "Transcripts", "Notes", "UI"];
const PROJECT_OWN_DIRS = new Set(["solutions", "documents", "design", "original-files", "outputs"]);

const listDir = async (dir) => {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (!e.isFile() || e.name.startsWith(".")) continue;
    out.push(e.name);
  }
  return out.sort();
};

const isDir = async (p) => (await stat(p).catch(() => null))?.isDirectory() ?? false;

async function documentsOnDisk(project) {
  const projectRoot = path.join(ROOT, "projects", project);
  const docs = [];

  for (const name of await listDir(path.join(projectRoot, "documents"))) {
    docs.push({ feature: null, path: `documents/${name}`, abs: path.join(projectRoot, "documents", name) });
  }

  for (const e of await readdir(projectRoot, { withFileTypes: true }).catch(() => [])) {
    if (!e.isDirectory() || e.name.startsWith(".")) continue;
    if (PROJECT_OWN_DIRS.has(e.name.toLowerCase())) continue;
    const feature = e.name;
    for (const sub of DISCOVERY) {
      const dir = path.join(projectRoot, feature, "requirements", sub);
      for (const name of await listDir(dir)) {
        docs.push({ feature, path: `requirements/${sub}/${name}`, abs: path.join(dir, name) });
      }
    }
  }
  return docs;
}

/** `sop`, `transcripts`, … — the vocabulary `--as` writes and `available()` counts by. */
const categoryFor = (p) => {
  const parts = p.split("/");
  if (parts[0] !== "requirements" || parts.length < 3) return null;
  return ({ sop: "sop", transcripts: "transcripts", notes: "notes", ui: "ui", templates: "template" })[parts[1].toLowerCase()] ?? null;
};

// ---------------------------------------------------------------------------

let projectsOnDisk;
try {
  projectsOnDisk = (await readdir(path.join(ROOT, "projects"), { withFileTypes: true }))
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => e.name)
    .sort();
} catch {
  console.error(`No projects/ directory under ${ROOT}.`);
  process.exit(2);
}
const only = flag("project");
if (only) {
  if (!projectsOnDisk.includes(only)) {
    console.error(`No such project on disk: ${only}\n  Available: ${projectsOnDisk.join(", ")}`);
    process.exit(2);
  }
  projectsOnDisk = [only];
}

let rows;
try {
  rows = await api("GET", "/projects");
} catch (e) {
  console.error(`Could not reach the orchestrator at ${BASE}: ${e.message}`);
  console.error("Is `npm run dev` running?");
  process.exit(2);
}
const byName = new Map(rows.map((p) => [p.name, p]));

const plan = { projects: [], features: [], documents: [], retire: [], skipped: [] };

for (const project of projectsOnDisk) {
  const row = byName.get(project);
  if (!row) plan.projects.push(project);

  const disk = await documentsOnDisk(project);
  const features = [...new Set(disk.map((d) => d.feature).filter(Boolean))];

  // Only a project that HAS a row can be asked what it holds. For one that does
  // not, everything is new by definition.
  let known = new Set();
  let knownFeatures = new Set();
  if (row) {
    const existing = await api("GET", `/projects/${row.id}/documents?all=true`);
    known = new Set(existing.map((d) => `${d.feature ?? ""}::${d.path}`));
    knownFeatures = new Set((await api("GET", `/projects/${row.id}/features`)).map((f) => f.name));

    // A row whose file is gone. Retired, never hard-deleted — the bytes are
    // shared by every path holding the same content, and history is the point
    // of a versioned store.
    const onDisk = new Set(disk.map((d) => `${d.feature ?? ""}::${d.path}`));
    for (const d of existing) {
      const key = `${d.feature ?? ""}::${d.path}`;
      if (!onDisk.has(key)) plan.retire.push({ project, feature: d.feature ?? null, path: d.path });
    }
  }

  for (const f of features) if (!knownFeatures.has(f)) plan.features.push({ project, feature: f });
  for (const d of disk) {
    if (!known.has(`${d.feature ?? ""}::${d.path}`)) plan.documents.push({ project, ...d });
  }
}

const total = plan.projects.length + plan.features.length + plan.documents.length + plan.retire.length;

console.log(`\n  ${APPLY ? "Applying" : "Plan"} — ${BASE}\n`);
for (const p of plan.projects) console.log(`  + project   ${p}`);
for (const f of plan.features) console.log(`  + feature   ${f.project} / ${f.feature}`);
for (const d of plan.documents) console.log(`  + document  ${d.project}${d.feature ? ` / ${d.feature}` : ""} · ${d.path}`);
for (const r of plan.retire) console.log(`  - retire    ${r.project}${r.feature ? ` / ${r.feature}` : ""} · ${r.path} (no file on disk)`);
if (!total) console.log("  nothing to do — the database already matches the folder tree");

if (!APPLY) {
  console.log(`\n  ${total} change(s). Nothing was written. Re-run with --apply.\n`);
  process.exit(0);
}

// --- apply -----------------------------------------------------------------
let created = 0, failed = 0;
const fail = (what, e) => { failed++; console.error(`  ! ${what}: ${e.message}`); };

for (const name of plan.projects) {
  try { await api("POST", "/projects", { name }); created++; byName.set(name, await resolve(name)); }
  catch (e) { fail(`project ${name}`, e); }
}

async function resolve(name) {
  const all = await api("GET", "/projects");
  return all.find((p) => p.name === name);
}

for (const f of plan.features) {
  const row = byName.get(f.project) ?? await resolve(f.project).catch(() => null);
  // A feature cannot be created without its project. Reported, not guessed.
  if (!row) { plan.skipped.push(`feature ${f.project}/${f.feature} — its project is not in the database`); continue; }
  try { await api("POST", `/projects/${row.id}/features`, { name: f.feature }); created++; }
  catch (e) { if (/409/.test(e.message)) continue; fail(`feature ${f.project}/${f.feature}`, e); }
}

for (const d of plan.documents) {
  const row = byName.get(d.project) ?? await resolve(d.project).catch(() => null);
  if (!row) { plan.skipped.push(`document ${d.project} · ${d.path} — its project is not in the database`); continue; }
  try {
    const bytes = await readFile(d.abs);
    await api("POST", `/projects/${row.id}/documents`, {
      ...(d.feature ? { feature: d.feature } : {}),
      path: d.path,
      category: categoryFor(d.path),
      // base64 for everything: a .docx or a screenshot cannot survive a JSON
      // string, and corrupting one would be found much later by a model
      // reading gibberish.
      encoding: "base64",
      content: bytes.toString("base64"),
    });
    created++;
  } catch (e) { fail(`document ${d.project} · ${d.path}`, e); }
}

for (const r of plan.retire) {
  const row = byName.get(r.project) ?? await resolve(r.project).catch(() => null);
  if (!row) continue;
  const q = new URLSearchParams({ path: r.path });
  if (r.feature) q.set("feature", r.feature);
  try { await api("DELETE", `/projects/${row.id}/documents?${q}`); created++; }
  catch (e) { fail(`retire ${r.project} · ${r.path}`, e); }
}

for (const s of plan.skipped) console.log(`  · skipped   ${s}`);
console.log(`\n  ${created} applied, ${failed} failed, ${plan.skipped.length} skipped.\n`);
process.exit(failed ? 1 : 0);
