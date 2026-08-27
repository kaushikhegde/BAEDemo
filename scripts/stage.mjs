#!/usr/bin/env node
// Stage inputs for ANY pipeline stage, so its skill can be run locally in a
// plain Claude Code session — WITHOUT Paperclip, the chatbot, or the owning
// agent.
//
//   node scripts/stage.mjs                                  every project + pipeline status
//   node scripts/stage.mjs <project>                        project status + its features
//   node scripts/stage.mjs <project> <project-stage>        stage a PROJECT stage
//   node scripts/stage.mjs <project> <feature>              status for one feature
//   node scripts/stage.mjs <project> <feature> <stage>      stage a FEATURE stage
//   node scripts/stage.mjs <project> all                    every project stage that is ready
//   node scripts/stage.mjs <project> <feature> all          every feature stage that is ready
//
// Two levels. PROJECT stages (capabilities, personas) describe the client
// organisation and run once; FEATURE stages describe one slice of work. Each
// stage replicates exactly what its agent does in Phase 1 step 2 (see
// agent-instructions/<agent>.json) before invoking the skill. Idempotent — safe
// to re-run; inputs are overwritten from their source of truth.
//
// Flags
//   --force            re-seed reference catalogues that already have files
//   --no-convert       skip the document → markdown conversion step
//   --keep-originals   leave converted source files beside their .md instead of
//                      archiving them to original-files/
//   --from-requirements  (datamodel only) stage raw requirement .md files
//                      instead of the product summary, for a feature that has
//                      not run the BA yet

import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { WORK_ROOT } from "./lib/roots.mjs";
import { convertTree, report as reportConversion, CONVERTIBLE, PLAIN_TEXT } from "./convert-to-md.mjs";
import {
  LEVEL, STAGES, ORDERED, ordered, NOT_SOURCE, SAFE_NAME, RENDER_CMD,
  isProjectStage, projectDir, featureDir, resolveInput, exists,
  listProjects, listFeatures, stageIsDone, unmetRequirements,
} from "./pipeline.mjs";
import { projectState } from "./extract-state.mjs";

// The project tree this run operates on. See scripts/lib/roots.mjs for why
// this is not the same question as "where does this code live".
const WORKSPACE = WORK_ROOT;
const KNOWN_FLAGS = ["--force", "--no-convert", "--keep-originals", "--from-requirements"];

// The plugin-local sync CLI, invoked as a subprocess. NOT `node` — sync.mjs
// imports the TypeScript sync engine and the plugin has no build step, so
// bare `node` dies with ERR_MODULE_NOT_FOUND. NOT `npx tsx` either — on a
// machine with tsx not cached, npx DOWNLOADS it, putting a network fetch
// inside a hook that runs before every stage. This repo's own precedent is
// the plugin-local binary (see plugins/aws-file-processing/scripts/stack.sh).
const SYNC_TSX = path.join(WORKSPACE, "plugins/aws-file-processing/node_modules/.bin/tsx");
const SYNC_CLI = path.join(WORKSPACE, "plugins/aws-file-processing/scripts/sync.mjs");

const PROJECT_STAGE_KEYS = new Set(ordered(LEVEL.PROJECT).map(([k]) => k));

const die = (msg) => {
  console.error(`\n[stage] ${msg}\n`);
  process.exit(1);
};
const rel = (p) => path.relative(WORKSPACE, p) || ".";

// ---------------------------------------------------------------------------
// Helpers shared by the stage functions
// ---------------------------------------------------------------------------

// Every .md under a directory tree that is SOURCE material, tagged with the
// folder it came from. That category becomes the skill's source tag, so it is
// preserved exactly. `templates/` holds house-style examples, not content.
async function findDocs(root, { skipTemplates = true } = {}) {
  const out = [];
  const walk = async (dir, depth) => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const lower = entry.name.toLowerCase();
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth === 0 && NOT_SOURCE.has(lower)) continue;
        // case-insensitive: the folder is `templates/` in CLAUDE.md but `Templates/` on some features
        if (skipTemplates && lower === "templates") continue;
        await walk(full, depth + 1);
      } else if (lower.endsWith(".md")) {
        const category = path.dirname(full) === root ? "root" : path.basename(path.dirname(full));
        out.push({ file: full, category });
      }
    }
  };
  await walk(root, 0);
  return out.sort((a, b) => a.file.localeCompare(b.file));
}

// The project's own documents/ tree. Unlike findDocs this does NOT skip
// `documents` (that IS the tree), and every file is source material.
async function findProjectDocs(project) {
  const root = path.join(projectDir(WORKSPACE, project), "documents");
  const out = [];
  const walk = async (dir) => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.toLowerCase().endsWith(".md")) {
        const category = path.dirname(full) === root ? "root" : path.basename(path.dirname(full));
        out.push({ file: full, category });
      }
    }
  };
  await walk(root);
  return out.sort((a, b) => a.file.localeCompare(b.file));
}

async function mkdirs(base, names) {
  const dirs = {};
  for (const n of names) {
    dirs[n] = path.join(base, n);
    await fs.mkdir(dirs[n], { recursive: true });
  }
  return dirs;
}

// Copy one file, returning the report line. Overwrites: the source is truth.
async function copyOne(src, destDir, staged, labelDir) {
  await fs.mkdir(destDir, { recursive: true });
  await fs.copyFile(src, path.join(destDir, path.basename(src)));
  staged.push(`${labelDir}/${path.basename(src)}  ← ${rel(src)}`);
}

const copyIf = async (src, destDir, staged, label) => {
  if (await exists(src)) { await copyOne(src, destDir, staged, label); return true; }
  return false;
};

// Copy every .md out of a source folder. Optional, so a missing folder is fine.
async function copyMdTree(srcDir, destDir, staged, labelDir, { note } = {}) {
  const files = (await fs.readdir(srcDir).catch(() => [])).filter((f) => f.toLowerCase().endsWith(".md"));
  if (files.length === 0) {
    if (note) staged.push(`${labelDir}/  — ${note}`);
    return 0;
  }
  await fs.mkdir(destDir, { recursive: true });
  for (const f of files) await fs.copyFile(path.join(srcDir, f), path.join(destDir, f));
  staged.push(`${labelDir}/  ← ${files.length} file(s) from ${rel(srcDir)}`);
  return files.length;
}

