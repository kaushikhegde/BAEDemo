import { UPLOADS_CONTAINER, ARTIFACTS_CONTAINER } from "../../shared/config.js";
import { getJob, updateJob } from "../../shared/jobs.js";
import { log } from "../../shared/logger.js";
import type { Ctx } from "../mcp.js";
import type { Storage } from "../../shared/storage.js";

const purge = async (s: Storage, container: string, prefix: string): Promise<number> => {
  const client = s.blob.getContainerClient(container);
  let removed = 0;
  for await (const blob of client.listBlobsFlat({ prefix })) {
    await client.getBlockBlobClient(blob.name).deleteIfExists();
    removed++;
  }
  return removed;
};

export const deleteJob = async (ctx: Ctx, args: { jobId: string }) => {
  const job = await getJob(ctx.storage, args.jobId);
  if (!job) throw new Error(`unknown job ${args.jobId}`);

  // The worker uploads its four artifacts and writes `state: "succeeded"`
  // unconditionally, with no check that the job it is finishing has not
  // meanwhile been deleted. Purging now and refusing later would let a
  // `queued`/`running` job's own completion re-create everything this call
  // just removed, moments after the caller was told `{ deleted: true }` —
  // data a client asked to be destroyed coming back on its own. Refuse
  // instead, before anything is purged.
  if (job.state === "queued" || job.state === "running") {
    throw new Error(
      `job ${args.jobId} is ${job.state}: wait for it to reach a terminal state ` +
      `(succeeded, failed or deleted) before deleting it`);
  }

  const prefix = `${args.jobId}/`;
  const blobsRemoved =
    (await purge(ctx.storage, UPLOADS_CONTAINER, prefix)) +
    (await purge(ctx.storage, ARTIFACTS_CONTAINER, prefix));

  // The row is retained, not dropped: an id a user still holds should explain
  // itself rather than answer "unknown job".
  await updateJob(ctx.storage, args.jobId, {
    state: "deleted", phase: null, finishedAt: new Date().toISOString(),
  });

  log.info("job.deleted", { jobId: args.jobId, blobsRemoved });
  return { jobId: args.jobId, deleted: true as const, blobsRemoved };
};
