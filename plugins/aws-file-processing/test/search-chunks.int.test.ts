import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, JOB_QUEUE, POISON_QUEUE, ARTIFACTS, type QueueKey } from "../src/shared/config.js";
import { getStorage, ensureStorage, putObject } from "../src/shared/storage.js";
import { getJob, updateJob } from "../src/shared/jobs.js";
import { createUploadUrl } from "../src/orchestrator/tools/create-upload-url.js";
import { startJob } from "../src/orchestrator/tools/start-job.js";
import { searchChunks } from "../src/orchestrator/tools/search-chunks.js";
import { fetchChunks } from "../src/orchestrator/tools/fetch-chunks.js";
import { runOnce } from "../src/worker/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const cfg = loadConfig();
const storage = getStorage(cfg);
const ctx = { cfg, storage };
const dir = mkdtempSync(join(tmpdir(), "afp-sc-"));
let jobId = "";

// The queue is shared with every other *.int.test.ts file, and
// start-job.int.test.ts deliberately enqueues jobs it never consumes. Without
// draining first, runOnce() below can pick up a stray message from another
// file instead of the one this file just queued — see fetch-chunks.int.test.ts
// for the identical hazard and the same fix.
const drainQueue = async (key: QueueKey) => {
  const q = storage.queue(key);
  for (;;) {
    // waitTimeSeconds is what makes this terminate honestly: SQS's short poll
    // samples a subset of hosts and can answer "nothing" while messages remain,
    // so a zero-wait receive would stop early and leave the queue dirty for the
    // next file.
    const r = await q.receiveMessages({ numberOfMessages: 10, waitTimeSeconds: 1 });
    if (!r.receivedMessageItems.length) return;
    for (const m of r.receivedMessageItems) await q.deleteMessage(m.messageId, m.popReceipt);
  }
};

beforeAll(async () => {
  await ensureStorage(storage);
  await drainQueue(JOB_QUEUE);
  await drainQueue(POISON_QUEUE);
  const pdf = join(dir, "s.pdf");
  execFileSync("node", [resolve(here, "../scripts/make-fixture-pdf.mjs"), pdf, "80",
    "--needle", "ZANZIBAR termination clause applies", "--needle-page", "63"]);
  const bytes = readFileSync(pdf);
  const out = await createUploadUrl(ctx, { filename: "s.pdf", sizeBytes: bytes.length });
  await fetch(out.uploadUrl, { method: "PUT", body: bytes });
  await startJob(ctx, { jobId: out.jobId });
  jobId = out.jobId;
  await runOnce(ctx);
});

