import { rm, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { extname, join } from "node:path";
import {
  loadConfig, JOB_QUEUE, POISON_QUEUE, type Config,
} from "../shared/config.js";
import { getStorage, ensureStorage, type Queue, type Storage } from "../shared/storage.js";
import { getJob, updateJob } from "../shared/jobs.js";
import { log } from "../shared/logger.js";
import { downloadToTemp } from "./download.js";
import { writeArtifacts } from "./artifacts.js";
import { extractPages, readMetadata, canExtractPages } from "./extract/index.js";
import { writeMarkdownFile, type Converter } from "./markdown.js";

export const WORKER_ID = `w-${randomUUID().slice(0, 8)}`;

const VISIBILITY_SECONDS = 300;   // longer than any single page window
const HEARTBEAT_MS = 120_000;     // renewed well inside the visibility window
const PROGRESS_EVERY_MS = 2_000;

export interface Ctx { cfg: Config; storage: Storage }
export type Turn = "idle" | "processed" | "failed" | "dead-lettered";

/**
 * Runs `work` while periodically renewing `msg`'s visibility so it survives
 * longer than any single VISIBILITY_SECONDS window, then hands back `work`'s
 * result together with the pop receipt that is current once `work` settles.
 *
 * An SQS ReceiptHandle, unlike an Azure pop receipt, is STABLE for the life of
 * the receive — ChangeMessageVisibility does not rotate it — so the moving
 * target this helper was written to chase does not exist here. It is kept
 * whole anyway, and for a reason rather than out of caution: a bare
 * `clearInterval` stops FUTURE ticks but does not cancel a renewal already on
 * the wire, and awaiting that in-flight call in `finally` is what stops a
 * ChangeMessageVisibility landing AFTER the DeleteMessage that follows —
 * against a receipt the queue has already retired. That fails, and — worse —
 * on the pre-split error handling it landed in the same catch as a genuine
 * processing failure, so a job that actually finished successfully got its
 * `succeeded` state overwritten back to `queued` and reprocessed. The receipt
 * is returned unchanged, which is what the queue wrapper promises.
 */
export const withRenewedVisibility = async <T>(
  queue: Pick<Queue, "updateMessage">,
  msg: { messageId: string; popReceipt: string },
  visibilitySeconds: number,
  heartbeatMs: number,
  work: () => Promise<T>,
): Promise<{ result: T; popReceipt: string }> => {
  let popReceipt = msg.popReceipt;
  let renewing: Promise<void> = Promise.resolve();
  const heartbeat = setInterval(() => {
    renewing = queue.updateMessage(msg.messageId, popReceipt, undefined, visibilitySeconds)
      .then((r) => { if (r.popReceipt) popReceipt = r.popReceipt; })
      .catch((e) => log.warn("queue.heartbeat_failed", {
        messageId: msg.messageId, message: String(e.message).slice(0, 200),
      }));
  }, heartbeatMs);

  let result: T;
  try {
    result = await work();
  } finally {
    clearInterval(heartbeat);
    await renewing; // wait out whatever renewal is still on the wire before reading popReceipt
  }
  return { result, popReceipt };
};

/**
 * Removes every entry directly under `tempDir` (spec §8.3). The per-job
 * `finally` in process1/downloadToTemp/writeArtifacts covers ordinary
 * failure, but not a SIGKILL mid-download — and a container's writable layer
 * survives `docker restart`, so a scratch file from a killed job is otherwise
 * never reclaimed. Exported and called once at startup, before the service
 * loop begins, so a restart after a crash starts from a clean tempDir rather
 * than accumulating leaked disk across restarts.
 *
 * Must not throw if the directory does not exist — a first boot with nothing
 * written yet is the common case, not an error.
 */
export const sweepTempDir = async (tempDir: string): Promise<number> => {
  let entries: string[];
  try {
    entries = await readdir(tempDir);
  } catch (e: any) {
    if (e?.code === "ENOENT") return 0;
    throw e;
  }
  await Promise.all(entries.map((name) =>
    rm(join(tempDir, name), { recursive: true, force: true })));
  return entries.length;
};

const process1 = async (ctx: Ctx, jobId: string, attempt: number): Promise<void> => {
  const job = await getJob(ctx.storage, jobId);
  if (!job) throw new Error(`unknown job ${jobId}`);

  await updateJob(ctx.storage, jobId, {
    state: "running", phase: "downloading", workerId: WORKER_ID,
    attempts: attempt, startedAt: new Date().toISOString(), error: null,
  });

  const downloaded = await downloadToTemp(ctx.storage, ctx.cfg, job.objectKey, {
    expectSha256: job.sha256,
  });

  // Declared outside the try so the finally can remove it. It holds a full
  // markdown rendering of the document — for a large spreadsheet that is not
  // small — and a job that throws mid-chunking must not leave one behind on a
  // worker that will run thousands more.
  let preScratch: string | null = null;

  try {
    const ext = extname(job.filename).toLowerCase();
    const params = JSON.parse(job.params || "{}") as Record<string, number>;
    const chunkChars = params.chunkChars ?? ctx.cfg.chunkChars;
    const overlapChars = params.overlapChars ?? ctx.cfg.overlapChars;
    const pageWindow = params.pageWindow ?? ctx.cfg.pageWindow;

    await updateJob(ctx.storage, jobId, { phase: "extracting" });

    // A spreadsheet or a slide deck has no page text to stream, so there is
    // nothing for the chunker to consume. Converting it to markdown FIRST and
    // chunking that gives those formats working search and fetch — without
    // page citations, which they never had to give: a .pptx has slides and a
    // .xlsx has sheets, neither of which is a page. Formats the page extractor
    // CAN read are left alone, so a PDF keeps the page-accurate citations that
    // are the whole point of the file plane.
    let chunkPath = downloaded.path;
    let chunkExt = ext;
    let preConverted: Converter | null = null;
    if (!canExtractPages(ext)) {
      preScratch = join(ctx.cfg.tempDir, `${randomUUID()}-pre.md`);
      await updateJob(ctx.storage, jobId, { phase: "converting" });
      preConverted = (await writeMarkdownFile(
        preScratch, downloaded.path, ext, job.filename, ctx.cfg,
      )).converter;
      chunkPath = preScratch;
      chunkExt = ".md";
    }

    const meta = await readMetadata(chunkPath, chunkExt);
    await updateJob(ctx.storage, jobId, { progressTotal: meta.pages, phase: "chunking" });

    // Progress is throttled: a page-per-write would put thousands of round
    // trips on the job table for a large document and tell a reader nothing
    // more than one every couple of seconds does.
    let lastWrite = 0;
    const result = await writeArtifacts(ctx.storage, ctx.cfg, jobId, {
      pages: extractPages(chunkPath, chunkExt, { pageWindow }),
      meta, chunkChars, overlapChars,
      // The temp file is already here and already verified against the sha256
      // the uploader recorded, so rendering markdown from it costs a second
      // local read and no second download. For a pre-converted format this
      // points at the markdown, so writeMarkdownFile copies it through rather
      // than running a second, identical conversion — `converterOverride`
      // carries the engine that actually did the work, which would otherwise
      // be reported as the passthrough that merely copied its output.
      source: {
        path: chunkPath, ext: chunkExt, filename: job.filename,
        converterOverride: preConverted,
      },
      onProgress: (done) => {
        const now = Date.now();
        if (now - lastWrite < PROGRESS_EVERY_MS) return;
        lastWrite = now;
        void updateJob(ctx.storage, jobId, { progressDone: done }).catch(() => {});
      },
    });

    await updateJob(ctx.storage, jobId, {
      state: "succeeded", phase: "done",
      progressDone: result.pages, progressTotal: result.pages,
      finishedAt: new Date().toISOString(),
    });
    log.info("job.succeeded", {
      jobId, workerId: WORKER_ID, pages: result.pages,
      chunks: result.chunks, durationMs: result.durationMs,
    });
  } finally {
    await rm(downloaded.path, { force: true });
    if (preScratch) await rm(preScratch, { force: true }).catch(() => {});
  }
};

export const runOnce = async (ctx: Ctx): Promise<Turn> => {
  const queue = ctx.storage.queue(JOB_QUEUE);
  const received = await queue.receiveMessages({
    numberOfMessages: 1, visibilityTimeout: VISIBILITY_SECONDS,
  });
  const msg = received.receivedMessageItems[0];
  if (!msg) return "idle";

  let jobId = "";
  try {
    const parsed = JSON.parse(msg.messageText);
    // A parseable message with no (or a non-string) jobId is just as dead as
    // one that fails to parse at all — nothing will ever make it valid — and
    // must be caught HERE, before jobId is used anywhere else. Left
    // unguarded, `jobId` stays `undefined` and the first attempt to log it
    // (the logger refuses any non-scalar field) throws an unrelated,
    // confusing error instead of the clean dead-letter this deserves.
    if (typeof parsed?.jobId !== "string" || !parsed.jobId) {
      throw new Error("message has no jobId");
    }
    jobId = parsed.jobId;
  } catch {
    // Unparseable message, or one with no usable jobId: nothing will ever
    // make it valid, so retiring it is the only outcome that does not wedge
    // the queue forever.
    await ctx.storage.queue(POISON_QUEUE).sendMessage(msg.messageText);
    await queue.deleteMessage(msg.messageId, msg.popReceipt);
    log.error("queue.unreadable_message", { messageId: msg.messageId });
    return "dead-lettered";
  }

  // ApproximateReceiveCount, and "approximate" is honest — a worker killed
  // between receiving and processing can have a message counted without ever
  // touching it. It is exactly as reliable as Azure's dequeueCount was for the
  // one decision it drives: when to stop handing a message to workers it keeps
  // killing. Erring toward dead-lettering one attempt early is the safe side.
  if (msg.dequeueCount > ctx.cfg.maxDequeueCount) {
    await ctx.storage.queue(POISON_QUEUE).sendMessage(msg.messageText);
    await queue.deleteMessage(msg.messageId, msg.popReceipt);
    await updateJob(ctx.storage, jobId, {
      state: "failed", phase: null, finishedAt: new Date().toISOString(),
      error: `dead-lettered after ${msg.dequeueCount - 1} attempts`,
    }).catch(() => {});
    log.error("job.dead_lettered", { jobId, attempts: msg.dequeueCount - 1 });
    return "dead-lettered";
  }

  // Keep the message invisible while work is in flight. A crashed worker simply
  // stops renewing, and the message reappears for someone else once its
  // visibility timeout lapses — which is the whole reason the queue owns retry
  // rather than a hand-rolled lease.
  let popReceipt: string;
  try {
    ({ popReceipt } = await withRenewedVisibility(
      queue, msg, VISIBILITY_SECONDS, HEARTBEAT_MS,
      () => process1(ctx, jobId, msg.dequeueCount),
    ));
  } catch (e) {
    // The message is NOT deleted: it becomes visible again when the visibility
    // timeout lapses, and dequeueCount decides when to give up.
    const message = String((e as Error).message).slice(0, 400);
    await updateJob(ctx.storage, jobId, {
      state: "queued", phase: null, attempts: msg.dequeueCount, error: message,
    }).catch(() => {});
    log.error("job.attempt_failed", { jobId, attempt: msg.dequeueCount, message });
    return "failed";
  }

  // Deliberately its own try/catch, outside the one above: by this point
  // process1 has already succeeded, uploaded every artifact and written
  // `state: "succeeded"` to the job row. A transient failure deleting the
  // QUEUE MESSAGE is not a processing failure and must never be treated as
  // one — folding it into the catch above reverted an already-succeeded
  // job's state back to "queued", overwriting real, finished work over a
  // network blip on an unrelated call. The message simply becomes visible
  // again after the visibility window and gets reprocessed (wasteful, since
  // the job already succeeded, but not destructive — every upload in
  // writeArtifacts is idempotent by path).
  try {
    await queue.deleteMessage(msg.messageId, popReceipt);
  } catch (e) {
    log.error("queue.delete_failed", {
      jobId, messageId: msg.messageId,
      message: String((e as Error).message).slice(0, 400),
    });
  }
  return "processed";
};

/**
 * One turn of the service loop, wrapped so a turn that throws — a transient
 * network blip reaching `receiveMessages`, or `sendMessage`/`deleteMessage`
 * failing inside one of `runOnce`'s dead-letter branches, neither of which
 * `runOnce`'s own try/catch covers — is logged and backed off from rather
 * than killing the whole worker process. Exported so the boundary itself is
 * testable without spawning a real, indefinitely-looping process.
 */
export const runResilientTurn = async (
  ctx: Ctx, opts: { idleDelayMs?: number; errorBackoffMs?: number } = {},
): Promise<Turn | "error"> => {
  const idleDelayMs = opts.idleDelayMs ?? 1_000;
  const errorBackoffMs = opts.errorBackoffMs ?? 5_000;
  try {
    const turn = await runOnce(ctx);
    if (turn === "idle") await new Promise((r) => setTimeout(r, idleDelayMs));
    return turn;
  } catch (e) {
    log.error("worker.turn_failed", {
      workerId: WORKER_ID, message: String((e as Error)?.message ?? e).slice(0, 400),
    });
    await new Promise((r) => setTimeout(r, errorBackoffMs));
    return "error";
  }
};

// Entry point when run as a service.
if (import.meta.url === `file://${process.argv[1]}`) {
  const cfg = loadConfig();
  const storage = getStorage(cfg);
  await ensureStorage(storage);
  // Before the loop, so a SIGKILL mid-download in a previous life of this
  // container cannot leak disk across restarts (spec §8.3).
  const swept = await sweepTempDir(cfg.tempDir);
  if (swept > 0) log.info("worker.temp_swept", { workerId: WORKER_ID, entries: swept });
  log.info("worker.started", { workerId: WORKER_ID });
  for (;;) await runResilientTurn({ cfg, storage });
}
