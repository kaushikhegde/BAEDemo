#!/usr/bin/env node
// Convert a feature's requirement documents to markdown, in place.
//
//   node scripts/convert-to-md.mjs <project> <feature> [--force] [--keep-originals]
//
// The skills only read `.md` — a `.docx` is unreadable to Claude Code entirely,
// and a `.pdf` reads far worse than clean markdown. The chatbot already does this
// on upload (scyne-chatbot/server/services/toMarkdown.ts on task/dockerize); this
// is the same conversion, ported for files that were hand-placed on disk and so
// never went through an upload route.
//
// Same end state as the upload route: the markdown replaces the source in
// requirements/, and the ORIGINAL is moved out of the way, never deleted —
//
//   requirements/Notes/Conceptual Data Model.md                  ← what agents read
//   original-files/requirements/Notes/Conceptual Data Model.pdf  ← archived source
//
// Two engines, both plain npm packages: markitdown-ts (pure JS — mammoth /
// pdf-parse / xlsx / turndown) for Word, PDF, Excel, HTML and notebooks, and
// @firecrawl/anydoc (a prebuilt native addon) for everything it cannot read —
// PowerPoint above all. Neither needs Python, and neither sends a document
// anywhere: both parse in-process.
//
// --keep-originals leaves the source beside its markdown instead of archiving.

import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
// pathToFileURL rather than a `file://${entry}` template: it is the correct
// encoding for a path with spaces in it, and a bundler statically analysing
// this file can see a call it cannot see through a template literal.
import { pathToFileURL } from "node:url";
import { INSTALL_ROOT, WORK_ROOT } from "./lib/roots.mjs";
import { csvToMarkdown } from "./lib/csv-to-markdown.mjs";

// The project tree this run operates on. See scripts/lib/roots.mjs for why
// this is not the same question as "where does this code live".
const WORKSPACE = WORK_ROOT;

// markitdown-ts lives in the chatbot's node_modules; resolve from there so the
// root install stays lean and the two paths can never use different versions.
//
// INSTALL_ROOT, deliberately, not WORKSPACE: the converter ships with this
// code, whereas WORKSPACE is the project tree — which, once a run materialises
// one, is a temporary directory holding documents and no node_modules at all.
// Resolving this against WORKSPACE threw there, with an error about a missing
// package rather than about the wrong root.
async function loadMarkItDown() {
  const require = createRequire(path.join(INSTALL_ROOT, "scyne-chatbot", "package.json"));
  let entry;
  try {
    entry = require.resolve("markitdown-ts");
  } catch {
    throw new Error(
      "markitdown-ts is not installed.\n" +
      "  cd scyne-chatbot && npm install markitdown-ts@^0.0.10",
    );
  }
  const mod = await import(pathToFileURL(entry).href);
  const MarkItDown = mod.MarkItDown ?? mod.default?.MarkItDown;
  if (!MarkItDown) throw new Error(`markitdown-ts loaded from ${entry} but exports no MarkItDown`);
  return MarkItDown;
}

// anydoc is a NAPI-RS addon: one prebuilt binary per platform and no runtime
// dependencies of its own. Resolved from the chatbot's node_modules for exactly
// the reasons given above loadMarkItDown — same install, same INSTALL_ROOT.
async function loadAnydoc() {
  const require = createRequire(path.join(INSTALL_ROOT, "scyne-chatbot", "package.json"));
  let entry;
  try {
    entry = require.resolve("@firecrawl/anydoc");
  } catch {
    throw new Error(
      "@firecrawl/anydoc is not installed.\n" +
      "  cd scyne-chatbot && npm install --save-exact @firecrawl/anydoc@0.2.3",
    );
  }
  const mod = await import(pathToFileURL(entry).href);
  const toMarkdown = mod.toMarkdown ?? mod.default?.toMarkdown;
  if (!toMarkdown) throw new Error(`@firecrawl/anydoc loaded from ${entry} but exports no toMarkdown`);
  return toMarkdown;
}

/**
 * Formats markitdown-ts cannot read, routed to @firecrawl/anydoc instead.
 *
 * PowerPoint is what prompted this: markitdown-ts lists it unchecked and
 * carries no pptx dependency, so a deck uploaded to a project converted to
 * nothing, counted as neither readable nor convertible, and every stage read
 * straight past it — while the Docs tab said "not converted … yet".
 *
 * Taken as anydoc's own documented table rather than a hand-picked subset, so
 * which engine owns what cannot drift by judgement call. The formats BOTH can
 * read stay with markitdown-ts: moving them would change the output of every
 * conversion this repo has already done.
 */