describe("searchChunks", () => {
  it("finds a rare term deep in the document and cites its page", async () => {
    const r = await searchChunks(ctx, { jobId, query: "ZANZIBAR" });
    expect(r.hits.length).toBeGreaterThan(0);
    expect(r.hits[0].pageStart).toBeLessThanOrEqual(63);
    expect(r.hits[0].pageEnd).toBeGreaterThanOrEqual(63);
    expect(r.hits[0].snippet).toContain("ZANZIBAR");
  });

  it("keeps snippets short enough to be quoted, not read", async () => {
    const r = await searchChunks(ctx, { jobId, query: "termination" });
    for (const h of r.hits) expect(h.snippet.length).toBeLessThanOrEqual(300);
  });

  it("ranks by how often the terms occur, not by position", async () => {
    const r = await searchChunks(ctx, { jobId, query: "ZANZIBAR termination clause", topK: 5 });
    expect(r.hits[0].pageStart).toBeLessThanOrEqual(63);
    expect(r.hits[0].pageEnd).toBeGreaterThanOrEqual(63);
    for (let i = 1; i < r.hits.length; i++) {
      expect(r.hits[i - 1].score).toBeGreaterThanOrEqual(r.hits[i].score);
    }
  });

  it("returns no hits rather than an error for a term that is absent", async () => {
    const r = await searchChunks(ctx, { jobId, query: "quokka" });
    expect(r.hits).toEqual([]);
    expect(r.scannedChunks).toBeGreaterThan(0);
  });

  it("honours topK", async () => {
    expect((await searchChunks(ctx, { jobId, query: "lorem", topK: 3 })).hits).toHaveLength(3);
  });

  it("hands back ids that fetch_chunks accepts", async () => {
    // The two tools are only useful as a pair; this is the seam between them.
    const r = await searchChunks(ctx, { jobId, query: "ZANZIBAR" });
    const f = await fetchChunks(ctx, { jobId, chunkIds: [r.hits[0].chunkId] });
    expect(f.chunks[0].text).toContain("ZANZIBAR");
  });

  it("stops at the scan ceiling and says so", async () => {
    const r = await searchChunks(
      { ...ctx, cfg: { ...cfg, searchMaxScanBytes: 2_000 } },
      { jobId, query: "lorem" });
    expect(r.truncated).toBe(true);
    expect(r.scannedBytes).toBeLessThanOrEqual(2_000 + 8_192);
  });

  it("refuses an empty query", async () => {
    await expect(searchChunks(ctx, { jobId, query: "   " })).rejects.toThrow(/query/);
  });

  it("refuses a non-integer topK rather than silently disabling the trim", async () => {
    // Math.min(Math.max(1, NaN), MAX_TOPK) is NaN, and `hits.length > NaN` is
    // always false — so an unvalidated NaN topK would let hits grow without
    // bound instead of throwing, quietly defeating the memory bound this tool
    // exists to guarantee. Not reachable through the registered MCP tool (its
    // zod schema enforces `.int()`), but searchChunks is exported and callable
    // directly — including by this test file.
    await expect(searchChunks(ctx, { jobId, query: "lorem", topK: NaN })).rejects.toThrow(/topK/);
  });
});

describe("searchChunks tolerates a malformed chunk record", () => {
  let malformedJobId = "";

  beforeAll(async () => {
    // A minimal real job, taken only as far as "succeeded" — its actual
    // content is irrelevant, because chunks.jsonl is overwritten below with
    // hand-crafted JSONL that JSON.parse()s cleanly but has the wrong SHAPE
    // (a non-string `text`), which is exactly what no compile-time type
    // annotation on the parsed value can catch.
    const bytes = Buffer.from("placeholder\n", "utf8");
    const out = await createUploadUrl(ctx, { filename: "malformed.md", sizeBytes: bytes.length });
    await fetch(out.uploadUrl, { method: "PUT", body: bytes });
    await startJob(ctx, { jobId: out.jobId });
    malformedJobId = out.jobId;
    const job = await getJob(storage, malformedJobId);
    await updateJob(storage, malformedJobId, {
      state: "succeeded", phase: "done", finishedAt: new Date().toISOString(),
    }, { ifMatch: job!.etag });

    const badLine = JSON.stringify({ chunkId: "c-bad", pageStart: 1, pageEnd: 1, text: null });
    const goodLine = JSON.stringify({ chunkId: "c-000000", pageStart: 1, pageEnd: 1, text: "PLATYPUS appears right here" });
    const body = `${badLine}\n${goodLine}\n`;
    await putObject(storage, storage.bucket(ARTIFACTS),
      `${malformedJobId}/chunks.jsonl`, body, { contentType: "application/x-ndjson" });
  });

  it("skips the malformed record and still finds the valid one after it, rather than throwing", async () => {
    const r = await searchChunks(ctx, { jobId: malformedJobId, query: "PLATYPUS" });
    expect(r.hits).toHaveLength(1);
    expect(r.hits[0].chunkId).toBe("c-000000");
    // Both lines were read: scannedChunks counts every non-blank line the
    // scan reaches, well-shaped or not, which is what proves iteration
    // continued past the bad record instead of the loop stopping there.
    expect(r.scannedChunks).toBe(2);
  });
});
