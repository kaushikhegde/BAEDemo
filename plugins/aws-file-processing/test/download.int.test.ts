import { describe, it, expect, beforeAll } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, statSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Transform, Readable } from "node:stream";
import { GetObjectCommand } from "@aws-sdk/client-s3";
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
  await fetch(out.uploadUrl, { method: "PUT", body });
  return out;
};

/**
 * Wraps a real Storage so that a GetObject's body carries genuine bytes off
 * the real object up to `poisonAfterBytes`, then errors — a faithful
 * simulation of a network drop partway through a transfer.
 *
 * The v3 client is ONE object with a `send` method rather than a tree of
 * per-container/per-blob clients, so the interception is a single `send`
 * override rather than the two-level duck-typed stand-in this test needed
 * against the Azure SDK. Every other command passes straight through to the
 * real client, so this is still a real LocalStack connection and a real object.
 */
const withNetworkDropAfter = (real: Storage, poisonAfterBytes: number): Storage => ({
  ...real,
  s3: {
    ...real.s3,
    async send(command: any) {
      const out = await (real.s3.send as any)(command);
      if (!(command instanceof GetObjectCommand)) return out;
      const source = out.Body as Readable;
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
      return { ...out, Body: dropped };
    },
  } as any, // duck-typed stand-in for S3Client; see comment above
});

describe("downloadToTemp", () => {
  it("writes the object to disk and reports its digest", async () => {
    const body = "contract text\n".repeat(500);
    const { objectKey } = await put(body);
    const got = await downloadToTemp(storage, cfg, objectKey);
    expect(got.bytes).toBe(Buffer.byteLength(body));
    expect(got.sha256).toBe(createHash("sha256").update(body).digest("hex"));
    expect(statSync(got.path).size).toBe(got.bytes);
  });

  it("accepts a digest that matches", async () => {
    const body = "matching\n";
    const { objectKey } = await put(body);
    const sha = createHash("sha256").update(body).digest("hex");
    await expect(downloadToTemp(storage, cfg, objectKey, { expectSha256: sha }))
      .resolves.toBeDefined();
  });

  it("rejects a digest that does not match, and leaves no temp file behind", async () => {
    const { objectKey } = await put("real content\n");
    let leaked: string | null = null;
    await expect(
      downloadToTemp(storage, cfg, objectKey, { expectSha256: "0".repeat(64) })
        .catch((e) => { leaked = e.tempPath ?? null; throw e; }),
    ).rejects.toThrow(/checksum_mismatch/);
    if (leaked) expect(existsSync(leaked)).toBe(false);
  });

  it("gives each download its own path, so two workers cannot collide", async () => {
    const body = "shared\n";
    const { objectKey } = await put(body);
    const expectedSha = createHash("sha256").update(body).digest("hex");
    const [a, b] = await Promise.all([
      downloadToTemp(storage, cfg, objectKey),
      downloadToTemp(storage, cfg, objectKey),
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
    const { objectKey } = await put(body);

    await expect(downloadToTemp(withNetworkDropAfter(storage, 100_000), scratchCfg, objectKey))
      .rejects.toThrow(/simulated network drop/);

    expect(readdirSync(scratchDir)).toEqual([]);
  });
});
