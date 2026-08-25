import { orchFetch, type OrchCtx } from "../orchestrator.js";

/** Pause is a REQUEST, not a status: the engine honours it at its next step
 *  boundary. `force` stops the agent in flight, losing that step's work. */
export const pauseIssue = async (ctx: OrchCtx, args: { issueId: string; force?: boolean }) => {
  await orchFetch(ctx.cfg, "POST", `/issues/${encodeURIComponent(args.issueId)}/pause`,
    { force: Boolean(args.force) });
  return { issueId: args.issueId, requested: args.force ? "pause_now" : "pause" };
};

export const resumeIssue = async (ctx: OrchCtx, args: { issueId: string }) => {
  await orchFetch(ctx.cfg, "POST", `/issues/${encodeURIComponent(args.issueId)}/resume`, {});
  return { issueId: args.issueId, requested: "resume" };
};
