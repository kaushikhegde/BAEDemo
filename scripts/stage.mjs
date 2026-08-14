#!/usr/bin/env node
// Stage a feature's inputs for ANY pipeline stage, so its skill can be run
// locally in a plain Claude Code session — WITHOUT Paperclip, the chatbot, or
// the owning agent.
//
//   node scripts/stage.mjs                                 list every feature + pipeline status
//   node scripts/stage.mjs <project> <feature>             status for one feature
//   node scripts/stage.mjs <project> <feature> <stage>     stage one stage, print its skill command
//   node scripts/stage.mjs <project> <feature> all         stage every stage whose inputs are ready
//
// Each stage replicates exactly what its agent does in Phase 1 step 2 (see
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
import { fileURLToPath } from "node:url";
import { convertTree, report as reportConversion } from "./convert-to-md.mjs";

const WORKSPACE = process.env.WORKSPACE_PATH || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SAFE_NAME = /^[A-Za-z0-9._ &-]+$/;
const KNOWN_FLAGS = ["--force", "--no-convert", "--keep-originals", "--from-requirements"];

// Top-level folders under a feature that are OUTPUT, not source material.
// Never staged as discovery documents, never converted.
const NOT_SOURCE = new Set(["outputs", "solutions", "design", "original-files", "node_modules", ".git"]);

const die = (msg) => {
  console.error(`\n[stage] ${msg}\n`);
  process.exit(1);
};
const rel = (p) => path.relative(WORKSPACE, p) || ".";
const exists = async (p) => {
  try { await fs.access(p); return true; } catch { return false; }
};

// ---------------------------------------------------------------------------
// The pipeline
// ---------------------------------------------------------------------------
// `order` is the sequence the stages are meant to run in. `requires` is a HARD
// prerequisite — staging refuses without it. `enriches` is opportunistic: the
// stage runs regardless, but reads the input when it happens to be there.

// The one page every stage feeds. Rendered after each stage, not once at the end.
const RENDER_CMD = "node scripts/render-companion-app.mjs <project> <feature>";

const STAGES = {
  capabilities: {
    order: 1,
    label: "Capability & Process Map",
    agent: "Capabilities Process Architect",
    skill: "capability-process-map",
    work: "solutions/Capabilities",
    // `produces` paths are relative to the FEATURE directory, not to `work` —
    // stageIsDone resolves them against the feature root, and it is also what
    // decides whether a later stage reports this one's output as an available
    // input. A path relative to `work` silently reports "never run".
    produces: [
      "solutions/Capabilities/outputs/capability-process.md",
      "solutions/Capabilities/outputs/capability-map.json",
      "solutions/Capabilities/outputs/process-model.json",
    ],
    requires: [],
    then: "node scripts/render-capability-map.mjs <project> <feature> --validate-only",
    stage: stageCapabilities,
  },
  personas: {
    order: 2,
    label: "Personas & Journey Map",
    agent: "Service Designer",
    skill: "persona-journey-map",
    work: "solutions/Experience",
    produces: [
      "solutions/Experience/outputs/personas-journeys.md",
      "solutions/Experience/outputs/personas.json",
      "solutions/Experience/outputs/journey-map.json",
    ],
    requires: [],
    then: "node scripts/validate-experience.mjs <project> <feature>",
    stage: stagePersonas,
  },
  requirements: {
    order: 3,
    label: "Requirements & Product Summary",
    agent: "BA",
    skill: "requirement-generator",
    work: "requirements",
    produces: ["outputs/product-summary.md", "outputs/stories.json"],
    requires: [],
    stage: stageRequirements,
  },
  datamodel: {
    order: 4,
    label: "Salesforce Data Model",
    agent: "Data Modeler",
    skill: "salesforce-data-modeler",
    work: "solutions/DataModel",
    produces: ["solutions/DataModel/outputs/salesforce-data-model.md"],
    requires: [{ path: "outputs/product-summary.md", from: "requirements", escape: "--from-requirements" }],
    stage: stageDataModel,
  },
  design: {
    order: 4.5,
    optional: true,
    label: "Solution Design (optional side stage)",
    agent: "Architecture Lead",
    skill: "solution-design-document",
    work: "solutions/Design",
    produces: ["solutions/Design/outputs/solution-design.md"],
    requires: [{ path: "outputs/product-summary.md", from: "requirements" }],
    stage: stageDesign,
  },
  architecture: {
    order: 5,
    label: "Solution Architecture",
    agent: "Solution Architect",
    skill: "salesforce-service-cloud-architecture",
    work: "solutions/Architecture",
    produces: ["solutions/Architecture/outputs/solution-architecture.md"],
    requires: [{ path: "outputs/product-summary.md", from: "requirements" }],
    stage: stageArchitecture,
  },
  qa: {
    order: 6,
    label: "Test Cases",
    agent: "QA Architect",
    skill: "requirements-test-case-generator",
    work: "solutions/QA",
    produces: ["solutions/QA/outputs/test-cases.md"],
    requires: [{ path: "outputs/product-summary.md", from: "requirements" }],
    stage: stageQA,
  },
  ui: {
    order: 6.5,
    label: "UI Mockups",
    agent: "UX Designer",
    skill: "ui-mockup-generator",
    work: "solutions/UI",
    produces: ["solutions/UI/outputs/mockups.json"],
    requires: [{ path: "outputs/product-summary.md", from: "requirements" }],
    then: "node scripts/render-mockups.mjs <project> <feature>",
    stage: stageUI,
  },
  app: {
    order: 7,
    label: "Companion App",
    agent: "Developer",
    script: "node scripts/render-companion-app.mjs <project> <feature>",
    work: "-",
    produces: [],
    // The only stage whose output lands outside the feature directory.
    producesInWorkspace: ["generated-apps/<key>/index.html"],
    requires: [],
    stage: stageApp,
  },
};

