// The mountable HTTP surface of @scyne/orchestrator. `createRouter(orch)`
// wires an Express Router straight onto the pieces `createOrchestrator`
// already assembled (db, repo, engine, config) — it adds no state and no
// business logic of its own beyond request/response shaping. `ROUTES` is the
// single source of truth for "what routes exist"; test/openapi.test.ts diffs
// it against openapi.yaml in BOTH directions, so this array and the spec can
// never silently drift apart.

import { Router, type Request, type Response } from "express";
import { readFileSync, writeFileSync, mkdirSync, renameSync, realpathSync } from "node:fs";
import { resolve, dirname, sep } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { filterRunLog } from "../core/transcript.js";
import { EFFORTS, workflowParams } from "../config.js";
import type {
  AgentBudget, AgentRow, AgentSpec, Effort, ListIssuesFilter, RunRow, UpdateIssuePatch,
} from "../core/repo.js";
import { resolveTheme } from "./theme.js";
import { createPlatformRouter, PLATFORM_ROUTES } from "./platform-router.js";
import { createPlatformRepo } from "../core/platform.js";
import { createAuth, type AuthedRequest } from "./auth-middleware.js";
import { loadOverrides, saveOverrides, withAgentPatch } from "../core/overrides.js";
import { listSkills, skillFilePath } from "../core/skills.js";
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
const CORE_ROUTES = [
  { method: "GET",   path: "/health" },
  { method: "GET",   path: "/agents" },
  { method: "POST",  path: "/agents" },          // hire
  { method: "DELETE", path: "/agents/{key}" },   // disable
  { method: "GET",   path: "/agents/{key}" },
  { method: "PATCH", path: "/agents/{key}" },   // adapter · model · effort · fallbackModel · budget
  { method: "GET",   path: "/agents/{key}/runs" },
  { method: "GET",   path: "/agents/{key}/bundle" },
  { method: "PUT",   path: "/agents/{key}/bundle" },   // edit the system prompt from the console
  { method: "GET",   path: "/skills" },         // what exists, and which agent invokes it
  { method: "GET",   path: "/skills/{name}" },
  { method: "PUT",   path: "/skills/{name}" },
  { method: "GET",   path: "/runners" },        // registered adapters
  { method: "POST",  path: "/issues" },
  { method: "GET",   path: "/issues" },
  { method: "GET",   path: "/issues/{id}" },
  { method: "PATCH", path: "/issues/{id}" },
  { method: "DELETE", path: "/issues/{id}" },
  { method: "POST",  path: "/issues/{id}/advance" },
  { method: "POST",  path: "/issues/{id}/pause" },
  { method: "POST",  path: "/issues/{id}/cancel" },
  { method: "POST",  path: "/issues/{id}/resume" },
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
  { method: "GET",   path: "/workflows/{key}" },   // the full step list, prompts included
  { method: "GET",   path: "/config" },
  { method: "GET",   path: "/orch" },
  { method: "GET",   path: "/openapi.json" },
  { method: "GET",   path: "/docs" },
] as const;

/**
 * The whole HTTP surface: the engine's routes above, plus the platform's from
 * http/platform-router.ts. Merged here rather than kept apart so that
 * test/openapi.test.ts — which diffs this table against openapi.yaml in BOTH
 * directions — still covers every route there is. Two files, one contract.
 */
export const ROUTES = [...CORE_ROUTES, ...PLATFORM_ROUTES] as const;

