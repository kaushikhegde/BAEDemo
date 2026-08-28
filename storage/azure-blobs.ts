import { BlobServiceClient } from "@azure/storage-blob";
import type { BlobBackend } from "../packages/orchestrator/src/index.js";
import { blobNameFor } from "./blob-name.js";

/** One block. Matches the plugin's own staged upload so the two agree. */
const BLOCK_BYTES = 8 * 1024 * 1024;
const CONCURRENCY = 4;

/** Re-exported so an existing importer of this module is unaffected by the
 *  move; the definition now lives in `blob-name.ts`, which carries no SDK. */
export { blobNameFor };

export interface AzureBlobOptions {
  connectionString: string;
  /** Defaults to "documents". Named in the locator so a container rename is visible. */
  container?: string;
}

/**
 * Bytes in Azure Blob Storage, addressed by their own SHA-256.
 *
 * Lives here rather than in `packages/orchestrator/` deliberately: that package
 * declares exactly three dependencies (`@electric-sql/pglite`, `express`,
 * `yaml`) and an object-store client is not going to be the fourth. It is
 * injected through `config.blobs`, the way `adapters` already are.
 *
 * Never overwrites: the same hash is the same bytes, so a second write of a
 * blob that exists is a no-op rather than a conflict. That is what lets two
 * features uploading the same document store one copy, and what lets `put()`
 * answer "unchanged" from a hash comparison without downloading anything.
 */
export const azureBlobBackend = (opts: AzureBlobOptions): BlobBackend => {
  const container = opts.container ?? "documents";
  const service = BlobServiceClient.fromConnectionString(opts.connectionString);
  const client = service.getContainerClient(container);
  let ensured: Promise<unknown> | null = null;
  const ensure = () => (ensured ??= client.createIfNotExists());

  return {
    async write(sha256, content, contentType) {
      await ensure();
      const name = blobNameFor(sha256);
      const locator = `azure:${container}/${name}`;
      const blob = client.getBlockBlobClient(name);

      // Content-addressed, so an existing blob already holds exactly these
      // bytes. Skipping the upload is not an optimisation — re-uploading would
      // burn the egress and time this whole design exists to avoid.
      if (await blob.exists()) return locator;

      const headers = contentType ? { blobContentType: contentType } : undefined;
      if (content.length <= BLOCK_BYTES) {
        await blob.upload(content, content.length, { blobHTTPHeaders: headers });
      } else {
        await blob.uploadData(content, {
          blockSize: BLOCK_BYTES,
          concurrency: CONCURRENCY,
          blobHTTPHeaders: headers,
        });
      }
      return locator;
    },

    async read(locator) {
      // A locator from another backend is not this backend's to answer for.
      if (!locator.startsWith(`azure:${container}/`)) return null;
      const name = locator.slice(`azure:${container}/`.length);
      try {
        return await client.getBlockBlobClient(name).downloadToBuffer();
      } catch (e: any) {
        // A missing blob is a real state, not an error: a store restored
        // without its container, or a locator recorded before a failed write.
        if (e?.statusCode === 404) return null;
        throw e;
      }
    },
  };
};
