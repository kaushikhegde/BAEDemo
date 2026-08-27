import { orchFetch, type OrchCtx } from "../orchestrator.js";

const MAX_COMMENTS = 20;
const MAX_COMMENT_CHARS = 400;

export interface IssueStatusArgs { issueId: string }

export const issueStatus = async (ctx: OrchCtx, args: IssueStatusArgs) => {
  const issue = await orchFetch<any>(ctx.cfg, "GET", `/issues/${encodeURIComponent(args.issueId)}`);
  const comments = await orchFetch<any[]>(
    ctx.cfg, "GET", `/issues/${encodeURIComponent(args.issueId)}/comments`).catch(() => []);
  const gates = await orchFetch<any[]>(
    ctx.cfg, "GET", `/issues/${encodeURIComponent(args.issueId)}/gates`).catch(() => []);

  // The engine narrates every step into comments; that timeline is what a person
  // watches. Capped so a long run cannot flood the model's context.
  const recent = (comments ?? []).slice(-MAX_COMMENTS).map((c: any) => ({
    author: c.author ?? c.agent_key ?? "engine",
    body: String(c.body ?? "").slice(0, MAX_COMMENT_CHARS),
  }));

  const pending = (gates ?? []).find((g: any) => g.status === "pending") ?? null;

  return {
    issueId: issue.id ?? args.issueId,
    status: issue.status,
    step: issue.step_index ?? null,
    workflow: issue.workflow_key ?? issue.workflow ?? null,
    project: issue.params?.project ?? null,
    feature: issue.params?.feature ?? null,
    gate: pending ? { id: pending.id, summary: pending.summary ?? null } : null,
    comments: recent,
  };
};
