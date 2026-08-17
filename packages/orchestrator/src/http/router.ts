// The mountable HTTP surface of @scyne/orchestrator. `createRouter(orch)`
// wires an Express Router straight onto the pieces `createOrchestrator`
// already assembled (db, repo, engine, config) — it adds no state and no
// business logic of its own beyond request/response shaping. `ROUTES` is the
// single source of truth for "what routes exist"; test/openapi.test.ts diffs
// it against openapi.yaml in BOTH directions, so this array and the spec can
// never silently drift apart.

import { Router, type Request, type Response } from "express";
import { readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { filterRunLog } from "../core/transcript.js";
import { EFFORTS } from "../config.js";
import type {
  AgentBudget, AgentRow, AgentSpec, Effort, ListIssuesFilter, RunRow, UpdateIssuePatch,
} from "../core/repo.js";
import { resolveTheme } from "./theme.js";
import { createDocsHandlers } from "./docs.js";
import type { createOrchestrator } from "../index.js";

/**
 * The route table, kept as DATA rather than inferred from the Router at
 * runtime — `test/openapi.test.ts` imports this array and diffs it against
 * `openapi.yaml`'s `paths`, in both directions: every route here must be
 * documented, and every documented route must be implemented. `{key}`/`{id}`
 * placeholders match the OpenAPI path-template convention (Express itself
 * uses `:key`/`:id`; the mapping between the two is only ever done by eye
 * when adding a route, which is exactly the discipline this table exists to
 * enforce).
 */
export const ROUTES = [
  { method: "GET",   path: "/health" },
  { method: "GET",   path: "/agents" },
  { method: "GET",   path: "/agents/{key}" },
  { method: "PATCH", path: "/agents/{key}" },   // adapter · model · effort · fallbackModel · budget
  { method: "GET",   path: "/agents/{key}/runs" },
  { method: "GET",   path: "/runners" },        // registered adapters
  { method: "POST",  path: "/issues" },
  { method: "GET",   path: "/issues" },
  { method: "GET",   path: "/issues/{id}" },
  { method: "PATCH", path: "/issues/{id}" },
  { method: "GET",   path: "/issues/{id}/comments" },
  { method: "POST",  path: "/issues/{id}/comments" },
  { method: "GET",   path: "/issues/{id}/work-products" },
  { method: "GET",   path: "/issues/{id}/gates" },
  { method: "POST",  path: "/gates/{id}/approve" },
  { method: "POST",  path: "/gates/{id}/reject" },
  { method: "GET",   path: "/issues/{id}/runs" },
  { method: "GET",   path: "/runs/{id}" },
  { method: "GET",   path: "/runs/{id}/log" },
  { method: "GET",   path: "/runs/{id}/transcript" },
  { method: "GET",   path: "/usage" },
  { method: "GET",   path: "/config" },
  { method: "GET",   path: "/openapi.json" },
  { method: "GET",   path: "/docs" },
] as const;

interface AgentPatchBody {
  adapter?: string; model?: string; effort?: Effort;
  fallbackModel?: string[]; budget?: AgentBudget;
}

/**
 * `@types/express`'s `ParamsDictionary` types every path param as `string |
 * string[]` (a param repeated via a wildcard `*` segment could come back as
 * an array) — none of this router's routes use a wildcard, so every param is
 * always a single string in practice. Narrowed once here rather than cast at
 * every call site below.
 */
function pathParam(v: string | string[]): string {
  return Array.isArray(v) ? v[0] : v;
}

const execFileAsync = promisify(execFile);

// Memoised for the life of the process: the Claude Code binary on PATH does
// not change between requests, so re-spawning it on every /health poll would
// be pure overhead for no new information. A restart of this process is what
// picks up a `claude` upgrade — the same granularity the orchestrator itself
// runs at.
let cachedClaudeVersion: string | undefined;
async function getClaudeVersion(): Promise<string> {
  if (cachedClaudeVersion) return cachedClaudeVersion;
  try {
    const { stdout } = await execFileAsync("claude", ["--version"], { timeout: 3_000 });
    cachedClaudeVersion = stdout.trim() || "unknown";
  } catch {
    cachedClaudeVersion = "unknown";
  }
  return cachedClaudeVersion;
}

export function createRouter(orch: Awaited<ReturnType<typeof createOrchestrator>>): Router {
  const r = Router();

  const ok = (res: Response, body: unknown): void => { res.json(body); };
  const notFound = (res: Response, what: string): void => { res.status(404).json({ error: `${what} not found` }); };
  const badRequest = (res: Response, message: string): void => { res.status(400).json({ error: message }); };

  const wrap = (fn: (req: Request, res: Response) => Promise<void>) =>
    (req: Request, res: Response): void => {
      fn(req, res).catch((err: unknown) => {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      });
    };

  /**
   * `AgentRow` carries `reports_to` as a uuid; `AgentSpec.reportsTo` (what
   * `repo.upsertAgent` accepts) is the parent's KEY, which it resolves back
   * to a uuid itself. There is no partial "just patch these fields" method on
   * the repo (Task 2 shipped only the full upsert), so a PATCH round-trips
   * through this conversion rather than writing raw SQL from the HTTP layer.
   */
  async function toAgentSpec(row: AgentRow): Promise<AgentSpec> {
    let reportsTo: string | null = null;
    if (row.reports_to) {
      const all = await orch.repo.listAgents(orch.companyId);
      reportsTo = all.find(a => a.id === row.reports_to)?.key ?? null;
    }
    return {
      key: row.key, name: row.name, title: row.title ?? undefined, icon: row.icon ?? undefined,
      reportsTo, adapter: row.adapter, model: row.model ?? undefined,
      effort: (row.effort ?? undefined) as Effort | undefined,
      fallbackModel: row.fallback_model, cwd: row.cwd ?? undefined,
      mcpEnabled: row.mcp_enabled, extraArgs: row.extra_args, bundlePath: row.bundle_path ?? undefined,
    };
  }

  // ---- health -------------------------------------------------------------

  r.get("/health", wrap(async (_req, res) => {
    const v = await orch.db.query<{ version: string }>(`select version()`);
    const raw = v.rows[0]?.version ?? "unknown";
    const short = raw.match(/PostgreSQL [\d.]+/)?.[0] ?? raw;
    ok(res, { ok: true, db: `${orch.config.db.driver} / ${short}`, claude: await getClaudeVersion() });
  }));

  // ---- agents ---------------------------------------------------------------

  r.get("/agents", wrap(async (_req, res) => {
    ok(res, await orch.repo.listAgents(orch.companyId));
  }));

  r.get("/agents/:key", wrap(async (req, res) => {
    const key = pathParam(req.params.key);
    const agent = await orch.repo.getAgentByKey(orch.companyId, key);
    if (!agent) { notFound(res, `agent '${key}'`); return; }
    ok(res, agent);
  }));

  r.patch("/agents/:key", wrap(async (req, res) => {
    const key = pathParam(req.params.key);
    const existing = await orch.repo.getAgentByKey(orch.companyId, key);
    if (!existing) { notFound(res, `agent '${key}'`); return; }

    const patch = (req.body ?? {}) as AgentPatchBody;
    if (patch.effort !== undefined && !EFFORTS.includes(patch.effort)) {
      badRequest(res, `effort must be one of ${EFFORTS.join(", ")}`);
      return;
    }

    const spec = await toAgentSpec(existing);
    if (patch.adapter !== undefined) spec.adapter = patch.adapter;
    if (patch.model !== undefined) spec.model = patch.model;
    if (patch.effort !== undefined) spec.effort = patch.effort;
    if (patch.fallbackModel !== undefined) spec.fallbackModel = patch.fallbackModel;
    if (patch.budget !== undefined) spec.budget = patch.budget;

    await orch.repo.upsertAgent(orch.companyId, spec);
    ok(res, await orch.repo.getAgentByKey(orch.companyId, key));
  }));

  r.get("/agents/:key/runs", wrap(async (req, res) => {
    const key = pathParam(req.params.key);
    const agent = await orch.repo.getAgentByKey(orch.companyId, key);
    if (!agent) { notFound(res, `agent '${key}'`); return; }
    // No repo.listRunsByAgent() exists (Task 2's repo is scoped to
    // per-issue reads) — a direct query is the least-worst option that
    // doesn't require touching the frozen core module for this one view.
    const { rows } = await orch.db.query<RunRow>(
      `select * from runs where agent_id=$1 order by started_at desc`, [agent.id]);
    ok(res, rows);
  }));

  r.get("/runners", wrap(async (_req, res) => {
    ok(res, Object.keys(orch.config.adapters));
  }));

  // ---- issues ---------------------------------------------------------------

  r.post("/issues", wrap(async (req, res) => {
    const { workflow, params } = (req.body ?? {}) as { workflow?: string; params?: Record<string, unknown> };
    if (!workflow) { badRequest(res, "workflow is required"); return; }
    let issue;
    try {
      issue = await orch.engine.start(workflow, (params ?? {}) as Record<string, string>);
    } catch (err) {
      badRequest(res, err instanceof Error ? err.message : String(err));
      return;
    }
    // Fire and forget — poll GET /issues/{id} for progress — but NEVER bare:
    // engine.advance() only wraps its runStep() call in try/catch (see
    // engine.ts). The surrounding repo.getIssue(), the workflow() lookup, and
    // the post-step repo.updateIssue() are all outside that try/catch, so a
    // transient failure there throws OUT of advance() as an unhandled
    // rejection. With no .catch() here and no process-level
    // unhandledRejection handler, Node's default since v15 is to terminate
    // the whole process — after this response has already gone out, so the
    // client believes the request succeeded while every other in-flight
    // request dies with it. Logged (not swallowed): the issue row is left
    // exactly where it was, which is recoverable by a retry or a manual
    // POST /issues/{id} nudge; a dead process is not.
    orch.engine.advance(issue.id).catch((err: unknown) => {
      console.error(`[orchestrator] advance(${issue.id}) failed:`, err);
    });
    res.status(201).json(issue);
  }));

  r.get("/issues", wrap(async (req, res) => {
    const filter: ListIssuesFilter = {};
    if (typeof req.query.status === "string") filter.status = req.query.status;
    if (req.query.parentId !== undefined) {
      filter.parentId = req.query.parentId === "null" ? null : String(req.query.parentId);
    }
    if (req.query.assigneeAgentId !== undefined) {
      filter.assigneeAgentId = req.query.assigneeAgentId === "null" ? null : String(req.query.assigneeAgentId);
    }
    ok(res, await orch.repo.listIssues(orch.companyId, filter));
  }));

  r.get("/issues/:id", wrap(async (req, res) => {
    const id = pathParam(req.params.id);
    const issue = await orch.repo.getIssue(id);
    if (!issue) { notFound(res, `issue '${id}'`); return; }
    ok(res, issue);
  }));

  r.patch("/issues/:id", wrap(async (req, res) => {
    const id = pathParam(req.params.id);
    const updated = await orch.repo.updateIssue(id, (req.body ?? {}) as UpdateIssuePatch);
    if (!updated) { notFound(res, `issue '${id}'`); return; }
    ok(res, updated);
  }));

  r.get("/issues/:id/comments", wrap(async (req, res) => {
    ok(res, await orch.repo.listComments(pathParam(req.params.id)));
  }));

  r.post("/issues/:id/comments", wrap(async (req, res) => {
    const id = pathParam(req.params.id);
    const { body, authorAgentId, authorUser } =
      (req.body ?? {}) as { body?: string; authorAgentId?: string; authorUser?: string };
    if (!body) { badRequest(res, "body is required"); return; }
    const comment = await orch.repo.addComment(
      id, body, { agentId: authorAgentId ?? null, user: authorUser ?? "api" });
    res.status(201).json(comment);
  }));

  r.get("/issues/:id/work-products", wrap(async (req, res) => {
    ok(res, await orch.repo.listWorkProducts(pathParam(req.params.id)));
  }));

  r.get("/issues/:id/gates", wrap(async (req, res) => {
    ok(res, await orch.repo.listGates(pathParam(req.params.id)));
  }));

  r.get("/issues/:id/runs", wrap(async (req, res) => {
    ok(res, await orch.repo.listRuns(pathParam(req.params.id)));
  }));

  // ---- gates ------------------------------------------------------------

  r.post("/gates/:id/approve", wrap(async (req, res) => {
    const id = pathParam(req.params.id);
    const gate = await orch.repo.getGate(id);
    if (!gate) { notFound(res, `gate '${id}'`); return; }
    const { note, by } = (req.body ?? {}) as { note?: string; by?: string };
    await orch.engine.decideGate(id, "approved", note, by);
    ok(res, { ok: true });
  }));

  r.post("/gates/:id/reject", wrap(async (req, res) => {
    const id = pathParam(req.params.id);
    const gate = await orch.repo.getGate(id);
    if (!gate) { notFound(res, `gate '${id}'`); return; }
    const { note, by } = (req.body ?? {}) as { note?: string; by?: string };
    await orch.engine.decideGate(id, "rejected", note, by);
    ok(res, { ok: true });
  }));

  // ---- runs ---------------------------------------------------------------

  r.get("/runs/:id", wrap(async (req, res) => {
    const id = pathParam(req.params.id);
    const run = await orch.repo.getRun(id);
    if (!run) { notFound(res, `run '${id}'`); return; }
    ok(res, run);
  }));

  r.get("/runs/:id/log", wrap(async (req, res) => {
    const id = pathParam(req.params.id);
    const run = await orch.repo.getRun(id);
    if (!run) { notFound(res, `run '${id}'`); return; }
    const offset = Number(req.query.offset ?? 0);
    let raw: string;
    try {
      raw = readFileSync(run.log_path, "utf8");
    } catch (err) {
      notFound(res, `log file at '${run.log_path}' (${err instanceof Error ? err.message : String(err)})`);
      return;
    }
    ok(res, { content: raw.slice(offset), nextOffset: raw.length });
  }));

  r.get("/runs/:id/transcript", wrap(async (req, res) => {
    const id = pathParam(req.params.id);
    const run = await orch.repo.getRun(id);
    if (!run) { notFound(res, `run '${id}'`); return; }
    const offset = Number(req.query.offset ?? 0);
    let raw: string;
    try {
      raw = readFileSync(run.log_path, "utf8").slice(offset);
    } catch (err) {
      notFound(res, `log file at '${run.log_path}' (${err instanceof Error ? err.message : String(err)})`);
      return;
    }
    const { events, consumed } = filterRunLog(raw);
    ok(res, { events, nextOffset: offset + consumed });
  }));

  // ---- usage / config -----------------------------------------------------

  r.get("/usage", wrap(async (_req, res) => {
    const { rows } = await orch.db.query<{
      run_count: string; input_tokens: string | null; output_tokens: string | null;
      cache_read_tokens: string | null; cache_creation_tokens: string | null; cost_usd: string | null;
    }>(
      `select count(*)::text as run_count,
              coalesce(sum(r.input_tokens),0)::text as input_tokens,
              coalesce(sum(r.output_tokens),0)::text as output_tokens,
              coalesce(sum(r.cache_read_tokens),0)::text as cache_read_tokens,
              coalesce(sum(r.cache_creation_tokens),0)::text as cache_creation_tokens,
              coalesce(sum(r.cost_usd),0)::text as cost_usd
         from runs r
         join issues i on i.id = r.issue_id
        where i.company_id = $1`,
      [orch.companyId]);
    const row = rows[0];
    ok(res, {
      runCount: Number(row?.run_count ?? 0),
      inputTokens: Number(row?.input_tokens ?? 0),
      outputTokens: Number(row?.output_tokens ?? 0),
      cacheReadTokens: Number(row?.cache_read_tokens ?? 0),
      cacheCreationTokens: Number(row?.cache_creation_tokens ?? 0),
      costUsd: Number(row?.cost_usd ?? 0),
    });
  }));

  r.get("/config", wrap(async (_req, res) => {
    ok(res, {
      workspace: orch.config.workspace,
      company: orch.config.company ?? "Scyne",
      adapters: Object.keys(orch.config.adapters),
      defaults: orch.config.defaults ?? {},
      theme: resolveTheme(orch.config.theme),
      workflows: orch.config.workflows.map(w => ({
        key: w.key, label: w.label, assignee: w.assignee, steps: w.steps.length,
      })),
    });
  }));

  // ---- docs -----------------------------------------------------------------

  const { openapiHandler, docsHandler } = createDocsHandlers(() => resolveTheme(orch.config.theme));
  r.get("/openapi.json", openapiHandler);
  r.get("/docs", docsHandler);

  return r;
}