const ORDERED = Object.entries(STAGES).sort((a, b) => a[1].order - b[1].order);

// ---------------------------------------------------------------------------
// Helpers shared by the stage functions
// ---------------------------------------------------------------------------

// Every .md under the feature that is SOURCE material, tagged with the folder
// it came from. That category becomes the skill's source tag, so it is
// preserved exactly. `templates/` holds house-style examples, not content.
async function findDocs(featureDir, { skipTemplates = true } = {}) {
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
        const category = path.dirname(full) === featureDir ? "root" : path.basename(path.dirname(full));
        out.push({ file: full, category });
      }
    }
  };
  await walk(featureDir, 0);
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
  const dest = path.join(destDir, path.basename(src));
  await fs.copyFile(src, dest);
  staged.push(`${labelDir}/${path.basename(src)}  ← ${rel(src)}`);
}

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

// Copy the discovery documents into documents/<category>/, preserving the tag.
async function copyDocsByCategory(docs, documentsDir, staged) {
  const byCategory = new Map();
  for (const d of docs) {
    if (!byCategory.has(d.category)) byCategory.set(d.category, []);
    byCategory.get(d.category).push(d.file);
  }
  for (const [category, files] of [...byCategory].sort()) {
    const destDir = path.join(documentsDir, category);
    await fs.mkdir(destDir, { recursive: true });
    for (const f of files) await fs.copyFile(f, path.join(destDir, path.basename(f)));
    staged.push(`documents/${category}/  ← ${files.length} file(s)`);
  }
}

// ---------------------------------------------------------------------------
// Stage functions — each mirrors its agent's Phase 1 step 2
// ---------------------------------------------------------------------------

async function stageCapabilities(ctx) {
  const { featureDir, work, staged, force } = ctx;
  const dirs = await mkdirs(work, ["documents", "capability-reference", "outputs"]);

  const docs = await findDocs(featureDir, { skipTemplates: true });
  if (docs.length === 0) die(`no .md source documents under ${rel(featureDir)} — nothing for the capability map to read`);
  await copyDocsByCategory(docs, dirs.documents, staged);

  // The product summary is one more source when it exists — never a gate.
  const summary = path.join(featureDir, "outputs", "product-summary.md");
  if (await exists(summary)) await copyOne(summary, path.join(dirs.documents, "product-summary"), staged, "documents/product-summary");

  const refs = (await fs.readdir(dirs["capability-reference"]).catch(() => [])).filter((f) => f.toLowerCase().endsWith(".md"));
  staged.push(
    refs.length && !force
      ? `capability-reference/  — left alone (${refs.length} curated file(s))`
      : `capability-reference/  — empty (optional: drop a house capability taxonomy here)`,
  );
}