async function copyDirMd(dir, destDir, staged, label) {
  for (const f of (await fs.readdir(dir).catch(() => []))) {
    const lower = f.toLowerCase();
    if (lower.endsWith(".md") || lower.endsWith(".json")) {
      await copyOne(path.join(dir, f), destDir, staged, label);
    }
  }
}

// Copy discovery documents into documents/<prefix>/<category>/, preserving the
// source tag. `prefix` separates the project's own documents from each
// feature's, so a skill can tell client-wide policy from feature discovery.
async function copyDocsByCategory(docs, documentsDir, staged, prefix = null) {
  const byCategory = new Map();
  for (const d of docs) {
    if (!byCategory.has(d.category)) byCategory.set(d.category, []);
    byCategory.get(d.category).push(d.file);
  }
  for (const [category, files] of [...byCategory].sort()) {
    const label = prefix ? `documents/${prefix}/${category}` : `documents/${category}`;
    const destDir = path.join(documentsDir, ...(prefix ? [prefix, category] : [category]));
    await fs.mkdir(destDir, { recursive: true });
    for (const f of files) await fs.copyFile(f, path.join(destDir, path.basename(f)));
    staged.push(`${label}/  ← ${files.length} file(s)`);
  }
}

// ---------------------------------------------------------------------------
// Read-up: what a PROJECT stage sees
// ---------------------------------------------------------------------------
// A project stage reads the project's own documents/ AND every feature's
// discovery documents. That is deliberate: a client's capability map should
// cover all the work discovered so far, not only what happened to be uploaded
// at the project level — and it means a project whose documents all live under
// features keeps working with no manual migration.
async function stageAllDocuments(ctx, documentsDir, staged) {
  let total = 0;

  const projectDocs = await findProjectDocs(ctx.project);
  if (projectDocs.length) {
    await copyDocsByCategory(projectDocs, documentsDir, staged, "project");
    total += projectDocs.length;
  }

  for (const feature of await listFeatures(WORKSPACE, ctx.project)) {
    const docs = await findDocs(featureDir(WORKSPACE, ctx.project, feature), { skipTemplates: true });
    if (!docs.length) continue;
    await copyDocsByCategory(docs, documentsDir, staged, feature);
    total += docs.length;
  }
  return total;
}

// ---------------------------------------------------------------------------
// Read-down: what a FEATURE stage sees of its parent project
// ---------------------------------------------------------------------------
// Opportunistic, never a gate. A project with nothing generated stages nothing
// extra and every feature stage still runs.
async function stageProjectDown(ctx, work, staged, { personasInto = "project", capabilitiesInto = "project" } = {}) {
  const proot = projectDir(WORKSPACE, ctx.project);
  const projectDest = path.join(work, "project");
  await fs.mkdir(projectDest, { recursive: true });

  const docs = await findProjectDocs(ctx.project);
  if (docs.length) {
    const destDir = path.join(projectDest, "documents");
    for (const d of docs) {
      const sub = path.relative(path.join(proot, "documents"), path.dirname(d.file));
      const dir = path.join(destDir, sub);
      await fs.mkdir(dir, { recursive: true });
      await fs.copyFile(d.file, path.join(dir, path.basename(d.file)));
    }
    staged.push(`project/documents/  ← ${docs.length} project document(s)`);
  } else {
    staged.push(`project/documents/  — none (optional: client-wide policy documents)`);
  }

  const personasDest = path.join(work, personasInto);
  let exp = 0;
  for (const f of ["personas.json", "journey-map.json", "personas-journeys.md"]) {
    if (await copyIf(path.join(proot, "solutions", "Experience", "outputs", f), personasDest, [], "")) exp++;
  }
  staged.push(exp
    ? `${personasInto}/  ← ${exp} file(s) from the project's personas & journeys`
    : `${personasInto}/  — personas not run for this project yet (optional)`);

  const capDest = path.join(work, capabilitiesInto);
  let cap = 0;
  for (const f of ["capability-map.json", "process-model.json", "capability-process.md"]) {
    if (await copyIf(path.join(proot, "solutions", "Capabilities", "outputs", f), capDest, [], "")) cap++;
  }
  staged.push(cap
    ? `${capabilitiesInto}/  ← ${cap} file(s) from the project's capability & process model`
    : `${capabilitiesInto}/  — capability map not run for this project yet (optional)`);
}

// ---------------------------------------------------------------------------
// Stage functions — each mirrors its agent's Phase 1 step 2
// ---------------------------------------------------------------------------

async function stageCapabilities(ctx) {
  const { work, staged, force } = ctx;
  const dirs = await mkdirs(work, ["documents", "capability-reference", "extracts", "outputs"]);

  const n = await stageAllDocuments(ctx, dirs.documents, staged);
  if (n === 0) {
    await dieWithNoSources(ctx,
      `no .md source documents for project ${ctx.project} — nothing for the capability map to read`,
      [projectDir(WORKSPACE, ctx.project)]);
  }

  // The reduce reads extracts, not documents. The documents are still staged
  // (unchanged) because `src` verification needs them reachable.
  //
  // Copied via `projectState()`, NOT a raw directory listing. Extracts are
  // keyed by content hash and never deleted when a document stops being
  // tracked (extract-state.mjs walking only SOP/Transcripts/Notes/UI, never
  // `requirements/project/`, is exactly that case) — the file just becomes an
  // orphan nothing points at any more. `projectState()` is the same "what
  // counts as a document right now" logic extract-documents.mjs and
  // validate-extracts.mjs use, so a stale orphan (e.g. an old extract of a
  // feature's own previous capability-process.md) is never copied in here
  // even though it is still sitting in the Extracts directory.
  const st = await projectState(WORKSPACE, ctx.project);
  let extractCount = 0;
  for (const d of st.documents) {
    if (d.state !== "ready") continue;
    await fs.copyFile(d.extractPath, path.join(dirs.extracts, path.basename(d.extractPath)));
    extractCount++;
  }
  staged.push(extractCount
    ? `extracts/  ← ${extractCount} file(s) from solutions/Extracts (project + every feature)`
    : `extracts/  — none found (the extract stage should have produced these — see 'requires')`);

  const refs = (await fs.readdir(dirs["capability-reference"]).catch(() => [])).filter((f) => f.toLowerCase().endsWith(".md"));
  staged.push(
    refs.length && !force
      ? `capability-reference/  — left alone (${refs.length} curated file(s))`
      : `capability-reference/  — empty (optional: drop a house capability taxonomy here)`,
  );
}