interface AgentPatchBody {
  adapter?: string; model?: string; effort?: Effort;
  fallbackModel?: string[]; budget?: AgentBudget;
  /**
   * Where this agent's system prompt lives, workspace-relative. Patchable
   * because an agent with no `bundlePath` has nowhere for instructions to go —
   * PUT /agents/{key}/bundle refuses one, and without this the only way to give
   * an existing agent instructions was to disable it and hire a replacement.
   */
  bundlePath?: string | null;
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

/**
 * Resolve a `bundlePath` against the workspace, or `null` if it escapes it.
 *
 * `bundlePath` is operator-typed — the console's Add-agent form takes free
 * text — so `../../../.ssh/config` is reachable input, and this endpoint both
 * reads and now WRITES that path. Confining it to the workspace is the whole
 * of the check; anything inside is the operator's own tree to edit.
 */
function makeSafeBundlePath(workspace: string) {
  const root = resolve(workspace);
  return (rel: string): string | null => {
    const abs = resolve(root, rel);
    return abs === root || abs.startsWith(root + sep) ? abs : null;
  };
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

// Same memoisation, same reasoning, for the other process adapter. Codex is
// registered only when the binary is on PATH (orchestrator.config.ts), so a
// failed probe here almost never happens in practice — but the fallback
// keeps /health honest rather than throwing if the binary vanishes between
// boot and this request.
let cachedCodexVersion: string | undefined;
async function getCodexVersion(): Promise<string> {
  if (cachedCodexVersion) return cachedCodexVersion;
  try {
    const { stdout } = await execFileAsync("codex", ["--version"], { timeout: 3_000 });
    cachedCodexVersion = stdout.trim() || "unknown";
  } catch {
    cachedCodexVersion = "unknown";
  }
  return cachedCodexVersion;
}

export function createRouter(orch: Awaited<ReturnType<typeof createOrchestrator>>): Router {
  const r = Router();

  const ok = (res: Response, body: unknown): void => { res.json(body); };
  const notFound = (res: Response, what: string): void => { res.status(404).json({ error: `${what} not found` }); };
  const badRequest = (res: Response, message: string): void => { res.status(400).json({ error: message }); };

  const safeBundlePath = makeSafeBundlePath(orch.config.workspace);

  // Mounted first so the platform's own paths resolve before any of this
  // router's parameterised ones could shadow them.
  // Every engine route below authenticates. Until this existed, /issues,
  // /runs, /agents, /config and /gates were open to anything that could
  // reach the port — the console rendered them with no login, and the
  // platform routes beside them were the only ones asking for a credential.
  //
  // The SAME middleware the platform router uses. Two implementations of an
  // authorisation check drift, and the one that drifts is unwatched.
  const platform = createPlatformRepo(orch.db);
  const auth = createAuth(platform, orch.homeCompanyId);
  const guard = auth.requireAuth();
  const org = (req: unknown): string => (req as AuthedRequest).principal!.companyId;

  /**
   * Resolve an issue the caller is allowed to see, or answer 404.
   *
   * Every one of these routes took a raw uuid and fetched it with no
   * organisation check, which was harmless while there was one organisation
   * and a cross-tenant read the moment there were two. 404 rather than 403,
   * for the reason platform-router.ts's header gives: a 403 confirms the
   * issue exists, which is exactly what a caller without access must not be
   * able to learn.
   *
   * Returns null HAVING ALREADY RESPONDED, so a handler reads as
   * `const issue = await issueFor(req, res, id); if (!issue) return;`.
   */
  const issueFor = async (req: Request, res: Response, id: string) => {
    const issue = await orch.repo.getIssue(id).catch(() => null);
    if (!issue || issue.company_id !== org(req)) { notFound(res, `issue '${id}'`); return null; }
    return issue;
  };

  /** The same rule for a run, reached through the issue that owns it. */
  const runFor = async (req: Request, res: Response, id: string) => {
    const run = await orch.repo.getRun(id).catch(() => null);
    if (!run) { notFound(res, `run '${id}'`); return null; }
    const issue = await orch.repo.getIssue(run.issue_id).catch(() => null);
    if (!issue || issue.company_id !== org(req)) { notFound(res, `run '${id}'`); return null; }
    return run;
  };

  r.use(createPlatformRouter(orch));

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
      const all = await orch.repo.listAgents(orch.homeCompanyId);
      reportsTo = all.find(a => a.id === row.reports_to)?.key ?? null;
    }
    return {
      key: row.key, name: row.name, title: row.title ?? undefined, icon: row.icon ?? undefined,
      reportsTo, adapter: row.adapter ?? undefined, model: row.model ?? undefined,
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
    //
    // `_local` names Claude Code's own adapters (claude_local); `codex` is
    // also a process adapter with its own `--version` — it just does not
    // follow that naming convention, so it needs its own explicit branch
    // rather than falling into the "n/a" bucket meant for the loop-driven
    // adapters (gemini, azure_foundry), which have no binary to ask at all.
    const versionOf = async (key: string): Promise<string> => {
      if (key.endsWith("_local")) return getClaudeVersion();
      if (key === "codex") return getCodexVersion();
      return "n/a";
    };
    const adapters = await Promise.all(
      Object.keys(orch.config.adapters).map(async (key) => ({ key, version: await versionOf(key) })));

    const stale = await orch.repo.listUnfinishedRuns();
    // Install-wide, not home-organisation-wide: /health is unauthenticated and
    // describes the whole process, and a per-org count here would read as
    // healthy while another tenant's queue backed up.
    const depth = await orch.repo.queueDepth();

    ok(res, {
      ok: true,
      db: `${orch.config.db.driver} / ${short}`,
      adapters,
      queue: {
        todo: depth.todo ?? 0,
        inProgress: depth.in_progress ?? 0,
        awaitingApproval: depth.in_review ?? 0,
        blocked: depth.blocked ?? 0,
      },
      unfinishedRuns: stale.length,
      // Kept for the chatbot and anything else already reading it.
      claude: adapters.find(a => a.version !== "n/a")?.version ?? "unknown",
    });
  }));

  // ---- agents ---------------------------------------------------------------

  r.get("/agents", guard, wrap(async (_req, res) => {
    ok(res, await orch.repo.listAgents(orch.homeCompanyId));
  }));

  r.get("/agents/:key", guard, wrap(async (req, res) => {
    const key = pathParam(req.params.key);
    const agent = await orch.repo.getAgentByKey(orch.homeCompanyId, key);
    if (!agent) { notFound(res, `agent '${key}'`); return; }
    ok(res, agent);
  }));

  r.patch("/agents/:key", guard, wrap(async (req, res) => {
    const key = pathParam(req.params.key);
    const existing = await orch.repo.getAgentByKey(orch.homeCompanyId, key);
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
    if (patch.bundlePath !== undefined) spec.bundlePath = patch.bundlePath ?? undefined;

    await orch.repo.upsertAgent(orch.homeCompanyId, spec);

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
    if (patch.bundlePath !== undefined) overlay.bundlePath = patch.bundlePath ?? undefined;
    if (Object.keys(overlay).length) {
      await saveOverrides(orch.config.workspace,
        withAgentPatch(await loadOverrides(orch.config.workspace), key, overlay));
    }
    ok(res, await orch.repo.getAgentByKey(orch.homeCompanyId, key));
  }));

  /**
   * Hire. The agent is written to the database AND to the overlay, because the
   * config file is re-read on every boot and an agent that exists only in the
   * database would disappear on restart.
   */
  r.post("/agents", guard, wrap(async (req, res) => {
    const spec = (req.body ?? {}) as AgentSpec;
    if (!spec.key || !spec.name) { badRequest(res, "key and name are required"); return; }
    if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(spec.key)) {
      badRequest(res, `key '${spec.key}' must start with a letter and contain only letters, digits, - or _`);
      return;
    }
    if (await orch.repo.getAgentByKey(orch.homeCompanyId, spec.key)) {
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
    await orch.repo.upsertAgent(orch.homeCompanyId, { ...spec, adapter });

    const o = await loadOverrides(orch.config.workspace);
    await saveOverrides(orch.config.workspace, {
      ...o,
      added: [...(o.added ?? []).filter(a => a.key !== spec.key), { ...spec, adapter }],
      removed: (o.removed ?? []).filter(k => k !== spec.key),
    });
    res.status(201).json(await orch.repo.getAgentByKey(orch.homeCompanyId, spec.key));
  }));

  /**
   * Disable, not destroy. Runs and issues reference agents, and an agent that
   * has done work is part of the audit trail — deleting the row would either
   * fail on the foreign key or orphan the history that explains a spend figure.
   */
  r.delete("/agents/:key", guard, wrap(async (req, res) => {
    const key = pathParam(req.params.key);
    const agent = await orch.repo.getAgentByKey(orch.homeCompanyId, key);
    if (!agent) { notFound(res, `agent '${key}'`); return; }

    // Across every organisation — agents are install-wide, so a home-scoped
    // check would let this disable an agent still working for another tenant.
    const assigned = await orch.repo.openIssuesForAgent(agent.id);
    if (assigned.length) {
      badRequest(res, `agent '${key}' still owns ${assigned.length} open issue(s): ` +
        assigned.map(i => i.identifier).join(", "));
      return;
    }

    await orch.repo.setAgentStatus(orch.homeCompanyId, key, "disabled");
    const o = await loadOverrides(orch.config.workspace);
    await saveOverrides(orch.config.workspace, {
      ...o,
      added: (o.added ?? []).filter(a => a.key !== key),
      removed: [...new Set([...(o.removed ?? []), key])],
    });
    ok(res, { ok: true, key, status: "disabled" });
  }));

  r.get("/agents/:key/runs", guard, wrap(async (req, res) => {
    const key = pathParam(req.params.key);
    const agent = await orch.repo.getAgentByKey(orch.homeCompanyId, key);
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
  r.get("/agents/:key/bundle", guard, wrap(async (req, res) => {
    const key = pathParam(req.params.key);
    const agent = await orch.repo.getAgentByKey(orch.homeCompanyId, key);
    if (!agent) { notFound(res, `agent '${key}'`); return; }
    if (!agent.bundle_path) { ok(res, { path: null, content: "" }); return; }
    const absRead = safeBundlePath(agent.bundle_path);
    if (!absRead) {
      ok(res, { path: agent.bundle_path, content: "",
                error: `bundlePath '${agent.bundle_path}' resolves outside the workspace` });
      return;
    }
    try {
      ok(res, { path: agent.bundle_path, content: readFileSync(absRead, "utf8") });
    } catch (err) {
      // Not a 404: the agent exists and declares a bundle. The missing file IS
      // the finding — it is the exact state that makes Claude Code fail with
      // "System prompt file not found" on the next run, and (before the runner
      // learned to handle EPIPE) took the whole process down with it.
      ok(res, { path: agent.bundle_path, content: "", error: err instanceof Error ? err.message : String(err) });
    }
  }));

  /**
   * Overwrite an agent's system prompt.
   *
   * The runner reads `bundlePath` off disk at SPAWN time, so a save here takes
   * effect on the very next run with no restart, no re-upload and no bundle to
   * re-register — which is the whole reason instructions live as plain files
   * rather than as rows. An edit made while a run is in flight cannot disturb
   * it: that process was handed its prompt when it started.
   *
   * Writes via a temp file and a rename, so an interrupted write leaves the
   * previous instructions intact rather than a truncated file that would make
   * every subsequent run fail in a way nobody attributes to a browser tab
   * closing mid-save.
   */
  r.put("/agents/:key/bundle", guard, wrap(async (req, res) => {
    const key = pathParam(req.params.key);
    const agent = await orch.repo.getAgentByKey(orch.homeCompanyId, key);
    if (!agent) { notFound(res, `agent '${key}'`); return; }
    if (!agent.bundle_path) {
      badRequest(res, `agent '${key}' declares no bundlePath — set one with PATCH /agents/${key} before editing`);
      return;
    }
    const { content } = (req.body ?? {}) as { content?: unknown };
    if (typeof content !== "string") { badRequest(res, "content must be a string"); return; }

    const abs = safeBundlePath(agent.bundle_path);
    if (!abs) {
      badRequest(res, `bundlePath '${agent.bundle_path}' resolves outside the workspace`);
      return;
    }
    try {
      // The declared-but-missing case is a supported starting point, not an
      // error: GET reports it rather than 404ing precisely so it can be fixed
      // from here.
      mkdirSync(dirname(abs), { recursive: true });
      const tmp = `${abs}.tmp-${process.pid}`;
      writeFileSync(tmp, content, "utf8");
      renameSync(tmp, abs);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      return;
    }
    ok(res, { path: agent.bundle_path, bytes: Buffer.byteLength(content, "utf8") });
  }));

  // ---- skills ---------------------------------------------------------------

  /**
   * Every skill the workflows invoke, cross-referenced against what is on disk.
   *
   * The agent→skill mapping is derived from the workflows themselves rather
   * than declared anywhere, so it always matches what the engine will do. Two
   * statuses are the reason this endpoint is worth having: `missing` (a stage
   * that will die with `Unknown skill` on its next run, after spawning) and
   * `unused` (a file that reads like part of the pipeline but is invoked by
   * nothing).
   */
  r.get("/skills", guard, wrap(async (_req, res) => {
    ok(res, {
      dir: orch.config.skillsDir ?? null,
      skills: listSkills(orch.config.workspace, orch.config.skillsDir, orch.config.workflows),
    });
  }));

  r.get("/skills/:name", guard, wrap(async (req, res) => {
    const name = pathParam(req.params.name);
    const rows = listSkills(orch.config.workspace, orch.config.skillsDir, orch.config.workflows);
    const row = rows.find(s2 => s2.name === name);
    if (!row) { notFound(res, `skill '${name}'`); return; }
    if (!orch.config.skillsDir) {
      ok(res, { ...row, content: "", error: "no skillsDir is configured" });
      return;
    }
    const abs = skillFilePath(orch.config.workspace, orch.config.skillsDir, name);
    if (!abs) { badRequest(res, `skill name '${name}' resolves outside the skills directory`); return; }
    try {
      ok(res, { ...row, content: readFileSync(abs, "utf8") });
    } catch (err) {
      // Same contract as the agent bundle: a referenced-but-absent file is the
      // FINDING, not a 404 — it is exactly the state that makes the next run of
      // that stage fail, and the editor offers to create it.
      ok(res, { ...row, content: "", error: err instanceof Error ? err.message : String(err) });
    }
  }));

  /**
   * Overwrite a skill. Same write discipline as an agent bundle — temp file
   * plus rename — with one addition: the target is resolved through
   * `realpathSync` first. A skills directory is very often a directory of
   * SYMLINKS into the source tree, and renaming onto a symlink REPLACES the
   * link with a regular file, quietly severing it from the file the team
   * actually edits. The next `link-skills` would look like it did nothing.
   */
  r.put("/skills/:name", guard, wrap(async (req, res) => {
    if (!orch.config.skillsDir) { badRequest(res, "no skillsDir is configured"); return; }
    const name = pathParam(req.params.name);
    const { content } = (req.body ?? {}) as { content?: unknown };
    if (typeof content !== "string") { badRequest(res, "content must be a string"); return; }

    const abs = skillFilePath(orch.config.workspace, orch.config.skillsDir, name);
    if (!abs) { badRequest(res, `skill name '${name}' resolves outside the skills directory`); return; }

    try {
      let target = abs;
      try { target = realpathSync(abs); } catch { /* not there yet — create it */ }
      mkdirSync(dirname(target), { recursive: true });
      const tmp = `${target}.tmp-${process.pid}`;
      writeFileSync(tmp, content, "utf8");
      renameSync(tmp, target);
      ok(res, { name, path: orch.config.skillsDir + "/" + name + "/SKILL.md",
                bytes: Buffer.byteLength(content, "utf8") });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  }));

  r.get("/runners", guard, wrap(async (_req, res) => {
    ok(res, Object.keys(orch.config.adapters));
  }));

  // ---- issues ---------------------------------------------------------------

  r.post("/issues", guard, wrap(async (req, res) => {
    const { workflow, params } = (req.body ?? {}) as { workflow?: string; params?: Record<string, unknown> };
    if (!workflow) { badRequest(res, "workflow is required"); return; }
    let issue;
    try {
      const principal = (req as AuthedRequest).principal!;
      issue = await orch.engine.start(workflow, (params ?? {}) as Record<string, string>, {
        companyId: principal.companyId,
        createdBy: principal.user.id,
      });
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

  r.get("/issues", guard, wrap(async (req, res) => {
    const filter: ListIssuesFilter = {};
    if (typeof req.query.status === "string") filter.status = req.query.status;
    if (req.query.parentId !== undefined) {
      filter.parentId = req.query.parentId === "null" ? null : String(req.query.parentId);
    }
    if (req.query.assigneeAgentId !== undefined) {
      filter.assigneeAgentId = req.query.assigneeAgentId === "null" ? null : String(req.query.assigneeAgentId);
    }
    ok(res, await orch.repo.listIssues(org(req), filter));
  }));

  r.get("/issues/:id", guard, wrap(async (req, res) => {
    const issue = await issueFor(req, res, pathParam(req.params.id));
    if (!issue) return;
    ok(res, issue);
  }));

  r.patch("/issues/:id", guard, wrap(async (req, res) => {
    const id = pathParam(req.params.id);
    if (!(await issueFor(req, res, id))) return;
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
  r.post("/issues/:id/advance", guard, wrap(async (req, res) => {
    const id = pathParam(req.params.id);
    const issue = await issueFor(req, res, id);
    if (!issue) return;
    if (issue.status === "done") { badRequest(res, `issue ${issue.identifier} is already done`); return; }
    orch.engine.retry(id).catch((err: unknown) => {
      console.error(`[orchestrator] retry(${id}) failed:`, err);
    });
    res.status(202).json({ ok: true, issueId: id });
  }));

  // ---- stopping a run ---------------------------------------------------
  //
  // All three return 202 with the issue as it stands. A graceful pause may
  // wait as long as an agent run before it takes effect, so a response that
  // waited for the status to change would hold the connection open for twenty
  // minutes on a request that had already succeeded. Poll GET /issues/{id}.

  r.post("/issues/:id/pause", guard, wrap(async (req, res) => {
    const id = pathParam(req.params.id);
    const issue = await issueFor(req, res, id);
    if (!issue) return;
    const force = Boolean((req.body ?? {}).force);
    const principal = (req as AuthedRequest).principal!;
    let updated;
    try {
      updated = await orch.engine.pause(id, { force, by: principal.user.id });
    } catch (err) {
      badRequest(res, err instanceof Error ? err.message : String(err));
      return;
    }
    await platform.recordAction({
      companyId: issue.company_id, issueId: id, userId: principal.user.id,
      verb: force ? "issue.pause_now" : "issue.pause", targetType: "issue", targetId: id,
    });
    res.status(202).json(updated);
  }));

  r.post("/issues/:id/cancel", guard, wrap(async (req, res) => {
    const id = pathParam(req.params.id);
    const issue = await issueFor(req, res, id);
    if (!issue) return;
    const principal = (req as AuthedRequest).principal!;
    let updated;
    try {
      updated = await orch.engine.cancel(id, { by: principal.user.id });
    } catch (err) {
      badRequest(res, err instanceof Error ? err.message : String(err));
      return;
    }
    await platform.recordAction({
      companyId: issue.company_id, issueId: id, userId: principal.user.id,
      verb: "issue.cancel", targetType: "issue", targetId: id,
    });
    res.status(202).json(updated);
  }));

  r.post("/issues/:id/resume", guard, wrap(async (req, res) => {
    const id = pathParam(req.params.id);
    const issue = await issueFor(req, res, id);
    if (!issue) return;
    const principal = (req as AuthedRequest).principal!;
    // Refused synchronously so the caller learns "this was cancelled" now,
    // rather than getting a 202 for something that will never move.
    if (issue.status === "cancelled") {
      res.status(409).json({
        error: "cancelled",
        message: `${issue.identifier} was cancelled and does not resume. ` +
                 `Start the workflow again if it is still wanted.`,
      });
      return;
    }
    if (issue.status === "done") { badRequest(res, `${issue.identifier} is already done`); return; }

    // Fire-and-forget: resuming runs an agent step. Same reason POST /issues
    // and the gate decisions return 202.
    orch.engine.resume(id).catch((err: unknown) => {
      console.error(`[orchestrator] resume(${id}) failed:`, err);
    });
    await platform.recordAction({
      companyId: issue.company_id, issueId: id, userId: principal.user.id,
      verb: "issue.resume", targetType: "issue", targetId: id,
    });
    res.status(202).json({ ok: true, issueId: id });
  }));

  /**
   * Delete an issue and its whole subtree. Refused while a run is in flight:
   * the child process would keep writing to a log whose run row no longer
   * exists, and its cost would vanish from the spend figures.
   */
  r.delete("/issues/:id", guard, wrap(async (req, res) => {
    const id = pathParam(req.params.id);
    const issue = await issueFor(req, res, id);
    if (!issue) return;
    const live = (await orch.repo.listRuns(id)).filter(r2 => !r2.finished_at);
    if (live.length) {
      badRequest(res, `issue ${issue.identifier} has a run in flight — wait for it, or stop the process first`);
      return;
    }
    await orch.repo.deleteIssue(id);
    ok(res, { ok: true, deleted: issue.identifier });
  }));

  r.get("/issues/:id/comments", guard, wrap(async (req, res) => {
    const id = pathParam(req.params.id);
    if (!(await issueFor(req, res, id))) return;
    ok(res, await orch.repo.listComments(id));
  }));

  r.post("/issues/:id/comments", guard, wrap(async (req, res) => {
    const id = pathParam(req.params.id);
    const { body, authorAgentId, authorUser } =
      (req.body ?? {}) as { body?: string; authorAgentId?: string; authorUser?: string };
    if (!body) { badRequest(res, "body is required"); return; }
    if (!(await issueFor(req, res, id))) return;
    const comment = await orch.repo.addComment(
      id, body, { agentId: authorAgentId ?? null, user: authorUser ?? "api" });
    res.status(201).json(comment);
  }));

  r.get("/issues/:id/work-products", guard, wrap(async (req, res) => {
    const id = pathParam(req.params.id);
    if (!(await issueFor(req, res, id))) return;
    ok(res, await orch.repo.listWorkProducts(id));
  }));

  r.get("/issues/:id/gates", guard, wrap(async (req, res) => {
    const id = pathParam(req.params.id);
    if (!(await issueFor(req, res, id))) return;
    ok(res, await orch.repo.listGates(id));
  }));

  r.get("/issues/:id/runs", guard, wrap(async (req, res) => {
    const id = pathParam(req.params.id);
    if (!(await issueFor(req, res, id))) return;
    ok(res, await orch.repo.listRuns(id));
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
    const gate = await orch.repo.getGate(id).catch(() => null);
    // Scoped through the issue that owns it: approving another organisation's
    // gate would publish their document, which is about as consequential as a
    // cross-tenant action gets.
    if (!gate || !(await issueFor(req, res, gate.issue_id))) {
      if (!gate) notFound(res, `gate '${id}'`);
      return;
    }
    const { note, by } = (req.body ?? {}) as { note?: string; by?: string };
    const { issueId } = await orch.engine.decideGate(id, status, note, by, { advance: false });
    orch.engine.advance(issueId).catch((err: unknown) => {
      console.error(`[orchestrator] advance(${issueId}) after ${status} failed:`, err);
    });
    res.status(202).json({ ok: true, issueId });
  });

  r.post("/gates/:id/approve", guard, decide("approved"));
  r.post("/gates/:id/reject", guard, decide("rejected"));

  // ---- runs ---------------------------------------------------------------

  r.get("/runs/:id", guard, wrap(async (req, res) => {
    const id = pathParam(req.params.id);
    const run = await runFor(req, res, id);
    if (!run) return;
    ok(res, run);
  }));

  r.get("/runs/:id/log", guard, wrap(async (req, res) => {
    const id = pathParam(req.params.id);
    const run = await runFor(req, res, id);
    if (!run) return;
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

  r.get("/runs/:id/transcript", guard, wrap(async (req, res) => {
    const id = pathParam(req.params.id);
    const run = await runFor(req, res, id);
    if (!run) return;
    const offset = Number(req.query.offset ?? 0);
    let raw: string;
    try {
      raw = readFileSync(run.log_path, "utf8").slice(offset);
    } catch (err) {
      notFound(res, `log file at '${run.log_path}' (${err instanceof Error ? err.message : String(err)})`);
      return;
    }
    const { events, consumed } = filterRunLog(raw, run.adapter);
    ok(res, { events, nextOffset: offset + consumed });
  }));

  // ---- usage / config -----------------------------------------------------

  r.get("/budgets", guard, wrap(async (req, res) => {
    ok(res, await orch.repo.listBudgets(org(req)));
  }));

  /**
   * Set (or clear) a limit. `scope` is agent | workflow | project; the engine
   * reads the WORKFLOW budget first and falls back to the agent's, so a limit
   * set here takes effect on the next run with no restart.
   */
  r.post("/budgets", guard, wrap(async (req, res) => {
    const { scope, scopeKey, maxTokens, maxCostUsd, maxDurationMs } =
      (req.body ?? {}) as { scope?: string; scopeKey?: string;
                            maxTokens?: number; maxCostUsd?: number; maxDurationMs?: number };
    if (!scope || !scopeKey) { badRequest(res, "scope and scopeKey are required"); return; }
    if (!["agent", "workflow", "project"].includes(scope)) {
      badRequest(res, `scope must be one of agent, workflow, project`);
      return;
    }
    if (maxTokens == null && maxCostUsd == null && maxDurationMs == null) {
      await orch.repo.clearBudget(org(req), scope, scopeKey);
      ok(res, { ok: true, cleared: true, scope, scopeKey });
      return;
    }
    await orch.repo.setBudget(org(req), scope, scopeKey, { maxTokens, maxCostUsd, maxDurationMs });
    ok(res, { ok: true, scope, scopeKey, maxTokens, maxCostUsd, maxDurationMs });
  }));

  // `costUsd` is REPORTED spend and stays that way; `estCostUsd` is ours,
  // summed from the runs whose CLI reported nothing (every Codex run) and
  // returned BESIDE it rather than added into it — the same separation
  // core/platform.ts already keeps for the Spend tab. Summing cost_usd alone
  // made a Codex-first install read "$0.0000 spent" across the console while
  // its estimates sat in the next column.
  r.get("/usage", guard, wrap(async (req, res) => {
    const { rows } = await orch.db.query<{
      run_count: string; input_tokens: string | null; output_tokens: string | null;
      cache_read_tokens: string | null; cache_creation_tokens: string | null; cost_usd: string | null;
      est_cost_usd: string | null; unpriced_run_count: string | null;
    }>(
      `select count(*)::text as run_count,
              coalesce(sum(r.input_tokens),0)::text as input_tokens,
              coalesce(sum(r.output_tokens),0)::text as output_tokens,
              coalesce(sum(r.cache_read_tokens),0)::text as cache_read_tokens,
              coalesce(sum(r.cache_creation_tokens),0)::text as cache_creation_tokens,
              coalesce(sum(r.cost_usd),0)::text as cost_usd,
              coalesce(sum(r.est_cost_usd),0)::text as est_cost_usd,
              count(*) filter (where r.cost_usd is null and r.est_cost_usd is null)::text
                as unpriced_run_count
         from runs r
         join issues i on i.id = r.issue_id
        where i.company_id = $1`,
      [org(req)]);
    const row = rows[0];
    ok(res, {
      runCount: Number(row?.run_count ?? 0),
      inputTokens: Number(row?.input_tokens ?? 0),
      outputTokens: Number(row?.output_tokens ?? 0),
      cacheReadTokens: Number(row?.cache_read_tokens ?? 0),
      cacheCreationTokens: Number(row?.cache_creation_tokens ?? 0),
      costUsd: Number(row?.cost_usd ?? 0),
      estCostUsd: Number(row?.est_cost_usd ?? 0),
      unpricedRunCount: Number(row?.unpriced_run_count ?? 0),
    });
  }));

  r.get("/config", guard, wrap(async (_req, res) => {
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
        variantOf: w.variantOf, variant: w.variant,
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

  /**
   * One workflow in full — every step, and for agent steps the PROMPT itself.
   *
   * `GET /config` deliberately omits prompts: it is a summary, and a workflow's
   * prompts run to kilobytes each. But "what is this agent actually told" has
   * no other answer — the prompt reaches Claude Code on stdin rather than argv,
   * and the transcript filter has no event kind for it, so without this
   * endpoint the instruction a run received is unrecoverable after the fact.
   *
   * Read-only on purpose. These strings are COMPILED from the consumer's
   * pipeline definition, which is what makes "add a stage, get a workflow for
   * free" true; an editable override would quietly make one workflow
   * hand-maintained and a later pipeline change would stop reaching it. The
   * layers meant to be edited — the agent's bundle and the skill — already are.
   */
  r.get("/workflows/:key", guard, wrap(async (req, res) => {
    const key = pathParam(req.params.key);
    const wf = orch.config.workflows.find(w => w.key === key);
    if (!wf) { notFound(res, `workflow '${key}'`); return; }
    ok(res, {
      key: wf.key, label: wf.label, assignee: wf.assignee, title: wf.title ?? null,
      variantOf: wf.variantOf, variant: wf.variant,
      params: workflowParams(wf),
      steps: wf.steps.map(step => {
        switch (step.type) {
          case "exec":
            return { type: step.type, cmd: step.cmd, cwd: step.cwd, timeoutMs: step.timeoutMs };
          case "agent":
            return {
              type: step.type, phase: step.phase, skill: step.skill,
              agent: step.agent ?? wf.assignee, adapter: step.adapter,
              model: step.model, effort: step.effort,
              reads: step.reads, prompt: step.prompt,
            };
          case "attach": return { type: step.type, files: step.files };
          case "gate":   return { type: step.type, title: step.title, summary: step.summary };
          case "flow":   return { type: step.type, workflow: step.workflow, params: step.params };
        }
      }),
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
