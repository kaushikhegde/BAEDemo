import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, JOB_QUEUE, POISON_QUEUE, ARTIFACTS, type QueueKey } from "../src/shared/config.js";
import { getStorage, ensureStorage, getObjectBuffer } from "../src/shared/storage.js";
import { getJob } from "../src/shared/jobs.js";
import { createUploadUrl } from "../src/orchestrator/tools/create-upload-url.js";
import { startJob } from "../src/orchestrator/tools/start-job.js";
import { runOnce } from "../src/worker/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const cfg = loadConfig();
const storage = getStorage(cfg);
const ctx = { cfg, storage };
const dir = mkdtempSync(join(tmpdir(), "afp-wk-"));

beforeAll(async () => { await ensureStorage(storage); });

const drainQueue = async (key: QueueKey) => {
  const q = storage.queue(key);
  for (;;) {
    // waitTimeSeconds is what makes this terminate honestly: SQS's short poll
    // samples a subset of hosts and can answer "nothing" while messages remain,
    // so a zero-wait receive would stop early and leave the queue dirty for the
    // next test. A long poll checks every host before answering empty.
    const r = await q.receiveMessages({ numberOfMessages: 10, waitTimeSeconds: 1 });
    if (!r.receivedMessageItems.length) return;
    for (const m of r.receivedMessageItems) await q.deleteMessage(m.messageId, m.popReceipt);
  }
};

const submit = async (filename: string, bytes: Buffer) => {
  const out = await createUploadUrl(ctx, { filename, sizeBytes: bytes.length });
  // Buffer.from() rather than the raw `bytes` param: @types/node's Buffer is
  // generic over ArrayBufferLike and fetch's BodyInit wants a concrete
  // ArrayBuffer, so a Buffer read straight off fs.readFileSync fails to
  // typecheck as a fetch body even though it works fine at runtime.
  await fetch(out.uploadUrl, { method: "PUT", body: Buffer.from(bytes) });
  await startJob(ctx, { jobId: out.jobId });
  return out.jobId;
};

// A failed attempt leaves the message invisible for the full visibility
// timeout (300s), which would make the dead-letter test below wait five
// minutes for nothing. This receives the message and immediately rewrites its
// visibility to 0, so the next receive can happen right away — and each cycle
// also increments ApproximateReceiveCount, which is what the ceiling counts.
const makeVisible = async () => {
  const q = storage.queue(JOB_QUEUE);
  const r = await q.receiveMessages({ numberOfMessages: 1, visibilityTimeout: 1, waitTimeSeconds: 1 });
  const m = r.receivedMessageItems[0];
  if (m) await q.updateMessage(m.messageId, m.popReceipt, undefined, 0);
};

/** Receives everything visible on a queue, counts what matches, and puts it all
 *  back. `approximateDepth()` is not usable for an assertion — see its own doc
 *  comment — so this is how a test knows what is on a queue. */
const peek = async (key: QueueKey): Promise<string[]> => {
  const q = storage.queue(key);
  const seen: Array<{ messageId: string; popReceipt: string; messageText: string }> = [];
  for (;;) {
    const r = await q.receiveMessages({ numberOfMessages: 10, visibilityTimeout: 30, waitTimeSeconds: 1 });
    if (!r.receivedMessageItems.length) break;
    seen.push(...r.receivedMessageItems);
  }
  for (const m of seen) await q.updateMessage(m.messageId, m.popReceipt, undefined, 0);
  return seen.map((m) => m.messageText);
};

