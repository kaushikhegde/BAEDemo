import { describe, it, expect, beforeAll } from "vitest";
import { loadConfig, UPLOADS_CONTAINER, ARTIFACTS_CONTAINER, JOB_QUEUE, POISON_QUEUE } from "../src/shared/config.js";
import { getStorage, ensureStorage } from "../src/shared/storage.js";
import { getJob, updateJob } from "../src/shared/jobs.js";
import { createUploadUrl } from "../src/orchestrator/tools/create-upload-url.js";
import { startJob } from "../src/orchestrator/tools/start-job.js";
import { jobStatus } from "../src/orchestrator/tools/job-status.js";
import { deleteJob } from "../src/orchestrator/tools/delete-job.js";
import { runOnce } from "../src/worker/index.js";

const cfg = loadConfig();
const storage = getStorage(cfg);
const ctx = { cfg, storage };

// The queue is shared with every other *.int.test.ts file, and
// start-job.int.test.ts deliberately enqueues jobs it never consumes. Without
// draining first, runOnce() below can pick up a stray message from another
// file instead of the one this file just queued — see fetch-chunks.int.test.ts
// for the identical hazard and the same fix.
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
});

const countUnder = async (container: string, prefix: string) => {
  let n = 0;
  for await (const _ of storage.blob.getContainerClient(container).listBlobsFlat({ prefix })) n++;
  return n;
};

const processedJob = async () => {
  const body = Buffer.from("# doc\n\nsome content to chunk\n".repeat(50));
  const out = await createUploadUrl(ctx, { filename: "d.md", sizeBytes: body.length });
  await fetch(out.uploadUrl, { method: "PUT", headers: { "x-ms-blob-type": "BlockBlob" }, body });
  await startJob(ctx, { jobId: out.jobId });
  await runOnce(ctx);
  return out.jobId;
};

describe("deleteJob", () => {
  it("removes every blob in both containers", async () => {
    const jobId = await processedJob();
    expect(await countUnder(UPLOADS_CONTAINER, `${jobId}/`)).toBeGreaterThan(0);
    expect(await countUnder(ARTIFACTS_CONTAINER, `${jobId}/`)).toBe(4);

    const r = await deleteJob(ctx, { jobId });
    expect(r.deleted).toBe(true);
    expect(r.blobsRemoved).toBe(5);
    expect(await countUnder(UPLOADS_CONTAINER, `${jobId}/`)).toBe(0);
    expect(await countUnder(ARTIFACTS_CONTAINER, `${jobId}/`)).toBe(0);
  });

  it("keeps the row so the id still explains itself", async () => {
    const jobId = await processedJob();
    await deleteJob(ctx, { jobId });
    expect((await getJob(storage, jobId))?.state).toBe("deleted");
    expect((await jobStatus(ctx, { jobId })).state).toBe("deleted");
  });

  it("is idempotent — deleting twice is not an error", async () => {
    const jobId = await processedJob();
    await deleteJob(ctx, { jobId });
    const again = await deleteJob(ctx, { jobId });
    expect(again.deleted).toBe(true);
    expect(again.blobsRemoved).toBe(0);
  });

  it("refuses an unknown job", async () => {
    await expect(deleteJob(ctx, { jobId: "j-000000000-aaaaaaaaaaaa" }))
      .rejects.toThrow(/unknown job/);
  });

  it("refuses a job that is still queued, rather than purging out from under it (I3)", async () => {
    // start_job queues the job but nothing here ever calls runOnce — it sits
    // in "queued" for the whole test, which is exactly the window in which
    // the pre-fix code purged both prefixes and marked the row "deleted"
    // regardless: the worker would then upload its four artifacts and set
    // "succeeded" on top of it moments later, un-deleting a job the caller
    // was already told was gone.
    const body = Buffer.from("# doc\n\nnot yet processed\n");
    const out = await createUploadUrl(ctx, { filename: "still-queued.md", sizeBytes: body.length });
    await fetch(out.uploadUrl, { method: "PUT", headers: { "x-ms-blob-type": "BlockBlob" }, body });
    await startJob(ctx, { jobId: out.jobId });

    await expect(deleteJob(ctx, { jobId: out.jobId })).rejects.toThrow(/queued/);

    // Refused, not merely erred: the row is untouched and the upload is
    // still there for the worker to pick up.
    expect((await getJob(storage, out.jobId))?.state).toBe("queued");
    expect(await countUnder(UPLOADS_CONTAINER, `${out.jobId}/`)).toBeGreaterThan(0);

    // Drain it so it does not sit in job-queue and confuse a later test file.
    await runOnce(ctx);
  });

  it("refuses a job that is running (I3)", async () => {
    const jobId = await processedJob();
    // processedJob() already ran it to "succeeded"; force it back to
    // "running" to exercise the same refusal without needing to catch a real
    // job mid-flight.
    await updateJob(storage, jobId, { state: "running" });

    await expect(deleteJob(ctx, { jobId })).rejects.toThrow(/running/);
    expect((await getJob(storage, jobId))?.state).toBe("running");
    expect(await countUnder(ARTIFACTS_CONTAINER, `${jobId}/`)).toBe(4);
  });
});
