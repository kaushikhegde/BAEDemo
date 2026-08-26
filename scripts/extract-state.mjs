// A document's extraction state, computed from disk alone.
//
// There is no database here on purpose: the extract FILES are the state, and
// their names are the source document's content hash. That makes invalidation
// free — edit a document and you are asking about a hash nothing has extracted
// yet, so it reads as `missing` with no bookkeeping to keep in step.

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { validateExtract } from "./lib/extract-schema.mjs";
import { DISCOVERY_SUBFOLDERS } from "./pipeline.mjs";

/** Streamed: a 300 MB document must not be resident to be hashed. */
export const hashOf = (absPath) =>
  new Promise((resolve, reject) => {
    const h = createHash("sha256");
    createReadStream(absPath)
      .on("error", reject)
      .on("data", (d) => h.update(d))
      .on("end", () => resolve(h.digest("hex")));
  });

const EXTRACTS_DIR = path.join("solutions", "Extracts");

export const extractPathFor = async (docAbsPath, levelRoot) => {
  const hash = (await hashOf(docAbsPath)).slice(0, 16);
  return path.join(levelRoot, EXTRACTS_DIR, `${hash}.extract.json`);
};

export const stateOf = async (docAbsPath, levelRoot) => {
  const extractPath = await extractPathFor(docAbsPath, levelRoot);
  const failedPath = extractPath.replace(/\.extract\.json$/, ".extract.failed.json");

  const failed = await readFile(failedPath, "utf8").catch(() => null);
  if (failed !== null) {
    let marker = {};
    try { marker = JSON.parse(failed) ?? {}; } catch { /* an unreadable marker is still a failure */ }
    // `attempts` and the two timestamps are what separate a document worth
    // retrying from one that never will extract — a scanned PDF with no text
    // layer fails identically every time, and only the count says so. Spread
    // conditionally rather than defaulting: an absent count must not arrive as
    // 0, which reads as "tried, did not fail".
    return {
      state: "failed",
      reason: marker.reason ?? "extraction failed",
      ...(marker.attempts != null ? { attempts: Number(marker.attempts) } : {}),
      ...(marker.firstFailedAt ? { firstFailedAt: String(marker.firstFailedAt) } : {}),
      ...(marker.lastFailedAt ? { lastFailedAt: String(marker.lastFailedAt) } : {}),
      extractPath,
    };
  }

  const raw = await readFile(extractPath, "utf8").catch(() => null);
  if (raw !== null) {
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch (e) { return { state: "failed", reason: `unparseable extract: ${e.message}`, extractPath }; }
    const v = validateExtract(parsed);
    // A file that exists but does not validate is FAILED, never ready. A naive
    // "does the file exist" check is how a malformed extract silently shrinks
    // the capability map.
    if (!v.ok) return { state: "failed", reason: v.errors.slice(0, 3).join("; "), extractPath };
    return { state: "ready", extractPath };
  }

  const partial = await stat(`${extractPath}.partial`).catch(() => null);
  if (partial) return { state: "extracting", extractPath };

  return { state: "missing", extractPath };
};

/** Folders that are OUTPUT, never source. Kept in step with pipeline.mjs's NOT_SOURCE. */
const SKIP = new Set(["outputs", "solutions", "design", "original-files", "node_modules", ".git"]);
const PROJECT_OWN = new Set(["solutions", "documents", "design", "original-files", "outputs"]);

const walkMd = async (dir, out, depth = 0) => {
  if (depth > 6) return out;
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP.has(e.name)) await walkMd(p, out, depth + 1); }
    else if (e.isFile() && /\.(md|markdown)$/i.test(e.name)) out.push(p);
  }
  return out;
};

export const projectState = async (workspaceRoot, project) => {
  const projRoot = path.join(workspaceRoot, "projects", project);
  const documents = [];

  for (const p of await walkMd(path.join(projRoot, "documents"), [])) {
    const s = await stateOf(p, projRoot);
    documents.push({ docId: path.relative(projRoot, p), scope: "project", ...s });
  }

  let entries = [];
  try { entries = await readdir(projRoot, { withFileTypes: true }); } catch { /* no project */ }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith(".") || PROJECT_OWN.has(e.name)) continue;
    const featRoot = path.join(projRoot, e.name);
    // ONLY the four discovery folders — never all of `requirements/`.
    // `requirements/project/` is staged DOWN from the parent on every run and
    // holds the project's OWN artefacts, `capability-process.md` among them. A
    // walk that swept it would feed the capability map its own previous output
    // as if it were client evidence: circular, and it would compound each run.
    // `templates/` is house style, not content. pipeline.mjs enumerates the
    // four for exactly this reason — import that list rather than restate it.
    for (const sub of DISCOVERY_SUBFOLDERS) {
      for (const p of await walkMd(path.join(featRoot, "requirements", sub), [])) {
        const s = await stateOf(p, featRoot);
        documents.push({ docId: path.relative(featRoot, p), scope: e.name, ...s });
      }
    }
  }

  const count = (st) => documents.filter((d) => d.state === st).length;
  return {
    ready: count("ready"), missing: count("missing"),
    failed: count("failed"), extracting: count("extracting"),
    documents,
  };
};
