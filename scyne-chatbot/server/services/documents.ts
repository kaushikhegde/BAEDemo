// The documents a person can see, replace and remove — read from DISK.
//
// Disk is what the stages actually read: every 409 gate counts `.md` under
// `projects/<p>/`, `stage.mjs` copies from the folder tree, and every skill
// reads its working folder. The database holds its own versioned record, and
// both are written — but a delete that retired only the row would report
// success and change nothing a single agent does.
//
// Two shapes, and only two:
//
//   projects/<p>/documents/<name>                    the client's own material
//   projects/<p>/<f>/requirements/<Sub>/<name>       one feature's discovery
//
// Everything else under those trees is deliberately NOT a document:
// `templates/` is house style, `project/` is staged down from the parent on
// every run, `original-files/` is the archive, and `outputs/` and `solutions/`
// are generated artefacts that belong to a stage rather than to an upload.

import fs from "node:fs/promises";
import path from "node:path";
import { CONVERTIBLE, PLAIN_TEXT } from "../../../scripts/convert-to-md.mjs";

/** The subfolders a feature's discovery material lands in. Mirrors stage.mjs. */
export const DISCOVERY_SUBFOLDERS = ["SOP", "Transcripts", "Notes", "UI"] as const;

/**
 * What the converter can turn into markdown — IMPORTED, never copied.
 *
 * This was a hand-written set with a comment claiming it mirrored
 * convert-to-md.mjs, and it had drifted in both directions: it listed .pptx,
 * .xls and .csv, which the converter could not read, and omitted .xml and
 * .ipynb, which it could. So a PowerPoint was badged "not converted — no stage
 * can read this yet", promising a conversion that was never going to happen,
 * while a genuinely convertible notebook was filed as "other".
 *
 * A copy of somebody else's list is a copy that drifts. There is one list.
 */
const READABLE_SOURCES = new Set([...CONVERTIBLE, ...PLAIN_TEXT]);
const IMAGE = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"]);
const AUDIO = new Set([".mp3", ".wav", ".m4a", ".ogg", ".flac", ".aac"]);

export type DocumentKind = "markdown" | "image" | "audio" | "unconverted" | "other";

export interface DocumentEntry {
  /** The file as it sits on disk. */
  name: string;
  /** Relative to the document's own LEVEL root — the convention `produces[]` uses. */
  path: string;
  /** `documents` at project level; `SOP` / `Transcripts` / `Notes` / `UI` at feature level. */
  subfolder: string;
  level: "project" | "feature";
  feature: string | null;
  bytes: number;
  modifiedAt: string;
  kind: DocumentKind;
  /**
   * The archived source this markdown was converted from, when there is one.
   * What a person recognises is the file they uploaded — the converter replaced
   * it, so a row naming only `handling.md` sends them looking for a `.docx`
   * that is no longer where they put it.
   */
  original: string | null;
  /**
   * Whether the DATABASE also has a row for this file. Attached by the route,
   * not read from disk — disk cannot know.
   */
  inDb?: boolean;
  /** The opening of the document. Attached by the route, on request. */
  excerpt?: string;
  /**
   * The store's version number. A document is never edited in place — a
   * re-upload of changed bytes writes a new version — so this is what tells a
   * reader their replacement actually landed. Absent for a disk-only file,
   * which has no row and therefore no version.
   */
  version?: number;
  /**
   * How far this document has got through extraction. Attached by the route.
   *
   * A document is not USABLE until it is extracted: `capabilities` refuses
   * `documents_not_ready` until every one of them is `ready`. Absent on a
   * non-markdown document, which is never extracted.
   */
  extract?: {
    state: "ready" | "missing" | "failed" | "extracting";
    /** Why it failed, from its `.extract.failed.json`. */
    reason?: string;
    /** How many times it has failed. Separates a bad night from a bad file. */
    attempts?: number;
    firstFailedAt?: string;
    lastFailedAt?: string;
  };
}

export interface DocumentList {
  project: DocumentEntry[];
  feature: DocumentEntry[];
}

const projectRoot = (workspace: string, project: string) =>
  path.join(workspace, "projects", project);

const levelRoot = (workspace: string, project: string, feature: string | null) =>
  feature ? path.join(workspace, "projects", project, feature) : projectRoot(workspace, project);

export function kindOf(name: string): DocumentKind {
  const ext = path.extname(name).toLowerCase();
  if (ext === ".md" || ext === ".markdown") return "markdown";
  if (IMAGE.has(ext)) return "image";
  if (AUDIO.has(ext)) return "audio";
  // A source still sitting here means the conversion did not happen — which is
  // precisely why a stage that looks readable is refused with `no_documents`.
  if (READABLE_SOURCES.has(ext)) return "unconverted";
  return "other";
}

