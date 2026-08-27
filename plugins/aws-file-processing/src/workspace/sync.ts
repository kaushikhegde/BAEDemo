import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import {
  localPathFor, projectPrefix, assertSafeSegment, isSyncTempFile,
  SYNC_TEMP_MIN_AGE_MS,
} from "./paths.js";
import { localManifest, diff, type Entry } from "./manifest.js";
import { WORKSPACE } from "../shared/config.js";
import {
  ensureWorkspaceBucket, getObjectStream, headObject, listObjects, uploadStream,
  type Storage,
} from "../shared/storage.js";
import { log } from "../shared/logger.js";

export interface SyncOpts { prefix?: string; dryRun?: boolean }

export { ensureWorkspaceBucket };

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
 *  tool call's params — and unlike an object KEY coming back off
 *  `ListObjectsV2`, nothing upstream has validated them. Left unchecked,
 *  `project = "../../etc"` resolves through `path.join` in `localManifest` to a
 *  real directory OUTSIDE `root/projects/` — and `localManifest` walks it,
 *  hashing whatever it finds there, before `objectKeyFor`'s own guard three
 *  frames in gets a chance to throw. That is a real local file read outside the
 *  sandbox as a SIDE EFFECT of a bad string, not a caught error. Every exported
 *  entry point in this module validates its scope here, first, so a
 *  project/prefix is trusted by the time it reaches `localManifest` or
 *  `remoteManifest`. A prefix is multi-segment by design
 *  (`"MVP/requirements"`), so each segment is checked individually with the
 *  same `assertSafeSegment` an object key gets; a leading/trailing slash is
 *  trimmed first, matching `remoteManifest`'s own prefix handling, so
 *  `"/documents/"` is accepted the way a caller would type it rather than
 *  refused as an "empty segment". */
const assertSafeScope = (project: string, prefix?: string): void => {
  assertSafeSegment(project);
  if (prefix) {
    for (const seg of stripSlashes(prefix).split("/")) assertSafeSegment(seg);
  }
};

/**
 * How many HeadObject calls `remoteManifest` keeps in flight.
 *
 * This is the one place S3 costs a call Azure did not. `listBlobsFlat({
 * includeMetadata: true })` returned every blob's user metadata inline, so a
 * remote manifest was one paginated LIST. `ListObjectsV2` returns key, size,
 * ETag and storage class and NOTHING user-defined — the sha256 this module
 * compares on lives in object metadata, which only HeadObject (or
 * GetObjectAttributes) will hand back. So: LIST to enumerate, then one HEAD per
 * key.
 *
 * Rejected alternatives, since the extra call is the obvious thing to want to
 * avoid: the ETag is an MD5 for a single-part upload and a hash-of-hashes for a
 * multipart one, so it is neither the digest we compare on nor stable across
 * part sizes; S3's own `ChecksumSHA256` is per-part for a multipart upload and
 * still needs a per-object call to read; and a manifest object written beside
 * the tree is a third opinion about what a project contains, which is exactly
 * what `syncDown`'s own doc comment says must not exist.
 *
 * Sixteen is chosen against the shape of the data rather than a benchmark: a
 * project here is hundreds of small files, HEAD is a round trip with no body,
 * and the SDK's default connection pool comfortably holds this many. Raising it
 * trades latency for burst request cost; lowering it makes a large project's
 * status call visibly slow.
 */
const HEAD_CONCURRENCY = 16;

/** The hash lives in object METADATA, so a comparison costs a HEAD rather than
 *  a download. Content-addressed rather than mtime-based deliberately: a
 *  syncDown rewrites mtimes, and an mtime comparison would then push every file
 *  straight back up. */