const NATIVE_FORMATS = new Set([
  ".pptx", ".ppt", ".pptm", ".ppsx", ".pps", ".pot", ".ppsm",   // PowerPoint
  ".odt", ".ods", ".odp",                                       // OpenDocument
  ".xls", ".xlsm", ".xlsb", ".docm",                            // older Office
  ".rtf", ".epub",
]);

/** Rendered here rather than by a native addon — see lib/csv-to-markdown.mjs. */
const CSV_FORMATS = new Set([".csv"]);

/**
 * Extensions worth converting. Deliberately EXCLUDED even though the libraries
 * handle some of them:
 *   - .png/.jpg/.jpeg — UI mockups. Agents read screens as images; a markdown
 *     rendering of a screenshot loses the whole point.
 *   - .mp3/.wav — audio has a better path (Gemini transcription).
 */
export const CONVERTIBLE = new Set([
  ".docx", ".doc", ".pdf", ".xlsx", ".html", ".htm", ".xml", ".ipynb",   // markitdown-ts
  ...NATIVE_FORMATS,                                                     // anydoc
  ...CSV_FORMATS,                                                        // built in
]);
/** Already text, but not `.md` — copied across verbatim under a `.md` name. */
export const PLAIN_TEXT = new Set([".txt"]);
export const ALREADY_MD = new Set([".md", ".markdown"]);

/**
 * Everything a stage will be able to read once step 0 has run — the markdown
 * that is already there, plus every source the converter turns INTO markdown.
 *
 * Exported because the chatbot's 409 gates ask "does this have documents?" and
 * were answering it by counting `.md` alone. `stage.mjs` converts as its FIRST
 * step, so a `.docx` is a document; refusing the run is what stopped it ever
 * reaching the converter that would have made it readable.
 */
export const READABLE_AFTER_CONVERSION = new Set([...ALREADY_MD, ...CONVERTIBLE, ...PLAIN_TEXT]);

const MARKER = "<!-- Converted from";

const header = (src, how) => `<!-- Converted from ${src} by ${how}. Regenerate with scripts/convert-to-md.mjs. -->\n\n`;

/**
 * Pick a `.md` path that will not clobber a hand-written file.
 * `foo.pdf` → `foo.md`, unless a foreign `foo.md` already exists, in which case
 * `foo.pdf.md` — losing someone's markdown to a conversion is unacceptable.
 */
async function resolveTarget(dir, base, ext) {
  const preferred = path.join(dir, `${base}.md`);
  try {
    const existing = await fs.readFile(preferred, "utf8");
    if (existing.startsWith(MARKER)) return { target: preferred, ours: true };
    return { target: path.join(dir, `${base}${ext}.md`), ours: false };
  } catch {
    return { target: preferred, ours: true };
  }
}

/**
 * Walk `root`, convert every convertible document to a sibling `.md`.
 * Returns one result row per file considered.
 */
export async function convertTree(root, opts = {}) {
  const { force = false, archiveRoot = null, onProgress = () => {} } = opts;
  const results = [];
  let MarkItDown = null;
  let toMarkdownNative = null;

  const walk = async (dir) => {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (entry.name.startsWith(".")) continue;

      const ext = path.extname(entry.name).toLowerCase();
      const base = path.basename(entry.name, path.extname(entry.name));
      const relPath = path.relative(WORKSPACE, full);

      if (ALREADY_MD.has(ext)) {
        results.push({ file: relPath, status: "already-md" });
        continue;
      }
      const isPlain = PLAIN_TEXT.has(ext);
      if (!isPlain && !CONVERTIBLE.has(ext)) {
        results.push({ file: relPath, status: "skipped", detail: ext || "no extension" });
        continue;
      }

      const { target, ours } = await resolveTarget(dir, base, ext);
      const targetRel = path.relative(WORKSPACE, target);

      // Move the source out of requirements/ once its markdown exists. Never
      // deletes — a rename into original-files/, mirroring the upload route.
      const archive = async (row) => {
        if (!archiveRoot) return row;
        const archiveDir = path.join(archiveRoot, path.relative(root, dir));
        await fs.mkdir(archiveDir, { recursive: true });
        const dest = path.join(archiveDir, entry.name);
        await fs.rename(full, dest);
        row.archived = path.relative(WORKSPACE, dest);
        return row;
      };

      if (!force) {
        const already = await fs.readFile(target, "utf8").catch(() => null);
        if (already !== null && ours) {
          // Markdown is current, but the source may still be sitting beside it
          // (converted before archiving was the default) — archive it now.
          results.push(await archive({ file: relPath, status: "up-to-date", target: targetRel }));
          continue;
        }
      }

      onProgress(relPath);

      let markdown;
      try {
        if (isPlain) {
          markdown = (await fs.readFile(full, "utf8")).trim();
          if (!markdown) throw new Error("file is empty");
          markdown = header(entry.name, "verbatim copy") + markdown + "\n";
        } else if (CSV_FORMATS.has(ext)) {
          // No native call and no deadline needed: a string parser with no I/O
          // and no addon, so there is nothing here that can hang.
          const body = csvToMarkdown(await fs.readFile(full, "utf8")).trim();
          if (!body) throw new Error("converter produced no text");
          markdown = header(entry.name, "csv") + body + "\n";
        } else if (NATIVE_FORMATS.has(ext)) {
          if (!toMarkdownNative) toMarkdownNative = await loadAnydoc();
          // The PATH form rather than the buffer one, because a signature-less
          // format (.csv) is identified by its extension — which the buffer
          // call would have to be told separately.
          const body = ((await toMarkdownNative(full)) || "").trim();
          if (!body) throw new Error("converter produced no text");
          markdown = header(entry.name, "anydoc") + body + "\n";
        } else {
          if (!MarkItDown) MarkItDown = await loadMarkItDown();
          const buffer = await fs.readFile(full);
          const r = await new MarkItDown().convertBuffer(buffer, { file_extension: ext });
          const body = (r?.markdown || "").trim();
          if (!body) throw new Error("converter produced no text");
          markdown = header(entry.name, "markitdown-ts") + body + "\n";
        }
      } catch (e) {
        // A failed conversion must never lose or hide the source — leave it be.
        results.push({ file: relPath, status: "failed", detail: e?.message ?? String(e) });
        continue;
      }

      await fs.writeFile(target, markdown, "utf8");
      results.push(await archive({ file: relPath, status: "converted", target: targetRel, chars: markdown.length }));
    }
  };

  await walk(root);
  return results;
}

