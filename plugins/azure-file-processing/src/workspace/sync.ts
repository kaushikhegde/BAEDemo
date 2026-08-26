import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  WORKSPACE_CONTAINER, localPathFor, projectPrefix, assertSafeSegment, isSyncTempFile,
  SYNC_TEMP_MIN_AGE_MS,
} from "./paths.js";
import { localManifest, diff, type Entry } from "./manifest.js";
import type { Storage } from "../shared/storage.js";
import { log } from "../shared/logger.js";

export interface SyncOpts { prefix?: string; dryRun?: boolean }

export const ensureWorkspaceContainer = async (s: Storage): Promise<void> => {
  await s.blob.getContainerClient(WORKSPACE_CONTAINER).createIfNotExists();
};

const stripSlashes = (p: string): string => p.replace(/^\/+|\/+$/g, "");

/** Removes any STALE `.sync-*.tmp` sibling of `dest` left by a syncDown that
 *  was killed between its download completing and its rename into place.
 *  Scoped to exactly the destination about to be written — not a recursive
 *  sweep of the tree — because that is the one place this run is already
 *  about to touch; anything a sync never revisits stays put and is still
 *  excluded from every manifest view by `isSyncTempFile` (paths.ts).
 *
 *  "Stale" is judged by mtime against `SYNC_TEMP_MIN_AGE_MS` (paths.ts), not
 *  by matching the name alone: two issues syncing the same project can both
 *  be mid-download of the same destination at once (see that constant's
 *  comment), and deleting the file the OTHER one is actively writing would
 *  make its `rename()` throw ENOENT and abort its entire syncDown. A file
 *  younger than the threshold is left alone even though its name matches —
 *  it might be exactly that concurrent write. Absent destination directory
 *  is not an error: there is nothing to sweep. A `stat` failing with ENOENT
 *  mid-sweep (the file finished and was renamed, or another sweep already
 *  took it) is not an error either — it is simply gone, which was the goal. */
const sweepStaleTemp = async (dest: string): Promise<void> => {
  const dir = dirname(dest);
  const base = basename(dest);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (e: unknown) {
    const err = e as NodeJS.ErrnoException;
    if (err?.code === "ENOENT") return;
    throw e;
  }
  for (const n of names) {
    if (n === base || !n.startsWith(`${base}.`) || !isSyncTempFile(n)) continue;
    const p = join(dir, n);
    let st: Awaited<ReturnType<typeof stat>>;
    try {
      st = await stat(p);
    } catch (e: unknown) {
      const err = e as NodeJS.ErrnoException;
      if (err?.code === "ENOENT") continue;
      throw e;
    }
    if (Date.now() - st.mtimeMs > SYNC_TEMP_MIN_AGE_MS) {
      await rm(p, { force: true });
    }
  }
};

/** `project` and `prefix` reach this module as bare strings — a CLI argument, a
 *  tool call's params — and unlike a blob NAME coming back off `listBlobsFlat`,
 *  nothing upstream has validated them (Task 2 left `localManifest`'s
 *  project/prefix arguments unchecked, deliberately, for this module to
 *  decide). Left unchecked, `project = "../../etc"` resolves through
 *  `path.join` in `localManifest` to a real directory OUTSIDE
 *  `root/projects/` — and `localManifest` walks it, hashing whatever it finds
 *  there, before `blobPathFor`'s own guard three frames in gets a chance to
 *  throw. That is a real local file read outside the sandbox as a SIDE EFFECT
 *  of a bad string, not a caught error. Every exported entry point in this
 *  module validates its scope here, first, so a project/prefix is trusted by
 *  the time it reaches `localManifest` or `remoteManifest`. A prefix is
 *  multi-segment by design (`"MVP/requirements"`), so each segment is checked
 *  individually with the same `assertSafeSegment` Task 1 uses for a blob path;
 *  a leading/trailing slash is trimmed first, matching `remoteManifest`'s own
 *  prefix handling, so `"/documents/"` is accepted the way a caller would type
 *  it rather than refused as an "empty segment". */
