import { orchFetch, type OrchCtx } from "../orchestrator.js";
import { log } from "../../shared/logger.js";
import { userError } from "../../shared/errors.js";

export const approveGate = async (ctx: OrchCtx, args: { gateId: string }) => {
  // Answers 202 and resumes in the background: the publish step runs after this.
  await orchFetch(ctx.cfg, "POST", `/gates/${encodeURIComponent(args.gateId)}/approve`, {});
  log.info("workspace.gate_approved", { gateId: args.gateId });
  return { gateId: args.gateId, decision: "approved" as const };
};

export const rejectGate = async (ctx: OrchCtx, args: { gateId: string; note: string }) => {
  // A rejection rewinds to the generating step and regenerates. Without a note
  // the agent is told to try again with no idea what was wrong.
  if (!args.note || !args.note.trim()) {
    throw userError("note_required", "a note is required when rejecting — it is what the agent is given to fix");
  }
  await orchFetch(ctx.cfg, "POST", `/gates/${encodeURIComponent(args.gateId)}/reject`,
    { note: args.note });
  log.info("workspace.gate_rejected", { gateId: args.gateId });
  return { gateId: args.gateId, decision: "rejected" as const };
};
