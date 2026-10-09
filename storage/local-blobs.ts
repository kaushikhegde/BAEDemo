import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import type { BlobBackend } from "../packages/orchestrator/src/index.js";
import { blobNameFor } from "./blob-name.js";

/**
 * Bytes in a folder on the machine running the stack, addressed by their own
 * SHA-256. The store for an install with no Docker and no cloud account — the
 * third member of the family whose other two are `s3-blobs.ts` and
 * `azure-blobs.ts`, and the same shape as both.
 *
 * Unlike LocalStack it survives a restart: the folder is the record, so there
 * is nothing to lose when a container goes away.
 *
 * The locator is `local:<name>` and deliberately does NOT name the folder, so
 * the workspace can be moved or copied to another machine without rewriting a
 * row. `s3:` and `azure:` locators are refused, which is what keeps
 * `compositeBlobBackend` safe when this store and an object store are both
 * configured.
 */
const PREFIX = "local:";
const NAME = /^[0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f]{64}$/;

export const localBlobBackend = (opts: { dir: string }): BlobBackend => ({
  async write(sha256, content) {
    const name = blobNameFor(sha256);
    const file = join(opts.dir, name);
    // Content-addressed: a file already under this name holds these bytes.
    if (await exists(file)) return PREFIX + name;

    // Written beside its final name and renamed into place, so a crash
    // mid-write never leaves a truncated file under a hash it does not match.
    await mkdir(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    try {
      await writeFile(tmp, content);
      await rename(tmp, file);
    } catch (e) {
      await unlink(tmp).catch(() => {});
      throw e;
    }
    return PREFIX + name;
  },

  async read(locator) {
    if (!locator.startsWith(PREFIX)) return null;
    const name = locator.slice(PREFIX.length);
    // Checked rather than joined blindly: a locator is a database value, and
    // `../` in one would read a file this store does not own.
    if (!NAME.test(name)) return null;
    try {
      return await readFile(join(opts.dir, name));
    } catch (e: any) {
      if (e?.code === "ENOENT") return null;
      throw e;
    }
  },
});

const exists = (file: string) => stat(file).then(() => true, () => false);
