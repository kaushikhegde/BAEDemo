import { describe, it, expect, beforeAll } from "vitest";
import { loadConfig, UPLOADS_CONTAINER } from "../src/shared/config.js";
import { getStorage, ensureStorage } from "../src/shared/storage.js";
import { mintUploadSas } from "../src/shared/sas.js";
import { createUploadUrl } from "../src/orchestrator/tools/create-upload-url.js";

const cfg = loadConfig();
const storage = getStorage(cfg);
const ctx = { cfg, storage };
beforeAll(async () => { await ensureStorage(storage); });

const put = (url: string, body: string) =>
  fetch(url, { method: "PUT", headers: { "x-ms-blob-type": "BlockBlob" }, body });

describe("mintUploadSas", () => {
  it("writes the blob it is scoped to", async () => {
    const { url } = mintUploadSas(storage, cfg, UPLOADS_CONTAINER, "sas-test/ok.txt");
    expect((await put(url, "hello")).status).toBe(201);
  });

  it("cannot READ the blob it just wrote", async () => {
    const { url } = mintUploadSas(storage, cfg, UPLOADS_CONTAINER, "sas-test/noread.txt");
    await put(url, "hello");
    expect((await fetch(url)).status).toBe(403);
  });

  it("cannot write a DIFFERENT blob name", async () => {
    const { url } = mintUploadSas(storage, cfg, UPLOADS_CONTAINER, "sas-test/scoped.txt");
    const other = url.replace("sas-test/scoped.txt", "sas-test/elsewhere.txt");
    expect((await put(other, "nope")).status).toBe(403);
  });

  it("cannot LIST the container", async () => {
    const { url } = mintUploadSas(storage, cfg, UPLOADS_CONTAINER, "sas-test/nolist.txt");
    const qs = url.split("?")[1];
    const listUrl = `${storage.blob.url}/${UPLOADS_CONTAINER}?restype=container&comp=list&${qs}`;
    expect((await fetch(listUrl)).status).toBe(403);
  });

  it("is rejected once expired", async () => {
    const past = new Date(Date.now() - (cfg.sasTtlSeconds + 3600) * 1000);
    const { url } = mintUploadSas(storage, cfg, UPLOADS_CONTAINER, "sas-test/expired.txt", past);
    expect((await put(url, "nope")).status).toBe(403);
  });
});

describe("mintUploadSas — filenames needing URL-safe encoding", () => {
  // '#' opens a URL fragment and '?' opens a bogus query string, either of
  // which truncates or corrupts the signed query string appended after it —
  // the SAS itself stays valid, but the URL handed back never carries it.
  it("uploads a filename containing '#'", async () => {
    const { url } = mintUploadSas(storage, cfg, UPLOADS_CONTAINER, "sas-test/notes#1.pdf");
    expect((await put(url, "hello")).status).toBe(201);
    expect((await fetch(url)).status).toBe(403);
  });

  it("uploads a filename containing '?'", async () => {
    const { url } = mintUploadSas(storage, cfg, UPLOADS_CONTAINER, "sas-test/invoice?v2.pdf");
    expect((await put(url, "hello")).status).toBe(201);
    expect((await fetch(url)).status).toBe(403);
  });

  it("uploads a filename with unicode and a space (regression — must keep working)", async () => {
    const { url } = mintUploadSas(storage, cfg, UPLOADS_CONTAINER, "sas-test/café report.pdf");
    expect((await put(url, "hello")).status).toBe(201);
    expect((await fetch(url)).status).toBe(403);
  });
});

describe("createUploadUrl", () => {
  it("mints a job whose blob path is namespaced by the jobId", async () => {
    const out = await createUploadUrl(ctx, { filename: "contract.pdf", sizeBytes: 1024 });
    expect(out.blobPath).toBe(`${out.jobId}/contract.pdf`);
    expect(out.container).toBe(UPLOADS_CONTAINER);
    expect(new Date(out.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it("refuses a filename that tries to climb out of its prefix", async () => {
    await expect(createUploadUrl(ctx, { filename: "../../etc/passwd", sizeBytes: 10 }))
      .rejects.toThrow(/filename/);
    await expect(createUploadUrl(ctx, { filename: "a/b.pdf", sizeBytes: 10 }))
      .rejects.toThrow(/filename/);
  });

  it("refuses an unsupported extension", async () => {
    await expect(createUploadUrl(ctx, { filename: "movie.mp4", sizeBytes: 10 }))
      .rejects.toThrow(/extension/);
  });

  it("refuses a size above the ceiling", async () => {
    await expect(createUploadUrl(ctx, { filename: "big.pdf", sizeBytes: cfg.maxUploadBytes + 1 }))
      .rejects.toThrow(/too large/);
  });

  it("refuses an over-long filename before minting a SAS or creating the job row", async () => {
    // 512 is the logger's own MAX_FIELD_CHARS (shared/logger.ts) — the
    // pre-fix code let a name past this length reach
    // log.info("upload.url_minted", { filename, … }) AFTER newJobId,
    // mintUploadSas and createJob had all already run, so the failure came
    // from inside the logger with an orphan job row and a minted SAS already
    // behind it. Matching this tool's own message (not the logger's near-
    // identical one) is what proves the check fires BEFORE any of that.
    const longName = "a".repeat(509) + ".pdf"; // 513 chars, one over the cap
    await expect(createUploadUrl(ctx, { filename: longName, sizeBytes: 10 }))
      .rejects.toThrow(/^filename is too long: 513 chars, max 512$/);
  });
});