async function stagePersonas(ctx) {
  const { work, staged } = ctx;
  const dirs = await mkdirs(work, ["documents", "capabilities", "productsummary", "outputs"]);

  const n = await stageAllDocuments(ctx, dirs.documents, staged);
  if (n === 0) {
    await dieWithNoSources(ctx,
      `no .md source documents for project ${ctx.project} — personas must be evidenced, not invented`,
      [projectDir(WORKSPACE, ctx.project)]);
  }

  // Journey stages align to the capability model's L1 lifecycle phases.
  const capOut = path.join(projectDir(WORKSPACE, ctx.project), "solutions", "Capabilities", "outputs");
  let copied = 0;
  for (const f of ["capability-process.md", "process-model.json", "capability-map.json"]) {
    if (await copyIf(path.join(capOut, f), dirs.capabilities, [], "")) copied++;
  }
  staged.push(copied ? `capabilities/  ← ${copied} file(s) from the capability map` : `capabilities/  — capability map missing`);

  // Every feature's product summary is one more source when it exists.
  let summaries = 0;
  for (const feature of await listFeatures(WORKSPACE, ctx.project)) {
    const src = path.join(featureDir(WORKSPACE, ctx.project, feature), "outputs", "product-summary.md");
    if (!(await exists(src))) continue;
    await fs.mkdir(dirs.productsummary, { recursive: true });
    await fs.copyFile(src, path.join(dirs.productsummary, `${feature}-product-summary.md`));
    summaries++;
  }
  staged.push(summaries
    ? `productsummary/  ← ${summaries} feature product summary/summaries`
    : `productsummary/  — no product summaries yet (optional; this stage is not gated on them)`);
}

async function stageRequirements(ctx) {
  const { featureDir: fdir, work, staged } = ctx;
  // The BA reads requirements/{SOP,Transcripts,Notes,UI}/ in place — there is no
  // working folder to populate beyond the project read-down. Staging here is the
  // conversion pass plus a readiness check, so a missing input surfaces now
  // rather than mid-skill.
  await fs.mkdir(path.join(fdir, "outputs"), { recursive: true });
  const reqDir = path.join(fdir, "requirements");
  if (!(await exists(reqDir))) die(`no requirements/ folder at ${rel(reqDir)}`);

  for (const sub of ["SOP", "Transcripts", "Notes", "UI"]) {
    const files = (await fs.readdir(path.join(reqDir, sub)).catch(() => [])).filter((f) => !f.startsWith("."));
    staged.push(`requirements/${sub}/  — ${files.length} file(s)${files.length ? "" : "  (empty)"}`);
  }
  const docs = await findDocs(fdir);
  if (docs.length === 0) {
    await dieWithNoSources(ctx,
      `no .md files under ${rel(reqDir)} — the BA has nothing to read`,
      [reqDir]);
  }

  // Templates are the house style for THIS project and override ./examples/.
  for (const t of ["templates", "Templates"]) {
    const files = (await fs.readdir(path.join(reqDir, t)).catch(() => [])).filter((f) => !f.startsWith("."));
    if (files.length) staged.push(`requirements/${t}/  — ${files.length} house-style template(s) (override ./examples/)`);
  }

  await stageProjectDown(ctx, work, staged);
}

async function stageDataModel(ctx) {
  const { featureDir: fdir, work, staged, force, flags } = ctx;
  const dirs = await mkdirs(work, ["productsummary", "datamodel-reference", "outputs"]);

  if (flags.has("--from-requirements")) {
    const docs = await findDocs(fdir, { skipTemplates: true });
    if (docs.length === 0) die(`--from-requirements given, but no .md files under ${rel(fdir)}`);
    for (const d of docs) await fs.copyFile(d.file, path.join(dirs.productsummary, path.basename(d.file)));
    staged.push(`productsummary/  ← ${docs.length} raw requirement file(s) (no approved summary)`);
  } else {
    await copyOne(path.join(fdir, "outputs", "product-summary.md"), dirs.productsummary, staged, "productsummary");
    await copyIf(path.join(fdir, "outputs", "stories.md"), dirs.productsummary, staged, "productsummary");
  }

  // A curated per-feature catalogue wins over the global one.
  const existing = (await fs.readdir(dirs["datamodel-reference"]).catch(() => [])).filter((f) => f.toLowerCase().endsWith(".md"));
  if (existing.length && !force) {
    staged.push(`datamodel-reference/  — left alone (${existing.length} curated file(s); --force to re-seed)`);
  } else {
    const n = await copyMdTree(path.join(WORKSPACE, "datamodel-reference"), dirs["datamodel-reference"], staged, "datamodel-reference");
    if (n === 0) staged.push(`datamodel-reference/  — empty (the skill falls back to its inlined Appendix A)`);
  }

  await stageProjectDown(ctx, work, staged);
}

async function stageDesign(ctx) {
  const { featureDir: fdir, work, staged } = ctx;
  const dirs = await mkdirs(work, ["productsummary", "DataModel", "outputs"]);
  await copyOne(path.join(fdir, "outputs", "product-summary.md"), dirs.productsummary, staged, "productsummary");
  await copyMdTree(path.join(fdir, "solutions", "DataModel", "outputs"), dirs.DataModel, staged, "DataModel", {
    note: "data model not run yet (run the datamodel stage first for a grounded design)",
  });
  await stageProjectDown(ctx, work, staged);
}

