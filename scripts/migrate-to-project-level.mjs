#!/usr/bin/env node
// One-shot migration: lift the artefacts that describe the CLIENT out of the
// feature that happened to generate them, up to the project.
//
//   node scripts/migrate-to-project-level.mjs            every project, dry run
//   node scripts/migrate-to-project-level.mjs --apply    do it
//   node scripts/migrate-to-project-level.mjs SAPN --apply
//
// What moves:
//   <feature>/solutions/Capabilities/   → projects/<project>/solutions/Capabilities/
//   <feature>/solutions/Experience/     → projects/<project>/solutions/Experience/
//   <feature>/design/                   → projects/<project>/design/
//
// When two features under one project both carry the same artefact, the most
// recently modified wins and the loser is MOVED (never deleted) to
//   projects/<project>/original-files/superseded/<feature>/
// so a consultant can diff them by hand.
//
// The per-feature companion app is retired by this change, so
// generated-apps/<project>-<feature>/ and its registry entries are cleared —
// the project page replaces them and is re-rendered afterwards.
//
// Idempotent: a second run reports "nothing to do". Refuses to overwrite an
// existing project-level artefact without --force.

import fs from "node:fs/promises";
import path from "node:path";
import { WORK_ROOT } from "./lib/roots.mjs";
import { listProjects, listFeatures, projectDir, featureDir, exists, SAFE_NAME } from "./pipeline.mjs";

// The project tree this run operates on. See scripts/lib/roots.mjs for why
// this is not the same question as "where does this code live".
const WORKSPACE = WORK_ROOT;

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith("--")));
const APPLY = flags.has("--apply");
const FORCE = flags.has("--force");
const only = argv.filter((a) => !a.startsWith("--"))[0] ?? null;

const rel = (p) => path.relative(WORKSPACE, p) || ".";
const die = (m) => { console.error(`\n[migrate] ${m}\n`); process.exit(1); };

// Directories lifted wholesale from a feature to its project.
const LIFT = [
  { from: ["solutions", "Capabilities"], to: ["solutions", "Capabilities"], label: "capability & process map" },
  { from: ["solutions", "Experience"], to: ["solutions", "Experience"], label: "personas & journeys" },
  { from: ["design"], to: ["design"], label: "branding & design references" },
];

const plan = [];
const notes = [];

/** Newest mtime anywhere under a directory — the tie-break between two features. */
async function newestUnder(dir) {
  let newest = 0;
  const walk = async (d) => {
    for (const e of await fs.readdir(d, { withFileTypes: true }).catch(() => [])) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) await walk(full);
      else {
        const st = await fs.stat(full).catch(() => null);
        if (st && st.mtimeMs > newest) newest = st.mtimeMs;
      }
    }
  };
  await walk(dir);
  return newest;
}

/** Does this directory hold any file at all? An empty scaffold is not worth moving. */
async function hasFiles(dir) {
  let found = false;
  const walk = async (d) => {
    if (found) return;
    for (const e of await fs.readdir(d, { withFileTypes: true }).catch(() => [])) {
      if (found) return;
      if (e.isDirectory()) await walk(path.join(d, e.name));
      else found = true;
    }
  };
  await walk(dir);
  return found;
}

async function moveDir(src, dest) {
  await fs.mkdir(path.dirname(dest), { recursive: true });
  try {
    await fs.rename(src, dest);
  } catch (e) {
    // Cross-device, or the destination exists — fall back to copy + remove.
    if (e.code !== "EXDEV" && e.code !== "ENOTEMPTY") throw e;
    await fs.cp(src, dest, { recursive: true, force: true });
    await fs.rm(src, { recursive: true, force: true });
  }
}

async function planProject(project) {
  const proot = projectDir(WORKSPACE, project);
  const features = await listFeatures(WORKSPACE, project);

  for (const lift of LIFT) {
    const dest = path.join(proot, ...lift.to);
    const destOccupied = (await exists(dest)) && (await hasFiles(dest));

    // Every feature that carries this artefact, newest first.
    const candidates = [];
    for (const feature of features) {
      const src = path.join(featureDir(WORKSPACE, project, feature), ...lift.from);
      if (!(await exists(src)) || !(await hasFiles(src))) continue;
      candidates.push({ feature, src, at: await newestUnder(src) });
    }
    candidates.sort((a, b) => b.at - a.at);

    if (!candidates.length) continue;

    if (destOccupied && !FORCE) {
      notes.push(`${project}: ${rel(dest)} already holds files — left alone (--force to replace from ${candidates[0].feature})`);
      continue;
    }

    const [winner, ...losers] = candidates;
    plan.push({ kind: "move", project, label: lift.label, src: winner.src, dest, feature: winner.feature });
    for (const loser of losers) {
      plan.push({
        kind: "supersede", project, label: lift.label, src: loser.src, feature: loser.feature,
        dest: path.join(proot, "original-files", "superseded", loser.feature, ...lift.from),
      });
    }
  }

  // Project documents folder — created empty so the wizard and the read-down
  // have somewhere to write. Feature discovery documents are NOT moved: a
  // feature's SOPs and transcripts belong to that feature, and the project
  // stages read them upward anyway.
  const docs = path.join(proot, "documents");
  if (!(await exists(docs))) plan.push({ kind: "mkdir", project, dest: docs, label: "project documents folder" });

  // Retire the per-feature companion apps.
  for (const feature of features) {
    const app = path.join(WORKSPACE, "generated-apps", `${project}-${feature}`);
    if (await exists(app)) plan.push({ kind: "rm", project, dest: app, label: `per-feature companion app (${feature})` });
  }
}