async function stagePersonas(ctx) {
  const { featureDir, work, staged } = ctx;
  const dirs = await mkdirs(work, ["documents", "productsummary", "capabilities", "outputs"]);

  const docs = await findDocs(featureDir, { skipTemplates: true });
  if (docs.length === 0) die(`no .md source documents under ${rel(featureDir)} — personas must be evidenced, not invented`);
  await copyDocsByCategory(docs, dirs.documents, staged);

  const summary = path.join(featureDir, "outputs", "product-summary.md");
  if (await exists(summary)) await copyOne(summary, dirs.productsummary, staged, "productsummary");
  else staged.push(`productsummary/  — no product summary yet (optional; this stage is not gated on it)`);

  // Capability model aligns journey stages to the L1 lifecycle phases.
  const capOut = path.join(featureDir, "solutions", "Capabilities", "outputs");
  let copied = 0;
  for (const f of ["capability-process.md", "process-model.json", "capability-map.json"]) {
    const src = path.join(capOut, f);
    if (await exists(src)) { await fs.copyFile(src, path.join(dirs.capabilities, f)); copied++; }
  }
  staged.push(copied ? `capabilities/  ← ${copied} file(s) from the capability map` : `capabilities/  — capability map not run yet (optional)`);
}

async function stageRequirements(ctx) {
  const { featureDir, staged } = ctx;
  // The BA reads requirements/{SOP,Transcripts,Notes,UI}/ in place — there is no
  // working folder to populate. Staging here is the conversion pass plus a
  // readiness check, so a missing input surfaces now rather than mid-skill.
  await fs.mkdir(path.join(featureDir, "outputs"), { recursive: true });
  const reqDir = path.join(featureDir, "requirements");
  if (!(await exists(reqDir))) die(`no requirements/ folder at ${rel(reqDir)}`);

  for (const sub of ["SOP", "Transcripts", "Notes", "UI"]) {
    const dir = path.join(reqDir, sub);
    const files = (await fs.readdir(dir).catch(() => [])).filter((f) => !f.startsWith("."));
    staged.push(`requirements/${sub}/  — ${files.length} file(s)${files.length ? "" : "  (empty)"}`);
  }
  const docs = await findDocs(featureDir);
  if (docs.length === 0) die(`no .md files under ${rel(reqDir)} — the BA has nothing to read`);

  // Templates are the house style for THIS project and override ./examples/.
  for (const t of ["templates", "Templates"]) {
    const dir = path.join(reqDir, t);
    const files = (await fs.readdir(dir).catch(() => [])).filter((f) => !f.startsWith("."));
    if (files.length) staged.push(`requirements/${t}/  — ${files.length} house-style template(s) (override ./examples/)`);
  }
}

async function stageDataModel(ctx) {
  const { featureDir, work, staged, force, flags } = ctx;
  const dirs = await mkdirs(work, ["productsummary", "datamodel-reference", "outputs"]);

  if (flags.has("--from-requirements")) {
    const docs = await findDocs(featureDir, { skipTemplates: true });
    if (docs.length === 0) die(`--from-requirements given, but no .md files under ${rel(featureDir)}`);
    for (const d of docs) await fs.copyFile(d.file, path.join(dirs.productsummary, path.basename(d.file)));
    staged.push(`productsummary/  ← ${docs.length} raw requirement file(s) (no approved summary)`);
  } else {
    await copyOne(path.join(featureDir, "outputs", "product-summary.md"), dirs.productsummary, staged, "productsummary");
    const stories = path.join(featureDir, "outputs", "stories.md");
    if (await exists(stories)) await copyOne(stories, dirs.productsummary, staged, "productsummary");
  }

  // A curated per-feature catalogue wins over the global one.
  const existing = (await fs.readdir(dirs["datamodel-reference"]).catch(() => [])).filter((f) => f.toLowerCase().endsWith(".md"));
  if (existing.length && !force) {
    staged.push(`datamodel-reference/  — left alone (${existing.length} curated file(s); --force to re-seed)`);
  } else {
    const n = await copyMdTree(path.join(WORKSPACE, "datamodel-reference"), dirs["datamodel-reference"], staged, "datamodel-reference");
    if (n === 0) staged.push(`datamodel-reference/  — empty (the skill falls back to its inlined Appendix A)`);
  }
}

