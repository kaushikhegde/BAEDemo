import { UPLOADS, ARTIFACTS } from "../../shared/config.js";
import { getJob, updateJob } from "../../shared/jobs.js";
import { deleteObjects, listObjects, type Storage } from "../../shared/storage.js";
import { log } from "../../shared/logger.js";
import type { Ctx } from "../mcp.js";
import { userError } from "../../shared/errors.js";
import type { BucketKey } from "../../shared/config.js";

/** Enumerate then batch-delete, rather than one DeleteObject per key: S3 takes
 *  a thousand keys per call, and a job with thousands of artifacts would
 *  otherwise take minutes of round trips to remove. The keys are collected
 *  first because DeleteObjects wants them in one array — bounded by the fact
 *  that a job's own prefix holds a handful of artifacts plus its upload. */
const purge = async (s: Storage, bucket: BucketKey, prefix: string): Promise<number> => {
  const keys: string[] = [];
  for await (const o of listObjects(s, s.bucket(bucket), prefix)) keys.push(o.key);
  if (!keys.length) return 0;
  return deleteObjects(s, s.bucket(bucket), keys);
};

export const deleteJob = async (ctx: Ctx, args: { jobId: string }) => {
  const job = await getJob(ctx.storage, args.jobId);
  if (!job) throw userError("unknown_job", `unknown job ${args.jobId}`);

  // The worker uploads its artifacts and writes `state: "succeeded"`
  // unconditionally, with no check that the job it is finishing has not
  // meanwhile been deleted. Purging now and refusing later would let a
  // `queued`/`running` job's own completion re-create everything this call
  // just removed, moments after the caller was told `{ deleted: true }` —
  // data a client asked to be destroyed coming back on its own. Refuse
  // instead, before anything is purged.
  if (job.state === "queued" || job.state === "running") {
    throw userError("job_not_terminal",
      `job ${args.jobId} is ${job.state}: wait for it to reach a terminal state ` +
      `(succeeded, failed or deleted) before deleting it`);
  }

  const prefix = `${args.jobId}/`;
  const objectsRemoved =
    (await purge(ctx.storage, UPLOADS, prefix)) +
    (await purge(ctx.storage, ARTIFACTS, prefix));

  // The row is retained, not dropped: an id a user still holds should explain
  // itself rather than answer "unknown job".
  await updateJob(ctx.storage, args.jobId, {
    state: "deleted", phase: null, finishedAt: new Date().toISOString(),
  });

  log.info("job.deleted", { jobId: args.jobId, objectsRemoved });
  return { jobId: args.jobId, deleted: true as const, objectsRemoved };
};
