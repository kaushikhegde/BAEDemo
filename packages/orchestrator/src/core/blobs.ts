
/**
 * Where bytes physically live.
 *
 * The one seam that makes the byte store swappable. `core/documents.ts` was
 * written expecting this — "Swapping in an object-store backend must not touch
 * a single caller" — and until now there was nothing to swap: `put`, `get` and
 * `read` reached into `blobs.content` themselves.
 *
 * Content is addressed by SHA-256 on both sides of the seam, so a backend never
 * overwrites: the same hash is the same bytes. That is what keeps dedup and the
 * `changed: false` harvest contract intact across the swap, and it is why
 * `write` may be called twice for one blob and must not complain.
 *
 * The LOCATOR is opaque to callers and is what `blobs.blob_path` records. It
 * carries a backend prefix so a half-migrated table is readable: a row still
 * reading `pg:<sha>` has not been moved to object storage, and one that has
 * cannot be mistaken for one that has not.
 */
export interface BlobBackend {
  /** Store bytes under their own hash. Idempotent. Returns the locator to record. */
  write(sha256: string, content: Buffer, contentType: string | null): Promise<string>;
  /** Fetch by a locator `write` returned. Null when nothing is stored there. */
  read(locator: string): Promise<Buffer | null>;
}


/**
 * Bytes in memory, for tests and for a run with no object store configured.
 *
 * This replaced `postgresBlobBackend`, which put them in `blobs.content` — a
 * column 011 dropped. Keeping that backend alive would have kept the column
 * alive with it, and a column that exists is a column something eventually
 * writes to; the rule is that no document content lives in the database at
 * all, and the only way to hold that rule is to remove the place it could go.
 *
 * NOT a fallback for production. `createOrchestrator` refuses to boot without a
 * real backend rather than quietly using this one — an install that thinks it
 * is storing documents and is holding them in a Map until the process exits is
 * the worst of the available failures.
 */
export const memoryBlobBackend = (): BlobBackend => {
  const bytes = new Map<string, Buffer>();
  return {
    async write(sha256, content) {
      // Content-addressed, so a second write of the same hash is the same
      // bytes and there is nothing to overwrite.
      if (!bytes.has(sha256)) bytes.set(sha256, content);
      return `memory:${sha256}`;
    },
    async read(locator) {
      if (!locator.startsWith("memory:")) return null;
      return bytes.get(locator.slice("memory:".length)) ?? null;
    },
  };
};

// `postgresBlobBackend` lived here. It inserted into `blobs.content` and read
// it back, which was every install's byte store until documents moved to object
// storage. Deleted rather than left dormant: it is the only thing that could
// have written to a dropped column, and a dormant path to a rule-breaking
// place is a rule that lasts until somebody is in a hurry.