export const remoteManifest = async (
  s: Storage, project: string, prefix?: string,
): Promise<Entry[]> => {
  assertSafeScope(project, prefix);
  const bucket = s.bucket(WORKSPACE);
  const full = prefix ? `${projectPrefix(project)}${stripSlashes(prefix)}/` : projectPrefix(project);

  const listed: Array<{ key: string; size: number }> = [];
  for await (const o of listObjects(s, bucket, full)) listed.push(o);

  const out: Entry[] = new Array(listed.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= listed.length) return;
      const o = listed[i];
      let sha256 = "";
      try {
        sha256 = (await headObject(s, bucket, o.key)).metadata.sha256 ?? "";
      } catch {
        // An object whose metadata cannot be read is reported with an EMPTY
        // hash, which `diff` treats as "differs from local" — so it is pushed
        // again rather than silently assumed to match. Wrong in the safe
        // direction: a needless re-upload costs bandwidth, a false "already in
        // sync" costs the file.
        sha256 = "";
      }
      // Written by index so the result is deterministic regardless of which
      // worker finishes first; the caller's `diff` is order-independent but a
      // manifest that reshuffles between calls is miserable to debug.
      out[i] = { path: o.key, sha256, bytes: o.size };
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(HEAD_CONCURRENCY, listed.length) }, worker));
  return out;
};

const paths = (es: Entry[]) => es.map((e) => e.path);

export const syncStatus = async (
  s: Storage, root: string, project: string, prefix?: string,
): Promise<{ onlyLocal: string[]; onlyRemote: string[]; differing: string[]; same: number }> => {
  assertSafeScope(project, prefix);
  // syncUp and syncDown both call this before touching S3; syncStatus is a read
  // but ListObjectsV2 on a bucket that has never been created throws
  // NoSuchBucket rather than returning an empty list — and "what's out of
  // sync?" is the natural first command against a brand new workspace, so a
  // first-run-ever must not blow up here.
  await ensureWorkspaceBucket(s);
  const [local, remote] = await Promise.all([
    localManifest(root, project, prefix),
    remoteManifest(s, project, prefix),
  ]);
  const d = diff(local, remote);
  return {
    onlyLocal: paths(d.onlyLocal),
    onlyRemote: paths(d.onlyRemote),
    differing: paths(d.differing),
    same: d.same.length,
  };
};

export const syncUp = async (
  s: Storage, root: string, project: string, opts: SyncOpts = {},
): Promise<{ pushed: number; skipped: number; bytes: number }> => {
  assertSafeScope(project, opts.prefix);
  await ensureWorkspaceBucket(s);
  const [local, remote] = await Promise.all([
    localManifest(root, project, opts.prefix),
    remoteManifest(s, project, opts.prefix),
  ]);
  const d = diff(local, remote);
  const toPush = [...d.onlyLocal, ...d.differing];
  const bucket = s.bucket(WORKSPACE);
  let bytes = 0;
  for (const e of toPush) {
    if (!opts.dryRun) {
      // Streamed from disk through lib-storage: a large artefact is never
      // resident in memory. An S3 write is atomic from a reader's perspective —
      // a single PutObject, or a multipart upload made visible only by
      // CompleteMultipartUpload — so a concurrent syncDown can only ever observe
      // the old content or the new content, never a half-written object. That
      // asymmetry is why syncDown (writing to the local disk, which has no such
      // guarantee) needs the temp-file dance below and syncUp does not.
      //
      // S3 is read-after-write consistent for new objects AND for overwrites
      // since December 2020, so the pushed content is immediately what the next
      // remoteManifest will see. That was NOT true when this design was first
      // written for blob storage, and it is worth stating: a sync that could
      // read its own stale write would report a file as still differing
      // immediately after pushing it.
      await uploadStream(
        s, bucket, e.path, createReadStream(localPathFor(e.path, root)),
        { metadata: { sha256: e.sha256 } },
      );
    }
    bytes += e.bytes;
  }
  // d.onlyRemote is deliberately ignored: syncUp never deletes an object. A file
  // present only in S3 is exactly what a caller must be able to trust survives
  // an accidental `rm -rf projects/` followed by a push.
  log.info("workspace.sync_up", {
    project, pushed: toPush.length, skipped: d.same.length,
    bytes, dryRun: Boolean(opts.dryRun),
  });
  return { pushed: toPush.length, skipped: d.same.length, bytes };
};