const assertSafeScope = (project: string, prefix?: string): void => {
  assertSafeSegment(project);
  if (prefix) {
    for (const seg of stripSlashes(prefix).split("/")) assertSafeSegment(seg);
  }
};

/** The hash lives in blob METADATA, so a comparison costs a list call rather
 *  than a download. Content-addressed rather than mtime-based deliberately: a
 *  syncDown rewrites mtimes, and an mtime comparison would then push every file
 *  straight back up. */
export const remoteManifest = async (
  s: Storage, project: string, prefix?: string,
): Promise<Entry[]> => {
  assertSafeScope(project, prefix);
  const c = s.blob.getContainerClient(WORKSPACE_CONTAINER);
  const full = prefix ? `${projectPrefix(project)}${stripSlashes(prefix)}/` : projectPrefix(project);
  const out: Entry[] = [];
  for await (const b of c.listBlobsFlat({ prefix: full, includeMetadata: true })) {
    out.push({
      path: b.name,
      sha256: b.metadata?.sha256 ?? "",
      bytes: b.properties.contentLength ?? 0,
    });
  }
  return out;
};

const paths = (es: Entry[]) => es.map((e) => e.path);

export const syncStatus = async (
  s: Storage, root: string, project: string, prefix?: string,
): Promise<{ onlyLocal: string[]; onlyBlob: string[]; differing: string[]; same: number }> => {
  assertSafeScope(project, prefix);
  // syncUp and syncDown both call this before touching blob; syncStatus is a
  // read but listBlobsFlat() on a container that has never been created
  // throws RestError 404 rather than returning an empty list — and "what's
  // out of sync?" is the natural first command against a brand new
  // workspace, so a first-run-ever must not blow up here.
  await ensureWorkspaceContainer(s);
  const [local, remote] = await Promise.all([
    localManifest(root, project, prefix),
    remoteManifest(s, project, prefix),
  ]);
  const d = diff(local, remote);
  return {
    onlyLocal: paths(d.onlyLocal),
    onlyBlob: paths(d.onlyRemote),
    differing: paths(d.differing),
    same: d.same.length,
  };
};

export const syncUp = async (
  s: Storage, root: string, project: string, opts: SyncOpts = {},
): Promise<{ pushed: number; skipped: number; bytes: number }> => {
  assertSafeScope(project, opts.prefix);
  await ensureWorkspaceContainer(s);
  const [local, remote] = await Promise.all([
    localManifest(root, project, opts.prefix),
    remoteManifest(s, project, opts.prefix),
  ]);
  const d = diff(local, remote);
  const toPush = [...d.onlyLocal, ...d.differing];
  const c = s.blob.getContainerClient(WORKSPACE_CONTAINER);
  let bytes = 0;
  for (const e of toPush) {
    if (!opts.dryRun) {
      // uploadFile streams from disk: a large artefact is never resident in
      // memory. A blob write is atomic from a reader's perspective — a single
      // Put Blob, or staged blocks committed in one call — so a concurrent
      // syncDown can only ever observe the old content or the new content,
      // never a half-written blob. That asymmetry is why syncDown (writing to
      // the local disk, which has no such guarantee) needs the temp-file dance
      // below and syncUp does not.
      await c.getBlockBlobClient(e.path).uploadFile(localPathFor(e.path, root), {
        metadata: { sha256: e.sha256 },
      });
    }
    bytes += e.bytes;
  }
  // d.onlyRemote is deliberately ignored: syncUp never deletes a blob. A file
  // present only in blob is exactly what a caller must be able to trust
  // survives an accidental `rm -rf projects/` followed by a push.
  log.info("workspace.sync_up", {
    project, pushed: toPush.length, skipped: d.same.length,
    bytes, dryRun: Boolean(opts.dryRun),
  });
  return { pushed: toPush.length, skipped: d.same.length, bytes };
};