async function pruneRegistry(projects) {
  const p = path.join(WORKSPACE, "generated-apps", "registry.json");
  let registry;
  try { registry = JSON.parse(await fs.readFile(p, "utf8")); } catch { return null; }

  const dead = Object.keys(registry).filter((key) => {
    // A project-keyed entry is the new shape and stays. Anything with a
    // "<project>-<feature>" shape for a project we are migrating is dead.
    if (projects.includes(key)) return false;
    return projects.some((proj) => key.startsWith(`${proj}-`)) || !projects.includes(key);
  });
  if (!dead.length) return null;
  if (APPLY) {
    for (const k of dead) delete registry[k];
    await fs.writeFile(p, JSON.stringify(registry, null, 2) + "\n", "utf8");
  }
  return dead;
}

async function main() {
  if (only && !SAFE_NAME.test(only)) die("project name contains unexpected characters");

  const projects = only ? [only] : await listProjects(WORKSPACE);
  if (only && !(await exists(projectDir(WORKSPACE, only)))) die(`no such project: projects/${only}`);
  if (!projects.length) die("no projects found under projects/");

  for (const project of projects) await planProject(project);

  console.log(`\n${APPLY ? "Migrating" : "DRY RUN — would migrate"} ${projects.length} project(s): ${projects.join(", ")}\n`);

  if (!plan.length) {
    console.log("  Nothing to do.\n");
  }

  for (const step of plan) {
    if (step.kind === "move") {
      console.log(`  ${step.project}  lift ${step.label}`);
      console.log(`        ${rel(step.src)}`);
      console.log(`     →  ${rel(step.dest)}`);
    } else if (step.kind === "supersede") {
      console.log(`  ${step.project}  ${step.feature} also has ${step.label} — archiving, not deleting`);
      console.log(`        ${rel(step.src)}`);
      console.log(`     →  ${rel(step.dest)}`);
    } else if (step.kind === "mkdir") {
      console.log(`  ${step.project}  create ${step.label}  ${rel(step.dest)}`);
    } else if (step.kind === "rm") {
      console.log(`  ${step.project}  remove ${step.label}  ${rel(step.dest)}`);
    }

    if (!APPLY) continue;
    if (step.kind === "move" || step.kind === "supersede") await moveDir(step.src, step.dest);
    else if (step.kind === "mkdir") await fs.mkdir(step.dest, { recursive: true });
    else if (step.kind === "rm") await fs.rm(step.dest, { recursive: true, force: true });
  }

  const dead = await pruneRegistry(projects);
  if (dead?.length) {
    console.log(`\n  registry.json — ${APPLY ? "removed" : "would remove"} ${dead.length} stale entry/entries:`);
    for (const k of dead) console.log(`     ${k}`);
  }

  for (const n of notes) console.log(`\n  NOTE  ${n}`);

  // Feature discovery documents that read like client-wide policy rather than
  // feature discovery. Reported, never moved — only the consultant knows.
  for (const project of projects) {
    const hits = [];
    for (const feature of await listFeatures(WORKSPACE, project)) {
      const notesDir = path.join(featureDir(WORKSPACE, project, feature), "requirements", "Notes");
      for (const f of (await fs.readdir(notesDir).catch(() => []))) {
        if (!f.toLowerCase().endsWith(".md")) continue;
        if (!/policy|legislation|act|regulation|standard|governance|current.?state|landscape/i.test(f)) continue;
        hits.push(path.join(notesDir, f));
      }
    }
    if (!hits.length) continue;
    console.log(`\n  CONSIDER  ${project} — these read like client-wide documents. If they are, move them by hand to`);
    console.log(`            projects/${project}/documents/ so every feature sees them:`);
    for (const h of hits) console.log(`     ${rel(h)}`);
  }

  console.log(APPLY
    ? `\nDone. Re-render the project page(s):\n${projects.map((p) => `  node scripts/render-companion-app.mjs ${p}`).join("\n")}\n`
    : `\nRe-run with --apply to make these changes.\n`);
}

main().catch((e) => die(e.stack || String(e)));
