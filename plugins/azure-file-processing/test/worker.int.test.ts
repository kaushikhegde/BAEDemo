import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, JOB_QUEUE, POISON_QUEUE, ARTIFACTS_CONTAINER } from "../src/shared/config.js";
import { getStorage, ensureStorage } from "../src/shared/storage.js";
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

const drainQueue = async (name: string) => {
  const q = storage.queue(name);
  for (;;) {
    const r = await q.receiveMessages({ numberOfMessages: 32 });
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
  await fetch(out.uploadUrl, {
    method: "PUT", headers: { "x-ms-blob-type": "BlockBlob" }, body: Buffer.from(bytes),
  });
  await startJob(ctx, { jobId: out.jobId });
  return out.jobId;
};

// A failed attempt leaves the message invisible for the full visibility
// timeout (300s), which would make the dead-letter test below wait five
// minutes for nothing. This receives the message and immediately rewrites its
// visibility to 0, so the next receive can happen right away.
const makeVisible = async () => {
  const q = storage.queue(JOB_QUEUE);
  const r = await q.receiveMessages({ numberOfMessages: 1, visibilityTimeout: 1 });
  const m = r.receivedMessageItems[0];
  if (m) await q.updateMessage(m.messageId, m.popReceipt, undefined, 0);
};

describe("runOnce", () => {
  // Captured once, right after the drain and before any test runs. Comparing
  // against this baseline (rather than asserting a bare 0) makes the check
  // below robust to a stray message elsewhere in job-queue that is currently
  // INVISIBLE (leased) rather than absent — approximateMessagesCount counts
  // both, and an invisible lease from a run within the last
  // VISIBILITY_SECONDS cannot be reclaimed by drainQueue's own receive. The
  // "processes a PDF" test below adds exactly one message and removes it on
  // success, so the delta is 0 regardless of what this baseline already was.
  let queueCountAfterDrain = 0;
  beforeAll(async () => {
    await drainQueue(JOB_QUEUE);
    await drainQueue(POISON_QUEUE);
    queueCountAfterDrain = (await storage.queue(JOB_QUEUE).getProperties()).approximateMessagesCount ?? 0;
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

    const c = storage.blob.getContainerClient(ARTIFACTS_CONTAINER);
    const result = JSON.parse(
      (await c.getBlockBlobClient(`${jobId}/result.json`).downloadToBuffer()).toString("utf8"));
    expect(result.pages).toBe(30);
    expect(result.chunks).toBeGreaterThan(0);

    const lines = (await c.getBlockBlobClient(`${jobId}/chunks.jsonl`).downloadToBuffer())
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
    const props = await storage.queue(JOB_QUEUE).getProperties();
    expect(props.approximateMessagesCount ?? 0).toBe(queueCountAfterDrain);
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
    // maxDequeueCount is 3: a message dead-letters once dequeueCount exceeds
    // that. makeVisible() cannot be used to fast-forward a message a FAILED
    // runOnce() call already left invisible: that lease belongs to whichever
    // caller's receiveMessages() created it, is keyed to a pop receipt only
    // that caller ever held, and nothing else — not even a fresh
    // receiveMessages() call — can shorten or reclaim it before the full
    // visibility window elapses (confirmed against real Azurite: a second
    // receive on an already-invisible message returns nothing, every time).
    // So the three "prior attempts" needed to reach the ceiling have to come
    // from makeVisible()'s OWN receive-then-reveal cycles on a message
    // nothing else has touched yet, back to back with no runOnce() in
    // between — runOnce() is reserved for the single receive that actually
    // crosses the ceiling and triggers dead-lettering.
    const jobId = await submit("broken2.pdf", Buffer.from("%PDF-1.4 also not a real pdf\n"));
    for (let i = 0; i < cfg.maxDequeueCount; i++) await makeVisible();

    expect(await runOnce(ctx)).toBe("dead-lettered");
    const job = await getJob(storage, jobId);
    expect(job?.state).toBe("failed");
    const poison = await storage.queue(POISON_QUEUE).peekMessages({ numberOfMessages: 8 });
    expect(poison.peekedMessageItems.length).toBeGreaterThan(0);
  });

  it("verifies the declared digest and fails the job when it disagrees", async () => {
    const body = Buffer.from("# real content\n");
    const out = await createUploadUrl(ctx, {
      filename: "hashed.md", sizeBytes: body.length, sha256: "0".repeat(64) });
    await fetch(out.uploadUrl, { method: "PUT", headers: { "x-ms-blob-type": "BlockBlob" }, body });
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
    const poison = await storage.queue(POISON_QUEUE).peekMessages({ numberOfMessages: 8 });
    expect(poison.peekedMessageItems.some((m) => m.messageText === JSON.stringify({}))).toBe(true);
  });

  it("does not revert an already-succeeded job to queued when deleting its queue message fails (I4)", async () => {
    const jobId = await submit("delete-fail.md", Buffer.from("# doc\n\nsome content to chunk\n".repeat(20)));

    // A storage wrapper identical to the real one except that job-queue's
    // deleteMessage always fails — process1 still runs for real, against the
    // real Azurite, so the job genuinely succeeds and its artifacts are
    // genuinely uploaded before the queue delete is even attempted. The
    // (messageId, popReceipt) it was called with is captured so the message
    // can be cleaned up afterwards through the real client, proving the
    // failure was purely at this call site and not a genuinely stuck lease.
    let deleteAttempts = 0;
    let captured: [string, string] | null = null;
    const flaky = {
      ...storage,
      queue: (name: string) => {
        const real = storage.queue(name);
        if (name !== JOB_QUEUE) return real;
        // A Proxy rather than a spread: QueueClient's methods live on its
        // prototype, not as own properties, so `{ ...real, deleteMessage }`
        // silently drops receiveMessages/updateMessage/etc. instead of
        // forwarding them.
        return new Proxy(real, {
          get(target, prop, receiver) {
            if (prop === "deleteMessage") {
              return async (messageId: string, popReceipt: string) => {
                deleteAttempts++;
                captured = [messageId, popReceipt];
                throw new Error("simulated transient deleteMessage failure");
              };
            }
            const value = Reflect.get(target, prop, receiver);
            return typeof value === "function" ? value.bind(target) : value;
          },
        }) as any;
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

    // Clean up through the real client so this message does not sit
    // invisible for the full 300s visibility window and confuse a later
    // test file.
    expect(captured).not.toBeNull();
    await storage.queue(JOB_QUEUE).deleteMessage(...captured!);
  });
});