async function stageArchitecture(ctx) {
  const { featureDir: fdir, work, staged } = ctx;
  const dirs = await mkdirs(work, ["productsummary", "DataModel", "landscape", "outputs"]);

  await copyOne(path.join(fdir, "outputs", "product-summary.md"), dirs.productsummary, staged, "productsummary");
  await copyIf(path.join(fdir, "outputs", "stories.md"), dirs.productsummary, staged, "productsummary");

  await copyMdTree(path.join(fdir, "solutions", "DataModel", "outputs"), dirs.DataModel, staged, "DataModel", {
    note: "data model not run yet (optional — the skill designs against requirement entities and records the dependency)",
  });

  // Current-state / integration documents live in Notes when they exist at all.
  const notes = path.join(fdir, "requirements", "Notes");
  const landscapeHits = (await fs.readdir(notes).catch(() => []))
    .filter((f) => f.toLowerCase().endsWith(".md") && /current.?state|integration|landscape|architect|system/i.test(f));
  for (const f of landscapeHits) await copyOne(path.join(notes, f), dirs.landscape, staged, "landscape");
  if (!landscapeHits.length) staged.push(`landscape/  — empty (optional current-state / integration docs)`);

  await stageProjectDown(ctx, work, staged);
}

async function stageQA(ctx) {
  const { featureDir: fdir, work, staged } = ctx;
  const dirs = await mkdirs(work, ["productsummary", "DataModel", "Architecture", "outputs"]);

  await copyOne(path.join(fdir, "outputs", "product-summary.md"), dirs.productsummary, staged, "productsummary");
  // Acceptance criteria are the highest-value input to a test pack.
  for (const f of ["stories.md", "stories.json"]) {
    await copyIf(path.join(fdir, "outputs", f), dirs.productsummary, staged, "productsummary");
  }

  await copyMdTree(path.join(fdir, "solutions", "DataModel", "outputs"), dirs.DataModel, staged, "DataModel", {
    note: "data model not run yet (optional — field types and picklists are what make boundary cases concrete)",
  });

  // Either or both may exist: the Solution Architect and Architecture Lead
  // produce different documents, and the pack reads whichever are there.
  const a = await copyMdTree(path.join(fdir, "solutions", "Architecture", "outputs"), dirs.Architecture, staged, "Architecture");
  const d = await copyMdTree(path.join(fdir, "solutions", "Design", "outputs"), dirs.Architecture, staged, "Architecture");
  if (a + d === 0) staged.push(`Architecture/  — neither architecture nor design run yet (optional)`);

  await stageProjectDown(ctx, work, staged);
}

// The mockup generator reads more inputs than any other stage: the discovery
// documents for real terminology, personas and journeys for who and when,
// capabilities for what it realises, the product summary for the stories, the
// data model for field names, architecture for the surface, and the test cases
// for the states a screen must be able to show.
//
// It now runs BEFORE the data model and test cases, so those two are usually
// absent on the first pass. That is by design — the staleness walk offers a
// refresh once they exist.
async function stageUI(ctx) {
  const { featureDir: fdir, work, staged } = ctx;
  const dirs = await mkdirs(work, ["documents", "personas", "capabilities", "productsummary", "DataModel", "Architecture", "QA", "outputs"]);

  const docs = await findDocs(fdir, { skipTemplates: true });
  if (docs.length) await copyDocsByCategory(docs, dirs.documents, staged);

  await copyIf(path.join(fdir, "outputs", "product-summary.md"), dirs.productsummary, staged, "productsummary");
  await copyIf(path.join(fdir, "outputs", "stories.md"), dirs.productsummary, staged, "productsummary");
  await copyDirMd(path.join(fdir, "outputs", "product-summaries"), dirs.productsummary, staged, "productsummary");
  await copyDirMd(path.join(fdir, "solutions", "DataModel", "outputs"), dirs.DataModel, staged, "DataModel");
  await copyDirMd(path.join(fdir, "solutions", "Architecture", "outputs"), dirs.Architecture, staged, "Architecture");
  await copyIf(path.join(fdir, "solutions", "QA", "outputs", "test-cases.md"), dirs.QA, staged, "QA");
  await copyDirMd(path.join(fdir, "solutions", "QA", "outputs", "test-cases"), dirs.QA, staged, "QA");

  const supplied = (await fs.readdir(path.join(fdir, "requirements", "UI")).catch(() => []));
  staged.push(supplied.length
    ? `requirements/UI/  — ${supplied.length} supplied mockup(s): reflect these rather than inventing a layout`
    : `requirements/UI/  — empty (no client designs supplied; the skill designs from requirements)`);

  // The UI skill reads personas/ and capabilities/ by name, so the project's
  // generated artefacts land there rather than under project/.
  await stageProjectDown(ctx, work, staged, { personasInto: "personas", capabilitiesInto: "capabilities" });
}

async function stageApp(ctx) {
  const { staged } = ctx;
  for (const [key, def] of ordered(LEVEL.PROJECT)) {
    if (key === "app") continue;
    const done = await stageIsDone(WORKSPACE, key, ctx.project, null);
    staged.push(`${done ? "included" : "MISSING "}  ${def.label}  (project)`);
  }
  for (const feature of await listFeatures(WORKSPACE, ctx.project)) {
    const marks = [];
    for (const [key, def] of ordered(LEVEL.FEATURE)) {
      if (await stageIsDone(WORKSPACE, key, ctx.project, feature)) marks.push(def.label);
    }
    staged.push(`feature    ${feature}: ${marks.length ? marks.join(", ") : "nothing generated yet"}`);
  }
  const theme = path.join(projectDir(WORKSPACE, ctx.project), "design", "style-guides", "theme.json");
  staged.push(
    (await exists(theme))
      ? `branding   design/style-guides/theme.json`
      : `branding   default Scyne palette (run: node scripts/extract-brand.mjs <url> ${ctx.project})`,
  );
}

