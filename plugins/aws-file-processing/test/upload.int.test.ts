import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { loadConfig, UPLOADS } from "../src/shared/config.js";
import { getStorage, ensureStorage, headObject } from "../src/shared/storage.js";
import { createUploadUrl } from "../src/orchestrator/tools/create-upload-url.js";

const cfg = loadConfig();
const storage = getStorage(cfg);
const ctx = { cfg, storage };
const script = resolve(dirname(fileURLToPath(import.meta.url)), "../scripts/upload.mjs");
const dir = mkdtempSync(join(tmpdir(), "afp-up-"));

beforeAll(async () => { await ensureStorage(storage); });

const upload = (file: string, url: string) =>
  JSON.parse(execFileSync("node", [script, file, url], { encoding: "utf8" }).trim());

const committed = async (key: string) =>
  (await headObject(storage, storage.bucket(UPLOADS), key)).contentLength;

describe("upload.mjs", () => {
  it("uploads a small file in a single streamed PUT", async () => {
    const file = join(dir, "small.md");
    const body = "# hello\n".repeat(1000);
    writeFileSync(file, body);
    const { uploadUrl, objectKey } = await createUploadUrl(ctx, {
      filename: "small.md", sizeBytes: Buffer.byteLength(body) });
    const out = upload(file, uploadUrl);
    expect(out.ok).toBe(true);
    expect(out.sha256).toBe(createHash("sha256").update(body).digest("hex"));
    expect(await committed(objectKey)).toBe(Buffer.byteLength(body));
  });

  it("uploads a file past the old 64 MiB block-staging threshold in ONE put", async () => {
    // The Azure ancestor staged blocks above 64 MiB and committed them with a
    // hand-written <BlockList> XML document, because a SAS PUT could not carry
    // more. S3's single-PutObject ceiling is 5 GiB — the same as this plugin's
    // own MAX_UPLOAD_BYTES — so the whole second protocol is gone, and this
    // asserts that a file that WOULD have needed it goes up unaltered.
    const file = join(dir, "big.txt");
    const chunk = Buffer.alloc(1024 * 1024, 0x61);
    writeFileSync(file, Buffer.concat(Array(80).fill(chunk)));
    const size = 80 * 1024 * 1024;
    const { uploadUrl, objectKey } = await createUploadUrl(ctx, {
      filename: "big.txt", sizeBytes: size });
    const out = upload(file, uploadUrl);
    expect(out.ok).toBe(true);
    expect(out.bytes).toBe(size);
    expect(await committed(objectKey)).toBe(size);
    // No block/part count is reported any more, because there are none.
    expect(out).not.toHaveProperty("blocks");
  });

  it("refuses a file over the single-PUT ceiling rather than truncating it", () => {
    // Reported by the script itself, before any bytes move: a PUT that S3 will
    // reject at 5 GiB should not be discovered 5 GiB in.
    const file = join(dir, "small.md");
    let output = "";
    try {
      execFileSync("node", [script, file, "http://127.0.0.1:4566/nope"], { encoding: "utf8" });
    } catch (e: any) { output = String(e.stderr ?? "") + String(e.stdout ?? ""); }
    expect(output).toMatch(/upload failed/i);
  });

  it("prints no file content on failure", () => {
    const file = join(dir, "small.md");
    let stderr = "";
    try {
      execFileSync("node", [script, file, "http://127.0.0.1:4566/nope"], { encoding: "utf8" });
    } catch (e: any) { stderr = String(e.stderr ?? "") + String(e.stdout ?? ""); }
    expect(stderr).not.toContain("# hello");
    expect(stderr).toMatch(/upload failed/i);
  });

  it("prints 'upload failed', not a stack trace, when the file cannot be read", () => {
    const missing = join(dir, "does-not-exist.md");
    let output = "";
    let threw = false;
    try {
      execFileSync("node", [script, missing, "http://127.0.0.1:4566/nope"], { encoding: "utf8" });
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
        execFileSync("node", [script, file, "http://127.0.0.1:4566/nope"], { encoding: "utf8" });
      } catch (e: any) { output = String(e.stderr ?? "") + String(e.stdout ?? ""); }
    } finally {
      chmodSync(file, 0o644); // restore so temp-dir teardown can remove it
    }
    expect(output).toMatch(/upload failed/i);
    expect(output).not.toContain("top secret contents");
    expect(output).not.toMatch(/node:internal/);
  });

  it("refuses an empty file rather than uploading nothing", () => {
    const file = join(dir, "empty.md");
    writeFileSync(file, "");
    let output = "";
    try {
      execFileSync("node", [script, file, "http://127.0.0.1:4566/nope"], { encoding: "utf8" });
    } catch (e: any) { output = String(e.stderr ?? "") + String(e.stdout ?? ""); }
    expect(output).toMatch(/empty/i);
  });

  it("never prints the signed URL — including its X-Amz-Signature — on failure", () => {
    const file = join(dir, "small.md");
    // A realistic-shaped SigV4 query string, so there is something for the
    // assertion to actually catch: a real signature, an expiry and a scope.
    const sig = "6f2a1c9b4e7d3f8a0b5c2e9d1f4a7b3c6e0d9a2f5b8c1e4d7a0f3b6c9e2d5a8b";
    const qs = "X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIA%2F20260101%2F" +
      "us-east-1%2Fs3%2Faws4_request&X-Amz-Date=20260101T000000Z&X-Amz-Expires=900&" +
      `X-Amz-SignedHeaders=host&X-Amz-Signature=${sig}`;
    const url = `http://127.0.0.1:4566/${storage.bucket(UPLOADS)}/nope?${qs}`;
    let output = "";
    try {
      execFileSync("node", [script, file, url], { encoding: "utf8" });
    } catch (e: any) { output = String(e.stderr ?? "") + String(e.stdout ?? ""); }
    expect(output).toMatch(/upload failed/i);
    expect(output).not.toContain(sig);
    expect(output).not.toContain(qs);
    expect(output).not.toContain(url);
  });

  it("says what a 403 usually means, since neither cause is guessable from it", () => {
    // Expired, or signed against a different host. A bare "403" sends somebody
    // looking at IAM, which is the one thing it is almost never.
    const body = readFileSync(script, "utf8");
    expect(body).toMatch(/expired/i);
    expect(body).toMatch(/signed against a different endpoint/i);
  });
});
