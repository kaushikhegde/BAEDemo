import { orchFetch, type OrchCtx } from "../orchestrator.js";
import { userError } from "../../shared/errors.js";

const DIMENSIONS = ["project", "feature", "user", "agent", "adapter", "model"] as const;
export type SpendBy = (typeof DIMENSIONS)[number];

export const spend = async (ctx: OrchCtx, args: { by: SpendBy }) => {
  if (!DIMENSIONS.includes(args.by)) {
    throw userError("bad_dimension", `by must be one of ${DIMENSIONS.join(", ")}, got ${args.by}`);
  }
  // `/spend` on the platform router, NOT `/usage` — `/usage` is the whole
  // company as one row and takes no grouping at all. Admin-only: `requireAdmin`
  // answers 403, and orchFetch throws with the status in the message, so a
  // refusal reaches the caller as a refusal rather than an empty table.
  const rows = await orchFetch<any>(ctx.cfg, "GET", `/spend?by=${args.by}`);
  return { by: args.by, rows };
};
