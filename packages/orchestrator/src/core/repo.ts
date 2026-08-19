import { newId } from "./ids.js";
import type { Db } from "./db.js";

export interface AgentBudget {
  maxTokens?: number;
  maxCostUsd?: number;
  maxDurationMs?: number;
}

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface AgentSpec {
  key: string; name: string; title?: string; icon?: string;
  reportsTo?: string | null;      // agent KEY, resolved to uuid on write
  adapter?: string;               // key into config.runners; default 'claude_local'
  model?: string;
  effort?: Effort;
  fallbackModel?: string[];       // tried in order when the primary is overloaded
  cwd?: string;
  mcpEnabled?: boolean; extraArgs?: string[];
  bundlePath?: string;
  budget?: AgentBudget;           // written to the `budgets` table on upsert
}

export interface AgentRow {
  id: string; company_id: string; key: string; name: string; title: string | null;
  icon: string | null; reports_to: string | null; adapter: string; model: string | null;
  effort: string | null; fallback_model: string[]; cwd: string | null;
  mcp_enabled: boolean; extra_args: string[]; bundle_path: string | null;
  status: string; created_at: string; updated_at: string;
}

export interface IssueRow {
  id: string; company_id: string; identifier: string; parent_id: string | null;
  title: string; description: string | null; status: string;
  assignee_agent_id: string | null; workflow_key: string | null;
  step_index: number; params: Record<string, unknown>;
}

export interface RunRow {
  id: string; issue_id: string; agent_id: string | null; step_index: number | null;
  phase: string | null; status: string; started_at: string; finished_at: string | null;
  exit_code: number | null; log_path: string; session_id: string | null;
  input_tokens: string | null; output_tokens: string | null;
  cache_read_tokens: string | null; cache_creation_tokens: string | null;
  cost_usd: string | null; duration_ms: string | null; num_turns: number | null;
}

export interface GateRow {
  id: string; issue_id: string; kind: string; status: string;
  // `stepIndex` records which workflow step raised this gate — the engine's
  // idempotency guard reads it back to tell "the gate this step already
  // raised" from "a new gate for a later pass at the same step" (after a
  // rejection rewinds and regenerates). No migration: it rides in the
  // existing jsonb column rather than a new one.
  payload: { title: string; summary?: string; stepIndex?: number };
  decision_note: string | null; decided_by: string | null; decided_at: string | null;
}

export interface CommentRow {
  id: string; issue_id: string; author_agent_id: string | null;
  author_user: string | null; body: string; created_at: string;
}

export interface WorkProductRow {
  id: string; issue_id: string; type: string; provider: string;
  title: string; url: string; created_at: string;
}

export interface WorkProductInput {
  type: string; provider: string; title: string; url: string;
}

export interface CreateIssueInput {
  companyId: string; title: string; description?: string; workflowKey?: string | null;
  params?: Record<string, unknown>; parentId?: string | null;
  assigneeAgentId?: string | null; status?: string;
}

export interface UpdateIssuePatch {
  title?: string; description?: string | null; status?: string;
  assigneeAgentId?: string | null; workflowKey?: string | null;
  stepIndex?: number; params?: Record<string, unknown>;
}

export interface ListIssuesFilter {
  parentId?: string | null; status?: string; assigneeAgentId?: string | null;
}

export interface GatePayload {
  title: string; summary?: string; stepIndex?: number;
}

export type GateStatus = "pending" | "approved" | "rejected" | "cancelled";

export interface StartRunInput {
  issueId: string; agentId?: string | null; stepIndex?: number | null;
  phase?: string | null; logPath: string;
}

export interface FinishRunResult {
  status: string; exitCode?: number | null; sessionId?: string | null;
  inputTokens?: number | null; outputTokens?: number | null;
  cacheReadTokens?: number | null; cacheCreationTokens?: number | null;
  costUsd?: number | null; durationMs?: number | null; numTurns?: number | null;
}

export interface BudgetRow {
  id: string; company_id: string; scope: string; scope_key: string;
  max_tokens: string | null; max_cost_usd: string | null; max_duration_ms: string | null;
}

