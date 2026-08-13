#!/usr/bin/env node
// Stage a feature's inputs into its Data Modeler working folder, so the
// `datamodel-impact-analysis` and `salesforce-data-modeler` skills can be run
// locally in a plain Claude Code session — WITHOUT Paperclip, the chatbot, or
// the Data Modeler agent.
//
//   node scripts/stage-datamodel.mjs <project> <feature> [--from-requirements] [--force]
//
// This replicates exactly what the Data Modeler agent does in its Phase 1 step 2
// (see agent-instructions/data-modeler.json) before it invokes a skill:
//
//   mkdir -p projects/<p>/<f>/solutions/DataModel/{productsummary,datamodel-reference,outputs}
//   cp        projects/<p>/<f>/outputs/product-summary.md  →  productsummary/
//   seed      ./datamodel-reference/*.md                   →  datamodel-reference/   (only if empty)
//
// Idempotent — safe to re-run. The product summary is overwritten (the approved
// summary is the source of truth); a non-empty datamodel-reference/ is left
// alone, because a curated per-feature copy wins over the global catalogue.
//
// --from-requirements  Stage requirements/{SOP,Transcripts,Notes}/**.md instead
//                      of the product summary, for features that have not run
//                      the BA yet. Valid for `salesforce-data-modeler` (which
//                      accepts a BRD/PRD, user stories or a transcript);
//                      `datamodel-impact-analysis` expects an approved summary,
//                      so it is only a fallback there.
// --force              Re-seed datamodel-reference/ even when it already has files.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { convertTree, report as reportConversion } from "./convert-to-md.mjs";

const WORKSPACE = process.env.WORKSPACE_PATH || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SAFE_NAME = /^[A-Za-z0-9._ &-]+$/;

function die(msg) {
  console.error(`[stage-datamodel] ${msg}`);
  process.exit(1);
}

const rel = (p) => path.relative(WORKSPACE, p) || ".";

async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

async function listFeatures() {
  const root = path.join(WORKSPACE, "projects");
  const out = [];
  for (const project of await fs.readdir(root).catch(() => [])) {
    const pdir = path.join(root, project);
    if (!(await fs.stat(pdir).catch(() => null))?.isDirectory()) continue;
    for (const feature of await fs.readdir(pdir).catch(() => [])) {
      if (!(await fs.stat(path.join(pdir, feature)).catch(() => null))?.isDirectory()) continue;
      const hasSummary = await exists(path.join(pdir, feature, "outputs", "product-summary.md"));
      out.push({ project, feature, hasSummary });
    }
  }
  return out;
}

// Every .md under requirements/, excluding templates/ (house-style examples, not content).
async function findRequirementDocs(featureDir) {
  const found = [];
  const walk = async (dir) => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // case-insensitive: the folder is `templates/` in CLAUDE.md but `Templates/` on disk
        if (entry.name.toLowerCase() !== "templates") await walk(full);
      } else if (entry.name.toLowerCase().endsWith(".md")) {
        found.push(full);
      }
    }
  };
  await walk(path.join(featureDir, "requirements"));
  return found.sort();
}

