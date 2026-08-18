// The mountable HTTP surface of @scyne/orchestrator. `createRouter(orch)`
// wires an Express Router straight onto the pieces `createOrchestrator`
// already assembled (db, repo, engine, config) — it adds no state and no
// business logic of its own beyond request/response shaping. `ROUTES` is the
// single source of truth for "what routes exist"; test/openapi.test.ts diffs
// it against openapi.yaml in BOTH directions, so this array and the spec can
// never silently drift apart.

import { Router, type Request, type Response } from "express";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { filterRunLog } from "../core/transcript.js";
import { EFFORTS, workflowParams } from "../config.js";
import type {
  AgentBudget, AgentRow, AgentSpec, Effort, ListIssuesFilter, RunRow, UpdateIssuePatch,
} from "../core/repo.js";
import { resolveTheme } from "./theme.js";
import { loadOverrides, saveOverrides, withAgentPatch } from "../core/overrides.js";
import { createDocsHandlers } from "./docs.js";
import { renderConsole } from "./console.js";
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
  { method: "POST",  path: "/agents" },          // hire
  { method: "DELETE", path: "/agents/{key}" },   // disable
  { method: "GET",   path: "/agents/{key}" },
  { method: "PATCH", path: "/agents/{key}" },   // adapter · model · effort · fallbackModel · budget
  { method: "GET",   path: "/agents/{key}/runs" },
  { method: "GET",   path: "/agents/{key}/bundle" },
  { method: "GET",   path: "/runners" },        // registered adapters
  { method: "POST",  path: "/issues" },
  { method: "GET",   path: "/issues" },
  { method: "GET",   path: "/issues/{id}" },
  { method: "PATCH", path: "/issues/{id}" },
  { method: "DELETE", path: "/issues/{id}" },
  { method: "POST",  path: "/issues/{id}/advance" },
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
  { method: "GET",   path: "/budgets" },
  { method: "POST",  path: "/budgets" },
  { method: "GET",   path: "/usage" },
  { method: "GET",   path: "/config" },
  { method: "GET",   path: "/orch" },
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

    // Report every REGISTERED adapter, not a hardcoded `claude --version`.
    // A console that says "Claude Code" no matter what is running tells an
    // operator nothing once a second adapter exists — and it reads as though
    // the runtime is nailed down, which is exactly what the adapter registry
    // exists to avoid. Version probing is per-adapter; only the process ones
    // have a binary to ask, so the rest report what the registry knows.
    const adapters = await Promise.all(
      Object.keys(orch.config.adapters).map(async (key) => ({
        key,
        version: key.endsWith("_local") ? await getClaudeVersion() : "n/a",
      })));

    const stale = await orch.repo.listUnfinishedRuns();
    const issues = await orch.repo.listIssues(orch.companyId);

    ok(res, {
      ok: true,
      db: `${orch.config.db.driver} / ${short}`,
      adapters,
      queue: {
        todo: issues.filter(i => i.status === "todo").length,
        inProgress: issues.filter(i => i.status === "in_progress").length,
        awaitingApproval: issues.filter(i => i.status === "in_review").length,
        blocked: issues.filter(i => i.status === "blocked").length,
      },
      unfinishedRuns: stale.length,
      // Kept for the chatbot and anything else already reading it.
      claude: adapters.find(a => a.version !== "n/a")?.version ?? "unknown",
    });
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

    // Persist to the overlay, or the next boot reconciles this away from the
    // config file and the operator's change silently vanishes. Only fields the
    // caller actually supplied are recorded — an absent field must stay
    // inherited from the config file, not be frozen at its current value.
    const overlay: Partial<AgentSpec> = {};
    if (patch.adapter !== undefined) overlay.adapter = patch.adapter;
    if (patch.model !== undefined) overlay.model = patch.model;
    if (patch.effort !== undefined) overlay.effort = patch.effort;
    if (patch.fallbackModel !== undefined) overlay.fallbackModel = patch.fallbackModel;
    if (patch.budget !== undefined) overlay.budget = patch.budget;
    if (Object.keys(overlay).length) {
      await saveOverrides(orch.config.workspace,
        withAgentPatch(await loadOverrides(orch.config.workspace), key, overlay));
    }
    ok(res, await orch.repo.getAgentByKey(orch.companyId, key));
  }));

  /**
   * Hire. The agent is written to the database AND to the overlay, because the
   * config file is re-read on every boot and an agent that exists only in the
   * database would disappear on restart.
   */
  r.post("/agents", wrap(async (req, res) => {
    const spec = (req.body ?? {}) as AgentSpec;
    if (!spec.key || !spec.name) { badRequest(res, "key and name are required"); return; }
    if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(spec.key)) {
      badRequest(res, `key '${spec.key}' must start with a letter and contain only letters, digits, - or _`);
      return;
    }
    if (await orch.repo.getAgentByKey(orch.companyId, spec.key)) {
      badRequest(res, `agent '${spec.key}' already exists`);
      return;
    }
    const adapter = spec.adapter ?? orch.config.defaults?.adapter ?? "claude_local";
    if (!orch.config.adapters[adapter]) {
      badRequest(res, `adapter '${adapter}' is not registered — available: ${Object.keys(orch.config.adapters).join(", ")}`);
      return;
    }
    if (spec.effort && !EFFORTS.includes(spec.effort)) {
      badRequest(res, `effort must be one of ${EFFORTS.join(", ")}`);
      return;
    }
    await orch.repo.upsertAgent(orch.companyId, { ...spec, adapter });

    const o = await loadOverrides(orch.config.workspace);
    await saveOverrides(orch.config.workspace, {
      ...o,
      added: [...(o.added ?? []).filter(a => a.key !== spec.key), { ...spec, adapter }],
      removed: (o.removed ?? []).filter(k => k !== spec.key),
    });
    res.status(201).json(await orch.repo.getAgentByKey(orch.companyId, spec.key));
  }));

  /**
   * Disable, not destroy. Runs and issues reference agents, and an agent that
   * has done work is part of the audit trail — deleting the row would either
   * fail on the foreign key or orphan the history that explains a spend figure.
   */
  r.delete("/agents/:key", wrap(async (req, res) => {
    const key = pathParam(req.params.key);
    const agent = await orch.repo.getAgentByKey(orch.companyId, key);
    if (!agent) { notFound(res, `agent '${key}'`); return; }

    const assigned = (await orch.repo.listIssues(orch.companyId, { assigneeAgentId: agent.id }))
      .filter(i => i.status !== "done");
    if (assigned.length) {
      badRequest(res, `agent '${key}' still owns ${assigned.length} open issue(s): ` +
        assigned.map(i => i.identifier).join(", "));
      return;
    }

    await orch.repo.setAgentStatus(orch.companyId, key, "disabled");
    const o = await loadOverrides(orch.config.workspace);
    await saveOverrides(orch.config.workspace, {
      ...o,
      added: (o.added ?? []).filter(a => a.key !== key),
      removed: [...new Set([...(o.removed ?? []), key])],
    });
    ok(res, { ok: true, key, status: "disabled" });
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

  /**
   * The agent's system prompt as it will actually be handed to the runtime.
   * Read from disk on every request rather than cached: editing a bundle and
   * re-reading it is the loop this endpoint exists to serve.
   */
  r.get("/agents/:key/bundle", wrap(async (req, res) => {
    const key = pathParam(req.params.key);
    const agent = await orch.repo.getAgentByKey(orch.companyId, key);
    if (!agent) { notFound(res, `agent '${key}'`); return; }
    if (!agent.bundle_path) { ok(res, { path: null, content: "" }); return; }
    try {
      ok(res, { path: agent.bundle_path, content: readFileSync(resolve(orch.config.workspace, agent.bundle_path), "utf8") });
    } catch (err) {
      // Not a 404: the agent exists and declares a bundle. The missing file IS
      // the finding — it is the exact state that makes Claude Code fail with
      // "System prompt file not found" on the next run, and (before the runner
      // learned to handle EPIPE) took the whole process down with it.
      ok(res, { path: agent.bundle_path, content: "", error: err instanceof Error ? err.message : String(err) });
    }
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

  /**
   * Resume a parked or blocked issue. Fire-and-forget with a 202 for the same
   * reason POST /issues is: a resumed workflow re-runs an agent step, which
   * takes tens of minutes — holding the request open would time out every
   * proxy between here and the browser. Poll GET /issues/{id} for progress.
   */
  r.post("/issues/:id/advance", wrap(async (req, res) => {
    const id = pathParam(req.params.id);
    const issue = await orch.repo.getIssue(id);
    if (!issue) { notFound(res, `issue '${id}'`); return; }
    if (issue.status === "done") { badRequest(res, `issue ${issue.identifier} is already done`); return; }
    orch.engine.retry(id).catch((err: unknown) => {
      console.error(`[orchestrator] retry(${id}) failed:`, err);
    });
    res.status(202).json({ ok: true, issueId: id });
  }));

  /**
   * Delete an issue and its whole subtree. Refused while a run is in flight:
   * the child process would keep writing to a log whose run row no longer
   * exists, and its cost would vanish from the spend figures.
   */
  r.delete("/issues/:id", wrap(async (req, res) => {
    const id = pathParam(req.params.id);
    const issue = await orch.repo.getIssue(id);
    if (!issue) { notFound(res, `issue '${id}'`); return; }
    const live = (await orch.repo.listRuns(id)).filter(r2 => !r2.finished_at);
    if (live.length) {
      badRequest(res, `issue ${issue.identifier} has a run in flight — wait for it, or stop the process first`);
      return;
    }
    await orch.repo.deleteIssue(id);
    ok(res, { ok: true, deleted: issue.identifier });
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

  /**
   * Both decisions record synchronously and resume in the BACKGROUND. Awaiting
   * the resume would hold the connection open for the whole of the next agent
   * step — a publish on approve, a full regeneration on reject, tens of minutes
   * either way — so the browser would see a timeout on a click that actually
   * worked. The decision itself is durable before the response goes out; poll
   * GET /issues/{id} for what happens next.
   */
  const decide = (status: "approved" | "rejected") => wrap(async (req: Request, res: Response) => {
    const id = pathParam(req.params.id);
    const gate = await orch.repo.getGate(id);
    if (!gate) { notFound(res, `gate '${id}'`); return; }
    const { note, by } = (req.body ?? {}) as { note?: string; by?: string };
    const { issueId } = await orch.engine.decideGate(id, status, note, by, { advance: false });
    orch.engine.advance(issueId).catch((err: unknown) => {
      console.error(`[orchestrator] advance(${issueId}) after ${status} failed:`, err);
    });
    res.status(202).json({ ok: true, issueId });
  });

  r.post("/gates/:id/approve", decide("approved"));
  r.post("/gates/:id/reject", decide("rejected"));

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

  r.get("/budgets", wrap(async (_req, res) => {
    ok(res, await orch.repo.listBudgets(orch.companyId));
  }));

  /**
   * Set (or clear) a limit. `scope` is agent | workflow | project; the engine
   * reads the WORKFLOW budget first and falls back to the agent's, so a limit
   * set here takes effect on the next run with no restart.
   */
  r.post("/budgets", wrap(async (req, res) => {
    const { scope, scopeKey, maxTokens, maxCostUsd, maxDurationMs } =
      (req.body ?? {}) as { scope?: string; scopeKey?: string;
                            maxTokens?: number; maxCostUsd?: number; maxDurationMs?: number };
    if (!scope || !scopeKey) { badRequest(res, "scope and scopeKey are required"); return; }
    if (!["agent", "workflow", "project"].includes(scope)) {
      badRequest(res, `scope must be one of agent, workflow, project`);
      return;
    }
    if (maxTokens == null && maxCostUsd == null && maxDurationMs == null) {
      await orch.repo.clearBudget(orch.companyId, scope, scopeKey);
      ok(res, { ok: true, cleared: true, scope, scopeKey });
      return;
    }
    await orch.repo.setBudget(orch.companyId, scope, scopeKey, { maxTokens, maxCostUsd, maxDurationMs });
    ok(res, { ok: true, scope, scopeKey, maxTokens, maxCostUsd, maxDurationMs });
  }));

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
      // `params` is derived from each workflow's own templates (see
      // `workflowParams`) so the console's New-run form can ask for exactly
      // what this workflow interpolates — and cannot go stale when a stage
      // starts reading a new variable.
      workflows: orch.config.workflows.map(w => ({
        key: w.key, label: w.label, assignee: w.assignee, steps: w.steps.length,
        params: workflowParams(w),
        // Type and phase ONLY. A step also carries its prompt, its shell
        // command and its `reads` paths; none of that belongs on a sanitised
        // endpoint, and the console needs neither — it wants to name the step
        // an issue is parked on ("step 4 of 6 — attach"), which "4/6" alone
        // cannot do.
        stepList: w.steps.map(s => ({
          type: s.type, phase: s.type === "agent" ? s.phase : undefined,
        })),
      })),
    });
  }));

  // ---- docs -----------------------------------------------------------------

  const { openapiHandler, docsHandler } = createDocsHandlers(() => resolveTheme(orch.config.theme));
  r.get("/orch", (_req: Request, res: Response) => {
    res.type("html").send(renderConsole(resolveTheme(orch.config.theme)));
  });
  r.get("/openapi.json", openapiHandler);
  r.get("/docs", docsHandler);

  return r;
}
