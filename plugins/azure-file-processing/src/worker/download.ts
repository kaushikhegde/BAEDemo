import { createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { basename, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { UPLOADS_CONTAINER, type Config } from "../shared/config.js";
import type { Storage } from "../shared/storage.js";

export interface Downloaded { path: string; bytes: number; sha256: string }

export const downloadToTemp = async (
  s: Storage, cfg: Config, blobPath: string,
  opts: { expectSha256?: string | null } = {},
): Promise<Downloaded> => {
  await mkdir(cfg.tempDir, { recursive: true });
  // A unique prefix: two workers may hold the same blob at the same time, and a
  // shared path would have one truncate the other's file mid-read.
  const dest = join(cfg.tempDir, `${randomUUID()}-${basename(blobPath)}`);

  const blob = s.blob.getContainerClient(UPLOADS_CONTAINER).getBlockBlobClient(blobPath);
  const dl = await blob.download();
  if (!dl.readableStreamBody) throw new Error(`blob ${blobPath} returned no body`);

  const hash = createHash("sha256");
  let bytes = 0;
  const tap = new Transform({
    transform(chunk, _enc, cb) { hash.update(chunk); bytes += chunk.length; cb(null, chunk); },
  });

  // Streamed with default 64 KiB buffers: peak memory is a buffer, not a file.
  try {
    await pipeline(dl.readableStreamBody, tap, createWriteStream(dest));
  } catch (err) {
    // A network drop on the read side or a write failure (disk full, EACCES)
    // must not leave a partial file behind for nobody to clean up. The
    // original error is what the caller needs, so it is rethrown unchanged;
    // a failed unlink here must not mask it.
    await rm(dest, { force: true }).catch(() => {});
    throw err;
  }

  const sha256 = hash.digest("hex");
  if (opts.expectSha256 && opts.expectSha256 !== sha256) {
    await rm(dest, { force: true });
    const err = new Error(
      `checksum_mismatch: declared ${opts.expectSha256}, downloaded ${sha256}`) as Error & { tempPath?: string };
    err.tempPath = dest;
    throw err;
  }
  return { path: dest, bytes, sha256 };
};