async function main() {
  const argv = process.argv.slice(2);
  const flags = new Set(argv.filter((a) => a.startsWith("--")));
  const [project, ...featureParts] = argv.filter((a) => !a.startsWith("--"));
  const feature = featureParts.join(" ");

  const fromRequirements = flags.has("--from-requirements");
  const force = flags.has("--force");
  const convert = !flags.has("--no-convert");
  for (const f of flags) {
    if (!["--from-requirements", "--force", "--no-convert", "--keep-originals"].includes(f)) die(`unknown flag ${f}`);
  }

  if (!project || !feature) {
    const features = await listFeatures();
    console.error("Usage: node scripts/stage-datamodel.mjs <project> <feature> [--from-requirements] [--force]\n");
    console.error("Available features:");
    for (const f of features) {
      console.error(`  ${f.project} / ${f.feature}${f.hasSummary ? "" : "   (no product-summary.md — needs --from-requirements)"}`);
    }
    process.exit(1);
  }
  if (!SAFE_NAME.test(project) || !SAFE_NAME.test(feature)) die("project/feature contain unexpected characters");

  const featureDir = path.join(WORKSPACE, "projects", project, feature);
  if (!(await exists(featureDir))) {
    const features = await listFeatures();
    die(
      `no such feature: projects/${project}/${feature}\n\nAvailable:\n` +
      features.map((f) => `  ${f.project} / ${f.feature}`).join("\n"),
    );
  }

  const work = path.join(featureDir, "solutions", "DataModel");
  const dirs = {
    productsummary: path.join(work, "productsummary"),
    reference: path.join(work, "datamodel-reference"),
    outputs: path.join(work, "outputs"),
  };
  for (const d of Object.values(dirs)) await fs.mkdir(d, { recursive: true });

  const staged = [];

  // --- step 0: make every source document readable ---------------------------
  // The skills only read .md. Convert .pdf/.docx/.xlsx/.txt in requirements/ to
  // markdown first, so a hand-placed PDF is not silently invisible to the model.
  if (convert) {
    const reqDir = path.join(featureDir, "requirements");
    if (await exists(reqDir)) {
      const results = await convertTree(reqDir, {
        force,
        archiveRoot: flags.has("--keep-originals")
          ? null
          : path.join(featureDir, "original-files", "requirements"),
        onProgress: (f) => console.log(`  converting ${f} …`),
      });
      reportConversion(results, (s) => console.log(s));
      console.log("");
    }
  }

  // --- input 1: the requirements the skill reads -----------------------------
  const summary = path.join(featureDir, "outputs", "product-summary.md");
  if (!fromRequirements) {
    if (!(await exists(summary))) {
      const docs = await findRequirementDocs(featureDir);
      die(
        `no product summary at ${rel(summary)}\n\n` +
        `Run the BA (requirement-generator) first, or re-run with --from-requirements ` +
        `to stage the ${docs.length} raw requirement .md file(s) instead.\n` +
        `(--from-requirements suits salesforce-data-modeler, which accepts a BRD / user ` +
        `stories / transcript. datamodel-impact-analysis expects an approved summary.)`,
      );
    }
    await fs.copyFile(summary, path.join(dirs.productsummary, "product-summary.md"));
    staged.push(`productsummary/product-summary.md  ← outputs/product-summary.md`);
  } else {
    const docs = await findRequirementDocs(featureDir);
    if (docs.length === 0) {
      die(
        `--from-requirements given, but no .md files under ${rel(path.join(featureDir, "requirements"))}\n` +
        `The chatbot converts uploads to .md on the way in; .docx/.pdf sources are not readable by the skills.`,
      );
    }
    for (const doc of docs) {
      await fs.copyFile(doc, path.join(dirs.productsummary, path.basename(doc)));
      staged.push(`productsummary/${path.basename(doc)}  ← ${rel(doc)}`);
    }
  }

  // --- input 2: the reference catalogue (seed only when empty) ---------------
  const existingRefs = (await fs.readdir(dirs.reference).catch(() => [])).filter((f) => f.toLowerCase().endsWith(".md"));
  if (existingRefs.length > 0 && !force) {
    staged.push(`datamodel-reference/  — left alone (${existingRefs.length} curated file(s); --force to re-seed)`);
  } else {
    const globalRefs = (await fs.readdir(path.join(WORKSPACE, "datamodel-reference")).catch(() => []))
      .filter((f) => f.toLowerCase().endsWith(".md"));
    for (const f of globalRefs) {
      await fs.copyFile(path.join(WORKSPACE, "datamodel-reference", f), path.join(dirs.reference, f));
    }
    staged.push(
      globalRefs.length
        ? `datamodel-reference/  ← seeded ${globalRefs.length} file(s) from ./datamodel-reference/`
        : `datamodel-reference/  — EMPTY (no global catalogue found; salesforce-data-modeler falls back to its inlined Appendix A)`,
    );
  }

  // --- report ---------------------------------------------------------------
  console.log(`\n[stage-datamodel] staged ${project} / ${feature}\n`);
  console.log(`  working folder: ${rel(work)}\n`);
  for (const line of staged) console.log(`  ${line}`);

  console.log(`\nNow run either skill in a Claude Code session at the workspace root:\n`);
  console.log(`  /salesforce-data-modeler       project: ${project}, feature: ${feature}`);
  console.log(`    → ${rel(dirs.outputs)}/salesforce-data-model.md`);
  console.log(`  /datamodel-impact-analysis     project: ${project}, feature: ${feature}`);
  console.log(`    → ${rel(dirs.outputs)}/datamodel-impact.md\n`);
  if (fromRequirements) {
    console.log(`  NOTE: staged from raw requirements, not an approved product summary.\n`);
  }
}

main().catch((e) => die(e.stack || String(e)));
