import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { loadConfig, UPLOADS_CONTAINER } from "../src/shared/config.js";
import { getStorage, ensureStorage } from "../src/shared/storage.js";
import { createUploadUrl } from "../src/orchestrator/tools/create-upload-url.js";

const cfg = loadConfig();
const storage = getStorage(cfg);
const ctx = { cfg, storage };
const script = resolve(dirname(fileURLToPath(import.meta.url)), "../scripts/upload.mjs");
const dir = mkdtempSync(join(tmpdir(), "afp-up-"));

beforeAll(async () => { await ensureStorage(storage); });

const upload = (file: string, url: string) =>
  JSON.parse(execFileSync("node", [script, file, url], { encoding: "utf8" }).trim());

const committed = async (blobPath: string) =>
  (await storage.blob.getContainerClient(UPLOADS_CONTAINER)
     .getBlockBlobClient(blobPath).getProperties()).contentLength;

describe("upload.mjs", () => {
  it("uploads a small file in a single PUT", async () => {
    const file = join(dir, "small.md");
    const body = "# hello\n".repeat(1000);
    writeFileSync(file, body);
    const { uploadUrl, blobPath } = await createUploadUrl(ctx, {
      filename: "small.md", sizeBytes: Buffer.byteLength(body) });
    const out = upload(file, uploadUrl);
    expect(out.ok).toBe(true);
    expect(out.blocks).toBe(1);
    expect(out.sha256).toBe(createHash("sha256").update(body).digest("hex"));
    expect(await committed(blobPath)).toBe(Buffer.byteLength(body));
  });

  it("stages blocks for a file past the single-PUT ceiling", async () => {
    // 80 MiB of repeated text: over the 64 MiB threshold, so it must take the
    // block-staging path and still commit to exactly the right length.
    const file = join(dir, "big.txt");
    const chunk = Buffer.alloc(1024 * 1024, 0x61);
    writeFileSync(file, Buffer.concat(Array(80).fill(chunk)));
    const size = 80 * 1024 * 1024;
    const { uploadUrl, blobPath } = await createUploadUrl(ctx, {
      filename: "big.txt", sizeBytes: size });
    const out = upload(file, uploadUrl);
    expect(out.ok).toBe(true);
    expect(out.blocks).toBeGreaterThan(1);
    expect(out.bytes).toBe(size);
    expect(await committed(blobPath)).toBe(size);
  });

  it("prints no file content on failure", () => {
    const file = join(dir, "small.md");
    let stderr = "";
    try {
      execFileSync("node", [script, file, "http://127.0.0.1:10000/nope"], { encoding: "utf8" });
    } catch (e: any) { stderr = String(e.stderr ?? "") + String(e.stdout ?? ""); }
    expect(stderr).not.toContain("# hello");
    expect(stderr).toMatch(/upload failed/i);
  });

  it("prints 'upload failed', not a stack trace, when the file cannot be read", () => {
    const missing = join(dir, "does-not-exist.md");
    let output = "";
    let threw = false;
    try {
      execFileSync("node", [script, missing, "http://127.0.0.1:10000/nope"], { encoding: "utf8" });
    } catch (e: any) {
      threw = true;
      output = String(e.stderr ?? "") + String(e.stdout ?? "");
    }
    expect(threw).toBe(true);
    expect(output).toMatch(/upload failed/i);
    // A raw Node fs error would surface as an uncaught-exception stack trace
    // instead — this is exactly what routing the read through fail() avoids.
    expect(output).not.toMatch(/at (Object\.|Module\.)?(readFileSync|Module\._compile|internal\/)/);
    expect(output).not.toMatch(/node:internal/);
  });

  it("prints 'upload failed', not a stack trace, when the file exists but is unreadable", () => {
    // Running as root defeats file-mode permission checks entirely, so this
    // test would be meaningless there (and CI containers commonly run as root).
    if (typeof process.getuid === "function" && process.getuid() === 0) return;
    const file = join(dir, "unreadable.md");
    writeFileSync(file, "top secret contents");
    chmodSync(file, 0o000);
    let output = "";
    try {
      try {
        execFileSync("node", [script, file, "http://127.0.0.1:10000/nope"], { encoding: "utf8" });
      } catch (e: any) { output = String(e.stderr ?? "") + String(e.stdout ?? ""); }
    } finally {
      chmodSync(file, 0o644); // restore so temp-dir teardown can remove it
    }
    expect(output).toMatch(/upload failed/i);
    expect(output).not.toContain("top secret contents");
    expect(output).not.toMatch(/node:internal/);
  });

  it("never prints the signed URL — including its sig= query parameter — on failure", () => {
    const file = join(dir, "small.md");
    // A realistic-shaped SAS query string, so there is something for the
    // assertion to actually catch: a real signature, an expiry and scope.
    const sig = "Ax7z9QpL2vN8mK3wR6tY1uI0oP5aS4dF7gH2jK9lM3n4B5c=";
    const qs = `sv=2024-08-04&spr=https,http&se=2026-01-01T00%3A00%3A00Z&sr=b&sp=cw&sig=${encodeURIComponent(sig)}`;
    const url = `http://127.0.0.1:10000/devstoreaccount1/${UPLOADS_CONTAINER}/nope?${qs}`;
    let output = "";
    try {
      execFileSync("node", [script, file, url], { encoding: "utf8" });
    } catch (e: any) { output = String(e.stderr ?? "") + String(e.stdout ?? ""); }
    expect(output).toMatch(/upload failed/i);
    expect(output).not.toContain(sig);
    expect(output).not.toContain(qs);
    expect(output).not.toContain(url);
  });
});
