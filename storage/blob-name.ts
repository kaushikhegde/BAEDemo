/**
 * The blob's name IS its content hash, fanned out two levels.
 *
 * Shared by every backend, and in its own module for a reason that is not
 * tidiness: `s3-blobs.ts` needs it, and importing it from `azure-blobs.ts`
 * would pull `@azure/storage-blob` into the AWS path. The rule this repo now
 * holds is that a Claude/AWS install loads nothing Azure and a Codex/Azure
 * install loads nothing AWS — a shared import would quietly break that.
 *
 * Fan-out because a single flat prefix holding millions of keys is slow to list
 * and unpleasant to browse; two levels of two hex characters gives 65,536
 * buckets, which is ample and costs nothing.
 *
 * Validated rather than trusted: the name is derived from caller-supplied text,
 * and a value that is not a hash would either create a blob nothing can find
 * again or — with `../` in it — address a key space this backend does not own.
 */
const SHA256 = /^[0-9a-f]{64}$/;

export const blobNameFor = (sha256: string): string => {
  if (!SHA256.test(sha256)) {
    throw new Error(`blob name must be a lowercase hex sha256, got ${JSON.stringify(sha256)}`);
  }
  return `${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}`;
};
