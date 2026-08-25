import { getJob } from "../../shared/jobs.js";
import type { Ctx } from "../mcp.js";

export const jobStatus = async (ctx: Ctx, args: { jobId: string }) => {
  const job = await getJob(ctx.storage, args.jobId);
  if (!job) throw new Error(`unknown job ${args.jobId}`);
  // workerId is deliberately absent: it is how an operator proves two jobs ran
  // on two workers, not something a model should reason about.
  return {
    jobId: job.jobId,
    state: job.state,
    phase: job.phase,
    progress: { done: job.progressDone, total: job.progressTotal, unit: "pages" as const },
    attempts: job.attempts,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    error: job.error,
  };
};
