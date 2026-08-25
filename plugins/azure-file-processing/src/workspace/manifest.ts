import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, lstat } from "node:fs/promises";
import { join } from "node:path";
import { log } from "../shared/logger.js";
import { blobPathFor, projectPrefix, isSyncTempFile } from "./paths.js";

export interface Entry { path: string; sha256: string; bytes: number }

/** Streamed, so a large artefact does not land in memory just to be hashed. */
export const hashFile = (absPath: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const h = createHash("sha256");
    createReadStream(absPath)
      .on("data", (c) => h.update(c))
      .on("end", () => resolve(h.digest("hex")))
      .on("error", reject);
  });

interface FileWithStats { absPath: string; stats: Awaited<ReturnType<typeof lstat>> }

interface WalkResult { files: FileWithStats[]; skippedSymlinks: number; skippedTemp: number }

const walk = async (
  dir: string, out: FileWithStats[], skippedSymlinks: number, skippedTemp: number,
): Promise<WalkResult> => {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (e: unknown) {
    const err = e as NodeJS.ErrnoException;
    if (err?.code === "ENOENT") return { files: out, skippedSymlinks, skippedTemp };
    throw e;
  }
  for (const n of names) {
    const p = join(dir, n);
    let s: Awaited<ReturnType<typeof lstat>>;
    try {
      s = await lstat(p);
    } catch (e: unknown) {
      const err = e as NodeJS.ErrnoException;
      if (err?.code === "ENOENT") continue;
      throw e;
    }
    if (s.isDirectory()) {
      const result = await walk(p, out, skippedSymlinks, skippedTemp);
      out = result.files;
      skippedSymlinks = result.skippedSymlinks;
      skippedTemp = result.skippedTemp;
    } else if (s.isSymbolicLink()) {
      skippedSymlinks++;
    } else if (isSyncTempFile(n)) {
      // A syncDown's own in-flight download, orphaned by a SIGKILL between it
      // finishing and its rename into place. Never a real document; never
      // hashed, never returned, never pushed to blob as one.
      skippedTemp++;
    } else {
      out.push({ absPath: p, stats: s });
    }
  }
  return { files: out, skippedSymlinks, skippedTemp };
};

export const localManifest = async (
  workspaceRoot: string, project: string, prefix?: string,
): Promise<Entry[]> => {
  const base = prefix
    ? join(workspaceRoot, "projects", project, prefix)
    : join(workspaceRoot, "projects", project);
  const walkResult = await walk(base, [], 0, 0);
  const entries: Entry[] = [];
  let skippedVanished = 0;
  for (const { absPath: f, stats: fileStats } of walkResult.files) {
    const path = blobPathFor(f, workspaceRoot);
    // Belt and braces: walk() already starts inside the project, but a symlink
    // could otherwise carry us out of it.
    if (!path.startsWith(projectPrefix(project))) continue;
    let sha256: string;
    try {
      sha256 = await hashFile(f);
    } catch (e: unknown) {
      const err = e as NodeJS.ErrnoException;
      if (err?.code === "ENOENT") {
        skippedVanished++;
        continue;
      }
      throw e;
    }
    entries.push({ path, sha256, bytes: Number(fileStats.size) });
  }
  entries.sort((a, b) => a.path.localeCompare(b.path));
  if (walkResult.skippedSymlinks > 0 || skippedVanished > 0 || walkResult.skippedTemp > 0) {
    log.info("localManifest.skipped", {
      project,
      prefix: prefix ?? null,
      symlinks: walkResult.skippedSymlinks,
      vanished: skippedVanished,
      tempOrphans: walkResult.skippedTemp,
    });
  }
  return entries;
};

export const diff = (local: Entry[], remote: Entry[]) => {
  const r = new Map(remote.map((e) => [e.path, e]));
  const l = new Map(local.map((e) => [e.path, e]));
  const onlyLocal: Entry[] = [], differing: Entry[] = [], same: Entry[] = [];
  for (const e of local) {
    const other = r.get(e.path);
    if (!other) onlyLocal.push(e);
    else if (other.sha256 !== e.sha256) differing.push(e);
    else same.push(e);
  }
  const onlyRemote = remote.filter((e) => !l.has(e.path));
  return { onlyLocal, onlyRemote, differing, same };
};