/**
 * Pull a project's tree DOWN from S3. Nothing in production may call this.
 *
 * The workspace bucket is an EXPORT: Postgres is the system of record (see
 * `core/materialise.ts` — "the store is the system of record now"), the tree
 * is materialised out of it per run and harvested back, and `syncUp` mirrors
 * the result to S3 for durability. A read path from S3 would make it a
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
 *
 * One S3-specific consequence worth knowing: object storage has no directories,
 * only keys containing slashes, so a project restored this way comes back with
 * every FILE in place and none of the empty scaffold folders nothing ever wrote
 * to — an untouched `requirements/UI/`, an empty `documents/` before the first
 * upload. Anything expecting a directory to exist before it can write into it
 * is the failure mode to watch for.
 */
export const syncDown = async (
  s: Storage, root: string, project: string, opts: SyncOpts = {},
): Promise<{ pulled: number; skipped: number; bytes: number }> => {
  assertSafeScope(project, opts.prefix);
  await ensureWorkspaceBucket(s);
  const [local, remote] = await Promise.all([
    localManifest(root, project, opts.prefix),
    remoteManifest(s, project, opts.prefix),
  ]);
  // Invert the diff: from S3's point of view, "onlyLocal" here means "only in
  // S3, absent on disk" — exactly what syncDown needs to pull.
  const d = diff(remote, local);
  const toPull = [...d.onlyLocal, ...d.differing];
  const bucket = s.bucket(WORKSPACE);
  let pulled = 0;
  let refused = 0;
  let bytes = 0;
  for (const e of toPull) {
    // `e.path` came straight off `ListObjectsV2` — untrusted input: S3 is the
    // source of truth, so an object KEY is not something this app wrote and
    // therefore not something it can trust. It is a MORE pointed rule on S3
    // than it was on blob storage, because a key is one opaque string with no
    // structure the service enforces: `../../etc/passwd` is a perfectly legal
    // key that any writer to the bucket can create.
    //
    // Refusing THIS one entry and continuing is the deliberate choice: aborting
    // the whole sync over one bad name would block every legitimate file queued
    // behind it, and dropping it with no trace would let a corrupt or hostile
    // object disappear from view with nobody told.
    let dest: string;
    try {
      dest = localPathFor(e.path, root);
    } catch (err) {
      refused++;
      log.warn("workspace.sync_down.unsafe_key_skipped", {
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
      // Streaming GetObject straight onto the destination path would leave a
      // TRUNCATED file sitting at the real path after an interrupted download
      // (network drop, a killed process). Downloading to a sibling temp file
      // and renaming into place avoids that: rename() within one directory is
      // atomic, so `dest` is always either the previous whole file or the new
      // whole file, never a partial one — a half-written file that a later hash
      // check calls "already in sync" is exactly the failure this guards
      // against.
      const tmp = `${dest}.sync-${randomUUID()}.tmp`;
      try {
        await pipeline(await getObjectStream(s, bucket, e.path), createWriteStream(tmp));
        await rename(tmp, dest);
      } catch (err) {
        await rm(tmp, { force: true }).catch(() => {});
        throw err;
      }
    }
    bytes += e.bytes;
    pulled++;
  }
  // d.onlyRemote here means "present locally, absent in S3" — never deleted.
  // An accidental `rm -rf projects/` followed by a pull must not compound the
  // damage; skipped folds together files already in sync and entries refused
  // above, both of which the log line makes visible on their own.
  log.info("workspace.sync_down", {
    project, pulled, skipped: d.same.length + refused,
    bytes, dryRun: Boolean(opts.dryRun),
  });
  return { pulled, skipped: d.same.length + refused, bytes };
};