// --- CLI -------------------------------------------------------------------

async function main() {
  const argv = process.argv.slice(2);
  const flags = new Set(argv.filter((a) => a.startsWith("--")));
  const [project, ...rest] = argv.filter((a) => !a.startsWith("--"));
  const feature = rest.join(" ");

  if (!project) {
    console.error("Usage: node scripts/convert-to-md.mjs <project> [<feature>] [--force] [--keep-originals]");
    console.error("  With no feature, converts the PROJECT's own documents/ tree.");
    process.exit(1);
  }
  for (const f of flags) {
    if (!["--force", "--keep-originals"].includes(f)) {
      console.error(`[convert-to-md] unknown flag ${f}`);
      process.exit(1);
    }
  }

  // With no feature, convert the project's own documents/ tree — the client-wide
  // material the wizard uploads, which every project stage reads.
  const scopeDir = feature
    ? path.join(WORKSPACE, "projects", project, feature)
    : path.join(WORKSPACE, "projects", project);
  const srcDir = feature ? path.join(scopeDir, "requirements") : path.join(scopeDir, "documents");
  try {
    await fs.access(srcDir);
  } catch {
    console.error(`[convert-to-md] nothing to convert at ${path.relative(WORKSPACE, srcDir)}`);
    process.exit(1);
  }

  const results = await convertTree(srcDir, {
    force: flags.has("--force"),
    archiveRoot: flags.has("--keep-originals")
      ? null
      : path.join(scopeDir, "original-files", feature ? "requirements" : "documents"),
    onProgress: (f) => console.log(`  converting ${f} …`),
  });

  report(results, (s) => console.log(s));
  if (results.some((r) => r.status === "failed")) process.exit(2);
}

export function report(results, log) {
  const by = (s) => results.filter((r) => r.status === s);
  const converted = by("converted");
  const archived = results.filter((r) => r.archived);
  log(`\n[convert-to-md] ${converted.length} converted, ${by("up-to-date").length} up-to-date, ` +
      `${by("already-md").length} already .md, ${by("skipped").length} skipped, ${by("failed").length} failed` +
      (archived.length ? `, ${archived.length} original(s) archived` : ""));
  for (const r of converted) {
    log(`  ✓ ${r.file}\n      → ${r.target} (${r.chars.toLocaleString()} chars)`);
    if (r.archived) log(`      ⤷ original → ${r.archived}`);
  }
  for (const r of by("up-to-date")) {
    if (r.archived) log(`  ⤷ ${r.file}\n      original → ${r.archived}`);
  }
  for (const r of by("failed")) log(`  ✗ ${r.file} — ${r.detail}`);
  const skipped = by("skipped");
  if (skipped.length) log(`  · skipped: ${skipped.map((r) => path.basename(r.file)).join(", ")}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(`[convert-to-md] ${e.stack || e}`);
    process.exit(1);
  });
}