async function stageDesign(ctx) {
  const { featureDir, work, staged } = ctx;
  const dirs = await mkdirs(work, ["productsummary", "DataModel", "outputs"]);
  await copyOne(path.join(featureDir, "outputs", "product-summary.md"), dirs.productsummary, staged, "productsummary");
  await copyMdTree(path.join(featureDir, "solutions", "DataModel", "outputs"), dirs.DataModel, staged, "DataModel", {
    note: "data model not run yet (run the datamodel stage first for a grounded design)",
  });
}

async function stageArchitecture(ctx) {
  const { featureDir, work, staged } = ctx;
  const dirs = await mkdirs(work, ["productsummary", "DataModel", "landscape", "outputs"]);

  await copyOne(path.join(featureDir, "outputs", "product-summary.md"), dirs.productsummary, staged, "productsummary");
  const stories = path.join(featureDir, "outputs", "stories.md");
  if (await exists(stories)) await copyOne(stories, dirs.productsummary, staged, "productsummary");

  await copyMdTree(path.join(featureDir, "solutions", "DataModel", "outputs"), dirs.DataModel, staged, "DataModel", {
    note: "data model not run yet (optional — the skill designs against requirement entities and records the dependency)",
  });

  // Capability + process model give the architecture its capability-to-component map.
  const capOut = path.join(featureDir, "solutions", "Capabilities", "outputs");
  const cap = path.join(capOut, "capability-process.md");
  if (await exists(cap)) await copyOne(cap, dirs.landscape, staged, "landscape");

  // Current-state / integration documents live in Notes when they exist at all.
  const notes = path.join(featureDir, "requirements", "Notes");
  const landscapeHits = (await fs.readdir(notes).catch(() => []))
    .filter((f) => f.toLowerCase().endsWith(".md") && /current.?state|integration|landscape|architect|system/i.test(f));
  for (const f of landscapeHits) await copyOne(path.join(notes, f), dirs.landscape, staged, "landscape");
  if (!landscapeHits.length && !(await exists(cap))) staged.push(`landscape/  — empty (optional current-state / integration docs)`);
}

async function stageQA(ctx) {
  const { featureDir, work, staged } = ctx;
  const dirs = await mkdirs(work, ["productsummary", "DataModel", "Architecture", "outputs"]);

  await copyOne(path.join(featureDir, "outputs", "product-summary.md"), dirs.productsummary, staged, "productsummary");
  // Acceptance criteria are the highest-value input to a test pack.
  for (const f of ["stories.md", "stories.json"]) {
    const src = path.join(featureDir, "outputs", f);
    if (await exists(src)) await copyOne(src, dirs.productsummary, staged, "productsummary");
  }

  await copyMdTree(path.join(featureDir, "solutions", "DataModel", "outputs"), dirs.DataModel, staged, "DataModel", {
    note: "data model not run yet (optional — field types and picklists are what make boundary cases concrete)",
  });

  // Either or both may exist: the Solution Architect and Architecture Lead
  // produce different documents, and the pack reads whichever are there.
  const a = await copyMdTree(path.join(featureDir, "solutions", "Architecture", "outputs"), dirs.Architecture, staged, "Architecture");
  const d = await copyMdTree(path.join(featureDir, "solutions", "Design", "outputs"), dirs.Architecture, staged, "Architecture");
  if (a + d === 0) staged.push(`Architecture/  — neither architecture nor design run yet (optional)`);
}


