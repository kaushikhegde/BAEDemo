import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, JOB_QUEUE, POISON_QUEUE } from "../src/shared/config.js";
import { getStorage, ensureStorage } from "../src/shared/storage.js";
import { createUploadUrl } from "../src/orchestrator/tools/create-upload-url.js";
import { startJob } from "../src/orchestrator/tools/start-job.js";
import { jobStatus } from "../src/orchestrator/tools/job-status.js";
import { getResult } from "../src/orchestrator/tools/get-result.js";
import { deleteJob } from "../src/orchestrator/tools/delete-job.js";
import { runOnce } from "../src/worker/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const cfg = loadConfig();
const storage = getStorage(cfg);
const ctx = { cfg, storage };
const dir = mkdtempSync(join(tmpdir(), "afp-res-"));
let jobId = "";

// The queue is shared with every other *.int.test.ts file, and
// start-job.int.test.ts deliberately enqueues jobs it never consumes (it is
// testing enqueue-idempotency, not processing). fileParallelism is off, but
// nothing guarantees this file runs before that one — Vitest's file order is
// not alphabetical — so a stray message can sit ahead of ours in job-queue
// and runOnce() below would process THAT job instead of the one this file
// just queued. worker.int.test.ts hits the identical hazard and drains for
// the same reason; this mirrors it rather than reinventing it.
const drainQueue = async (name: string) => {
  const q = storage.queue(name);
  for (;;) {
    const r = await q.receiveMessages({ numberOfMessages: 32 });
    if (!r.receivedMessageItems.length) return;
    for (const m of r.receivedMessageItems) await q.deleteMessage(m.messageId, m.popReceipt);
  }
};

beforeAll(async () => {
  await ensureStorage(storage);
  await drainQueue(JOB_QUEUE);
  await drainQueue(POISON_QUEUE);
  const pdf = join(dir, "r.pdf");
  execFileSync("node", [resolve(here, "../scripts/make-fixture-pdf.mjs"), pdf, "45",
    "--needle", "RESULT_NEEDLE", "--needle-page", "31"]);
  const bytes = readFileSync(pdf);
  const out = await createUploadUrl(ctx, { filename: "r.pdf", sizeBytes: bytes.length });
  await fetch(out.uploadUrl, { method: "PUT", headers: { "x-ms-blob-type": "BlockBlob" }, body: bytes });
  await startJob(ctx, { jobId: out.jobId });
  jobId = out.jobId;
  expect(await runOnce(ctx)).toBe("processed");
});

describe("jobStatus", () => {
  it("reports a finished job with its progress", async () => {
    const s = await jobStatus(ctx, { jobId });
    expect(s.state).toBe("succeeded");
    expect(s.phase).toBe("done");
    expect(s.progress).toEqual({ done: 45, total: 45, unit: "pages" });
    expect(s.error).toBeNull();
  });

  it("does not leak the worker id, which is an operational detail", async () => {
    expect(Object.keys(await jobStatus(ctx, { jobId }))).not.toContain("workerId");
  });

  it("refuses an unknown job", async () => {
    await expect(jobStatus(ctx, { jobId: "j-000000000-ffffffffffff" }))
      .rejects.toThrow(/unknown job/);
  });
});

describe("getResult", () => {
  it("returns computed facts and artifact paths", async () => {
    const r = await getResult(ctx, { jobId });
    expect(r.result.pages).toBe(45);
    expect(r.result.chunks).toBeGreaterThan(0);
    expect(r.artifacts.map((a) => a.type).sort())
      // Five, not four: `document.md` is the structured markdown rendering that
      // ingest_document files into a Scyne project. Listed here so a caller
      // knows it exists; its bytes are never returned inline.
      .toEqual(["chunks", "index", "markdown", "metadata", "result"]);
  });

  it("reports a byte size for every artifact — spec §6.4's contract", async () => {
    const r = await getResult(ctx, { jobId });
    for (const a of r.artifacts) {
      expect(typeof a.bytes).toBe("number");
      expect(a.bytes).toBeGreaterThan(0);
    }
    // chunks.jsonl is the large one; a sanity floor that would catch this
    // field silently reporting 0 or the wrong artifact's size.
    const chunks = r.artifacts.find((a) => a.type === "chunks");
    expect(chunks?.bytes).toBeGreaterThan(100);
  });

  it("gives a deleted job its own message rather than 'not ready'", async () => {
    const out = await createUploadUrl(ctx, { filename: "to-delete.md", sizeBytes: 5 });
    const bytes = Buffer.from("hello");
    await fetch(out.uploadUrl, { method: "PUT", headers: { "x-ms-blob-type": "BlockBlob" }, body: bytes });
    await startJob(ctx, { jobId: out.jobId });
    expect(await runOnce(ctx)).toBe("processed");
    await deleteJob(ctx, { jobId: out.jobId });

    // "deleted" is terminal — polling again will never make it ready, unlike
    // every other pre-"succeeded" state — so it must not read like the
    // ordinary "still working, try again" refusal.
    await expect(getResult(ctx, { jobId: out.jobId })).rejects.toThrow(/deleted/);
    await expect(getResult(ctx, { jobId: out.jobId })).rejects.not.toThrow(/not ready/);
  });

  it("stays under 8 KB — the response is a summary, never a payload", async () => {
    const bytes = Buffer.byteLength(JSON.stringify(await getResult(ctx, { jobId })), "utf8");
    expect(bytes).toBeLessThan(8192);
  });

  it("returns no document text at all", async () => {
    const body = JSON.stringify(await getResult(ctx, { jobId }));
    expect(body).not.toContain("RESULT_NEEDLE");
    expect(body).not.toContain("lorem ipsum");
  });

  it("refuses a job that has not succeeded", async () => {
    const out = await createUploadUrl(ctx, { filename: "pending.md", sizeBytes: 5 });
    await expect(getResult(ctx, { jobId: out.jobId })).rejects.toThrow(/not ready/);
  });

  it("caps headings at 50 and stays under 8 KB even with real headings present", async () => {
    // The shared r.pdf fixture's "lorem ipsum" body never matches the HEADING
    // regex in worker/artifacts.ts (every other test here sees an empty
    // headings array), so it cannot prove the 50-heading cap or the 8 KB
    // bound actually hold in the presence of headings — only that they hold
    // when there are none. Numbered section titles are the regex's other
    // match arm (besides markdown `#`), so 80 of them genuinely exercises
    // MAX_HEADINGS rather than coincidentally satisfying it with zero.
    const headingLines = Array.from({ length: 80 }, (_, i) => `${i + 1}. Heading Number ${i + 1}`);
    const mdPath = join(dir, "headings.md");
    writeFileSync(mdPath, headingLines.join("\n"));
    const bytes = readFileSync(mdPath);
    const out = await createUploadUrl(ctx, { filename: "headings.md", sizeBytes: bytes.length });
    await fetch(out.uploadUrl, { method: "PUT", headers: { "x-ms-blob-type": "BlockBlob" }, body: bytes });
    await startJob(ctx, { jobId: out.jobId });
    expect(await runOnce(ctx)).toBe("processed");

    const r = await getResult(ctx, { jobId: out.jobId });
    expect(r.result.headings.length).toBeGreaterThan(0);
    expect(r.result.headings.length).toBeLessThanOrEqual(50);
    expect(Buffer.byteLength(JSON.stringify(r), "utf8")).toBeLessThan(8192);
  });
});
