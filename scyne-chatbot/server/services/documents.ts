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

/** The subfolders a feature's discovery material lands in. Mirrors stage.mjs. */
export const DISCOVERY_SUBFOLDERS = ["SOP", "Transcripts", "Notes", "UI"] as const;

/** What the converter can turn into markdown. Mirrors convert-to-md.mjs. */
const CONVERTIBLE = new Set([".pdf", ".docx", ".doc", ".txt", ".xlsx", ".xls", ".pptx", ".csv", ".html", ".htm"]);
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
}

export interface DocumentList {
  project: DocumentEntry[];
  feature: DocumentEntry[];
}

const projectRoot = (workspace: string, project: string) =>
  path.join(workspace, "projects", project);

const levelRoot = (workspace: string, project: string, feature: string | null) =>
  feature ? path.join(workspace, "projects", project, feature) : projectRoot(workspace, project);

function kindOf(name: string): DocumentKind {
  const ext = path.extname(name).toLowerCase();
  if (ext === ".md" || ext === ".markdown") return "markdown";
  if (IMAGE.has(ext)) return "image";
  if (AUDIO.has(ext)) return "audio";
  // A source still sitting here means the conversion did not happen — which is
  // precisely why a stage that looks readable is refused with `no_documents`.
  if (CONVERTIBLE.has(ext)) return "unconverted";
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