// The mockup generator reads more inputs than any other stage: the discovery
// documents for real terminology, personas and journeys for who and when,
// capabilities for what it realises, the product summary for the stories, the
// data model for field names, architecture for the surface, and the test cases
// for the states a screen must be able to show.
async function stageUI(ctx) {
  const { featureDir, work, staged } = ctx;
  const dirs = await mkdirs(work, ["documents", "personas", "capabilities", "productsummary", "DataModel", "Architecture", "QA", "outputs"]);

  const docs = await findDocs(featureDir, { skipTemplates: true });
  if (docs.length) await copyDocsByCategory(docs, dirs.documents, staged);

  const copyIf = async (src, destDir, label) => {
    if (await exists(src)) await copyOne(src, destDir, staged, label);
  };
  const copyDirMd = async (dir, destDir, label) => {
    for (const f of (await fs.readdir(dir).catch(() => []))) {
      if (f.toLowerCase().endsWith(".md") || f.toLowerCase().endsWith(".json")) {
        await copyOne(path.join(dir, f), destDir, staged, label);
      }
    }
  };

  await copyIf(path.join(featureDir, "solutions", "Experience", "outputs", "personas.json"), dirs.personas, "personas");
  await copyIf(path.join(featureDir, "solutions", "Experience", "outputs", "journey-map.json"), dirs.personas, "personas");
  await copyIf(path.join(featureDir, "solutions", "Capabilities", "outputs", "capability-map.json"), dirs.capabilities, "capabilities");
  await copyIf(path.join(featureDir, "solutions", "Capabilities", "outputs", "process-model.json"), dirs.capabilities, "capabilities");
  await copyIf(path.join(featureDir, "outputs", "product-summary.md"), dirs.productsummary, "productsummary");
  await copyIf(path.join(featureDir, "outputs", "stories.md"), dirs.productsummary, "productsummary");
  await copyDirMd(path.join(featureDir, "outputs", "product-summaries"), dirs.productsummary, "productsummary");
  await copyDirMd(path.join(featureDir, "solutions", "DataModel", "outputs"), dirs.DataModel, "DataModel");
  await copyDirMd(path.join(featureDir, "solutions", "Architecture", "outputs"), dirs.Architecture, "Architecture");
  await copyIf(path.join(featureDir, "solutions", "QA", "outputs", "test-cases.md"), dirs.QA, "QA");
  await copyDirMd(path.join(featureDir, "solutions", "QA", "outputs", "test-cases"), dirs.QA, "QA");

  const supplied = (await fs.readdir(path.join(featureDir, "requirements", "UI")).catch(() => []));
  staged.push(supplied.length
    ? `requirements/UI/  — ${supplied.length} supplied mockup(s): reflect these rather than inventing a layout`
    : `requirements/UI/  — empty (no client designs supplied; the skill designs from requirements)`);
}

