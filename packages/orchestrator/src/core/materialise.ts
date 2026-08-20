// Materialise a project out of the database into a real directory tree, run
// against it, then harvest what changed back.
//
// This exists because agents work on files. Every skill reads a folder, every
// `produces[]` entry is a path, and ~5,000 lines of scripts under scripts/
// walk `projects/<project>/<feature>/…`. Moving the system of record into
// Postgres does not change any of that — it changes only where the tree comes
// from and where it goes afterwards.
//
// The layout written here is deliberately IDENTICAL to the on-disk layout the
// repository has always used:
//
//   <workRoot>/projects/<project>/…              project-level documents
//   <workRoot>/projects/<project>/<feature>/…    feature-level documents
//   <workRoot>/generated-apps/…                  rendered output
//
// which is why stage.mjs, render-companion-app.mjs, render-mockups.mjs and
// validate-experience.mjs need no changes at all: they already take their root
// as a parameter (`projectDir(workspace, project)` and friends in
// scripts/pipeline.mjs), so they simply receive a different one.
//
// The install's own material — scripts/, skills/, examples/ — is LINKED in
// rather than copied, because an agent's prompt tells it to run
// `node scripts/ado-publish.mjs` from its working directory. Links are
// never harvested: they are the install's content, not the project's.
//
// Harvest is non-destructive on purpose. A file that vanished from the tree is
// REPORTED, never deleted from the store. An agent that crashes mid-write, or
// a materialisation that silently missed a file, would otherwise turn into
// permanent data loss the first time it happened — and the store is the system
// of record now, so there is no second copy to recover from.

import { mkdir, mkdtemp, readdir, readFile, symlink, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { sha256Of, type DocumentStore } from "./documents.js";

/** Install directories linked into the work root so an agent's cwd can reach them. */
export const LINKED_FROM_INSTALL = [
  "scripts", "skills", "examples", "datamodel-reference", "agent-instructions",
  "scyne-chatbot", ".mcp.json",
] as const;

/** Real (non-linked) top-level directories that belong to the project and are harvested. */
export const HARVESTED_ROOTS = ["projects", "generated-apps"] as const;

export interface FeatureRef { id: string; name: string }

export interface MaterialiseInput {
  store: DocumentStore;
  projectId: string;
  projectName: string;
  features: FeatureRef[];
  installRoot: string;
  workRoot: string;
}

/**
 * What was on disk the moment materialisation finished: work-root-relative
 * path → content hash. Harvest diffs against this rather than against the
 * database, so a file the agent wrote AND a file it rewrote to identical bytes
 * are told apart without a second query per file.
 */
export interface Manifest {
  files: Record<string, string>;
  projectId: string;
  projectName: string;
  featuresByName: Record<string, string>;
}

export interface HarvestResult {
  written: string[];
  unchanged: string[];
  /** In the manifest, absent from disk. Reported only — never removed from the store. */
  missing: string[];
  /** On disk but not attributable to a project or feature; left alone and named. */
  skipped: string[];
}

/** Create an empty work root. The caller owns its lifetime — see `discard`. */
export async function createWorkRoot(prefix = "scyne-work-"): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

export async function discardWorkRoot(workRoot: string): Promise<void> {
  await rm(workRoot, { recursive: true, force: true });
}

const exists = async (p: string): Promise<boolean> => {
  try { await stat(p); return true; } catch { return false; }
};

/** Documents at a level are stored level-relative; this puts them at the right depth. */
function levelDir(workRoot: string, projectName: string, featureName: string | null): string {
  return featureName
    ? join(workRoot, "projects", projectName, featureName)
    : join(workRoot, "projects", projectName);
}

/**
 * Write the project's current documents into `workRoot`, then link the
 * install's material beside them. Returns the manifest harvest will diff on.
 */
export async function materialise(input: MaterialiseInput): Promise<Manifest> {
  const { store, projectId, projectName, features, installRoot, workRoot } = input;
  const files: Record<string, string> = {};
  const byId = new Map(features.map(f => [f.id, f.name]));

  for (const ref of await store.list(projectId, { anyLevel: true })) {
    // A document naming a feature this project no longer has cannot be placed.
    // Skipping is right — but silently skipping is not, so it is left out of
    // the manifest, which makes it show up as `missing` rather than vanishing.
    const featureName = ref.featureId ? byId.get(ref.featureId) : null;
    if (ref.featureId && !featureName) continue;

    const abs = join(levelDir(workRoot, projectName, featureName ?? null), ref.path);
    const got = await store.get(projectId, ref.featureId, ref.path);
    if (!got) continue;

    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, got.content);
    files[relative(workRoot, abs).split(sep).join("/")] = got.ref.sha256;
  }

  // `generated-apps/` is written by the renderers rather than read from the
  // store, but it must exist for them to write into.
  await mkdir(join(workRoot, "generated-apps"), { recursive: true });
  await mkdir(join(workRoot, "projects", projectName), { recursive: true });

  await linkInstall(installRoot, workRoot);

  return {
    files,
    projectId,
    projectName,
    featuresByName: Object.fromEntries(features.map(f => [f.name, f.id])),
  };
}