/**
 * The archived source a document was converted from.
 *
 * Matched on STEM rather than on a guessed extension, because the source could
 * have been any of eight and the converter's disambiguated form (`foo.docx.md`,
 * written when a foreign `foo.md` was already there) makes the stem the whole
 * of `foo.docx`. Both candidates are tried, longest first, so a document called
 * `handling.md` never claims `handling-appendix.docx`.
 */
async function findOriginal(
  levelDir: string, subPath: string, name: string,
): Promise<string | null> {
  const archiveRel = path.join("original-files", subPath);
  const archiveDir = path.join(levelDir, archiveRel);
  const entries = await fs.readdir(archiveDir).catch(() => [] as string[]);
  if (!entries.length) return null;

  const withoutMd = name.replace(/\.(md|markdown)$/i, "");
  // `foo.docx.md` → try `foo.docx` before `foo`, so the exact source wins over
  // anything else that merely starts with the same word.
  const stems = [withoutMd, withoutMd.replace(/\.[^.]+$/, "")];
  for (const stem of stems) {
    const hit = entries.find(e => e === stem || e.replace(/\.[^.]+$/, "") === stem);
    if (hit) return path.join(archiveRel, hit);
  }
  return null;
}

async function readFolder(
  workspace: string, project: string, feature: string | null,
  subPath: string, subfolder: string,
): Promise<DocumentEntry[]> {
  const levelDir = levelRoot(workspace, project, feature);
  const dir = path.join(levelDir, subPath);
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const out: DocumentEntry[] = [];

  for (const e of entries) {
    if (!e.isFile() || e.name.startsWith(".")) continue;
    const st = await fs.stat(path.join(dir, e.name)).catch(() => null);
    if (!st) continue;
    out.push({
      name: e.name,
      path: path.join(subPath, e.name),
      subfolder,
      level: feature ? "feature" : "project",
      feature,
      bytes: st.size,
      modifiedAt: new Date(st.mtimeMs).toISOString(),
      kind: kindOf(e.name),
      original: await findOriginal(levelDir, subPath, e.name),
    });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Every document at both levels.
 *
 * The project's own material is returned whether or not a feature was asked
 * for, because a feature is always read in the context of its project and the
 * two are edited from the same screen.
 */
export async function listDocuments(
  workspace: string, project: string, feature?: string | null,
): Promise<DocumentList> {
  const projectDocs = await readFolder(workspace, project, null, "documents", "documents");
  if (!feature) return { project: projectDocs, feature: [] };

  const featureDocs: DocumentEntry[] = [];
  for (const sub of DISCOVERY_SUBFOLDERS) {
    featureDocs.push(...await readFolder(workspace, project, feature, path.join("requirements", sub), sub));
  }
  return { project: projectDocs, feature: featureDocs };
}

/** The folders a document may live in, at each level. */
const allowedPrefixes = (feature: string | null): string[] =>
  feature
    ? DISCOVERY_SUBFOLDERS.map(s => path.join("requirements", s) + path.sep)
    : ["documents" + path.sep];

/**
 * The absolute path of one document, or a refusal.
 *
 * Two separate checks, because they fail for different reasons and a caller
 * should be told which: a path that climbs out of the workspace is an attack or
 * a bug, and a path inside it but outside `documents/` is someone pointing a
 * delete at a generated artefact.
 */
export function resolveDocument(
  workspace: string, project: string, feature: string | null, relPath: string,
): string {
  const rel = String(relPath ?? "").trim();
  if (!rel || path.isAbsolute(rel)) throw new Error(`invalid document path: ${rel || "(empty)"}`);

  const root = levelRoot(workspace, project, feature);
  const full = path.resolve(root, rel);
  const within = path.relative(root, full);
  if (within.startsWith("..") || path.isAbsolute(within)) {
    throw new Error(`document path resolves outside the project: ${rel}`);
  }
  if (!allowedPrefixes(feature).some(p => within.startsWith(p))) {
    throw new Error(
      `not a document: ${rel} — ` +
      (feature ? `expected requirements/{${DISCOVERY_SUBFOLDERS.join(",")}}/…` : "expected documents/…"));
  }
  return full;
}

/** One document's bytes, plus what a preview header needs to label it. */
export interface DocumentContent {
  name: string;
  path: string;
  bytes: number;
  modifiedAt: string;
  /** The archived source it was converted from, when there is one. */
  original: string | null;
  /**
   * The file this markdown was MACHINE-GENERATED from, per the converter's own
   * banner — or null when a person wrote it.
   *
   * Distinct from `original`, which is merely the archived upload and exists
   * for a hand-written `.md` too. Only the banner says the content was produced
   * by a tool, which is what decides whether a reader needs its line structure
   * preserved: markitdown-ts flattens a PDF table to one field per line, and
   * CommonMark joins those into a single run-on paragraph.
   */
  convertedFrom: string | null;
  content: string;
}

/** `<!-- Converted from X.pdf by markitdown-ts. … -->`, written as line 1. */
export const CONVERTED_BANNER = /^\s*<!--\s*Converted from\s+(.+?)\s+by\s+[\s\S]*?-->/;

/**
 * Read one document as text.
 *
 * Refuses a binary file rather than decoding it: `requirements/UI/` holds
 * screenshots, and a PNG read as utf8 renders as several screens of mojibake
 * that LOOKS like a document — worse than saying no. An UNCONVERTED source is
 * read happily, because a `.txt` still sitting there is exactly the file
 * somebody opens to work out why a stage reports no documents.
 */
export async function readDocument(
  workspace: string, project: string, feature: string | null, relPath: string,
): Promise<DocumentContent | null> {
  const full = resolveDocument(workspace, project, feature, relPath);
  const levelDir = levelRoot(workspace, project, feature);
  const rel = path.relative(levelDir, full);
  const name = path.basename(rel);

  const kind = kindOf(name);
  if (kind === "image" || kind === "audio") {
    throw new Error(`not text: ${rel} is ${kind === "image" ? "an image" : "audio"}`);
  }

  const st = await fs.stat(full).catch(() => null);
  if (!st || !st.isFile()) return null;

  const buf = await fs.readFile(full);
  // A `.pdf` or `.docx` that never converted reaches here as a convertible
  // kind and is still binary. One NUL byte in the first few KB is the cheap,
  // reliable tell, and no text document this pipeline handles contains one.
  if (buf.subarray(0, 8192).includes(0)) {
    throw new Error(`not text: ${rel} is a binary file that has not been converted`);
  }

  const text = buf.toString("utf8");
  return {
    name,
    path: rel,
    bytes: st.size,
    modifiedAt: new Date(st.mtimeMs).toISOString(),
    original: await findOriginal(levelDir, path.dirname(rel), name),
    convertedFrom: CONVERTED_BANNER.exec(text)?.[1] ?? null,
    // The banner stays IN the content. Stripping it here would make a raw view
    // a lie about what is on disk; the preview hides it for the rendered view.
    content: text,
  };
}

/**
 * The opening of a document, for a card that has to fit on a grid.
 *
 * Raw markdown rather than rendered: at this size a heading and two lines of
 * prose read perfectly well as text, while a rendered fragment of a document
 * whose first block happens to be a 40-column table reads as nothing at all.
 */
export function excerptOf(markdown: string, max: number): string {
  const body = String(markdown ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/^\uFEFF/, "")
    // Front matter is metadata, and it is the first thing in the file — an
    // excerpt of it says the author's name and nothing about the document.
    .replace(/^---\n[\s\S]*?\n---\n/, "")
    // So is `convert-to-md.mjs`'s banner, and that one is on MOST documents
    // here: `<!-- Converted from X.pdf by markitdown-ts. Regenerate with … -->`
    // is 100 characters of build note, which is a quarter of a card. Measured
    // on SA-Demo, two of three cards showed the banner and no document.
    // ANCHORED, so a comment further down is prose and survives.
    .replace(/^\s*<!--[\s\S]*?-->\n?/, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (body.length <= max) return body;

  const cut = body.slice(0, max);
  const boundary = cut.lastIndexOf(" ");
  // No space to cut at — a URL, a base64 blob — so cut hard. Returning nothing
  // because one token was long is worse than an abrupt edge.
  return (boundary > max * 0.5 ? cut.slice(0, boundary) : cut).trimEnd() + "\u2026";
}

export interface DeleteResult {
  found: boolean;
  /** Level-relative paths actually removed — the document, and its archived source. */
  removed: string[];
}

/**
 * Remove a document, and the archived source it was converted from.
 *
 * BOTH, deliberately. `convert-to-md.mjs` moves the source into
 * `original-files/` rather than deleting it, so a delete that took only the
 * markdown would leave the thing that produced it — and the next conversion
 * pass would put the document straight back, long after the person who deleted
 * it stopped watching.
 */
export async function deleteDocument(
  workspace: string, project: string, feature: string | null, relPath: string,
): Promise<DeleteResult> {
  const full = resolveDocument(workspace, project, feature, relPath);
  const levelDir = levelRoot(workspace, project, feature);
  const rel = path.relative(levelDir, full);

  const exists = await fs.access(full).then(() => true, () => false);
  if (!exists) return { found: false, removed: [] };

  const removed: string[] = [];
  await fs.rm(full);
  removed.push(rel);

  const original = await findOriginal(levelDir, path.dirname(rel), path.basename(rel));
  if (original) {
    await fs.rm(path.join(levelDir, original)).catch(() => { /* already gone */ });
    removed.push(original);
  }
  return { found: true, removed };
}