async function stageApp(ctx) {
  const { featureDir, staged } = ctx;
  // Nothing to copy: the renderer reads the feature's artefacts in place.
  // Report what it will find, so a missing perspective is visible before the render.
  for (const [key, def] of ORDERED) {
    if (key === "app") continue;
    const done = await stageIsDone(featureDir, def);
    staged.push(`${done ? "included" : "MISSING "}  ${def.label}`);
  }
  const theme = path.join(featureDir, "design", "style-guides", "theme.json");
  staged.push(
    (await exists(theme))
      ? `branding   design/style-guides/theme.json`
      : `branding   default Scyne palette (run: node scripts/extract-brand.mjs <url> ${ctx.project} "${ctx.feature}")`,
  );
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

// `project`/`feature` are only needed for the app stage, whose output lands in
// generated-apps/ rather than under the feature. Callers that only have the
// feature directory can omit them; the app row then reports not-run, which is
// what the staging report wants anyway (it lists feature inputs).
async function stageIsDone(featureDir, def, project, feature) {
  const outside = def.producesInWorkspace ?? [];
  if (!def.produces.length && !outside.length) return false;
  for (const p of def.produces) {
    if (!(await exists(path.join(featureDir, p)))) return false;
  }
  if (outside.length) {
    if (!project || !feature) return false;
    for (const p of outside) {
      const resolved = p.replace("<key>", `${project}-${feature}`);
      if (!(await exists(path.join(WORKSPACE, resolved)))) return false;
    }
  }
  return true;
}

async function featureStatus(featureDir, project, feature) {
  const rows = [];
  for (const [key, def] of ORDERED) {
    rows.push({ key, def, done: await stageIsDone(featureDir, def, project, feature) });
  }
  return rows;
}

async function listFeatures() {
  const root = path.join(WORKSPACE, "projects");
  const out = [];
  for (const project of (await fs.readdir(root).catch(() => [])).sort()) {
    const pdir = path.join(root, project);
    if (!(await fs.stat(pdir).catch(() => null))?.isDirectory()) continue;
    for (const feature of (await fs.readdir(pdir).catch(() => [])).sort()) {
      const fdir = path.join(pdir, feature);
      if (!(await fs.stat(fdir).catch(() => null))?.isDirectory()) continue;
      out.push({ project, feature, dir: fdir });
    }
  }
  return out;
}

async function printAllFeatures() {
  const features = await listFeatures();
  console.log(`\nUsage: npm run stage <project> <feature> <stage>\n`);
  console.log(`Stages, in pipeline order:\n`);
  for (const [key, def] of ORDERED) {
    console.log(`  ${key.padEnd(14)}${def.label}${def.optional ? "" : ""}`);
  }
  console.log(`  ${"all".padEnd(14)}every stage whose inputs are ready\n`);
  if (!features.length) return console.log(`No features found under projects/.\n`);

  console.log(`Features (${"·".repeat(1)} = not run, ${"✓"} = produced its output):\n`);
  const head = ORDERED.map(([k]) => k.slice(0, 4).padEnd(4)).join(" ");
  console.log(`  ${"".padEnd(38)}${head}`);
  for (const f of features) {
    const rows = await featureStatus(f.dir, f.project, f.feature);
    const marks = rows.map((r) => (r.done ? "  ✓ " : "  · ").padEnd(5)).join("").trimEnd();
    console.log(`  ${`${f.project} / ${f.feature}`.padEnd(38)}${marks}`);
  }
  console.log("");
}

async function printFeatureStatus(project, feature, featureDir) {
  const rows = await featureStatus(featureDir, project, feature);
  console.log(`\n${project} / ${feature}\n`);
  for (const { key, def, done } of rows) {
    const mark = done ? "✓" : def.optional ? "·" : "·";
    console.log(`  ${mark} ${key.padEnd(14)}${def.label}`);
  }
  const next = rows.find((r) => !r.done && !r.def.optional && r.key !== "app");
  const appBuilt = rows.find((r) => r.key === "app")?.done;
  if (next) {
    console.log(`\nNext:  npm run stage ${project} "${feature}" ${next.key}\n`);
  } else if (!appBuilt) {
    console.log(`\nEvery stage has run. Build the companion app:\n  npm run stage ${project} "${feature}" app\n`);
  } else {
    // The page is progressive, so it is only current as of the last render —
    // re-rendering is cheap and idempotent, so always offer it.
    console.log(`\nEvery stage has run and the companion app is built.\nRe-render it to pick up any later edit:\n  ${RENDER_CMD.replace("<project>", project).replace("<feature>", `"${feature}"`)}\n`);
  }
}

// ---------------------------------------------------------------------------
// Conversion — make every source document readable before staging
// ---------------------------------------------------------------------------

async function convertSources(featureDir, { force, keepOriginals }) {
  // The skills only read .md. Convert .pdf/.docx/.xlsx/.txt in every source
  // tree first, so a hand-placed PDF is not silently invisible to the model.
  let any = false;
  for (const entry of await fs.readdir(featureDir, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory() || NOT_SOURCE.has(entry.name.toLowerCase())) continue;
    const results = await convertTree(path.join(featureDir, entry.name), {
      force,
      archiveRoot: keepOriginals ? null : path.join(featureDir, "original-files", entry.name),
      onProgress: (f) => console.log(`  converting ${f} …`),
    });
    if (results.length) { reportConversion(results, (s) => console.log(s)); any = true; }
  }
  if (any) console.log("");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function runStage(key, ctx) {
  const def = STAGES[key];
  const featureDir = ctx.featureDir;

  // Hard prerequisites.
  for (const req of def.requires || []) {
    if (await exists(path.join(featureDir, req.path))) continue;
    if (req.escape && ctx.flags.has(req.escape)) continue;
    die(
      `${key}: missing required input ${req.path}\n` +
      `  Run the ${req.from} stage first:  npm run stage ${ctx.project} "${ctx.feature}" ${req.from}` +
      (req.escape ? `\n  Or stage without it:            npm run stage ${ctx.project} "${ctx.feature}" ${key} -- ${req.escape}` : ""),
    );
  }

  const staged = [];
  const work = def.work === "-" ? featureDir : path.join(featureDir, def.work);

  // The project definition is read by every skill straight from its stable
  // path, so it is never copied into a working folder — but a missing one
  // changes the output quality enough to be worth saying out loud.
  const description = path.join(WORKSPACE, "projects", ctx.project, "description.md");
  const hasDescription = await exists(description);

  await def.stage({ ...ctx, work, staged });

  console.log(`\n── ${def.order}. ${def.label}  (${def.agent})`);
  if (def.work !== "-") console.log(`   working folder: ${rel(work)}`);
  console.log("");
  console.log(hasDescription
    ? `   project definition: ${rel(description)}`
    : `   project definition: MISSING — projects/${ctx.project}/description.md\n` +
      `      Every skill reads it for who the client is and what they may do.\n` +
      `      Without it the output falls back to generic industry assumptions.`);
  console.log("");
  for (const line of staged) console.log(`   ${line}`);
  console.log("");

  const cmd = def.skill
    ? `   /${def.skill}   project: ${ctx.project}, feature: ${ctx.feature}`
    : `   ${def.script.replace("<project>", ctx.project).replace("<feature>", `"${ctx.feature}"`)}`;
  console.log(def.skill ? `   Run in a Claude Code session at the workspace root:` : `   Run:`);
  console.log(cmd);
  if (def.then) {
    console.log(`\n   Then verify:`);
    console.log(`   ${def.then.replace("<project>", ctx.project).replace("<feature>", `"${ctx.feature}"`)}`);
  }
  // The feature has ONE page, and it is progressive: it renders whatever the
  // feature has produced so far, so it is re-rendered after EVERY stage rather
  // than once at the end. Skipping this is why a feature's page can show a
  // stage that ran hours ago and miss the one that just finished.
  if (key !== "app") {
    console.log(`\n   Then update the feature's single page:`);
    console.log(`   ${RENDER_CMD.replace("<project>", ctx.project).replace("<feature>", `"${ctx.feature}"`)}`);
  }
  console.log("");
}

async function main() {
  const argv = process.argv.slice(2);
  const flags = new Set(argv.filter((a) => a.startsWith("--")));
  for (const f of flags) if (!KNOWN_FLAGS.includes(f)) die(`unknown flag ${f}\nKnown: ${KNOWN_FLAGS.join(" ")}`);

  const positional = argv.filter((a) => !a.startsWith("--"));
  if (positional.length === 0) return printAllFeatures();

  // <project> <feature...> [stage] — the feature name may contain spaces, so the
  // stage is only the last token when it names a real stage.
  const [project, ...rest] = positional;
  const last = rest[rest.length - 1];
  const isStage = rest.length > 1 && (last === "all" || Object.hasOwn(STAGES, last));
  const stageKey = isStage ? last : null;
  const feature = (isStage ? rest.slice(0, -1) : rest).join(" ");

  if (!feature) return printAllFeatures();
  if (!SAFE_NAME.test(project) || !SAFE_NAME.test(feature)) die("project/feature contain unexpected characters");

  const featureDir = path.join(WORKSPACE, "projects", project, feature);
  if (!(await exists(featureDir))) {
    const features = await listFeatures();
    die(
      `no such feature: projects/${project}/${feature}\n\nAvailable:\n` +
      features.map((f) => `  ${f.project} / ${f.feature}`).join("\n"),
    );
  }

  if (!stageKey) return printFeatureStatus(project, feature, featureDir);

  const ctx = {
    project, feature, featureDir, flags,
    force: flags.has("--force"),
  };

  if (!flags.has("--no-convert")) {
    await convertSources(featureDir, { force: ctx.force, keepOriginals: flags.has("--keep-originals") });
  }

  if (stageKey === "all") {
    // Stage everything whose hard prerequisites are already satisfied. A stage
    // that is not ready is reported, not fatal — the point of `all` is to get
    // as far as the feature's artefacts allow in one pass.
    const ran = [];
    for (const [key, def] of ORDERED) {
      if (def.optional) continue;
      const missing = [];
      for (const req of def.requires || []) {
        if (!(await exists(path.join(featureDir, req.path)))) missing.push(req.path);
      }
      if (missing.length) {
        console.log(`\n── ${def.order}. ${def.label}  — SKIPPED, needs ${missing.join(", ")}`);
        continue;
      }
      await runStage(key, ctx);
      ran.push(key);
    }
    console.log(`Staged: ${ran.join(", ") || "nothing"}\n`);
    return;
  }

  await runStage(stageKey, ctx);
}

main().catch((e) => die(e.stack || String(e)));