/**
 * `extract` — order 0, and the only stage that stages NOTHING.
 *
 * Its job is one agent per document, each reading ONE document and writing a
 * small structured extract to `solutions/Extracts/`. Those documents are read
 * IN PLACE, at their real paths, because `extract-documents.mjs` keys each
 * extract by the source document's CONTENT HASH — copying a document into a
 * working folder first would not change its hash, but it would create a second
 * path for the same bytes and a second thing to keep in step. Every other
 * stage copies its inputs in; this one deliberately does not.
 *
 * It existed in `scripts/pipeline.mjs` and NOT in `STAGE_FNS`, which is a
 * combination nothing caught: `orchestrator.workflows.ts` compiles a workflow
 * for every stage in the graph and gives each one
 * `node scripts/stage.mjs <project> <stage>` as its first step, so the
 * `extract` workflow crashed at step 1 of 7 with
 *
 *     TypeError: STAGE_FNS[key] is not a function
 *
 * reported as "Gathering the inputs failed (exit 1)" — a tooling bug wearing
 * the costume of a bad input. `assertEveryStageHasAFn()` below now makes that
 * a startup failure naming the missing key, because "add a stage to
 * pipeline.mjs and get a workflow for free" is only true while these two agree.
 */
async function stageExtract(ctx) {
  const { work, staged } = ctx;
  await mkdirs(work, []);

  // What extract-documents.mjs will actually walk — the same `projectState`
  // every other consumer uses, so this cannot report a different set of
  // documents from the one that gets extracted.
  const st = await projectState(WORKSPACE, ctx.project);
  if (st.documents.length === 0) {
    await dieWithNoSources(ctx,
      `no .md source documents for project ${ctx.project} — nothing to extract`,
      [projectDir(WORKSPACE, ctx.project)]);
  }

  const by = { ready: 0, missing: 0, failed: 0, extracting: 0 };
  for (const d of st.documents) by[d.state] = (by[d.state] ?? 0) + 1;

  staged.push(`documents  ${st.documents.length} tracked, read in place (not copied — extracts are keyed by content hash)`);
  staged.push(`extracts   ${by.ready} ready · ${by.missing} to do · ${by.extracting} in flight · ${by.failed} failed`);
  for (const d of st.documents.filter((x) => x.state === "failed")) {
    staged.push(`  FAILED   ${d.docId}${d.reason ? ` — ${d.reason}` : ""}`);
  }
}

const STAGE_FNS = {
  extract: stageExtract,
  capabilities: stageCapabilities,
  personas: stagePersonas,
  requirements: stageRequirements,
  ui: stageUI,
  datamodel: stageDataModel,
  architecture: stageArchitecture,
  qa: stageQA,
  design: stageDesign,
  app: stageApp,
};

/**
 * Every stage in the pipeline graph must have a staging function here.
 *
 * Checked at startup rather than at the moment of use, because the failure it
 * prevents is silent until somebody runs the stage: `extract` sat in
 * `pipeline.mjs` with no entry in `STAGE_FNS` and every one of its workflow
 * runs died at step 1 with `STAGE_FNS[key] is not a function`. The workflows
 * are COMPILED from that graph, so a stage added there acquires a workflow
 * whether or not anything here can stage it.
 */
const assertEveryStageHasAFn = () => {
  const missing = Object.keys(STAGES).filter((k) => typeof STAGE_FNS[k] !== "function");
  if (missing.length) {
    console.error(
      `[stage] INTERNAL ERROR: ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} in ` +
      `scripts/pipeline.mjs with no staging function in scripts/stage.mjs.\n` +
      `  Every compiled workflow runs \`node scripts/stage.mjs <project> <stage>\` as its first step,\n` +
      `  so ${missing.length === 1 ? "that stage" : "those stages"} would fail at step 1 of every run.`);
    process.exit(1);
  }
};
assertEveryStageHasAFn();

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

async function printAllProjects() {
  const projects = await listProjects(WORKSPACE);
  console.log(`\nUsage: npm run stage <project> [<feature>] <stage>\n`);
  console.log(`Project stages (run once per client):\n`);
  for (const [key, def] of ordered(LEVEL.PROJECT)) console.log(`  ${key.padEnd(14)}${def.label}`);
  console.log(`\nFeature stages (run per slice of work):\n`);
  for (const [key, def] of ordered(LEVEL.FEATURE)) console.log(`  ${key.padEnd(14)}${def.label}`);
  console.log(`  ${"all".padEnd(14)}every stage at that level whose inputs are ready\n`);
  if (!projects.length) return console.log(`No projects found under projects/.\n`);

  console.log(`(· = not run, ✓ = produced its output)\n`);
  for (const project of projects) {
    const marks = [];
    for (const [key] of ordered(LEVEL.PROJECT)) {
      marks.push(`${key.slice(0, 4)}${(await stageIsDone(WORKSPACE, key, project, null)) ? "✓" : "·"}`);
    }
    console.log(`  ${project.padEnd(24)}${marks.join("  ")}`);
    for (const feature of await listFeatures(WORKSPACE, project)) {
      const fm = [];
      for (const [key] of ordered(LEVEL.FEATURE)) {
        fm.push(`${key.slice(0, 4)}${(await stageIsDone(WORKSPACE, key, project, feature)) ? "✓" : "·"}`);
      }
      console.log(`    ${feature.padEnd(22)}${fm.join("  ")}`);
    }
  }
  console.log("");
}

async function printProjectStatus(project) {
  console.log(`\n${project}\n`);
  console.log(`  Project stages:`);
  for (const [key, def] of ordered(LEVEL.PROJECT)) {
    const done = await stageIsDone(WORKSPACE, key, project, null);
    console.log(`   ${done ? "✓" : "·"} ${key.padEnd(14)}${def.label}`);
  }
  const features = await listFeatures(WORKSPACE, project);
  console.log(`\n  Features (${features.length}):`);
  if (!features.length) console.log(`    (none yet)`);
  for (const feature of features) {
    const done = [];
    for (const [key, def] of ordered(LEVEL.FEATURE)) {
      if (await stageIsDone(WORKSPACE, key, project, feature)) done.push(def.label);
    }
    console.log(`    ${feature.padEnd(24)}${done.length ? done.join(", ") : "nothing generated yet"}`);
  }

  const next = [];
  for (const [key] of ordered(LEVEL.PROJECT)) {
    if (key === "app") continue;
    if (!(await stageIsDone(WORKSPACE, key, project, null))) { next.push(key); break; }
  }
  console.log(next.length
    ? `\nNext:  npm run stage ${project} ${next[0]}\n`
    : `\nBoth project stages have run. Pick a feature:  npm run stage ${project} "<feature>"\n`);
}

