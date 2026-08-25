import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { BlobServiceClient } from "@azure/storage-blob";
import { loadConfig, JOB_QUEUE, POISON_QUEUE } from "../src/shared/config.js";
import { getStorage, ensureStorage, type Storage } from "../src/shared/storage.js";
import { readArtifactJson } from "../src/orchestrator/artifacts.js";
import { createUploadUrl } from "../src/orchestrator/tools/create-upload-url.js";
import { startJob } from "../src/orchestrator/tools/start-job.js";
import { fetchChunks } from "../src/orchestrator/tools/fetch-chunks.js";
import { runOnce } from "../src/worker/index.js";
import type { ChunkIndexEntry } from "../src/worker/artifacts.js";

const here = dirname(fileURLToPath(import.meta.url));
const cfg = loadConfig();
const storage = getStorage(cfg);
const ctx = { cfg, storage };
const dir = mkdtempSync(join(tmpdir(), "afp-fc-"));
let jobId = "";
let ids: string[] = [];

// The queue is shared with every other *.int.test.ts file, and
// start-job.int.test.ts deliberately enqueues jobs it never consumes. Without
// draining first, runOnce() below can pick up a stray message from another
// file instead of the one this file just queued — see results.int.test.ts
// for the identical hazard and the same fix.
const drainQueue = async (name: string) => {
  const q = storage.queue(name);
  for (;;) {
    const r = await q.receiveMessages({ numberOfMessages: 32 });
    if (!r.receivedMessageItems.length) return;
    for (const m of r.receivedMessageItems) await q.deleteMessage(m.messageId, m.popReceipt);
  }
};

interface RecordedDownload { blobPath: string; offset: number | undefined; count: number | undefined }

/**
 * Wraps just the slice of the real BlobServiceClient → ContainerClient →
 * BlockBlobClient chain that artifacts.ts's `blob()` helper walks
 * (getContainerClient → getBlockBlobClient → downloadToBuffer), recording
 * every downloadToBuffer call's own arguments before delegating to the real
 * client — production code is never touched. This is the discriminator: a
 * genuine ranged read calls downloadToBuffer(offset, count) with both
 * defined; a whole-file read sliced in memory calls it bare, so both would
 * be undefined.
 */
const wrapStorageForRangeAssertion = (storage: Storage, calls: RecordedDownload[]): Storage => {
  const realBlobService = storage.blob;
  const fakeBlobService = {
    getContainerClient(containerName: string) {
      const realContainer = realBlobService.getContainerClient(containerName);
      return {
        getBlockBlobClient(blobPath: string) {
          const realBlobClient = realContainer.getBlockBlobClient(blobPath);
          return {
            downloadToBuffer(offset?: number, count?: number) {
              calls.push({ blobPath, offset, count });
              return realBlobClient.downloadToBuffer(offset, count);
            },
          };
        },
      };
    },
  };
  return { ...storage, blob: fakeBlobService as unknown as BlobServiceClient };
};

beforeAll(async () => {
  await ensureStorage(storage);
  await drainQueue(JOB_QUEUE);
  await drainQueue(POISON_QUEUE);
  const pdf = join(dir, "f.pdf");
  execFileSync("node", [resolve(here, "../scripts/make-fixture-pdf.mjs"), pdf, "50",
    "--needle", "FETCH_NEEDLE", "--needle-page", "41"]);
  const bytes = readFileSync(pdf);
  const out = await createUploadUrl(ctx, { filename: "f.pdf", sizeBytes: bytes.length });
  await fetch(out.uploadUrl, { method: "PUT", headers: { "x-ms-blob-type": "BlockBlob" }, body: bytes });
  await startJob(ctx, { jobId: out.jobId });
  jobId = out.jobId;
  await runOnce(ctx);
  ids = Object.keys(await readArtifactJson<Record<string, unknown>>(storage, jobId, "index.json"));
});

describe("fetchChunks", () => {
  it("returns exactly the chunks asked for, with their pages", async () => {
    const r = await fetchChunks(ctx, { jobId, chunkIds: [ids[0], ids[2]] });
    expect(r.chunks.map((c) => c.chunkId)).toEqual([ids[0], ids[2]]);
    expect(r.chunks[0].pageStart).toBeGreaterThan(0);
    expect(r.chunks[0].pageEnd).toBeGreaterThanOrEqual(r.chunks[0].pageStart);
    expect(r.truncated).toBe(false);
  });

  it("returns the text the ranged read actually points at", async () => {
    const index = await readArtifactJson<Record<string, any>>(storage, jobId, "index.json");
    // The needle is on page 41; the chunk containing it may START earlier and END
    // later, so assert the RANGE contains 41 rather than a single page equalling it.
    const needleId = Object.entries(index)
      .find(([, v]) => v.pageStart <= 41 && v.pageEnd >= 41)![0];
    const r = await fetchChunks(ctx, { jobId, chunkIds: [needleId] });
    expect(r.chunks[0].pageStart).toBeLessThanOrEqual(41);
    expect(r.chunks[0].pageEnd).toBeGreaterThanOrEqual(41);
    expect(r.chunks[0].text.length).toBeGreaterThan(0);
  });

  it("caps the response and SAYS it capped it", async () => {
    // Ten chunks of 4000 chars is ~40 KB, past the 32 KB ceiling.
    const r = await fetchChunks(ctx, { jobId, chunkIds: ids.slice(0, 10) });
    expect(r.bytes).toBeLessThanOrEqual(cfg.fetchMaxBytes);
    if (r.returned < r.requested) expect(r.truncated).toBe(true);
  });

  it("refuses more than ten chunk ids", async () => {
    await expect(fetchChunks(ctx, { jobId, chunkIds: ids.slice(0, 11) }))
      .rejects.toThrow(/at most 10/);
  });

  it("refuses an unknown chunk id rather than returning silence", async () => {
    await expect(fetchChunks(ctx, { jobId, chunkIds: ["c-999999"] }))
      .rejects.toThrow(/unknown chunk/);
  });

  it("refuses a job that has not succeeded", async () => {
    const out = await createUploadUrl(ctx, { filename: "np.md", sizeBytes: 4 });
    await expect(fetchChunks(ctx, { jobId: out.jobId, chunkIds: ["c-000000"] }))
      .rejects.toThrow(/not ready/);
  });
});

describe("fetchChunks's read is genuinely ranged", () => {
  it("calls downloadToBuffer on chunks.jsonl with an offset and count matching the index entry, not bare", async () => {
    const index = await readArtifactJson<Record<string, ChunkIndexEntry>>(storage, jobId, "index.json");
    const chunkId = ids[0];
    const entry = index[chunkId];

    const calls: RecordedDownload[] = [];
    const wrappedCtx = { cfg, storage: wrapStorageForRangeAssertion(storage, calls) };
    await fetchChunks(wrappedCtx, { jobId, chunkIds: [chunkId] });

    const chunkCall = calls.find((c) => c.blobPath === `${jobId}/chunks.jsonl`);
    expect(chunkCall).toBeDefined();
    // A whole-file read (the regression this guards against) calls
    // downloadToBuffer() with no arguments, so both would read as undefined
    // here rather than matching the index entry's own numbers.
    expect(chunkCall!.offset).toBe(entry.byteOffset);
    expect(chunkCall!.count).toBe(entry.byteLength);
  });
});
