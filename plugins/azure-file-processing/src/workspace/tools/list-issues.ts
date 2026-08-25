import { orchFetch, type OrchCtx } from "../orchestrator.js";

export interface ListIssuesArgs {
  project?: string; feature?: string; status?: string; open?: boolean;
}

const NEEDS_HUMAN = new Set(["in_review", "blocked", "paused"]);

/** The statuses that mean a person has to do something. */
const OPEN = new Set(["todo", "in_progress", "in_review", "blocked", "paused"]);

/**
 * `ListIssuesFilter` in core/repo.ts accepts ONLY parentId, status and
 * assigneeAgentId — there is no project or feature column to filter on, the
 * project lives in `params` as jsonb. So `status` is the one filter that goes
 * over the wire; the rest are applied here. Sending `?project=` would be
 * WORSE than filtering locally: the route ignores an unknown query parameter,
 * so it would answer with every issue in the company while appearing to have
 * filtered.
 */
export const listIssues = async (ctx: OrchCtx, args: ListIssuesArgs) => {
  const q = new URLSearchParams();
  if (args.status) q.set("status", args.status);
  const path = `/issues${q.toString() ? `?${q}` : ""}`;

  const raw = await orchFetch<any>(ctx.cfg, "GET", path);
  let rows: any[] = Array.isArray(raw) ? raw : (raw?.issues ?? []);

  if (args.project) rows = rows.filter((i) => i.params?.project === args.project);
  if (args.feature) rows = rows.filter((i) => i.params?.feature === args.feature);
  if (args.open) rows = rows.filter((i) => OPEN.has(i.status));

  return {
    issues: rows.map((i) => ({
      // The raw uuid, not the "SCY-7" identifier: `GET /issues/:id` (what
      // issue_status and every control tool call next) looks up strictly by
      // `id` — `where id=$1` in core/repo.ts — never by identifier.
      issueId: i.id,
      identifier: i.identifier ?? null,
      workflow: i.workflow_key ?? i.workflow ?? null,
      project: i.params?.project ?? null,
      feature: i.params?.feature ?? null,
      status: i.status,
      step: i.step_index ?? null,
      needsHuman: NEEDS_HUMAN.has(i.status),
    })),
  };
};