/**
 * Link the install's material into the work root.
 *
 * Symlinks rather than copies: `scyne-chatbot/` alone carries a node_modules
 * tree, and copying it per run would dominate the cost of a stage that takes
 * twenty-five minutes only because a model is thinking.
 */
async function linkInstall(installRoot: string, workRoot: string): Promise<void> {
  for (const name of LINKED_FROM_INSTALL) {
    const target = join(installRoot, name);
    if (!(await exists(target))) continue;      // optional; .mcp.json often absent
    const link = join(workRoot, name);
    if (await exists(link)) continue;
    try {
      await symlink(target, link);
    } catch {
      // A filesystem without symlink permission (Windows without developer
      // mode, some container mounts) must degrade rather than fail the run:
      // exec steps run from the install root anyway, so only an agent that
      // shells out is affected, and it will fail with its own clear error.
    }
  }
}

/** Every real file under `dir`, work-root-relative, following no symlinks. */
async function walk(root: string, dir: string, out: string[] = []): Promise<string[]> {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    // Never descend a symlink: those point back into the install, and
    // harvesting them would import the entire codebase as project documents.
    if (e.isSymbolicLink()) continue;
    const abs = join(dir, e.name);
    if (e.isDirectory()) await walk(root, abs, out);
    else if (e.isFile()) out.push(relative(root, abs).split(sep).join("/"));
  }
  return out;
}

/**
 * Attribute a work-root-relative path back to a project or feature document.
 *
 * `projects/<project>/<rest>` where the first segment of `<rest>` names a
 * feature is a feature document; anything else under the project is a project
 * document. `generated-apps/<...>` is a project-level artefact.
 */
export function attribute(
  path: string, manifest: Manifest,
): { featureId: string | null; docPath: string; category: string } | null {
  const parts = path.split("/");

  if (parts[0] === "generated-apps") {
    return { featureId: null, docPath: path, category: "artefact" };
  }
  if (parts[0] !== "projects" || parts[1] !== manifest.projectName || parts.length < 3) return null;

  const rest = parts.slice(2);
  const featureId = manifest.featuresByName[rest[0]];
  if (featureId && rest.length >= 2) {
    return { featureId, docPath: rest.slice(1).join("/"), category: categoryFor(rest.slice(1)) };
  }
  return { featureId: null, docPath: rest.join("/"), category: categoryFor(rest) };
}

/** Best-effort classification, matching the folders fileRouter.ts already uses. */
function categoryFor(parts: string[]): string {
  const [head, sub] = parts;
  if (head === "requirements") {
    const m: Record<string, string> = {
      SOP: "sop", Transcripts: "transcripts", Notes: "notes", UI: "ui", templates: "template",
    };
    return m[sub] ?? "source";
  }
  if (head === "outputs" || head === "solutions") return "output";
  if (head === "documents") return "source";
  return "artefact";
}

export interface HarvestInput {
  store: DocumentStore;
  workRoot: string;
  manifest: Manifest;
  stage?: string;
  uploadedBy?: string | null;
}

/**
 * Write back everything the run changed.
 *
 * Reads each file and hands it to `store.put`, which is the authority on
 * whether anything actually changed — the manifest is only a fast path that
 * avoids reading unchanged bytes at all. Where the two could disagree (a file
 * rewritten to identical content), `put` wins, because it compares against
 * what is actually stored.
 */
export async function harvest(input: HarvestInput): Promise<HarvestResult> {
  const { store, workRoot, manifest } = input;
  const result: HarvestResult = { written: [], unchanged: [], missing: [], skipped: [] };

  const seen = new Set<string>();
  for (const root of HARVESTED_ROOTS) {
    for (const rel of await walk(workRoot, join(workRoot, root))) {
      seen.add(rel);
      const known = manifest.files[rel];
      const content = await readFile(join(workRoot, rel));

      // Fast path: the manifest says these bytes are already stored.
      if (known && known === sha256Of(content)) { result.unchanged.push(rel); continue; }

      const target = attribute(rel, manifest);
      if (!target) { result.skipped.push(rel); continue; }

      const { changed } = await store.put({
        projectId: manifest.projectId,
        featureId: target.featureId,
        path: target.docPath,
        content,
        category: target.category,
        stage: input.stage ?? null,
        uploadedBy: input.uploadedBy ?? null,
      });
      (changed ? result.written : result.unchanged).push(rel);
    }
  }

  // Reported, never acted on. See the header: the store is the only copy.
  for (const rel of Object.keys(manifest.files)) if (!seen.has(rel)) result.missing.push(rel);

  return result;
}
