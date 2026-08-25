import { describe, it, expect, beforeAll } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, statSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Transform, Readable } from "node:stream";
import { loadConfig } from "../src/shared/config.js";
import { getStorage, ensureStorage, type Storage } from "../src/shared/storage.js";
import { createUploadUrl } from "../src/orchestrator/tools/create-upload-url.js";
import { downloadToTemp } from "../src/worker/download.js";

const cfg = loadConfig();
const storage = getStorage(cfg);
const ctx = { cfg, storage };
beforeAll(async () => { await ensureStorage(storage); });

const put = async (body: string) => {
  const out = await createUploadUrl(ctx, { filename: "d.md", sizeBytes: Buffer.byteLength(body) });
  await fetch(out.uploadUrl, { method: "PUT", headers: { "x-ms-blob-type": "BlockBlob" }, body });
  return out;
};

/**
 * Wraps a real Storage so that a download's readable stream carries genuine
 * bytes off the real blob up to `poisonAfterBytes`, then errors — a faithful
 * simulation of a network drop partway through a transfer. download.ts only
 * ever reads `.readableStreamBody` off what `download()` resolves to, so a
 * minimal duck-typed stand-in is enough; everything else on Storage is the
 * real thing (real Azurite connection, real container/blob).
 */
const withNetworkDropAfter = (real: Storage, poisonAfterBytes: number): Storage => ({
  ...real,
  blob: {
    getContainerClient: (container: string) => ({
      getBlockBlobClient: (blobPath: string) => ({
        async download() {
          // The SDK types this as a minimal NodeJSReadableStream, but the
          // real object is a Node Readable — needed here for .destroyed.
          const source = (await real.blob.getContainerClient(container)
            .getBlockBlobClient(blobPath).download()).readableStreamBody as unknown as Readable;
          let seen = 0;
          const dropped = new Transform({
            transform(chunk, _enc, cb) {
              seen += chunk.length;
              if (seen > poisonAfterBytes) { cb(new Error("simulated network drop")); return; }
              cb(null, chunk);
            },
          });
          // The real response is upstream of `dropped` and outside pipeline()'s
          // view, so its cleanup has to be wired by hand in both directions.
          source.on("error", (e) => dropped.destroy(e));
          dropped.on("close", () => { if (!source.destroyed) source.destroy(); });
          source.pipe(dropped);
          return { readableStreamBody: dropped };
        },
      }),
    }),
  } as any, // duck-typed stand-in for BlobServiceClient; see comment above
});

describe("downloadToTemp", () => {
  it("writes the blob to disk and reports its digest", async () => {
    const body = "contract text\n".repeat(500);
    const { blobPath } = await put(body);
    const got = await downloadToTemp(storage, cfg, blobPath);
    expect(got.bytes).toBe(Buffer.byteLength(body));
    expect(got.sha256).toBe(createHash("sha256").update(body).digest("hex"));
    expect(statSync(got.path).size).toBe(got.bytes);
  });

  it("accepts a digest that matches", async () => {
    const body = "matching\n";
    const { blobPath } = await put(body);
    const sha = createHash("sha256").update(body).digest("hex");
    await expect(downloadToTemp(storage, cfg, blobPath, { expectSha256: sha }))
      .resolves.toBeDefined();
  });

  it("rejects a digest that does not match, and leaves no temp file behind", async () => {
    const { blobPath } = await put("real content\n");
    let leaked: string | null = null;
    await expect(
      downloadToTemp(storage, cfg, blobPath, { expectSha256: "0".repeat(64) })
        .catch((e) => { leaked = e.tempPath ?? null; throw e; }),
    ).rejects.toThrow(/checksum_mismatch/);
    if (leaked) expect(existsSync(leaked)).toBe(false);
  });

  it("gives each download its own path, so two workers cannot collide", async () => {
    const body = "shared\n";
    const { blobPath } = await put(body);
    const expectedSha = createHash("sha256").update(body).digest("hex");
    const [a, b] = await Promise.all([
      downloadToTemp(storage, cfg, blobPath),
      downloadToTemp(storage, cfg, blobPath),
    ]);
    expect(a.path).not.toBe(b.path);
    // Not just that the paths differ — that neither download corrupted the
    // other's bytes while they ran at the same time.
    expect(a.bytes).toBe(Buffer.byteLength(body));
    expect(b.bytes).toBe(Buffer.byteLength(body));
    expect(a.sha256).toBe(expectedSha);
    expect(b.sha256).toBe(expectedSha);
  });

  it("removes a partially written file when the pipeline fails mid-transfer, and surfaces the original error unchanged", async () => {
    // A dedicated, empty directory: downloadToTemp's destination filename
    // carries a random UUID we can't predict, so we can't check one exact
    // path for absence. But nothing else ever writes here, so the directory
    // being empty afterwards is exactly "no partial file left behind".
    const scratchDir = mkdtempSync(join(tmpdir(), "afp-dl-drop-"));
    const scratchCfg = { ...cfg, tempDir: scratchDir };

    // Comfortably larger than the drop point below, so real bytes are
    // already flowing to disk before the injected failure — unlike an
    // open()-time permission failure, which would leave nothing to clean up
    // either way and so would pass this assertion regardless of the fix.
    const body = "network drop payload, ".repeat(20_000); // ~460 KB
    const { blobPath } = await put(body);

    await expect(downloadToTemp(withNetworkDropAfter(storage, 100_000), scratchCfg, blobPath))
      .rejects.toThrow(/simulated network drop/);

    expect(readdirSync(scratchDir)).toEqual([]);
  });
});