async function printFeatureStatus(project, feature) {
  console.log(`\n${project} / ${feature}\n`);
  for (const [key, def] of ordered(LEVEL.FEATURE)) {
    const done = await stageIsDone(WORKSPACE, key, project, feature);
    console.log(`  ${done ? "✓" : "·"} ${key.padEnd(14)}${def.label}`);
  }
  let next = null;
  for (const [key, def] of ordered(LEVEL.FEATURE)) {
    if (def.optional) continue;
    if (!(await stageIsDone(WORKSPACE, key, project, feature))) { next = key; break; }
  }
  if (next) console.log(`\nNext:  npm run stage ${project} "${feature}" ${next}\n`);
  else console.log(`\nEvery feature stage has run. Re-render the project page:\n  ${RENDER_CMD.replace("<project>", project)}\n`);
}

// ---------------------------------------------------------------------------
// Conversion — make every source document readable before staging
// ---------------------------------------------------------------------------

// The skills only read .md. Convert .pdf/.docx/.xlsx/.txt in every source tree
// first, so a hand-placed PDF is not silently invisible to the model.
async function convertUnder(root, archiveBase, { force, keepOriginals }, failed) {
  let any = false;
  for (const entry of await fs.readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory()) continue;
    const lower = entry.name.toLowerCase();
    // `documents/` IS source material at project level, so it is converted;
    // everything else in NOT_SOURCE is output.
    if (NOT_SOURCE.has(lower) && lower !== "documents") continue;
    const results = await convertTree(path.join(root, entry.name), {
      force,
      archiveRoot: keepOriginals ? null : path.join(archiveBase, entry.name),
      onProgress: (f) => console.log(`  converting ${f} …`),
    });
    if (results.length) { reportConversion(results, (s) => console.log(s)); any = true; }
    failed.push(...results.filter((r) => r.status === "failed"));
  }
  return any;
}

async function convertSources(ctx, opts) {
  let any = false;
  const failed = [];
  const proot = projectDir(WORKSPACE, ctx.project);
  // Project stages read every feature too, so convert the whole project tree.
  // ctx.level is authoritative for "baseline", which is not in STAGES.
  if (ctx.level === LEVEL.PROJECT || isProjectStage(ctx.stageKey)) {
    any = (await convertUnder(proot, path.join(proot, "original-files"), opts, failed)) || any;
    for (const feature of await listFeatures(WORKSPACE, ctx.project)) {
      const fdir = featureDir(WORKSPACE, ctx.project, feature);
      any = (await convertUnder(fdir, path.join(fdir, "original-files"), opts, failed)) || any;
    }
  } else {
    any = (await convertUnder(proot, path.join(proot, "original-files"), opts, failed)) || any;
    any = (await convertUnder(ctx.featureDir, path.join(ctx.featureDir, "original-files"), opts, failed)) || any;
  }
  if (any) console.log("");

  // Conversion is a BEST EFFORT, and a failure here is not a reason to stop.
  //
  // Every source that converted is staged; the ones that did not are simply
  // not there, exactly as before. What changed is that it is now SAID. It used
  // to scroll past inside the conversion report, so a `.docx` that never
  // became markdown surfaced two screens later as "nothing to read" — the
  // person was told their documents were missing when the converter was
  // broken, and `markitdown-ts is not installed` reads nothing like an empty
  // project.
  //
  // The stage still refuses further down if that left it with no sources at
  // all, which is the right place for it: that check knows whether anything
  // else was readable. This block only makes sure the REASON is on screen
  // directly above it.
  ctx.conversionFailures = failed;
  if (failed.length) {
    // STDERR, not stdout. This runs as the workflow's first `exec` step and the
    // engine's blocking comment quotes the step's STDERR only — so the entire
    // conversion report, and this warning with it, was invisible in the console
    // where somebody is trying to work out why a run stopped. A reason nobody
    // can see is not a reason.
    console.error(`⚠  ${failed.length} document(s) could not be converted to markdown, so no stage can read them:`);
    for (const r of failed) console.error(`     ${r.file} — ${r.detail}`);
    console.error(`   Everything else was staged. If that says markitdown-ts is not installed:`);
    console.error(`     cd scyne-chatbot && npm install\n`);
  }
}

/** Sources still sitting on disk that a stage cannot read until they convert. */
async function unconvertedSources(root) {
  const found = [];
  const walk = async (dir, depth) => {
    if (depth > 6) return;
    for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (e.name.startsWith(".")) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        const lower = e.name.toLowerCase();
        if (NOT_SOURCE.has(lower) && lower !== "documents") continue;
        await walk(full, depth + 1);
      } else {
        const ext = path.extname(e.name).toLowerCase();
        if (CONVERTIBLE.has(ext) || PLAIN_TEXT.has(ext)) found.push(rel(full));
      }
    }
  };
  await walk(root, 0);
  return found;
}

/**
 * Refuse a stage that has no readable sources — and say which of the two
 * reasons it is.
 *
 * "Drop documents in projects/<p>/documents/" is the right advice for an empty
 * project and exactly the wrong advice for the case that keeps happening: the
 * documents ARE there, as `.docx`, and the converter that would have made them
 * readable failed. Telling somebody to upload files they are looking at is how
 * a broken dependency reads as an empty project.
 */
