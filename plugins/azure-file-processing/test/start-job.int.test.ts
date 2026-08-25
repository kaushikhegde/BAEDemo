import { describe, it, expect, beforeAll } from "vitest";
import { loadConfig, UPLOADS_CONTAINER, JOB_QUEUE } from "../src/shared/config.js";
import { getStorage, ensureStorage } from "../src/shared/storage.js";
import { getJob } from "../src/shared/jobs.js";
import { createUploadUrl } from "../src/orchestrator/tools/create-upload-url.js";
import { startJob } from "../src/orchestrator/tools/start-job.js";

const cfg = loadConfig();
const storage = getStorage(cfg);
const ctx = { cfg, storage };
beforeAll(async () => { await ensureStorage(storage); });

const uploadedJob = async (body = "hello world\n") => {
  const sizeBytes = Buffer.byteLength(body);
  const out = await createUploadUrl(ctx, { filename: "doc.md", sizeBytes });
  await fetch(out.uploadUrl, {
    method: "PUT", headers: { "x-ms-blob-type": "BlockBlob" }, body,
  });
  return out;
};

describe("startJob", () => {
  it("queues an uploaded job and records the parameters", async () => {
    const { jobId } = await uploadedJob();
    const out = await startJob(ctx, {
      jobId, pipeline: { id: "extract-chunks", params: { chunkChars: 1500 } } });
    expect(out.state).toBe("queued");
    expect(out.alreadyStarted).toBe(false);
    const job = await getJob(storage, jobId);
    expect(job?.state).toBe("queued");
    expect(JSON.parse(job!.params).chunkChars).toBe(1500);
  });

  it("is idempotent — a second call enqueues nothing more", async () => {
    // A model that retries on a slow response must not be able to make a 2 GB
    // file process twice.
    const { jobId } = await uploadedJob();
    await startJob(ctx, { jobId });
    const before = (await storage.queue(JOB_QUEUE).getProperties()).approximateMessagesCount ?? 0;
    const second = await startJob(ctx, { jobId });
    const after = (await storage.queue(JOB_QUEUE).getProperties()).approximateMessagesCount ?? 0;
    expect(second.alreadyStarted).toBe(true);
    expect(after).toBe(before);
  });

  it("is safe under real concurrency — two simultaneous calls enqueue exactly one message", async () => {
    // Unlike the sequential test above, neither call is awaited before the
    // other starts: this is what "a model retries while the first call is
    // still in flight" actually looks like, and it is the case a plain
    // check-then-act guard (read state, then act) cannot survive — both
    // calls can observe "awaiting_upload" before either has written "queued".
    const { jobId } = await uploadedJob();
    const before = (await storage.queue(JOB_QUEUE).getProperties()).approximateMessagesCount ?? 0;
    const [a, b] = await Promise.all([
      startJob(ctx, { jobId }),
      startJob(ctx, { jobId }),
    ]);
    const after = (await storage.queue(JOB_QUEUE).getProperties()).approximateMessagesCount ?? 0;
    const alreadyStartedCount = [a, b].filter((r) => r.alreadyStarted).length;
    expect(alreadyStartedCount).toBe(1); // exactly one call lost the race
    expect(after - before).toBe(1);      // exactly one message reached the queue
  });

  it("refuses a job whose blob was never uploaded", async () => {
    const out = await createUploadUrl(ctx, { filename: "missing.md", sizeBytes: 10 });
    await expect(startJob(ctx, { jobId: out.jobId })).rejects.toThrow(/not uploaded/);
  });

  it("refuses when the committed size disagrees with what was declared", async () => {
    const out = await createUploadUrl(ctx, { filename: "short.md", sizeBytes: 9999 });
    await fetch(out.uploadUrl, {
      method: "PUT", headers: { "x-ms-blob-type": "BlockBlob" }, body: "tiny" });
    await expect(startJob(ctx, { jobId: out.jobId })).rejects.toThrow(/size/);
  });

  it("refuses an unknown jobId", async () => {
    await expect(startJob(ctx, { jobId: "j-000000000-aaaaaaaaaaaa" }))
      .rejects.toThrow(/unknown job/);
  });
});
