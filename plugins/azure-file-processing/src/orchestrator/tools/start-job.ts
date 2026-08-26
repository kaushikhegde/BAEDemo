import { UPLOADS_CONTAINER, JOB_QUEUE } from "../../shared/config.js";
import { getJob, updateJob, type JobState } from "../../shared/jobs.js";
import { log } from "../../shared/logger.js";
import type { Ctx } from "../mcp.js";
import { userError } from "../../shared/errors.js";

export interface StartJobArgs {
  jobId: string;
  pipeline?: { id: string; params?: Record<string, number> };
}

const ALLOWED_PARAMS = ["chunkChars", "overlapChars", "pageWindow"] as const;

export const startJob = async (ctx: Ctx, args: StartJobArgs): Promise<{
  jobId: string; state: JobState; queuedAt: string; alreadyStarted: boolean;
}> => {
  const job = await getJob(ctx.storage, args.jobId);
  if (!job) throw userError("unknown_job", `unknown job ${args.jobId}`);
  if (job.state === "deleted") throw userError("job_deleted", `job ${args.jobId} was deleted`);

  // Idempotent: report the current state rather than enqueueing a duplicate.
  if (job.state !== "awaiting_upload") {
    return { jobId: job.jobId, state: job.state, queuedAt: job.createdAt, alreadyStarted: true };
  }

  const blob = ctx.storage.blob
    .getContainerClient(UPLOADS_CONTAINER).getBlockBlobClient(job.blobPath);
  let contentLength: number | undefined;
  try {
    contentLength = (await blob.getProperties()).contentLength;
  } catch (e: any) {
    if (e?.statusCode === 404) throw userError("not_uploaded", `job ${job.jobId} was not uploaded`);
    throw e;
  }
  if (contentLength !== job.sizeBytes) {
    throw userError("size_mismatch",
      `size mismatch: declared ${job.sizeBytes} bytes, storage holds ${contentLength}`);
  }
  // sha256 is NOT verified here: hashing means reading every byte, and this is
  // the control plane. The worker checks it while streaming (spec §6.2).

  const params: Record<string, number> = {};
  for (const k of ALLOWED_PARAMS) {
    const v = args.pipeline?.params?.[k];
    if (typeof v === "number" && Number.isFinite(v) && v > 0) params[k] = v;
  }

  // Claim BEFORE enqueueing, conditional on the etag we just read. Two
  // concurrent callers can both pass the "awaiting_upload" check above — the
  // read and the check are not atomic with what follows — so the write here
  // is what actually decides the race: only the caller still holding the
  // current etag can win it. A stale etag means someone else already claimed
  // the job; back off and report its state rather than enqueueing a second
  // message for the same jobId.
  const queuedAt = new Date().toISOString();
  try {
    await updateJob(ctx.storage, job.jobId, {
      state: "queued",
      pipelineId: args.pipeline?.id ?? "extract-chunks",
      params: JSON.stringify(params),
    }, { ifMatch: job.etag });
  } catch (e: any) {
    if (e?.statusCode === 412) {
      const current = await getJob(ctx.storage, job.jobId);
      return {
        jobId: job.jobId,
        state: current?.state ?? "queued",
        queuedAt: current?.createdAt ?? job.createdAt,
        alreadyStarted: true,
      };
    }
    throw e;
  }

  // Only now, after the claim has been won, do we enqueue. If sendMessage
  // fails from here the job is left "queued" with no message — a visible,
  // diagnosable state (job_status shows queued, the queue shows nothing) —
  // rather than the silent double-enqueue that enqueueing before the claim
  // would risk on a crash between the two writes.
  await ctx.storage.queue(JOB_QUEUE).sendMessage(JSON.stringify({ jobId: job.jobId }));

  log.info("job.queued", { jobId: job.jobId, sizeBytes: job.sizeBytes });
  return { jobId: job.jobId, state: "queued", queuedAt, alreadyStarted: false };
};