/**
 * Pull a project's tree DOWN from blob. Nothing in production may call this.
 *
 * The workspace container is an EXPORT: Postgres is the system of record (see
 * `core/materialise.ts` — "the store is the system of record now"), the tree
 * is materialised out of it per run and harvested back, and `syncUp` mirrors
 * the result to blob for durability. A read path from blob would make it a
 * third opinion about what a project contains, competing with the store and
 * with whatever is on the local disk at the time — which is precisely the
 * disagreement that let `POST /api/projects` refuse to create a project the
 * database had never heard of.
 *
 * It is kept, exported and tested because the behaviour is real and an
 * operator restoring a lost workspace by hand is a legitimate use. What is
 * NOT legitimate is a code path reaching for it automatically, so
 * `test/sync-one-way.test.ts` asserts that nothing under `src/` imports it.
 * Deleting it would only mean rewriting it, worse, the first time somebody
 * needs a restore.
 */
export const syncDown = async (
  s: Storage, root: string, project: string, opts: SyncOpts = {},
): Promise<{ pulled: number; skipped: number; bytes: number }> => {
  assertSafeScope(project, opts.prefix);
  await ensureWorkspaceContainer(s);
  const [local, remote] = await Promise.all([
    localManifest(root, project, opts.prefix),
    remoteManifest(s, project, opts.prefix),
  ]);
  // Invert the diff: from blob's point of view, "onlyLocal" here means "only
  // in blob, absent on disk" — exactly what syncDown needs to pull.
  const d = diff(remote, local);
  const toPull = [...d.onlyLocal, ...d.differing];
  const c = s.blob.getContainerClient(WORKSPACE_CONTAINER);
  let pulled = 0;
  let refused = 0;
  let bytes = 0;
  for (const e of toPull) {
    // `e.path` came straight off `listBlobsFlat` — untrusted input, exactly
    // per Task 1's own note on `localPathFor`: blob is the source of truth, so
    // a blob NAME is not something this app wrote and therefore not something
    // it can trust. Refusing THIS one entry and continuing is the deliberate
    // choice: aborting the whole sync over one bad name would block every
    // legitimate file queued behind it, and dropping it with no trace would
    // let a corrupt or hostile blob disappear from view with nobody told.
    let dest: string;
    try {
      dest = localPathFor(e.path, root);
    } catch (err) {
      refused++;
      log.warn("workspace.sync_down.unsafe_blob_skipped", {
        project,
        path: e.path.slice(0, 300),
        reason: String((err as Error).message).slice(0, 150),
      });
      continue;
    }
    if (!opts.dryRun) {
      await mkdir(dirname(dest), { recursive: true });
      // A stale temp file from a PREVIOUS syncDown of this exact destination
      // that was killed between its download completing and its rename (see
      // isSyncTempFile in paths.ts) must not accumulate on disk forever. Swept
      // before every write, not just after a crash is suspected — cheap, and
      // it means a killed run's leftover is cleared the very next time this
      // destination is touched rather than needing a separate recovery step.
      await sweepStaleTemp(dest);
      // `BlockBlobClient.downloadToFile` writes the destination path directly
      // — it has no temp file of its own. An interrupted download (network
      // drop, a killed process) would otherwise leave a TRUNCATED file sitting
      // at the real path. Downloading to a sibling temp file and renaming into
      // place avoids that: rename() within one directory is atomic, so `dest`
      // is always either the previous whole file or the new whole file, never
      // a partial one — a half-written file that a later hash check calls
      // "already in sync" is exactly the failure this guards against.
      const tmp = `${dest}.sync-${randomUUID()}.tmp`;
      try {
        await c.getBlockBlobClient(e.path).downloadToFile(tmp);
        await rename(tmp, dest);
      } catch (err) {
        await rm(tmp, { force: true }).catch(() => {});
        throw err;
      }
    }
    bytes += e.bytes;
    pulled++;
  }
  // d.onlyRemote here means "present locally, absent in blob" — never deleted.
  // An accidental `rm -rf projects/` followed by a pull must not compound the
  // damage; skipped folds together files already in sync and entries refused
  // above, both of which the log line makes visible on their own.
  log.info("workspace.sync_down", {
    project, pulled, skipped: d.same.length + refused,
    bytes, dryRun: Boolean(opts.dryRun),
  });
  return { pulled, skipped: d.same.length + refused, bytes };
};