async function dieWithNoSources(ctx, why, roots) {
  const failures = ctx.conversionFailures ?? [];
  if (failures.length) {
    die(`${why}\n\n` +
        `  ${failures.length} document(s) FAILED to convert to markdown — that is the reason, not missing files:\n` +
        failures.map((r) => `    ✗ ${r.file} — ${r.detail}`).join("\n") +
        `\n\n  If that says markitdown-ts is not installed:  cd scyne-chatbot && npm install`);
  }
  const pending = (await Promise.all(roots.map(unconvertedSources))).flat();
  if (pending.length) {
    die(`${why}\n\n` +
        `  ${pending.length} source document(s) are on disk but are not markdown:\n` +
        pending.slice(0, 10).map((f) => `    · ${f}`).join("\n") +
        (pending.length > 10 ? `\n    … and ${pending.length - 10} more` : "") +
        `\n\n  Convert them with:  node scripts/convert-to-md.mjs "${ctx.project}"` +
        `\n  (staging does this itself unless --no-convert was passed)`);
  }
  die(`${why}\n  Drop documents in projects/${ctx.project}/documents/ or in a feature's requirements/`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function runStage(key, ctx) {
  const def = STAGES[key];
  const level = def.level;

  // Hard prerequisites.
  const missing = await unmetRequirements(WORKSPACE, key, ctx.project, ctx.feature, ctx.flags);
  if (missing.length) {
    const m = missing[0];
    const target = m.scope === "project" ? ctx.project : `${ctx.project} "${ctx.feature}"`;
    die(
      `${key}: missing required input ${m.scope}:${m.path}\n` +
      `  Run the ${m.from} stage first:  npm run stage ${STAGES[m.from]?.level === LEVEL.PROJECT ? ctx.project : target} ${m.from}` +
      (m.escape ? `\n  Or stage without it:            npm run stage ${target} ${key} -- ${m.escape}` : ""),
    );
  }

  const root = level === LEVEL.PROJECT
    ? projectDir(WORKSPACE, ctx.project)
    : featureDir(WORKSPACE, ctx.project, ctx.feature);
  const work = def.work === "-" ? root : path.join(root, def.work);
  const staged = [];

  await STAGE_FNS[key]({ ...ctx, work, staged, stageKey: key });

  console.log(`\n── ${def.order}. ${def.label}  (${def.agent})   [${level}]`);
  if (def.work !== "-") console.log(`   working folder: ${rel(work)}`);
  console.log("");

  // The project definition is read by every skill straight from its stable
  // path, so it is never copied into a working folder — but a missing one
  // changes the output quality enough to be worth saying out loud.
  const description = path.join(projectDir(WORKSPACE, ctx.project), "description.md");
  console.log((await exists(description))
    ? `   project definition: ${rel(description)}`
    : `   project definition: MISSING — projects/${ctx.project}/description.md\n` +
      `      Every skill reads it for who the client is and what they may do.\n` +
      `      Without it the output falls back to generic industry assumptions.`);
  console.log("");
  for (const line of staged) console.log(`   ${line}`);
  console.log("");

  // Quoted, and EVERY occurrence. These lines exist to be copy-pasted into a
  // shell, and a project called `SA Demo` pasted bare becomes two arguments —
  // the same fault the workflow compiler had, printed as advice. `.replace`
  // also stopped at the first match, which `render-mockups.mjs <project>
  // <feature>` would have hit the moment a template named either one twice.
  const sub = (s) => s
    .replaceAll("<project>", `"${ctx.project}"`)
    .replaceAll("<feature>", `"${ctx.feature ?? ""}"`);
  const scope = level === LEVEL.PROJECT
    ? `project: ${ctx.project}`
    : `project: ${ctx.project}, feature: ${ctx.feature}`;
  console.log(def.skill ? `   Run in a Claude Code session at the workspace root:` : `   Run:`);
  console.log(def.skill ? `   /${def.skill}   ${scope}` : `   ${sub(def.script)}`);
  if (def.then) {
    console.log(`\n   Then verify:`);
    console.log(`   ${sub(def.then)}`);
  }
  // The project has ONE page, and it is progressive: it renders whatever has
  // been produced so far, so it is re-rendered after EVERY stage rather than
  // once at the end.
  if (key !== "app") {
    console.log(`\n   Then update the project's single page:`);
    console.log(`   ${sub(RENDER_CMD)}`);
  }
  console.log("");
}

/**
 * Blob is the source of truth for projects/; this local tree is a cache.
 *
 * Shelled out rather than imported on purpose: the repo root has NO runtime
 * dependencies, and @azure/storage-blob lives only in the plugin's
 * node_modules. A subprocess is the seam that keeps the root install lean.
 *
 * Non-fatal by design, in the ORDINARY case. A developer with no Azurite
 * running must still be able to stage from a local tree — the sync is an
 * enrichment, not a gate — so a failure here only prints a `sync skipped:`
 * line and lets staging carry on from whatever is already on disk.
 *
 * The one case this does NOT swallow: a project that exists nowhere but
 * blob. If the pull fails and there is still no local copy afterwards,
 * staging genuinely cannot proceed — the caller (`main`) checks for exactly
 * that combination and fails loudly, naming the sync error, rather than
 * reporting the generic (and in that case misleading) "no such project".
 */
async function syncDownFromBlob(project) {
  try {
    const out = execFileSync(
      SYNC_TSX, [SYNC_CLI, project, "--down", "--root", WORKSPACE],
      { cwd: path.join(WORKSPACE, "plugins/aws-file-processing"), encoding: "utf8" },
    );
    const r = JSON.parse(out.trim());
    console.log(`  synced: pulled ${r.pulled}, skipped ${r.skipped}`);
    return { ok: true, ...r };
  } catch (e) {
    const message = String(e?.message ?? e).split("\n")[0];
    console.log(`  sync skipped: ${message}`);
    return { ok: false, error: message };
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const flags = new Set(argv.filter((a) => a.startsWith("--")));
  for (const f of flags) if (!KNOWN_FLAGS.includes(f)) die(`unknown flag ${f}\nKnown: ${KNOWN_FLAGS.join(" ")}`);

  const positional = argv.filter((a) => !a.startsWith("--"));
  if (positional.length === 0) return printAllProjects();

  const [project, ...rest] = positional;
  if (!SAFE_NAME.test(project)) die("project name contains unexpected characters");

  // Always work from the authoritative copy: a project that exists only in
  // blob (created or worked on from another machine) must still be staged
  // here. Before the existence check below, deliberately — that check is
  // what would otherwise refuse a project this pull is about to produce.
  const sync = await syncDownFromBlob(project);

  if (!(await exists(projectDir(WORKSPACE, project)))) {
    if (!sync.ok) {
      // The one case sync failure IS fatal: nothing local, and the one place
      // that might have a copy could not be reached either. The generic
      // "no such project" listing below would be actively misleading here —
      // it reads as "this project has never existed", when the truth may be
      // "it exists in blob and this machine could not reach it".
      die(
        `no such project: projects/${project}\n\n` +
        `  This machine could not sync down from blob to check there either:\n` +
        `    ${sync.error}\n\n` +
        `  If the project exists only in blob storage, fix the sync (is Azurite running?) and retry.`,
      );
    }
    const projects = await listProjects(WORKSPACE);
    die(`no such project: projects/${project}\n\nAvailable:\n` + projects.map((p) => `  ${p}`).join("\n"));
  }

  // Resolve the LEVEL before the name. `npm run stage SAPN capabilities` has a
  // single trailing token that names a project stage, so it is a stage — where
  // the old feature-only parser would have read it as a feature name and failed.
  let level = null, feature = null, stageKey = null;

  if (rest.length === 0) return printProjectStatus(project);

  if (rest.length === 1 && (PROJECT_STAGE_KEYS.has(rest[0]) || rest[0] === "all" || rest[0] === "baseline")) {
    level = LEVEL.PROJECT;
    stageKey = rest[0];
  } else {
    const last = rest[rest.length - 1];
    const isStage = rest.length > 1 && (last === "all" || (Object.hasOwn(STAGES, last) && !PROJECT_STAGE_KEYS.has(last)));
    stageKey = isStage ? last : null;
    feature = (isStage ? rest.slice(0, -1) : rest).join(" ");
    level = LEVEL.FEATURE;
    if (!SAFE_NAME.test(feature)) die("feature name contains unexpected characters");
    if (!(await exists(featureDir(WORKSPACE, project, feature)))) {
      const features = await listFeatures(WORKSPACE, project);
      die(`no such feature: projects/${project}/${feature}\n\nAvailable under ${project}:\n` +
          (features.length ? features.map((f) => `  ${f}`).join("\n") : "  (none)"));
    }
    if (!stageKey) return printFeatureStatus(project, feature);
  }

  const ctx = {
    project, feature, level, stageKey,
    featureDir: feature ? featureDir(WORKSPACE, project, feature) : null,
    flags,
    force: flags.has("--force"),
  };

  if (!flags.has("--no-convert")) {
    await convertSources(ctx, { force: ctx.force, keepOriginals: flags.has("--keep-originals") });
  }

  // PROJECT BASELINE — capability map + personas produced in ONE agent pass.
  //
  // They cannot run in parallel: `personas` hard-requires capability-map.json
  // because journey stages align to the L1 lifecycle phases. What this DOES
  // remove is the second agent wake, the second approval gate, and — the real
  // cost — re-reading the same discovery documents a second time. The two
  // working folders stage the SAME 8 source files, so a second agent paid ~45k
  // input tokens to read what the first had already read.
  //
  // Staging happens in two beats because step 3 needs step 1's output on disk.
  if (stageKey === "baseline") {
    await runStage("capabilities", ctx);
    const p = ctx.project;
    console.log(`── PROJECT BASELINE — run these in ONE session, in order\n`);
    console.log(`   1. /capability-process-map`);
    console.log(`   2. node scripts/render-capability-map.mjs "${p}" --validate-only`);
    console.log(`   3. npm run stage "${p}" personas      (needs step 1's output on disk)`);
    console.log(`   4. /persona-journey-map               ← do NOT re-read the discovery`);
    console.log(`                                           documents; they are already in`);
    console.log(`                                           context from step 1`);
    console.log(`   5. node scripts/validate-experience.mjs "${p}"`);
    console.log(`   6. node scripts/render-companion-app.mjs "${p}"   (ONCE — covers both)\n`);
    console.log(`   Then raise ONE approval gate covering both artefacts.\n`);
    return;
  }

  if (stageKey === "all") {
    // Stage everything at this level whose hard prerequisites are already
    // satisfied. A stage that is not ready is reported, not fatal.
    const ran = [];
    for (const [key, def] of ordered(level)) {
      if (def.optional) continue;
      const missing = await unmetRequirements(WORKSPACE, key, project, feature, flags);
      if (missing.length) {
        console.log(`\n── ${def.order}. ${def.label}  — SKIPPED, needs ${missing.map((m) => `${m.scope}:${m.path}`).join(", ")}`);
        continue;
      }
      await runStage(key, ctx);
      ran.push(key);
    }
    console.log(`Staged: ${ran.join(", ") || "nothing"}\n`);
    return;
  }

  if (STAGES[stageKey].level !== level) {
    die(`${stageKey} is a ${STAGES[stageKey].level} stage — ` +
        (STAGES[stageKey].level === LEVEL.PROJECT
          ? `run it as:  npm run stage ${project} ${stageKey}`
          : `it needs a feature:  npm run stage ${project} "<feature>" ${stageKey}`));
  }

  await runStage(stageKey, ctx);
}

// An unexpected throw here is a BUG IN THIS SCRIPT, not something the caller
// did wrong — and an agent that sees a raw stack trace will try to debug it,
// burning a lot of tokens reading tooling that is not its job. Label it plainly
// so the agent reports it and stops.
main().catch((e) => die(
  `INTERNAL ERROR in stage.mjs — this is a bug in the tooling, not in your inputs.\n` +
  `  Do NOT try to fix this script. Report the text below verbatim and stop.\n\n` +
  (e?.stack || String(e)),
));
