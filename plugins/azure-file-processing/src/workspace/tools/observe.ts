import { orchFetch, type OrchCtx } from "../orchestrator.js";
import { chatFetch, type WsCtx } from "../chatbot.js";
import { userError } from "../../shared/errors.js";

/**
 * Watching what happened — the CLI's `logs`, `actions` and `run cancel`, and
 * the chatbot's request-changes path.
 *
 * `spend` and `list_issues` already existed; these are the rest of the
 * observability surface, so a person working from Codex can answer "what did
 * that agent actually do" and "who approved this" without opening the console.
 */

/** Cancel is NOT pause. Pause parks the issue and resumes from the same step;
 *  cancel ends it for good and `core/retry.ts` refuses to retry it. Separate
 *  tools rather than a flag, because the difference is irreversible. */
export const cancelIssue = async (ctx: OrchCtx, args: { issueId: string }) =>
  orchFetch<any>(ctx.cfg, "POST", `/issues/${encodeURIComponent(args.issueId)}/cancel`, {});

/** Every agent run against one issue: agent, phase, duration, tokens, cost. */
export const issueRuns = async (ctx: OrchCtx, args: { issueId: string }) =>
  orchFetch<any>(ctx.cfg, "GET", `/issues/${encodeURIComponent(args.issueId)}/runs`);

/**
 * One run's transcript — tool calls, skill invocations and assistant text,
 * filtered and with secrets scrubbed.
 *
 * Capped, because a transcript is the one orchestrator response with no size
 * bound: a twenty-five-minute agent run over a large corpus produces megabytes
 * of events, and returning them whole is precisely the context flooding this
 * plugin exists to prevent. The tail is what a person debugging a failure
 * wants — the last thing it did before it stopped.
 */
export const runTranscript = async (
  ctx: OrchCtx, args: { runId: string; maxChars?: number },
) => {
  const cap = Math.min(args.maxChars ?? 8_000, 32_000);
  const raw = await orchFetch<any>(
    ctx.cfg, "GET", `/runs/${encodeURIComponent(args.runId)}/transcript`);
  const text = typeof raw === "string" ? raw : JSON.stringify(raw);
  if (text.length <= cap) return { runId: args.runId, truncated: false, transcript: text };
  return {
    runId: args.runId,
    truncated: true,
    omittedChars: text.length - cap,
    note: `Showing the last ${cap} characters of ${text.length}. Raise maxChars (max 32000) for more.`,
    transcript: text.slice(-cap),
  };
};

/** The organisation's audit feed: who started, approved, paused or cancelled
 *  what. Admin-only upstream — a 403 is passed through as a refusal rather
 *  than collapsed into an empty list, which would read as "nothing happened". */
export const actions = async (ctx: WsCtx) => chatFetch<any>(ctx.cfg, "GET", "/api/actions");

/** Completed runs with their wiki and work-item links — what was produced and
 *  where it was published. */
export const history = async (ctx: WsCtx) => chatFetch<any>(ctx.cfg, "GET", "/api/history");

/** Reviewer feedback on a pending gate: comments it onto the issue and re-fires
 *  the assignee to regenerate. Distinct from reject_gate, which rewinds without
 *  a conversation, and from approve_gate, which publishes. */
export const requestChanges = async (
  ctx: WsCtx, args: { approvalId: string; feedback: string },
) => {
  if (!args.feedback.trim()) {
    throw userError("feedback_required", "feedback is required — it is what the agent is given to know what to fix");
  }
  return chatFetch<any>(
    ctx.cfg, "POST", `/api/request-changes/${encodeURIComponent(args.approvalId)}`,
    { feedback: args.feedback });
};
