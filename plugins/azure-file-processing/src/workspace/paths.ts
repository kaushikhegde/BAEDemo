import { relative, isAbsolute, sep, posix } from "node:path";

export const WORKSPACE_CONTAINER = "workspace";

/** Blob paths mirror the local tree with `projects/` removed, so the mapping is
 *  mechanical and reversible with no lookup table. Always POSIX separators —
 *  a blob name containing a backslash is a different blob. */
export const blobPathFor = (localPath: string, workspaceRoot: string): string => {
  const root = workspaceRoot.replace(/[/\\]+$/, "");
  const rel = relative(`${root}${sep}projects`, localPath);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`path is outside projects/: ${localPath}`);
  }
  return rel.split(sep).join(posix.sep);
};

export const localPathFor = (blobPath: string, workspaceRoot: string): string => {
  const root = workspaceRoot.replace(/[/\\]+$/, "");
  const segments = blobPath.split(posix.sep);
  for (const segment of segments) {
    assertSafeSegment(segment);
  }
  return [root, "projects", ...segments].join(sep);
};

/** The trailing slash matters: without it, prefix "SA" would also match every
 *  blob under "SAPN/". */
export const projectPrefix = (project: string): string => `${project}/`;

export const assertSafeSegment = (name: string): void => {
  if (!name) {
    throw new Error(`path segment is empty`);
  }
  if (isAbsolute(name)) {
    throw new Error(`path segment ${JSON.stringify(name)} is an absolute path`);
  }
  if (name === ".") {
    throw new Error(`path segment ${JSON.stringify(name)} refers to the current directory`);
  }
  if (name.includes("..")) {
    throw new Error(`path segment ${JSON.stringify(name)} would climb out of the project tree`);
  }
  if (/[/\\]/.test(name)) {
    throw new Error(`path segment ${JSON.stringify(name)} contains a path separator`);
  }
};

/** The exact shape of the sibling temp file `syncDown` (sync.ts) creates
 *  before an atomic rename into place: `<real-name>.sync-<uuid>.tmp`, where
 *  `<uuid>` is a canonical `randomUUID()` string. A SIGKILL in the gap between
 *  the download finishing and the rename — this orchestrator's `Pause now`
 *  and `Cancel` both do exactly that, as a routine operation — leaves one of
 *  these sitting beside the real file it was about to become, permanently,
 *  unless something accounts for it. Two things do, deliberately, because
 *  either alone is insufficient: `localManifest` (manifest.ts) uses this
 *  predicate to exclude such a file from every manifest view, so it can never
 *  be hashed and pushed to blob as a real document no matter who wrote it or
 *  how it got there — that is the half that actually protects blob. `syncDown`
 *  additionally sweeps any stale sibling matching THIS pattern before writing
 *  a destination, which is the half that stops it accumulating on disk
 *  forever (it only clears siblings of paths a sync actually revisits, which
 *  is the narrow, deliberate scope — not a recursive tree sweep).
 *
 *  It lives here, in the leaf module both `sync.ts` and `manifest.ts` already
 *  import, rather than in either of them: a predicate over the SHAPE of a
 *  path is exactly what this module is for, alongside `blobPathFor`,
 *  `localPathFor` and `assertSafeSegment` — and putting it in `sync.ts`
 *  (which imports `localManifest`/`diff` from `manifest.ts`) would have made
 *  `manifest.ts` import it back, a real circular dependency for no benefit
 *  when a cycle-free home was sitting right here. Exported once, from here,
 *  so the shape is asserted in exactly one place; a second, independently
 *  typed copy anywhere else is exactly the kind of thing that drifts. */
export const SYNC_TEMP_PATTERN =
  /\.sync-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/;
export const isSyncTempFile = (name: string): boolean => SYNC_TEMP_PATTERN.test(name);

/** How old a `.sync-*.tmp` file must be before `syncDown`'s sweep (sync.ts)
 *  will remove it. The sweep has no way to tell, from the name alone, a
 *  crashed run's orphan apart from a file a CONCURRENTLY running syncDown is
 *  writing right now — two issues against the same project (e.g. `requirements`
 *  and `datamodel` on different features) both call syncDown and can compute
 *  the same diff, so both can be mid-download of the same destination at once.
 *  Deleting the wrong one is not a missed cleanup, it is `rename()` throwing
 *  `ENOENT` in the middle of someone else's sync and aborting it outright.
 *
 *  An age threshold separates the two cases with no coordination between
 *  processes: a temp file being actively written is seconds old; a crashed
 *  run's orphan is, by definition, not. An orphan younger than this threshold
 *  is INERT in the meantime — `isSyncTempFile` above already excludes it from
 *  every manifest view, so it cannot be hashed and pushed to blob regardless
 *  of its age. The sweep only bounds litter on disk, never blob's safety, so
 *  it can afford to be lazy and must not be aggressive. Six hours is
 *  deliberately generous against a very large artefact still downloading:
 *  getting this threshold wrong in the "too long" direction costs nothing;
 *  wrong in the "too short" direction can delete a live sync's own file.
 *  Rejected alternatives: a lock (disproportionate for litter collection, and
 *  nothing else here coordinates between processes); dropping the sweep
 *  (orphans then accumulate forever); tolerating `rename()`'s `ENOENT` (hides
 *  a genuine failure, and this module exists to make failure modes visible). */
export const SYNC_TEMP_MIN_AGE_MS = 6 * 60 * 60 * 1000;