describe("runOnce", () => {
  beforeAll(async () => {
    await drainQueue(JOB_QUEUE);
    await drainQueue(POISON_QUEUE);
  });

  it("reports idle on an empty queue", async () => {
    expect(await runOnce(ctx)).toBe("idle");
  });

  it("processes a PDF end to end and records the worker that did it", async () => {
    const pdf = join(dir, "doc.pdf");
    execFileSync("node", [resolve(here, "../scripts/make-fixture-pdf.mjs"), pdf, "30",
      "--needle", "WORKER_NEEDLE", "--needle-page", "22"]);
    const jobId = await submit("doc.pdf", readFileSync(pdf));

    expect(await runOnce(ctx)).toBe("processed");

    const job = await getJob(storage, jobId);
    expect(job?.state).toBe("succeeded");
    expect(job?.phase).toBe("done");
    expect(job?.progressDone).toBe(30);
    expect(job?.workerId).toBeTruthy();
    expect(job?.finishedAt).toBeTruthy();

    const bucket = storage.bucket(ARTIFACTS);
    const result = JSON.parse(
      (await getObjectBuffer(storage, bucket, `${jobId}/result.json`)).toString("utf8"));
    expect(result.pages).toBe(30);
    expect(result.chunks).toBeGreaterThan(0);

    const lines = (await getObjectBuffer(storage, bucket, `${jobId}/chunks.jsonl`))
      .toString("utf8").trimEnd().split("\n").map((l) => JSON.parse(l));
    const hit = lines.find((l) => l.text.includes("WORKER_NEEDLE"));
    // A chunk cites the RANGE of pages its text spans, not a single page: the
    // default chunkChars (4000) comfortably exceeds this fixture's ~2600
    // chars/page, so the chunk containing the needle routinely starts on the
    // page before it. pageStart..pageEnd is the honest citation; page 22 must
    // fall inside it.
    expect(hit).toBeTruthy();
    expect(hit.pageStart).toBeLessThanOrEqual(22);
    expect(hit.pageEnd).toBeGreaterThanOrEqual(22);
  });

  it("removes the message once the job succeeds", async () => {
    // Counted by receiving rather than by ApproximateNumberOfMessages, which
    // lags by up to a minute and would make this assertion a coin flip.
    expect(await peek(JOB_QUEUE)).toEqual([]);
  });

  it("leaves a failed job's message for another attempt rather than losing it", async () => {
    const jobId = await submit("broken.pdf", Buffer.from("%PDF-1.4 this is not a pdf\n"));
    expect(await runOnce(ctx)).toBe("failed");
    const job = await getJob(storage, jobId);
    expect(job?.state).toBe("queued");   // still queued: it will be retried
    expect(job?.attempts).toBe(1);
    expect(job?.error).toBeTruthy();
  });

  it("dead-letters after the attempt ceiling and marks the job failed", async () => {
    // maxDequeueCount is 3: a message dead-letters once its receive count
    // exceeds that. makeVisible() cannot fast-forward a message a FAILED
    // runOnce() call already left invisible — that lease is keyed to a receipt
    // handle only that caller ever held, and nothing else can shorten it before
    // the visibility window elapses. So the three "prior attempts" needed to
    // reach the ceiling come from makeVisible()'s OWN receive-then-reveal
    // cycles on a message nothing else has touched, back to back with no
    // runOnce() in between; runOnce() is reserved for the single receive that
    // actually crosses the ceiling.
    const jobId = await submit("broken2.pdf", Buffer.from("%PDF-1.4 also not a real pdf\n"));
    for (let i = 0; i < cfg.maxDequeueCount; i++) await makeVisible();

    expect(await runOnce(ctx)).toBe("dead-lettered");
    const job = await getJob(storage, jobId);
    expect(job?.state).toBe("failed");
    expect((await peek(POISON_QUEUE)).length).toBeGreaterThan(0);
  });

  it("verifies the declared digest and fails the job when it disagrees", async () => {
    const body = Buffer.from("# real content\n");
    const out = await createUploadUrl(ctx, {
      filename: "hashed.md", sizeBytes: body.length, sha256: "0".repeat(64) });
    await fetch(out.uploadUrl, { method: "PUT", body });
    await startJob(ctx, { jobId: out.jobId });
    expect(await runOnce(ctx)).toBe("failed");
    expect((await getJob(storage, out.jobId))?.error).toMatch(/checksum_mismatch/);
  });

  it("dead-letters a parseable message with no jobId instead of crashing on it", async () => {
    // A message like `{}` sails past JSON.parse (it IS valid JSON) but has
    // nothing runOnce can act on. Sent directly to the queue — startJob
    // always embeds a real jobId, so this simulates a malformed producer
    // rather than going through the normal path.
    await storage.queue(JOB_QUEUE).sendMessage(JSON.stringify({}));
    await expect(runOnce(ctx)).resolves.toBe("dead-lettered");
    expect(await peek(POISON_QUEUE)).toContain(JSON.stringify({}));
  });

  it("does not revert an already-succeeded job to queued when deleting its queue message fails (I4)", async () => {
    const jobId = await submit("delete-fail.md", Buffer.from("# doc\n\nsome content to chunk\n".repeat(20)));

    // A storage wrapper identical to the real one except that job-queue's
    // deleteMessage always fails — process1 still runs for real, against real
    // S3 and DynamoDB, so the job genuinely succeeds and its artifacts are
    // genuinely uploaded before the queue delete is even attempted. The
    // receipt handle it was called with is captured so the message can be
    // cleaned up afterwards through the real client, proving the failure was
    // purely at this call site and not a genuinely stuck lease.
    let deleteAttempts = 0;
    let captured: [string, string] | null = null;
    const flaky = {
      ...storage,
      queue: (key: QueueKey) => {
        const real = storage.queue(key);
        if (key !== JOB_QUEUE) return real;
        return {
          ...real,
          deleteMessage: async (messageId: string, receiptHandle: string) => {
            deleteAttempts++;
            captured = [messageId, receiptHandle];
            throw new Error("simulated transient deleteMessage failure");
          },
        };
      },
    } as any;

    const result = await runOnce({ cfg, storage: flaky });

    // The pre-fix code folded this into the same catch as a process1
    // failure, which wrote state: "queued" over the job's own
    // state: "succeeded" moments after process1 had set it — reprocessing a
    // job that had already finished and reporting the turn as "failed" even
    // though the document was fully extracted.
    expect(deleteAttempts).toBe(1);
    expect(result).toBe("processed");
    const job = await getJob(storage, jobId);
    expect(job?.state).toBe("succeeded");
    expect(job?.finishedAt).toBeTruthy();

    // Clean up through the real client so this message does not sit invisible
    // for the full 300s visibility window and confuse a later test file.
    expect(captured).not.toBeNull();
    await storage.queue(JOB_QUEUE).deleteMessage(...captured!);
  });
});