export function createRepo(db: Db) {
  return {
    async ensureCompany(name: string): Promise<string> {
      const found = await db.query<{ id: string }>(`select id from companies where name=$1`, [name]);
      if (found.rows[0]) return found.rows[0].id;
      const id = newId();
      await db.query(`insert into companies (id, name) values ($1,$2)`, [id, name]);
      return id;
    },

    async upsertAgent(companyId: string, spec: AgentSpec): Promise<string> {
      let reportsTo: string | null = null;
      if (spec.reportsTo) {
        const r = await db.query<{ id: string }>(
          `select id from agents where company_id=$1 and key=$2`, [companyId, spec.reportsTo]);
        reportsTo = r.rows[0]?.id ?? null;
      }
      const existing = await db.query<{ id: string }>(
        `select id from agents where company_id=$1 and key=$2`, [companyId, spec.key]);
      const id = existing.rows[0]?.id ?? newId();
      await db.query(
        `insert into agents (id, company_id, key, name, title, icon, reports_to,
                             adapter, model, effort, fallback_model, cwd,
                             mcp_enabled, extra_args, bundle_path, updated_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15, now())
         on conflict (company_id, key) do update set
           name=excluded.name, title=excluded.title, icon=excluded.icon,
           reports_to=excluded.reports_to, adapter=excluded.adapter,
           model=excluded.model, effort=excluded.effort,
           fallback_model=excluded.fallback_model, cwd=excluded.cwd,
           mcp_enabled=excluded.mcp_enabled, extra_args=excluded.extra_args,
           bundle_path=excluded.bundle_path, updated_at=now()`,
        [id, companyId, spec.key, spec.name, spec.title ?? null, spec.icon ?? null,
         reportsTo, spec.adapter ?? "claude_local", spec.model ?? null, spec.effort ?? null,
         JSON.stringify(spec.fallbackModel ?? []), spec.cwd ?? null, spec.mcpEnabled ?? false,
         JSON.stringify(spec.extraArgs ?? []), spec.bundlePath ?? null]);
      if (spec.budget) await this.setBudget(companyId, "agent", spec.key, spec.budget);
      return id;
    },

    async getAgentByKey(companyId: string, key: string): Promise<AgentRow | null> {
      const { rows } = await db.query<AgentRow>(
        `select * from agents where company_id=$1 and key=$2`, [companyId, key]);
      const row = rows[0];
      if (!row) return null;
      return {
        ...row,
        fallback_model: parseJson(row.fallback_model, []),
        extra_args: parseJson(row.extra_args, []),
      };
    },

    async listAgents(companyId: string): Promise<AgentRow[]> {
      const { rows } = await db.query<AgentRow>(
        `select * from agents where company_id=$1 order by created_at asc`, [companyId]);
      return rows.map(row => ({
        ...row,
        fallback_model: parseJson(row.fallback_model, []),
        extra_args: parseJson(row.extra_args, []),
      }));
    },

    async createIssue(input: CreateIssueInput): Promise<IssueRow> {
      // The identifier is computed inside the INSERT itself (rather than a
      // preceding `select count(*)`) so the read and the write are one
      // statement — atomic with respect to any single-connection driver
      // (pglite, the only one this prototype runs against). A separate
      // select-then-insert is a TOCTOU window: two concurrent callers can both
      // read the same count and then both insert 'SCY-N', tripping the
      // (company_id, identifier) unique constraint. The bounded retry below
      // additionally covers the `external` driver, where genuinely separate
      // connections can interleave even with the atomic form.
      const maxAttempts = 3;
      const id = newId();
      const params = [
        id, input.companyId, input.parentId ?? null, input.title,
        input.description ?? null, input.status ?? "todo", input.assigneeAgentId ?? null,
        input.workflowKey ?? null, 0, JSON.stringify(input.params ?? {}),
      ];
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          const { rows } = await db.query<IssueRow>(
            `insert into issues (id, company_id, identifier, parent_id, title, description,
                                 status, assignee_agent_id, workflow_key, step_index, params)
             values ($1, $2,
                     'SCY-' || (select count(*) + 1 from issues where company_id = $2),
                     $3, $4, $5, $6, $7, $8, $9, $10)
             returning *`,
            params);
          return parseIssueRow(rows[0]);
        } catch (err) {
          if (isUniqueViolation(err) && attempt < maxAttempts) continue;
          throw err;
        }
      }
      // Unreachable: every loop iteration above either returns or throws.
      throw new Error("createIssue: exhausted retry attempts");
    },

    async getIssue(id: string): Promise<IssueRow | null> {
      const { rows } = await db.query<IssueRow>(`select * from issues where id=$1`, [id]);
      return rows[0] ? parseIssueRow(rows[0]) : null;
    },

    async listIssues(companyId: string, filter?: ListIssuesFilter): Promise<IssueRow[]> {
      const clauses = ["company_id=$1"];
      const params: unknown[] = [companyId];
      // `IS $n` is not valid Postgres — `IS` only accepts the literal keywords
      // NULL/NOT NULL/TRUE/FALSE/UNKNOWN, never a bound parameter. A null
      // filter value is therefore emitted as a literal `is null` clause with no
      // parameter pushed; a non-null value still binds through `=$n` as usual.
      if (filter?.parentId !== undefined) {
        if (filter.parentId === null) {
          clauses.push(`parent_id is null`);
        } else {
          params.push(filter.parentId);
          clauses.push(`parent_id=$${params.length}`);
        }
      }
      if (filter?.status !== undefined) {
        params.push(filter.status);
        clauses.push(`status=$${params.length}`);
      }
      if (filter?.assigneeAgentId !== undefined) {
        if (filter.assigneeAgentId === null) {
          clauses.push(`assignee_agent_id is null`);
        } else {
          params.push(filter.assigneeAgentId);
          clauses.push(`assignee_agent_id=$${params.length}`);
        }
      }
      const { rows } = await db.query<IssueRow>(
        `select * from issues where ${clauses.join(" and ")} order by created_at asc`, params);
      return rows.map(parseIssueRow);
    },

    async updateIssue(id: string, patch: UpdateIssuePatch): Promise<IssueRow | null> {
      const sets: string[] = [];
      const params: unknown[] = [];
      if (patch.title !== undefined) { params.push(patch.title); sets.push(`title=$${params.length}`); }
      if (patch.description !== undefined) { params.push(patch.description); sets.push(`description=$${params.length}`); }
      if (patch.status !== undefined) { params.push(patch.status); sets.push(`status=$${params.length}`); }
      if (patch.assigneeAgentId !== undefined) { params.push(patch.assigneeAgentId); sets.push(`assignee_agent_id=$${params.length}`); }
      if (patch.workflowKey !== undefined) { params.push(patch.workflowKey); sets.push(`workflow_key=$${params.length}`); }
      if (patch.stepIndex !== undefined) { params.push(patch.stepIndex); sets.push(`step_index=$${params.length}`); }
      if (patch.params !== undefined) { params.push(JSON.stringify(patch.params)); sets.push(`params=$${params.length}`); }
      sets.push(`updated_at=now()`);
      params.push(id);
      const { rows } = await db.query<IssueRow>(
        `update issues set ${sets.join(", ")} where id=$${params.length} returning *`, params);
      return rows[0] ? parseIssueRow(rows[0]) : null;
    },

    async addComment(issueId: string, body: string, author: { agentId?: string | null; user?: string | null }): Promise<CommentRow> {
      const id = newId();
      const { rows } = await db.query<CommentRow>(
        `insert into comments (id, issue_id, author_agent_id, author_user, body)
         values ($1,$2,$3,$4,$5) returning *`,
        [id, issueId, author.agentId ?? null, author.user ?? null, body]);
      return rows[0];
    },

    async listComments(issueId: string): Promise<CommentRow[]> {
      const { rows } = await db.query<CommentRow>(
        `select * from comments where issue_id=$1 order by created_at asc`, [issueId]);
      return rows;
    },

    async attachWorkProduct(issueId: string, wp: WorkProductInput): Promise<WorkProductRow | null> {
      const id = newId();
      const { rows } = await db.query<WorkProductRow>(
        `insert into work_products (id, issue_id, type, provider, title, url)
         values ($1,$2,$3,$4,$5,$6)
         on conflict (issue_id, url) do nothing
         returning *`,
        [id, issueId, wp.type, wp.provider, wp.title, wp.url]);
      return rows[0] ?? null;
    },

    async listWorkProducts(issueId: string): Promise<WorkProductRow[]> {
      const { rows } = await db.query<WorkProductRow>(
        `select * from work_products where issue_id=$1 order by created_at asc`, [issueId]);
      return rows;
    },

    async createGate(issueId: string, payload: GatePayload): Promise<GateRow> {
      const id = newId();
      const { rows } = await db.query<GateRow>(
        `insert into gates (id, issue_id, payload) values ($1,$2,$3) returning *`,
        [id, issueId, JSON.stringify(payload)]);
      return parseGateRow(rows[0]);
    },

    async getGate(id: string): Promise<GateRow | null> {
      const { rows } = await db.query<GateRow>(`select * from gates where id=$1`, [id]);
      return rows[0] ? parseGateRow(rows[0]) : null;
    },

    async decideGate(id: string, status: GateStatus, note: string | null, by: string): Promise<GateRow | null> {
      const { rows } = await db.query<GateRow>(
        `update gates set status=$1, decision_note=$2, decided_by=$3, decided_at=now()
         where id=$4 returning *`,
        [status, note, by, id]);
      return rows[0] ? parseGateRow(rows[0]) : null;
    },

    async listGates(issueId: string): Promise<GateRow[]> {
      const { rows } = await db.query<GateRow>(
        `select * from gates where issue_id=$1 order by created_at asc`, [issueId]);
      return rows.map(parseGateRow);
    },

    async startRun(input: StartRunInput): Promise<RunRow> {
      const id = newId();
      const { rows } = await db.query<RunRow>(
        `insert into runs (id, issue_id, agent_id, step_index, phase, status, log_path)
         values ($1,$2,$3,$4,$5,'running',$6) returning *`,
        [id, input.issueId, input.agentId ?? null, input.stepIndex ?? null,
         input.phase ?? null, input.logPath]);
      return rows[0];
    },

    async finishRun(id: string, result: FinishRunResult): Promise<RunRow | null> {
      const { rows } = await db.query<RunRow>(
        `update runs set status=$1, exit_code=$2, session_id=$3, finished_at=now(),
           input_tokens=$4, output_tokens=$5, cache_read_tokens=$6, cache_creation_tokens=$7,
           cost_usd=$8, duration_ms=$9, num_turns=$10
         where id=$11 returning *`,
        [result.status, result.exitCode ?? null, result.sessionId ?? null,
         result.inputTokens ?? null, result.outputTokens ?? null,
         result.cacheReadTokens ?? null, result.cacheCreationTokens ?? null,
         result.costUsd ?? null, result.durationMs ?? null, result.numTurns ?? null, id]);
      return rows[0] ?? null;
    },

    async getRun(id: string): Promise<RunRow | null> {
      const { rows } = await db.query<RunRow>(`select * from runs where id=$1`, [id]);
      return rows[0] ?? null;
    },

    async listRuns(issueId: string): Promise<RunRow[]> {
      const { rows } = await db.query<RunRow>(
        `select * from runs where issue_id=$1 order by started_at desc`, [issueId]);
      return rows;
    },

    /** Called by upsertAgent when spec.budget is present. Scope 'agent', key = agent key. */
    async setBudget(companyId: string, scope: string, scopeKey: string, b: AgentBudget): Promise<void> {
      await db.query(
        `insert into budgets (id, company_id, scope, scope_key, max_tokens, max_cost_usd, max_duration_ms)
         values ($1,$2,$3,$4,$5,$6,$7)
         on conflict (company_id, scope, scope_key) do update set
           max_tokens=excluded.max_tokens, max_cost_usd=excluded.max_cost_usd,
           max_duration_ms=excluded.max_duration_ms`,
        [newId(), companyId, scope, scopeKey, b.maxTokens ?? null, b.maxCostUsd ?? null, b.maxDurationMs ?? null]);
    },

    async getBudget(companyId: string, scope: string, scopeKey: string): Promise<BudgetRow | null> {
      const { rows } = await db.query<BudgetRow>(
        `select * from budgets where company_id=$1 and scope=$2 and scope_key=$3`,
        [companyId, scope, scopeKey]);
      return rows[0] ?? null;
    },

    /** Used by engine.recoverOrphans(). */
    /**
     * Delete an issue and everything hanging off it. The schema cascades
     * comments, work products, gates, runs AND child issues, so this is one
     * statement rather than a hand-rolled teardown that would drift from the
     * schema the first time a table is added.
     */
    async deleteIssue(id: string): Promise<boolean> {
      const { rows } = await db.query<{ id: string }>(
        `delete from issues where id=$1 returning id`, [id]);
      return rows.length > 0;
    },

    /**
     * Wipe a company's operational history: every issue, and with it (by
     * `on delete cascade`) its comments, work products, gates and runs, plus
     * every budget.
     *
     * `opts.agents` also drops the org chart. That is only useful because the
     * org is RECONCILED from the config file on every boot — so dropping it is
     * how a hand-edited row or an `.orchestrator/overrides.json` entry gets
     * discarded, not how an agent is permanently removed.
     *
     * Order matters and is not incidental: `issues.assignee_agent_id` and
     * `runs.agent_id` reference `agents` WITHOUT a cascade, so agents cannot be
     * deleted until the issues that point at them are gone. Deleting in the
     * other order fails on a foreign key, which reads like corruption.
     */
    /**
     * Clear a company's history.
     *
     * `agents` additionally drops the org chart, which the next boot rebuilds
     * from the config file. `platform` additionally drops IDENTITY and CONTENT
     * — users, projects, features, documents, installations and chats — which
     * is what "start completely fresh" has to mean once those exist. Without
     * it a reset left every account in place, so the installation could never
     * be claimed again and the wipe looked like it had failed.
     */
    async resetCompany(
      companyId: string, opts: { agents?: boolean; platform?: boolean } = {},
    ): Promise<{ issues: number; runs: number; budgets: number; agents: number;
                 users: number; projects: number; documents: number; installations: number }> {
      const count = async (table: string, col: string): Promise<number> => {
        const { rows } = await db.query<{ n: string }>(
          `select count(*) as n from ${table} where ${col}=$1`, [companyId]);
        return Number(rows[0]?.n ?? 0);
      };
      // Runs hang off issues, not off the company, so they are counted through
      // the join rather than assumed to equal anything.
      const { rows: runRows } = await db.query<{ n: string }>(
        `select count(*) as n from runs r join issues i on i.id = r.issue_id where i.company_id=$1`,
        [companyId]);

      // Documents hang off projects, so they are counted through the join for
      // the same reason runs are.
      const { rows: docRows } = await db.query<{ n: string }>(
        `select count(*) as n from documents d join projects p on p.id = d.project_id
          where p.company_id=$1`, [companyId]);

      const summary = {
        issues: await count("issues", "company_id"),
        runs: Number(runRows[0]?.n ?? 0),
        budgets: await count("budgets", "company_id"),
        agents: 0,
        users: opts.platform ? await count("users", "company_id") : 0,
        projects: opts.platform ? await count("projects", "company_id") : 0,
        documents: opts.platform ? Number(docRows[0]?.n ?? 0) : 0,
        installations: opts.platform ? await count("installations", "company_id") : 0,
      };

      await db.query(`delete from issues where company_id=$1`, [companyId]);
      await db.query(`delete from budgets where company_id=$1`, [companyId]);

      if (opts.platform) {
        // Order follows the foreign keys. Projects cascade into features,
        // documents, members and their actions; users cascade into tokens and
        // sessions. What is left over is deleted explicitly rather than left
        // to chance.
        await db.query(`delete from projects where company_id=$1`, [companyId]);
        await db.query(`delete from conversations where company_id=$1`, [companyId]);
        await db.query(`delete from installations where company_id=$1`, [companyId]);
        await db.query(`delete from actions where company_id=$1`, [companyId]);
        await db.query(`delete from users where company_id=$1`, [companyId]);
        // Blobs are shared content addressed by hash and belong to no company,
        // so they are removed only once nothing references them at all.
        await db.query(`delete from blobs b where not exists
          (select 1 from documents d where d.sha256 = b.sha256)`);
      }

      if (opts.agents) {
        summary.agents = await count("agents", "company_id");
        await db.query(`delete from agents where company_id=$1`, [companyId]);
      }
      return summary;
    },

    /** Every budget for a company — agent, workflow and project scopes together. */
    async listBudgets(companyId: string): Promise<BudgetRow[]> {
      const { rows } = await db.query<BudgetRow>(
        `select * from budgets where company_id=$1 order by scope, scope_key`, [companyId]);
      return rows;
    },

    async clearBudget(companyId: string, scope: string, scopeKey: string): Promise<void> {
      await db.query(`delete from budgets where company_id=$1 and scope=$2 and scope_key=$3`,
        [companyId, scope, scopeKey]);
    },

    /** `active` | `disabled`. Disabling keeps the history and hides the agent. */
    async setAgentStatus(companyId: string, key: string, status: string): Promise<AgentRow | null> {
      const { rows } = await db.query<AgentRow>(
        `update agents set status=$3, updated_at=now() where company_id=$1 and key=$2 returning *`,
        [companyId, key, status]);
      return rows[0] ? { ...rows[0], fallback_model: rows[0].fallback_model ?? [], extra_args: rows[0].extra_args ?? [] } : null;
    },

    async listUnfinishedRuns(): Promise<RunRow[]> {
      const { rows } = await db.query<RunRow>(`select * from runs where finished_at is null`);
      return rows;
    },
  };
}

/** Postgres SQLSTATE 23505 = unique_violation. PGlite and `pg` both surface it as `.code`. */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err
    && (err as { code?: unknown }).code === "23505";
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "string") {
    try { return JSON.parse(value) as T; } catch { return fallback; }
  }
  return value as T;
}

function parseIssueRow(row: IssueRow): IssueRow {
  return { ...row, params: parseJson(row.params, {}) };
}

function parseGateRow(row: GateRow): GateRow {
  return { ...row, payload: parseJson(row.payload, { title: "" }) };
}
