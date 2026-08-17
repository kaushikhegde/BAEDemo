# Scyne Orchestrator Prototype — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a working `@scyne/orchestrator` package — PGlite storage, a five-step-type workflow engine, a Claude Code runner with token/cost capture, an HTTP API and OpenAPI docs — and prove it by running the `requirements` stage end-to-end against `SAPN_DEMO / interiam-benifits`.

**Architecture:** A domain-agnostic library. The core knows about agents, issues, runs, gates and five step primitives; it knows nothing about Salesforce, Confluence or requirements. This repo becomes a *consumer* that supplies its org and compiles `scripts/pipeline.mjs` into workflow definitions. The engine owns the issue lifecycle; agents are thin and do domain work only.

**Tech Stack:** Node 24 · TypeScript 5.7 · ESM · `@electric-sql/pglite` (Postgres as WASM) · Express 4 · Vitest · Claude Code CLI 2.1.232

**Spec:** [`docs/superpowers/specs/2026-08-17-scyne-orchestrator-design.md`](../specs/2026-08-17-scyne-orchestrator-design.md)

## Global Constraints

- **NEVER run `git commit`, `git add`, or any git write operation.** The user commits their own work. Every task ends with a verification checkpoint instead. This overrides the writing-plans skill's default task template.
- **Australian English** in all generated content and user-facing copy.
- **ESM only.** Every package is `"type": "module"`. No `require`.
- **Node ≥ 24.** `package.json` sets `"engines": { "node": ">=24" }`.
- **Zero network requests from rendered HTML.** The `/docs` page inlines everything; no CDN links. Same rule as `scripts/render-companion-app.mjs`.
- **The core must not import from `scyne-chatbot/` or `scripts/`.** The only permitted direction is consumer → library. A test enforces this (Task 12).
- **No `any` in exported signatures.** Internal `any` is tolerated; the public API is typed.
- **PGlite data lives at `.orchestrator/`** — added to `.gitignore` in Task 1.
- Claude Code invocation flags are fixed by the spec §8 and confirmed against 2.1.232. Do not improvise alternatives.

## Deliberately out of scope for this prototype

Named here so their absence reads as a decision rather than an oversight. Each is
specified and belongs to a later phase.

| Spec section | Deferred | Why |
|---|---|---|
| §12 The console | All nine tabs | The user scoped this prototype to engine + CLI + API + docs. The console builds on a proven core. |
| §6 `native` driver | `embedded-postgres` | `pglite` and `external` cover every prototype need; the third path would be untested code. `openDb` throws a named error for it. |
| §11 Skills mirroring | Populating `skills` / `agent_skills` | The tables exist in the migration; nothing writes them yet. Skill resolution still works — it comes from `.claude/skills/`, not the database. |
| §7 `publish` step | Confluence/Jira phase 2 | Publishing during a prototype run would write to a real client space. |
| §14 phases 2–4 | Chatbot switch, 10 bundle rewrites | Each gets its own plan after the findings are reviewed. |

---

## File Structure

```
packages/orchestrator/
  package.json                  ESM, engines node>=24
  tsconfig.json
  vitest.config.ts
  openapi.yaml                  the API contract — source of truth for §13
  migrations/
    001_init.sql                the spec §6.1 schema
  src/
    index.ts                    public API surface
    config.ts                   defineOrchestrator(), config types, resolution
    core/
      db.ts                     driver abstraction + migration runner
      ids.ts                    uuid v4 + human identifiers (SCY-1)
      repo.ts                   typed queries over the schema
      interpolate.ts            {project} {feature} {workspace} {issueId}
      transcript.ts             stream-json → events  (ported from the chatbot)
      usage.ts                  extract usage/cost from the `result` event
      runner.ts                 spawn claude, tee log to disk, return usage
      engine.ts                 five step types + advance()
    http/
      router.ts                 Express Router over the API surface
      docs.ts                   /openapi.json + /docs (inlined reference)
    cli.ts                      run | status | gate | runs | log | serve
  test/
    db.test.ts
    repo.test.ts
    config.test.ts
    interpolate.test.ts
    usage.test.ts
    transcript.test.ts
    engine.test.ts              against a fake runner
    router.test.ts
    openapi.test.ts             contract drift guard
    boundaries.test.ts          the core imports nothing from the consumer
  fixtures/
    result-event.jsonl          a REAL captured claude result event (Task 4)

orchestrator.config.ts          consumer config: the org + compiled workflows
agent-instructions/ba.thin.md   domain-only BA bundle
```

**Responsibility boundaries.** `db.ts` owns connection and migration only — no domain queries. `repo.ts` owns every SQL statement; nothing else writes SQL. `runner.ts` owns process spawning and knows nothing about workflows. `engine.ts` owns sequencing and never spawns a process directly — it calls the injected runner, which is what makes it testable without Claude.

---

## Task 1: Package scaffold, PGlite driver, migrations

**Files:**
- Create: `packages/orchestrator/package.json`
- Create: `packages/orchestrator/tsconfig.json`
- Create: `packages/orchestrator/vitest.config.ts`
- Create: `packages/orchestrator/migrations/001_init.sql`
- Create: `packages/orchestrator/src/core/db.ts`
- Create: `packages/orchestrator/test/db.test.ts`
- Modify: `.gitignore` — add `.orchestrator/`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `type Db = { query<T=any>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>; close(): Promise<void> }`
  - `openDb(opts: { driver: "pglite"|"native"|"external"; dir?: string; url?: string }): Promise<Db>`
  - `migrate(db: Db, dir: string): Promise<{ applied: string[] }>`

- [ ] **Step 1: Create the package manifest**

`packages/orchestrator/package.json`:

```json
{
  "name": "@scyne/orchestrator",
  "version": "0.1.0",
  "type": "module",
  "engines": { "node": ">=24" },
  "main": "./src/index.ts",
  "exports": {
    ".": "./src/index.ts",
    "./client": "./src/client/index.ts"
  },
  "bin": { "scyne-orchestrator": "./src/cli.ts" },
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "@electric-sql/pglite": "^0.2.17",
    "express": "^4.21.1",
    "yaml": "^2.6.1"
  },
  "devDependencies": {
    "@types/express": "^5.0.0",
    "@types/node": "^22.10.0",
    "tsx": "^4.19.2",
    "typescript": "^5.7.2",
    "vitest": "^2.1.8"
  }
}
```

`packages/orchestrator/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "types": ["node", "vitest/globals"]
  },
  "include": ["src", "test"]
}
```

`packages/orchestrator/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    testTimeout: 30_000, // PGlite cold start on first run
  },
});
```

- [ ] **Step 2: Install dependencies**

Run: `cd packages/orchestrator && npm install`
Expected: completes, `node_modules/@electric-sql/pglite` exists.

- [ ] **Step 3: Add the ignore rule**

Append to `.gitignore`:

```
.orchestrator/
```

- [ ] **Step 4: Write the migration**

`packages/orchestrator/migrations/001_init.sql` — copy the schema verbatim from spec §6.1 (`companies`, `agents`, `skills`, `agent_skills`, `issues`, `comments`, `work_products`, `gates`, `runs`, `budgets`), preceded by:

```sql
create table if not exists _migrations (
  name       text primary key,
  applied_at timestamptz not null default now()
);
```

Then all ten tables from §6.1, unchanged. Add these indexes at the end:

```sql
create index on issues (company_id, status);
create index on issues (parent_id);
create index on runs   (issue_id, started_at desc);
create index on comments (issue_id, created_at);
create index on gates  (issue_id, status);
```

- [ ] **Step 5: Write the failing test**

`packages/orchestrator/test/db.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, migrate } from "../src/core/db.js";

let dir: string;
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

describe("db", () => {
  it("opens pglite, applies migrations, and is idempotent", async () => {
    dir = mkdtempSync(join(tmpdir(), "orch-"));
    const db = await openDb({ driver: "pglite", dir });

    const first = await migrate(db, new URL("../migrations", import.meta.url).pathname);
    expect(first.applied).toContain("001_init.sql");

    const second = await migrate(db, new URL("../migrations", import.meta.url).pathname);
    expect(second.applied).toEqual([]); // already applied

    const { rows } = await db.query<{ table_name: string }>(
      `select table_name from information_schema.tables where table_schema='public'`
    );
    const names = rows.map(r => r.table_name);
    for (const t of ["companies","agents","issues","comments","work_products","gates","runs","budgets","skills","agent_skills"]) {
      expect(names).toContain(t);
    }
    await db.close();
  });
});
```

- [ ] **Step 6: Run it to confirm it fails**

Run: `cd packages/orchestrator && npx vitest run test/db.test.ts`
Expected: FAIL — `Cannot find module '../src/core/db.js'`.

- [ ] **Step 7: Implement the driver**

`packages/orchestrator/src/core/db.ts`:

```ts
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export interface Db {
  query<T = any>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  close(): Promise<void>;
}

export interface DbOptions {
  driver: "pglite" | "native" | "external";
  dir?: string;   // pglite | native
  url?: string;   // external
}

export async function openDb(opts: DbOptions): Promise<Db> {
  if (opts.driver === "pglite") {
    const { PGlite } = await import("@electric-sql/pglite");
    const pg = new PGlite(opts.dir);
    return {
      async query(sql, params) {
        const r = await pg.query(sql, params as any[]);
        return { rows: (r.rows ?? []) as any[] };
      },
      async close() { await pg.close(); },
    };
  }
  if (opts.driver === "external") {
    if (!opts.url) throw new Error("driver 'external' requires a url");
    const { default: pgLib } = await import("pg");
    const client = new pgLib.Client({ connectionString: opts.url });
    await client.connect();
    return {
      async query(sql, params) {
        const r = await client.query(sql, params as any[]);
        return { rows: r.rows };
      },
      async close() { await client.end(); },
    };
  }
  throw new Error(`driver '${opts.driver}' is not implemented in the prototype`);
}

export async function migrate(db: Db, dir: string): Promise<{ applied: string[] }> {
  await db.query(
    `create table if not exists _migrations (
       name text primary key,
       applied_at timestamptz not null default now())`
  );
  const { rows } = await db.query<{ name: string }>(`select name from _migrations`);
  const done = new Set(rows.map(r => r.name));
  const files = (await readdir(dir)).filter(f => f.endsWith(".sql")).sort();

  const applied: string[] = [];
  for (const f of files) {
    if (done.has(f)) continue;
    const sql = await readFile(join(dir, f), "utf8");
    await db.query(sql);
    await db.query(`insert into _migrations (name) values ($1)`, [f]);
    applied.push(f);
  }
  return { applied };
}
```

> `native` throws deliberately. The spec lists it as a supported driver, but the prototype only needs `pglite`; implementing an unused path is the kind of speculative work the spec's §18 warns about. The throw names it clearly rather than failing mysteriously.

- [ ] **Step 8: Run the test**

Run: `cd packages/orchestrator && npx vitest run test/db.test.ts`
Expected: PASS. **This closes spec open item #4** — PGlite's Postgres version accepts the schema.

- [ ] **Step 9: Checkpoint**

Report: the PGlite version resolved, the Postgres server version (`select version()`), and confirmation that all ten tables exist. Leave all files uncommitted.

---

## Task 2: The repository layer

**Files:**
- Create: `packages/orchestrator/src/core/ids.ts`
- Create: `packages/orchestrator/src/core/repo.ts`
- Create: `packages/orchestrator/test/repo.test.ts`

**Interfaces:**
- Consumes: `Db`, `openDb`, `migrate` from Task 1
- Produces:
  - `newId(): string` — uuid v4
  - `createRepo(db: Db): Repo`
  - `Repo` with: `ensureCompany(name)`, `upsertAgent(companyId, spec)`, `getAgentByKey(companyId, key)`, `listAgents(companyId)`, `createIssue(input)`, `getIssue(id)`, `listIssues(companyId, filter?)`, `updateIssue(id, patch)`, `addComment(issueId, body, author)`, `listComments(issueId)`, `attachWorkProduct(issueId, wp)`, `listWorkProducts(issueId)`, `createGate(issueId, payload)`, `getGate(id)`, `decideGate(id, status, note, by)`, `listGates(issueId)`, `startRun(input)`, `finishRun(id, result)`, `getRun(id)`, `listRuns(issueId)`
  - Types: `AgentSpec`, `IssueRow`, `RunRow`, `GateRow`

- [ ] **Step 1: Write `ids.ts`**

```ts
import { randomUUID } from "node:crypto";

export function newId(): string {
  return randomUUID();
}

/** Next human identifier for a company, e.g. SCY-7. */
export function nextIdentifier(prefix: string, count: number): string {
  return `${prefix}-${count + 1}`;
}
```

- [ ] **Step 2: Write the failing test**

`packages/orchestrator/test/repo.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, migrate, type Db } from "../src/core/db.js";
import { createRepo } from "../src/core/repo.js";

let dir: string, db: Db, repo: ReturnType<typeof createRepo>, companyId: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "orch-"));
  db = await openDb({ driver: "pglite", dir });
  await migrate(db, new URL("../migrations", import.meta.url).pathname);
  repo = createRepo(db);
  companyId = await repo.ensureCompany("Scyne");
});
afterEach(async () => { await db.close(); rmSync(dir, { recursive: true, force: true }); });

describe("repo", () => {
  it("ensureCompany is idempotent", async () => {
    const again = await repo.ensureCompany("Scyne");
    expect(again).toBe(companyId);
  });

  it("upserts an agent addressed by stable key, not uuid", async () => {
    await repo.upsertAgent(companyId, { key: "ba", name: "BA", title: "BA", icon: "search", model: "claude-sonnet-4-6" });
    await repo.upsertAgent(companyId, { key: "ba", name: "BA", title: "Business Analyst", icon: "search", model: "claude-sonnet-4-6" });
    const a = await repo.getAgentByKey(companyId, "ba");
    expect(a?.title).toBe("Business Analyst");
    expect((await repo.listAgents(companyId)).length).toBe(1);
  });

  it("issues get sequential identifiers", async () => {
    const a = await repo.createIssue({ companyId, title: "One", workflowKey: "requirements", params: { project: "P" } });
    const b = await repo.createIssue({ companyId, title: "Two", workflowKey: "requirements", params: { project: "P" } });
    expect(a.identifier).toBe("SCY-1");
    expect(b.identifier).toBe("SCY-2");
  });

  it("work products dedupe on (issue, url)", async () => {
    const i = await repo.createIssue({ companyId, title: "X", workflowKey: "requirements", params: {} });
    await repo.attachWorkProduct(i.id, { type: "document", provider: "local", title: "a.md", url: "file:///a.md" });
    await repo.attachWorkProduct(i.id, { type: "document", provider: "local", title: "a.md", url: "file:///a.md" });
    expect((await repo.listWorkProducts(i.id)).length).toBe(1);
  });

  it("records a run with usage", async () => {
    const i = await repo.createIssue({ companyId, title: "X", workflowKey: "requirements", params: {} });
    const run = await repo.startRun({ issueId: i.id, agentId: null, stepIndex: 0, phase: "generate", logPath: "/tmp/x.jsonl" });
    await repo.finishRun(run.id, {
      status: "succeeded", exitCode: 0, sessionId: "s1",
      inputTokens: 100, outputTokens: 200, cacheReadTokens: 50, cacheCreationTokens: 10,
      costUsd: 0.0123, durationMs: 4321, numTurns: 3,
    });
    const got = await repo.getRun(run.id);
    expect(got?.status).toBe("succeeded");
    expect(Number(got?.output_tokens)).toBe(200);
    expect(Number(got?.cost_usd)).toBeCloseTo(0.0123, 4);
  });

  it("decides a gate", async () => {
    const i = await repo.createIssue({ companyId, title: "X", workflowKey: "requirements", params: {} });
    const g = await repo.createGate(i.id, { title: "Approve", summary: "" });
    await repo.decideGate(g.id, "approved", "looks good", "tagari");
    expect((await repo.getGate(g.id))?.status).toBe("approved");
  });
});
```

- [ ] **Step 3: Run it to confirm it fails**

Run: `cd packages/orchestrator && npx vitest run test/repo.test.ts`
Expected: FAIL — `Cannot find module '../src/core/repo.js'`.

- [ ] **Step 4: Implement `repo.ts`**

Every SQL statement in the package lives in this file. Structure:

```ts
import { newId, nextIdentifier } from "./ids.js";
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
  payload: { title: string; summary?: string };
  decision_note: string | null; decided_by: string | null; decided_at: string | null;
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

    // …getAgentByKey, listAgents, createIssue (assigns SCY-N via a count),
    //   getIssue, listIssues, updateIssue, addComment, listComments,
    //   attachWorkProduct (on conflict (issue_id,url) do nothing),
    //   listWorkProducts, createGate, getGate, decideGate, listGates,
    //   startRun, finishRun, getRun, listRuns
  };
}
```

Implement every remaining method following the same shape: parameterised SQL, uuid generated in JS, JSON columns stringified on write and parsed on read. `createIssue` derives the identifier from `select count(*) from issues where company_id=$1` and `nextIdentifier("SCY", count)`.

Two additional methods this task must provide, used by later tasks:

```ts
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

    async getBudget(companyId: string, scope: string, scopeKey: string) {
      const { rows } = await db.query(
        `select * from budgets where company_id=$1 and scope=$2 and scope_key=$3`,
        [companyId, scope, scopeKey]);
      return rows[0] ?? null;
    },

    /** Used by engine.recoverOrphans(). */
    async listUnfinishedRuns() {
      const { rows } = await db.query(`select * from runs where finished_at is null`);
      return rows;
    },
```

`upsertAgent` calls `setBudget(companyId, "agent", spec.key, spec.budget)` whenever `spec.budget` is present.

- [ ] **Step 5: Run the tests**

Run: `cd packages/orchestrator && npx vitest run test/repo.test.ts`
Expected: all six PASS.

- [ ] **Step 6: Checkpoint**

Report: test output. Note that numeric columns come back as strings from Postgres (`bigint`/`numeric`) — the test already asserts this by wrapping in `Number()`. Confirm the reviewer is happy with that convention before it spreads.

---

## Task 3: Config and interpolation

**Files:**
- Create: `packages/orchestrator/src/config.ts`
- Create: `packages/orchestrator/src/core/interpolate.ts`
- Create: `packages/orchestrator/test/config.test.ts`
- Create: `packages/orchestrator/test/interpolate.test.ts`

**Interfaces:**
- Consumes: `AgentSpec` from Task 2
- Produces:
  - `type Step` — the five variants from spec §7.1
  - `interface WorkflowDef { key: string; label: string; assignee: string; steps: Step[] }`
  - `interface OrchestratorConfig { workspace: string; company?: string; db: DbOptions; org: AgentSpec[]; workflows: WorkflowDef[] }`
  - `defineOrchestrator(c: OrchestratorConfig): OrchestratorConfig`
  - `validateConfig(c): string[]` — human-readable problems, empty when valid
  - `interpolate(tpl: string, vars: Record<string, string>): string`

- [ ] **Step 1: Write the interpolation test**

`packages/orchestrator/test/interpolate.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { interpolate } from "../src/core/interpolate.js";

describe("interpolate", () => {
  it("substitutes known placeholders", () => {
    expect(interpolate("stage {project} {feature} qa", { project: "RTWSA", feature: "Appeals" }))
      .toBe("stage RTWSA Appeals qa");
  });

  it("throws on an unknown placeholder rather than emitting it literally", () => {
    expect(() => interpolate("run {nope}", { project: "P" }))
      .toThrow(/unknown placeholder.*nope/i);
  });

  it("leaves a string with no placeholders untouched", () => {
    expect(interpolate("no vars here", {})).toBe("no vars here");
  });
});
```

> Throwing on an unknown placeholder is deliberate. A silently un-substituted `{feature}` becomes a shell command that runs against a directory literally named `{feature}` — a failure that surfaces far from its cause.

- [ ] **Step 2: Run it to confirm it fails**

Run: `cd packages/orchestrator && npx vitest run test/interpolate.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `interpolate.ts`**

```ts
export function interpolate(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\{(\w+)\}/g, (_m, name: string) => {
    if (!(name in vars)) {
      throw new Error(
        `unknown placeholder {${name}} — available: ${Object.keys(vars).join(", ") || "(none)"}`
      );
    }
    return vars[name];
  });
}
```

- [ ] **Step 4: Run it**

Run: `cd packages/orchestrator && npx vitest run test/interpolate.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the config test**

`packages/orchestrator/test/config.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { defineOrchestrator, validateConfig, resolveRuntime } from "../src/config.js";

const noopRunner = { run: async () => ({ exitCode: 0, status: "succeeded" as const, usage: null, stderrTail: "" }) };

const base = {
  workspace: "/tmp/ws",
  db: { driver: "pglite" as const, dir: "/tmp/ws/.orchestrator/pgdata" },
  runners: { claude_local: noopRunner },
  org: [{ key: "ba", name: "BA", model: "claude-sonnet-4-6" }],
  workflows: [{
    key: "requirements", label: "Requirements", assignee: "ba",
    steps: [
      { type: "exec" as const, cmd: "echo {project}" },
      { type: "agent" as const, phase: "generate" },
      { type: "attach" as const, files: ["outputs/product-summary.md"] },
      { type: "gate" as const, title: "Approve Requirements" },
    ],
  }],
};

describe("config", () => {
  it("accepts a valid config", () => {
    expect(validateConfig(defineOrchestrator(base))).toEqual([]);
  });

  it("rejects a workflow whose assignee is not in the org", () => {
    const bad = { ...base, workflows: [{ ...base.workflows[0], assignee: "ghost" }] };
    expect(validateConfig(bad as any)[0]).toMatch(/assignee 'ghost'/);
  });

  it("rejects an agent whose reportsTo is not in the org", () => {
    const bad = { ...base, org: [{ key: "ba", name: "BA", reportsTo: "nobody" }] };
    expect(validateConfig(bad as any)[0]).toMatch(/reportsTo 'nobody'/);
  });

  it("rejects a duplicate agent key", () => {
    const bad = { ...base, org: [{ key: "ba", name: "BA" }, { key: "ba", name: "BA2" }] };
    expect(validateConfig(bad as any)[0]).toMatch(/duplicate agent key 'ba'/);
  });

  it("rejects an unknown step type", () => {
    const bad = { ...base, workflows: [{ ...base.workflows[0], steps: [{ type: "nope" }] }] };
    expect(validateConfig(bad as any)[0]).toMatch(/unknown step type 'nope'/);
  });

  it("reports every problem at once, not just the first", () => {
    const bad = { ...base, org: [{ key: "ba", name: "BA" }, { key: "ba", name: "B2" }],
                  workflows: [{ ...base.workflows[0], assignee: "ghost" }] };
    expect(validateConfig(bad as any).length).toBeGreaterThan(1);
  });

  it("rejects an agent whose adapter is not registered, and names the alternatives", () => {
    const bad = { ...base, org: [{ key: "ba", name: "BA", adapter: "openai_local" }] };
    const p = validateConfig(bad as any)[0];
    expect(p).toMatch(/adapter 'openai_local'/);
    expect(p).toMatch(/available: claude_local/);
  });

  it("rejects an invalid effort level", () => {
    const bad = { ...base, org: [{ key: "ba", name: "BA", effort: "turbo" }] };
    expect(validateConfig(bad as any)[0]).toMatch(/effort 'turbo'/);
  });

  it("rejects a config with no runners registered", () => {
    const bad = { ...base, runners: {} };
    expect(validateConfig(bad as any)[0]).toMatch(/no runners registered/);
  });
});

describe("resolveRuntime", () => {
  const step = { type: "agent" as const, phase: "generate" };

  it("falls back to claude_local when nothing is specified", () => {
    expect(resolveRuntime(step, null, {})).toEqual({ adapter: "claude_local", model: undefined, effort: undefined });
  });

  it("prefers the agent over the defaults", () => {
    expect(resolveRuntime(step, { model: "opus", effort: "high" }, { model: "sonnet", effort: "low" }))
      .toMatchObject({ model: "opus", effort: "high" });
  });

  it("prefers the step over the agent", () => {
    expect(resolveRuntime({ ...step, model: "haiku", effort: "low" }, { model: "opus", effort: "max" }, {}))
      .toMatchObject({ model: "haiku", effort: "low" });
  });

  it("resolves each field independently", () => {
    // step sets only effort; model must still come from the agent
    expect(resolveRuntime({ ...step, effort: "low" }, { model: "opus" }, { model: "sonnet" }))
      .toMatchObject({ model: "opus", effort: "low" });
  });
});
```

- [ ] **Step 6: Run it to confirm it fails**

Run: `cd packages/orchestrator && npx vitest run test/config.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 7: Implement `config.ts`**

```ts
import type { DbOptions } from "./core/db.js";
import type { AgentSpec } from "./core/repo.js";

export type Step =
  | { type: "exec";   cmd: string; cwd?: string; timeoutMs?: number }
  | { type: "agent";  agent?: string; phase: string; skill?: string; prompt?: string;
                      adapter?: string; model?: string; effort?: Effort }
  | { type: "attach"; files: string[] }
  | { type: "gate";   title: string; summary?: string }
  | { type: "flow";   workflow: string; params?: Record<string, unknown> };

export const STEP_TYPES = ["exec", "agent", "attach", "gate", "flow"] as const;
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

export interface WorkflowDef {
  key: string;
  label: string;
  assignee: string;          // agent key
  steps: Step[];
}

export interface OrchestratorDefaults {
  adapter?: string;          // default "claude_local"
  model?: string;
  effort?: Effort;
}

export interface OrchestratorConfig {
  workspace: string;
  company?: string;          // default "Scyne"
  db: DbOptions;
  runners: Record<string, Runner>;   // the adapter registry
  defaults?: OrchestratorDefaults;
  theme?: Partial<Theme>;    // merged over SCYNE_THEME; see src/http/theme.ts
  org: AgentSpec[];
  workflows: WorkflowDef[];
}

export function defineOrchestrator(c: OrchestratorConfig): OrchestratorConfig {
  return {
    company: "Scyne",
    ...c,
    defaults: { adapter: "claude_local", ...c.defaults },
  };
}

/**
 * Resolve adapter / model / effort, most specific wins.
 *   step → agent → defaults → (the CLI's own default, i.e. undefined)
 */
export function resolveRuntime(
  step: Extract<Step, { type: "agent" }>,
  agent: { adapter?: string; model?: string; effort?: string } | null,
  defaults: OrchestratorDefaults = {},
): { adapter: string; model?: string; effort?: string } {
  return {
    adapter: step.adapter ?? agent?.adapter ?? defaults.adapter ?? "claude_local",
    model:   step.model   ?? agent?.model   ?? defaults.model,
    effort:  step.effort  ?? agent?.effort  ?? defaults.effort,
  };
}

export function validateConfig(c: OrchestratorConfig): string[] {
  const problems: string[] = [];
  const keys = new Set<string>();

  for (const a of c.org) {
    if (keys.has(a.key)) problems.push(`duplicate agent key '${a.key}'`);
    keys.add(a.key);
  }
  const runners = new Set(Object.keys(c.runners ?? {}));
  if (!runners.size) problems.push(`no runners registered — config.runners is empty`);

  for (const a of c.org) {
    if (a.reportsTo && !keys.has(a.reportsTo)) {
      problems.push(`agent '${a.key}' has reportsTo '${a.reportsTo}', which is not in the org`);
    }
    const adapter = a.adapter ?? c.defaults?.adapter ?? "claude_local";
    if (!runners.has(adapter)) {
      problems.push(
        `agent '${a.key}' uses adapter '${adapter}', which is not registered — ` +
        `available: ${[...runners].join(", ") || "(none)"}`);
    }
    if (a.effort && !EFFORTS.includes(a.effort)) {
      problems.push(`agent '${a.key}' has effort '${a.effort}' — must be one of ${EFFORTS.join(", ")}`);
    }
  }
  const wfKeys = new Set(c.workflows.map(w => w.key));
  for (const w of c.workflows) {
    if (!keys.has(w.assignee)) {
      problems.push(`workflow '${w.key}' has assignee '${w.assignee}', which is not in the org`);
    }
    if (!w.steps?.length) problems.push(`workflow '${w.key}' has no steps`);
    for (const [i, s] of (w.steps ?? []).entries()) {
      if (!STEP_TYPES.includes((s as any).type)) {
        problems.push(`workflow '${w.key}' step ${i}: unknown step type '${(s as any).type}'`);
        continue;
      }
      if (s.type === "agent") {
        if (s.agent && !keys.has(s.agent)) {
          problems.push(`workflow '${w.key}' step ${i}: agent '${s.agent}' is not in the org`);
        }
        if (s.adapter && !runners.has(s.adapter)) {
          problems.push(`workflow '${w.key}' step ${i}: adapter '${s.adapter}' is not registered`);
        }
        if (s.effort && !EFFORTS.includes(s.effort)) {
          problems.push(`workflow '${w.key}' step ${i}: effort '${s.effort}' — must be one of ${EFFORTS.join(", ")}`);
        }
      }
      if (s.type === "flow" && !wfKeys.has(s.workflow)) {
        problems.push(`workflow '${w.key}' step ${i}: flow '${s.workflow}' is not a known workflow`);
      }
      if (s.type === "attach" && !s.files?.length) {
        problems.push(`workflow '${w.key}' step ${i}: attach has no files`);
      }
    }
  }
  return problems;
}
```

- [ ] **Step 8: Run the tests**

Run: `cd packages/orchestrator && npx vitest run test/config.test.ts test/interpolate.test.ts`
Expected: all PASS.

- [ ] **Step 9: Checkpoint**

Report test output. Confirm the "report every problem at once" convention matches `scripts/validate-experience.mjs`, which this repo already does the same way.

---

## Task 4: Capture a real `result` event, then parse usage

> **This task closes spec open item #2 empirically.** Do not write the parser from
> memory of the field names — capture a real event first, commit the fixture, and
> parse against it. If the shape differs from what is written below, the fixture is
> right and this plan is wrong.

**Files:**
- Create: `packages/orchestrator/fixtures/result-event.jsonl`
- Create: `packages/orchestrator/src/core/usage.ts`
- Create: `packages/orchestrator/test/usage.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `interface RunUsage { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number; costUsd: number | null; durationMs: number | null; numTurns: number | null; sessionId: string | null }`
  - `extractUsage(streamJsonLines: string): RunUsage | null`

- [ ] **Step 1: Capture a real result event**

Run from the repo root:

```bash
mkdir -p packages/orchestrator/fixtures
claude -p "Reply with exactly the word: ok" \
  --output-format stream-json \
  --model claude-sonnet-4-6 \
  --permission-mode bypassPermissions \
  --no-session-persistence \
  2>/dev/null | tee packages/orchestrator/fixtures/raw-capture.jsonl \
  | grep '"type":"result"' > packages/orchestrator/fixtures/result-event.jsonl

cat packages/orchestrator/fixtures/result-event.jsonl | python3 -m json.tool
```

Record the exact keys printed. **Update Step 3's implementation to match what you actually see**, then delete `raw-capture.jsonl`.

- [ ] **Step 2: Write the failing test against the captured fixture**

`packages/orchestrator/test/usage.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { extractUsage } from "../src/core/usage.js";

const fixture = readFileSync(
  new URL("../fixtures/result-event.jsonl", import.meta.url), "utf8");

describe("extractUsage", () => {
  it("pulls token counts from a real captured result event", () => {
    const u = extractUsage(fixture);
    expect(u).not.toBeNull();
    expect(u!.inputTokens).toBeGreaterThan(0);
    expect(u!.outputTokens).toBeGreaterThan(0);
    expect(u!.sessionId).toBeTruthy();
  });

  it("returns null when there is no result event", () => {
    expect(extractUsage(`{"type":"assistant","message":{"content":[]}}\n`)).toBeNull();
  });

  it("survives a truncated final line", () => {
    expect(() => extractUsage(fixture + `{"type":"resu`)).not.toThrow();
  });

  it("takes the LAST result event when several are present", () => {
    const doubled = fixture + fixture.replace(/"output_tokens":\s*\d+/, '"output_tokens": 9999');
    expect(extractUsage(doubled)!.outputTokens).toBe(9999);
  });
});
```

- [ ] **Step 3: Run it to confirm it fails**

Run: `cd packages/orchestrator && npx vitest run test/usage.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement `usage.ts`**

```ts
export interface RunUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number | null;
  durationMs: number | null;
  numTurns: number | null;
  sessionId: string | null;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/**
 * Pull the aggregate usage from a stream-json transcript.
 *
 * The chatbot's runTranscript.ts skipped this event entirely
 * ("final aggregate, redundant with status") — which is why there has never been
 * any cost visibility. Field names are confirmed against fixtures/result-event.jsonl.
 */
export function extractUsage(streamJson: string): RunUsage | null {
  let last: any = null;
  for (const line of streamJson.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    let obj: any;
    try { obj = JSON.parse(t); } catch { continue; } // truncated final line
    if (obj?.type === "result") last = obj;
  }
  if (!last) return null;

  const u = last.usage ?? {};
  return {
    inputTokens:         num(u.input_tokens),
    outputTokens:        num(u.output_tokens),
    cacheReadTokens:     num(u.cache_read_input_tokens),
    cacheCreationTokens: num(u.cache_creation_input_tokens),
    costUsd:      typeof last.total_cost_usd === "number" ? last.total_cost_usd : null,
    durationMs:   typeof last.duration_ms    === "number" ? last.duration_ms    : null,
    numTurns:     typeof last.num_turns      === "number" ? last.num_turns      : null,
    sessionId:    typeof last.session_id     === "string" ? last.session_id     : null,
  };
}
```

- [ ] **Step 5: Run the tests**

Run: `cd packages/orchestrator && npx vitest run test/usage.test.ts`
Expected: all four PASS. If field names differ from the fixture, fix the implementation — not the fixture.

- [ ] **Step 6: Checkpoint**

Report the **actual captured keys** and the real token/cost numbers from the trivial run. This is the first real evidence of the budget story; it belongs in the review.

---

## Task 5: Port the transcript module

**Files:**
- Create: `packages/orchestrator/src/core/transcript.ts`
- Create: `packages/orchestrator/test/transcript.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `type TranscriptEvent` — the union from `scyne-chatbot/server/services/runTranscript.ts`
  - `filterRunLog(rawLog: string): { events: TranscriptEvent[]; consumed: number }`

- [ ] **Step 1: Copy the module**

Copy `scyne-chatbot/server/services/runTranscript.ts` to `packages/orchestrator/src/core/transcript.ts` **unchanged except for two edits**:

1. Change the `"framing"` line detector from `line.startsWith("[paperclip]")` to also accept `"[orchestrator]"`:
   ```ts
   if (line.startsWith("[paperclip]") || line.startsWith("[orchestrator]") ||
       line.startsWith("[event]") || line.startsWith("Status:") || line.startsWith("Run ")) {
   ```
   `[paperclip]` stays so logs captured during migration still parse.

2. Leave `if (type === "result") continue;` in place, but change the comment to:
   ```ts
   if (type === "result") continue; // usage is extracted separately by usage.ts
   ```

Do not otherwise refactor it. It works, and a rewrite would need its own test corpus.

- [ ] **Step 2: Write the test**

`packages/orchestrator/test/transcript.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { filterRunLog } from "../src/core/transcript.js";

const wrap = (inner: object) =>
  JSON.stringify({ ts: "2026-08-17T10:00:00Z", stream: "stdout", chunk: JSON.stringify(inner) + "\n" }) + "\n";

describe("filterRunLog", () => {
  it("emits assistant text", () => {
    const log = wrap({ type: "assistant", message: { content: [{ type: "text", text: "hello" }] } });
    const { events } = filterRunLog(log);
    expect(events).toEqual([{ ts: "10:00:00", kind: "assistant", text: "hello" }]);
  });

  it("emits skill invocations distinctly from tool calls", () => {
    const log = wrap({ type: "assistant", message: { content: [
      { type: "tool_use", name: "Skill", input: { skill: "requirement-generator" } },
      { type: "tool_use", name: "Bash",  input: { command: "ls" } },
    ] } });
    const { events } = filterRunLog(log);
    expect(events[0]).toMatchObject({ kind: "skill", name: "requirement-generator" });
    expect(events[1]).toMatchObject({ kind: "tool_use", tool: "Bash", preview: "ls" });
  });

  it("redacts secrets in both directions", () => {
    const log = wrap({ type: "assistant", message: { content: [
      { type: "text", text: "token ATATT3xFfABCDEFGHIJKLMNOP and key AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZ0123456" },
    ] } });
    const { events } = filterRunLog(log);
    expect((events[0] as any).text).not.toMatch(/ATATT3xFf[A-Za-z0-9]/);
    expect((events[0] as any).text).toContain("[ATLASSIAN_TOKEN]");
  });

  it("leaves a partial trailing line unconsumed for the next poll", () => {
    const log = wrap({ type: "assistant", message: { content: [{ type: "text", text: "a" }] } })
              + `{"ts":"2026-08-17T10:00:01Z","stream":"stdout","chunk":"{\\"type\\":\\"assi`;
    const { consumed } = filterRunLog(log);
    expect(consumed).toBeLessThan(log.length);
  });
});
```

- [ ] **Step 3: Run the tests**

Run: `cd packages/orchestrator && npx vitest run test/transcript.test.ts`
Expected: all four PASS. If any fail, the port introduced a change — diff against the chatbot original.

- [ ] **Step 4: Checkpoint**

Report test output. Note explicitly that the chatbot's copy is **not** deleted in this task — it stays until phase 3 switches the chatbot over.

---

## Task 6: The Claude Code runner

**Files:**
- Create: `packages/orchestrator/src/core/runner.ts`
- Create: `packages/orchestrator/test/runner.test.ts`

**Interfaces:**
- Consumes: `RunUsage`, `extractUsage` from Task 4
- Produces:
  - `interface RunRequest { agent: { key: string; bundlePath?: string; mcpEnabled?: boolean; extraArgs?: string[] }; model?: string; effort?: string; fallbackModel?: string[]; prompt: string; cwd: string; logPath: string; mcpConfigPath?: string; budget?: { maxTokens?: number; maxCostUsd?: number; maxDurationMs?: number } }`
    > `model` / `effort` / `fallbackModel` sit at the top level, not under `agent`, because the engine has **already resolved** them through step → agent → defaults. Leaving them on `agent` would imply the runner does the resolving.
  - `interface RunResult { exitCode: number; status: "succeeded"|"failed"|"over_budget"; usage: RunUsage | null; stderrTail: string }`
  - `interface Runner { run(req: RunRequest): Promise<RunResult> }`
  - `createClaudeRunner(opts?: { bin?: string }): Runner`
  - `buildArgs(req: RunRequest): string[]` — exported for testing without spawning

- [ ] **Step 1: Write the failing test**

`packages/orchestrator/test/runner.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildArgs, createClaudeRunner } from "../src/core/runner.js";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const base = {
  agent: { key: "ba", bundlePath: "/w/agent-instructions/ba.thin.md" },
  model: "claude-sonnet-4-6",
  prompt: "do the thing",
  cwd: "/w",
  logPath: "/tmp/run.jsonl",
};

describe("buildArgs", () => {
  it("builds the confirmed 2.1.232 headless invocation", () => {
    const a = buildArgs(base as any);
    expect(a).toContain("-p");
    expect(a).toEqual(expect.arrayContaining([
      "--output-format", "stream-json",
      "--model", "claude-sonnet-4-6",
      "--system-prompt-file", "/w/agent-instructions/ba.thin.md",
      "--permission-mode", "bypassPermissions",
      "--no-session-persistence",
      "--exclude-dynamic-system-prompt-sections",
    ]));
  });

  it("omits --mcp-config unless the agent publishes", () => {
    expect(buildArgs(base as any)).toContain("--strict-mcp-config");
    expect(buildArgs(base as any)).not.toContain("--mcp-config");
  });

  it("adds --mcp-config when mcpEnabled and a path is supplied", () => {
    const a = buildArgs({ ...base, agent: { ...base.agent, mcpEnabled: true }, mcpConfigPath: "/w/.mcp.json" } as any);
    expect(a).toEqual(expect.arrayContaining(["--mcp-config", "/w/.mcp.json"]));
  });

  it("never passes a --cwd flag (2.1.232 has none)", () => {
    expect(buildArgs(base as any).join(" ")).not.toContain("--cwd");
  });

  it("passes --effort when resolved", () => {
    expect(buildArgs({ ...base, effort: "xhigh" } as any))
      .toEqual(expect.arrayContaining(["--effort", "xhigh"]));
  });

  it("omits --effort when not set, deferring to the CLI default", () => {
    expect(buildArgs(base as any)).not.toContain("--effort");
  });

  it("joins fallback models with commas, in order", () => {
    const a = buildArgs({ ...base, fallbackModel: ["claude-sonnet-4-5-20250929", "claude-haiku-4-5-20251001"] } as any);
    expect(a).toEqual(expect.arrayContaining([
      "--fallback-model", "claude-sonnet-4-5-20250929,claude-haiku-4-5-20251001",
    ]));
  });
});

describe("createClaudeRunner", () => {
  it("runs a trivial prompt, writes a log, and captures usage", async () => {
    const dir = mkdtempSync(join(tmpdir(), "orch-run-"));
    const logPath = join(dir, "run.jsonl");
    const runner = createClaudeRunner();
    const res = await runner.run({
      agent: { key: "probe" },
      model: "claude-sonnet-4-6",
      effort: "low",
      prompt: "Reply with exactly the word: ok",
      cwd: dir,
      logPath,
    });
    expect(res.status).toBe("succeeded");
    expect(res.usage!.outputTokens).toBeGreaterThan(0);
    const log = readFileSync(logPath, "utf8");
    expect(log).toContain('"stream"');   // the {ts,stream,chunk} envelope
    rmSync(dir, { recursive: true, force: true });
  }, 120_000);
});
```

> The last test spawns a real Claude Code process. Tag it so it can be excluded in CI without a key: `describe.skipIf(!process.env.ORCH_E2E)`. Set `ORCH_E2E=1` when running locally.

- [ ] **Step 2: Run it to confirm it fails**

Run: `cd packages/orchestrator && npx vitest run test/runner.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `runner.ts`**

```ts
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { extractUsage, type RunUsage } from "./usage.js";

export interface RunRequest {
  agent: { key: string; bundlePath?: string; mcpEnabled?: boolean; extraArgs?: string[] };
  /** Already resolved by the engine through step → agent → defaults. */
  model?: string;
  effort?: string;
  fallbackModel?: string[];
  prompt: string;
  cwd: string;
  logPath: string;
  mcpConfigPath?: string;
  budget?: { maxTokens?: number; maxCostUsd?: number; maxDurationMs?: number };
}

export interface RunResult {
  exitCode: number;
  status: "succeeded" | "failed" | "over_budget";
  usage: RunUsage | null;
  stderrTail: string;
}

export interface Runner { run(req: RunRequest): Promise<RunResult>; }

/** Confirmed against Claude Code 2.1.232. There is no --cwd flag. */
export function buildArgs(req: RunRequest): string[] {
  const a = [
    "-p",
    "--output-format", "stream-json",
    "--permission-mode", "bypassPermissions",
    "--no-session-persistence",
    "--exclude-dynamic-system-prompt-sections",
    "--strict-mcp-config",
  ];
  if (req.model)                 a.push("--model", req.model);
  if (req.effort)                a.push("--effort", req.effort);
  if (req.fallbackModel?.length) a.push("--fallback-model", req.fallbackModel.join(","));
  if (req.agent.bundlePath)      a.push("--system-prompt-file", req.agent.bundlePath);
  if (req.agent.mcpEnabled && req.mcpConfigPath) a.push("--mcp-config", req.mcpConfigPath);
  if (req.agent.extraArgs?.length) a.push(...req.agent.extraArgs);
  return a;
}

export function createClaudeRunner(opts: { bin?: string } = {}): Runner {
  const bin = opts.bin ?? "claude";

  return {
    run(req) {
      return new Promise<RunResult>((resolve) => {
        void (async () => {
          await mkdir(dirname(req.logPath), { recursive: true });
          const logStream = createWriteStream(req.logPath, { flags: "a" });
          const started = Date.now();
          let captured = "";
          let stderr = "";
          let killedForBudget = false;

          const child = spawn(bin, buildArgs(req), {
            cwd: req.cwd,
            stdio: ["pipe", "pipe", "pipe"],
            env: process.env,
          });

          // Envelope each chunk as {ts, stream, chunk} — the same shape Paperclip
          // emits, so transcript.ts parses old and new logs identically.
          const tee = (stream: "stdout" | "stderr") => (buf: Buffer) => {
            const chunk = buf.toString("utf8");
            if (stream === "stdout") captured += chunk; else stderr += chunk;
            logStream.write(JSON.stringify({ ts: new Date().toISOString(), stream, chunk }) + "\n");
          };
          child.stdout.on("data", tee("stdout"));
          child.stderr.on("data", tee("stderr"));

          let timer: NodeJS.Timeout | undefined;
          if (req.budget?.maxDurationMs) {
            timer = setTimeout(() => { killedForBudget = true; child.kill("SIGTERM"); },
                               req.budget.maxDurationMs);
          }

          child.stdin.write(req.prompt);
          child.stdin.end();

          child.on("close", (code) => {
            if (timer) clearTimeout(timer);
            logStream.end();
            const usage = extractUsage(captured);

            let status: RunResult["status"] = code === 0 ? "succeeded" : "failed";
            if (killedForBudget) status = "over_budget";
            if (usage && req.budget) {
              const total = usage.inputTokens + usage.outputTokens;
              if (req.budget.maxTokens && total > req.budget.maxTokens) status = "over_budget";
              if (req.budget.maxCostUsd && (usage.costUsd ?? 0) > req.budget.maxCostUsd) status = "over_budget";
            }
            resolve({
              exitCode: code ?? -1,
              status,
              usage: usage ? { ...usage, durationMs: usage.durationMs ?? (Date.now() - started) } : null,
              stderrTail: stderr.slice(-4000),
            });
          });
        })();
      });
    },
  };
}
```

- [ ] **Step 4: Run the arg tests**

Run: `cd packages/orchestrator && npx vitest run test/runner.test.ts`
Expected: the four `buildArgs` tests PASS; the spawn test is skipped without `ORCH_E2E`.

- [ ] **Step 5: Run the real spawn test**

Run: `cd packages/orchestrator && ORCH_E2E=1 npx vitest run test/runner.test.ts`
Expected: PASS. **This is the first end-to-end proof that the orchestrator can drive Claude Code.**

- [ ] **Step 6: Checkpoint**

Report: the real token counts and cost from the spawn test, and the first three lines of the written log file. If `--system-prompt-file` is rejected, fall back to `--append-system-prompt-file` and record which one 2.1.232 accepts.

---

## Task 7: The engine

**Files:**
- Create: `packages/orchestrator/src/core/engine.ts`
- Create: `packages/orchestrator/test/engine.test.ts`

**Interfaces:**
- Consumes: `Repo` (Task 2), `Step`/`WorkflowDef`/`OrchestratorConfig` (Task 3), `Runner` (Task 6), `interpolate` (Task 3)
- Produces:
  - `createEngine(deps: { repo: Repo; config: OrchestratorConfig; exec?: ExecFn }): Engine`
    > The engine takes **no** runner. It resolves one per agent step from `config.runners[adapter]`. Tests inject a fake by registering it in `config.runners`, which means they exercise the real resolution path rather than bypassing it.
  - `interface Engine { start(workflowKey: string, params: Record<string,string>): Promise<IssueRow>; advance(issueId: string): Promise<void>; decideGate(gateId: string, status: "approved"|"rejected", note?: string, by?: string): Promise<void>; recoverOrphans(): Promise<void> }`
  - `type ExecFn = (cmd: string, cwd: string, timeoutMs?: number) => Promise<{ code: number; stdout: string; stderr: string }>`

- [ ] **Step 1: Write the failing test**

`packages/orchestrator/test/engine.test.ts`. The whole point is that this runs with **no Claude process and no shell** — both are injected.

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, migrate, type Db } from "../src/core/db.js";
import { createRepo } from "../src/core/repo.js";
import { createEngine } from "../src/core/engine.js";
import { defineOrchestrator } from "../src/config.js";

let dir: string, db: Db, repo: any, calls: string[];

const fakeRunner = { run: async () => { calls.push("run"); return {
  exitCode: 0, status: "succeeded" as const, stderrTail: "",
  usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 0, cacheCreationTokens: 0,
           costUsd: 0.01, durationMs: 100, numTurns: 1, sessionId: "s" } }; } };

const fakeExec = async (cmd: string) => { calls.push(`exec:${cmd}`); return { code: 0, stdout: "", stderr: "" }; };

function config(workspace: string, runner: any = fakeRunner) {
  return defineOrchestrator({
    workspace,
    db: { driver: "pglite", dir: join(workspace, "pg") },
    runners: { claude_local: runner },
    defaults: { adapter: "claude_local", model: "claude-sonnet-4-6", effort: "medium" },
    org: [{ key: "ba", name: "BA", model: "claude-sonnet-4-6" }],
    workflows: [{
      key: "requirements", label: "Requirements", assignee: "ba",
      steps: [
        { type: "exec",   cmd: "stage {project}" },
        { type: "agent",  phase: "generate" },
        { type: "attach", files: ["outputs/product-summary.md"] },
        { type: "gate",   title: "Approve Requirements" },
        { type: "agent",  phase: "publish" },
      ],
    }],
  });
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "orch-eng-"));
  db = await openDb({ driver: "pglite", dir: join(dir, "pg") });
  await migrate(db, new URL("../migrations", import.meta.url).pathname);
  repo = createRepo(db);
  calls = [];
});
afterEach(async () => { await db.close(); rmSync(dir, { recursive: true, force: true }); });

describe("engine", () => {
  it("runs exec then agent then attach, and stops at the gate", async () => {
    mkdirSync(join(dir, "outputs"), { recursive: true });
    writeFileSync(join(dir, "outputs/product-summary.md"), "# summary");

    const engine = createEngine({ repo, config: config(dir), exec: fakeExec });
    const issue = await engine.start("requirements", { project: "P", feature: "F" });
    await engine.advance(issue.id);

    expect(calls).toEqual(["exec:stage P", "run"]);
    const after = await repo.getIssue(issue.id);
    expect(after.status).toBe("in_review");          // parked at the gate
    expect((await repo.listWorkProducts(issue.id)).length).toBe(1);
    expect((await repo.listGates(issue.id))[0].status).toBe("pending");
  });

  it("resumes into the publish step when the gate is approved", async () => {
    mkdirSync(join(dir, "outputs"), { recursive: true });
    writeFileSync(join(dir, "outputs/product-summary.md"), "# summary");
    const engine = createEngine({ repo, config: config(dir), exec: fakeExec });
    const issue = await engine.start("requirements", { project: "P", feature: "F" });
    await engine.advance(issue.id);

    const gate = (await repo.listGates(issue.id))[0];
    await engine.decideGate(gate.id, "approved", "ok", "tagari");

    expect(calls.filter(c => c === "run").length).toBe(2);   // generate + publish
    expect((await repo.getIssue(issue.id)).status).toBe("done");
  });

  it("blocks when an exec step exits non-zero, and does not reach the agent", async () => {
    const failing = async () => ({ code: 1, stdout: "", stderr: "boom" });
    const engine = createEngine({ repo, config: config(dir), exec: failing });
    const issue = await engine.start("requirements", { project: "P", feature: "F" });
    await engine.advance(issue.id);

    expect(calls).toEqual([]);                                  // runner never called
    expect((await repo.getIssue(issue.id)).status).toBe("blocked");
    expect((await repo.listComments(issue.id))[0].body).toContain("boom");
  });

  it("blocks when a produces file is missing, naming it, and raises NO gate", async () => {
    const engine = createEngine({ repo, config: config(dir), exec: fakeExec });
    const issue = await engine.start("requirements", { project: "P", feature: "F" });
    await engine.advance(issue.id);

    const i = await repo.getIssue(issue.id);
    expect(i.status).toBe("blocked");
    expect((await repo.listComments(issue.id)).map((c: any) => c.body).join("\n"))
      .toContain("outputs/product-summary.md");
    expect((await repo.listGates(issue.id)).length).toBe(0);
  });

  it("rewinds to the generating step when a gate is rejected", async () => {
    mkdirSync(join(dir, "outputs"), { recursive: true });
    writeFileSync(join(dir, "outputs/product-summary.md"), "# summary");
    const engine = createEngine({ repo, config: config(dir), exec: fakeExec });
    const issue = await engine.start("requirements", { project: "P", feature: "F" });
    await engine.advance(issue.id);

    const gate = (await repo.listGates(issue.id))[0];
    await engine.decideGate(gate.id, "rejected", "wrong personas", "tagari");

    const i = await repo.getIssue(issue.id);
    expect(i.status).toBe("todo");
    expect(i.step_index).toBe(1);                   // back to the agent step
    expect((await repo.listComments(issue.id)).map((c: any) => c.body).join("\n"))
      .toContain("wrong personas");
  });

  it("records the run with its usage", async () => {
    mkdirSync(join(dir, "outputs"), { recursive: true });
    writeFileSync(join(dir, "outputs/product-summary.md"), "# summary");
    const engine = createEngine({ repo, config: config(dir), exec: fakeExec });
    const issue = await engine.start("requirements", { project: "P", feature: "F" });
    await engine.advance(issue.id);

    const runs = await repo.listRuns(issue.id);
    expect(runs.length).toBe(1);
    expect(Number(runs[0].output_tokens)).toBe(20);
    expect(Number(runs[0].cost_usd)).toBeCloseTo(0.01, 4);
  });

  it("passes the agent's budget to the runner and blocks on over_budget", async () => {
    const seen: any[] = [];
    const budgetRunner = { run: async (req: any) => {
      seen.push(req.budget);
      return { exitCode: 0, status: "over_budget" as const, stderrTail: "",
               usage: { inputTokens: 900_000, outputTokens: 1, cacheReadTokens: 0,
                        cacheCreationTokens: 0, costUsd: 99, durationMs: 1, numTurns: 1, sessionId: "s" } };
    } };
    const cfg = config(dir, budgetRunner);
    cfg.org[0].budget = { maxTokens: 400_000, maxCostUsd: 5 };
    const companyId = await repo.ensureCompany("Scyne");
    await repo.upsertAgent(companyId, cfg.org[0]);

    const engine = createEngine({ repo, config: cfg, exec: fakeExec });
    const issue = await engine.start("requirements", { project: "P", feature: "F" });
    await engine.advance(issue.id);

    expect(seen[0]).toMatchObject({ maxTokens: 400_000, maxCostUsd: 5 });
    expect((await repo.getIssue(issue.id)).status).toBe("blocked");
    expect((await repo.listRuns(issue.id))[0].status).toBe("over_budget");
  });

  it("resolves the runner from config.runners and passes the resolved model and effort", async () => {
    const seen: any[] = [];
    const spy = { run: async (req: any) => { seen.push(req); return {
      exitCode: 0, status: "succeeded" as const, stderrTail: "",
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0,
               costUsd: 0, durationMs: 1, numTurns: 1, sessionId: "s" } }; } };

    const cfg = config(dir, spy);
    // The step overrides the agent, which overrides the defaults.
    (cfg.workflows[0].steps[1] as any).effort = "xhigh";
    const companyId = await repo.ensureCompany("Scyne");
    await repo.upsertAgent(companyId, cfg.org[0]);

    mkdirSync(join(dir, "outputs"), { recursive: true });
    writeFileSync(join(dir, "outputs/product-summary.md"), "# summary");

    const engine = createEngine({ repo, config: cfg, exec: fakeExec });
    const issue = await engine.start("requirements", { project: "P", feature: "F" });
    await engine.advance(issue.id);

    expect(seen[0].model).toBe("claude-sonnet-4-6");  // from the agent
    expect(seen[0].effort).toBe("xhigh");             // from the step
  });

  it("blocks with a clear message when an agent's adapter is not registered", async () => {
    const cfg = config(dir);
    (cfg.workflows[0].steps[1] as any).adapter = "openai_local";
    const engine = createEngine({ repo, config: cfg, exec: fakeExec });
    const issue = await engine.start("requirements", { project: "P", feature: "F" });
    await engine.advance(issue.id);

    expect((await repo.getIssue(issue.id)).status).toBe("blocked");
    expect((await repo.listComments(issue.id))[0].body).toMatch(/adapter 'openai_local' is not registered/);
  });

  it("marks an orphaned run and returns the issue to todo", async () => {
    const engine = createEngine({ repo, config: config(dir), exec: fakeExec });
    const issue = await engine.start("requirements", { project: "P", feature: "F" });
    await repo.startRun({ issueId: issue.id, agentId: null, stepIndex: 1, phase: "generate", logPath: "/tmp/x" });
    await engine.recoverOrphans();
    const runs = await repo.listRuns(issue.id);
    expect(runs[0].status).toBe("orphaned");
    expect((await repo.getIssue(issue.id)).status).toBe("todo");
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `cd packages/orchestrator && npx vitest run test/engine.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `engine.ts`**

Core shape. `advance()` is re-entrant, guarded by a per-issue in-memory lock, and returns after any step that must wait for something external.

```ts
import { exec as nodeExec } from "node:child_process";
import { access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { interpolate } from "./interpolate.js";
import { resolveRuntime } from "../config.js";
import type { OrchestratorConfig, Step, WorkflowDef } from "../config.js";
import type { Runner } from "./runner.js";

export type ExecFn = (cmd: string, cwd: string, timeoutMs?: number)
  => Promise<{ code: number; stdout: string; stderr: string }>;

const defaultExec: ExecFn = (cmd, cwd, timeoutMs = 20 * 60_000) =>
  new Promise((res) => {
    nodeExec(cmd, { cwd, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout, stderr) => res({ code: err ? ((err as any).code ?? 1) : 0, stdout, stderr }));
  });

export function createEngine(deps: {
  repo: any; config: OrchestratorConfig; exec?: ExecFn;
}) {
  const { repo, config } = deps;
  const exec = deps.exec ?? defaultExec;
  const locks = new Set<string>();

  const workflow = (key: string): WorkflowDef => {
    const w = config.workflows.find(w => w.key === key);
    if (!w) throw new Error(`unknown workflow '${key}'`);
    return w;
  };

  async function block(issueId: string, message: string) {
    await repo.addComment(issueId, message, { user: "orchestrator" });
    await repo.updateIssue(issueId, { status: "blocked" });
  }

  async function advance(issueId: string): Promise<void> {
    if (locks.has(issueId)) return;
    locks.add(issueId);
    try {
      for (;;) {
        const issue = await repo.getIssue(issueId);
        if (!issue || issue.status === "blocked" || issue.status === "done") return;

        const wf = workflow(issue.workflow_key);
        const step = wf.steps[issue.step_index];
        if (!step) { await repo.updateIssue(issueId, { status: "done" }); return; }

        const vars = {
          ...(issue.params as Record<string, string>),
          workspace: config.workspace,
          issueId,
        };

        const outcome = await runStep(step, issue, wf, vars);
        if (outcome === "blocked" || outcome === "wait") return;

        await repo.updateIssue(issueId, { step_index: issue.step_index + 1, status: "in_progress" });
      }
    } finally {
      locks.delete(issueId);
    }
  }

  async function runStep(step: Step, issue: any, wf: WorkflowDef, vars: Record<string,string>)
    : Promise<"next" | "wait" | "blocked"> {
    switch (step.type) {
      case "exec": {
        const cmd = interpolate(step.cmd, vars);
        const r = await exec(cmd, step.cwd ?? config.workspace, step.timeoutMs);
        if (r.code !== 0) {
          await block(issue.id, `Step \`${cmd}\` failed (exit ${r.code}).\n\n\`\`\`\n${r.stderr.slice(-2000)}\n\`\`\``);
          return "blocked";
        }
        return "next";
      }

      case "agent": {
        const agentKey = step.agent ?? wf.assignee;
        const agent = await repo.getAgentByKey(issue.company_id, agentKey);

        // Resolve adapter / model / effort: step → agent → defaults.
        const rt = resolveRuntime(step, agent, config.defaults);
        const runner = config.runners?.[rt.adapter];
        if (!runner) {
          await block(issue.id,
            `Agent \`${agentKey}\`: adapter '${rt.adapter}' is not registered. ` +
            `Available: ${Object.keys(config.runners ?? {}).join(", ") || "(none)"}.`);
          return "blocked";
        }

        const logPath = join(config.workspace, ".orchestrator", "runs", `${issue.id}-${issue.step_index}.jsonl`);
        const run = await repo.startRun({
          issueId: issue.id, agentId: agent?.id ?? null,
          stepIndex: issue.step_index, phase: step.phase, logPath,
        });
        // Budget: the workflow's limit wins over the agent's when both exist.
        const agentBudget = await repo.getBudget(issue.company_id, "agent", agentKey);
        const wfBudget    = await repo.getBudget(issue.company_id, "workflow", wf.key);
        const b = wfBudget ?? agentBudget;
        const budget = b ? {
          maxTokens:     b.max_tokens      ? Number(b.max_tokens)      : undefined,
          maxCostUsd:    b.max_cost_usd    ? Number(b.max_cost_usd)    : undefined,
          maxDurationMs: b.max_duration_ms ? Number(b.max_duration_ms) : undefined,
        } : undefined;

        const res = await runner.run({
          agent: {
            key: agentKey,
            bundlePath: agent?.bundle_path ? resolve(config.workspace, agent.bundle_path) : undefined,
            mcpEnabled: agent?.mcp_enabled ?? false,
            extraArgs: agent?.extra_args ?? [],
          },
          model: rt.model,
          effort: rt.effort,
          fallbackModel: agent?.fallback_model ?? [],
          prompt: buildPrompt(step, wf, vars),
          cwd: config.workspace,
          logPath,
          budget,
          mcpConfigPath: join(config.workspace, ".mcp.json"),
        });
        await repo.finishRun(run.id, {
          status: res.status, exitCode: res.exitCode, sessionId: res.usage?.sessionId ?? null,
          inputTokens: res.usage?.inputTokens ?? null, outputTokens: res.usage?.outputTokens ?? null,
          cacheReadTokens: res.usage?.cacheReadTokens ?? null,
          cacheCreationTokens: res.usage?.cacheCreationTokens ?? null,
          costUsd: res.usage?.costUsd ?? null, durationMs: res.usage?.durationMs ?? null,
          numTurns: res.usage?.numTurns ?? null,
        });
        if (res.status !== "succeeded") {
          await block(issue.id, `Agent \`${agentKey}\` ${res.status} (exit ${res.exitCode}).\n\n\`\`\`\n${res.stderrTail}\n\`\`\``);
          return "blocked";
        }
        return "next";
      }

      case "attach": {
        const missing: string[] = [];
        for (const f of step.files) {
          const abs = resolve(config.workspace, interpolate(f, vars));
          try { await access(abs); } catch { missing.push(f); }
        }
        if (missing.length) {
          await block(issue.id, `Expected output not produced:\n${missing.map(m => `- \`${m}\``).join("\n")}`);
          return "blocked";
        }
        for (const f of step.files) {
          const abs = resolve(config.workspace, interpolate(f, vars));
          await repo.attachWorkProduct(issue.id, {
            type: "document", provider: "local",
            title: abs.split("/").pop()!, url: pathToFileURL(abs).href,
          });
        }
        return "next";
      }

      case "gate": {
        await repo.createGate(issue.id, {
          title: interpolate(step.title, vars),
          summary: step.summary ? interpolate(step.summary, vars) : "",
        });
        await repo.updateIssue(issue.id, { status: "in_review" });
        return "wait";
      }

      case "flow": {
        // Child issue; the parent resumes when the child completes.
        await repo.createIssue({
          companyId: issue.company_id, parentId: issue.id,
          title: `${step.workflow} — ${vars.project ?? ""}`,
          workflowKey: step.workflow,
          params: { ...issue.params, ...(step.params ?? {}) },
        });
        return "wait";
      }
    }
  }

  function buildPrompt(step: Extract<Step, { type: "agent" }>, wf: WorkflowDef, vars: Record<string,string>): string {
    if (step.prompt) return interpolate(step.prompt, vars);
    return [
      `Run PHASE ${step.phase} for workflow \`${wf.key}\`.`,
      ...Object.entries(vars).filter(([k]) => k !== "workspace" && k !== "issueId")
              .map(([k, v]) => `  ${k}: ${v}`),
      step.skill ? `  Invoke skill: ${step.skill}` : "",
      ``,
      `Do not call any API. Do not change issue status. Exit when your files are written.`,
    ].filter(Boolean).join("\n");
  }

  return {
    async start(workflowKey: string, params: Record<string, string>) {
      const wf = workflow(workflowKey);
      const companyId = await repo.ensureCompany(config.company ?? "Scyne");
      const agent = await repo.getAgentByKey(companyId, wf.assignee);
      return repo.createIssue({
        companyId, title: `${wf.label} — ${params.project ?? ""}`.trim(),
        workflowKey, params, assigneeAgentId: agent?.id ?? null, status: "todo",
      });
    },

    advance,

    async decideGate(gateId: string, status: "approved" | "rejected", note?: string, by?: string) {
      const gate = await repo.getGate(gateId);
      if (!gate) throw new Error(`unknown gate ${gateId}`);
      await repo.decideGate(gateId, status, note ?? null, by ?? null);
      if (note) await repo.addComment(gate.issue_id, `**${status === "approved" ? "Approved" : "Rejected"}:** ${note}`, { user: by ?? "reviewer" });

      if (status === "rejected") {
        const issue = await repo.getIssue(gate.issue_id);
        const wf = workflow(issue.workflow_key);
        // Rewind to the last agent step before the gate.
        let i = issue.step_index;
        while (i > 0 && wf.steps[i]?.type !== "agent") i--;
        await repo.updateIssue(gate.issue_id, { step_index: i, status: "todo" });
        return;
      }
      const issue = await repo.getIssue(gate.issue_id);
      await repo.updateIssue(gate.issue_id, { step_index: issue.step_index + 1, status: "in_progress" });
      await advance(gate.issue_id);
    },

    async recoverOrphans() {
      const stale = await repo.listUnfinishedRuns();
      for (const r of stale) {
        await repo.finishRun(r.id, { status: "orphaned", exitCode: null });
        await repo.updateIssue(r.issue_id, { status: "todo" });
      }
    },
  };
}
```

> `listUnfinishedRuns()` must be added to `repo.ts` in this task: `select * from runs where finished_at is null`.

- [ ] **Step 4: Run the tests**

Run: `cd packages/orchestrator && npx vitest run test/engine.test.ts`
Expected: all ten PASS, in under a second — no Claude process, no shell.

- [ ] **Step 5: Checkpoint**

Report test output and timing. The speed is the point: the entire state machine is testable without spending a token.

---

## Task 8: The CLI

**Files:**
- Create: `packages/orchestrator/src/cli.ts`
- Create: `packages/orchestrator/src/index.ts`
- Modify: root `package.json` — add `"orch": "node --experimental-strip-types packages/orchestrator/src/cli.ts"`

**Interfaces:**
- Consumes: everything from Tasks 1–7
- Produces:
  - `createOrchestrator(config): Promise<{ repo, engine, db, close() }>` from `src/index.ts`
  - CLI verbs: `seed`, `run <workflow>`, `status <issueId>`, `gate list|approve|reject`, `runs <issueId>`, `log <runId>`, `serve`

- [ ] **Step 1: Write `src/index.ts`**

```ts
export { defineOrchestrator, validateConfig, type Step, type WorkflowDef, type OrchestratorConfig } from "./config.js";
export { openDb, migrate, type Db, type DbOptions } from "./core/db.js";
export { createRepo, type AgentSpec, type IssueRow, type RunRow, type GateRow } from "./core/repo.js";
export { createEngine, type ExecFn } from "./core/engine.js";
export { createClaudeRunner, buildArgs, type Runner, type RunRequest, type RunResult } from "./core/runner.js";
export { extractUsage, type RunUsage } from "./core/usage.js";
export { filterRunLog, type TranscriptEvent } from "./core/transcript.js";
export { createRouter } from "./http/router.js";

import { openDb, migrate } from "./core/db.js";
import { createRepo } from "./core/repo.js";
import { createEngine } from "./core/engine.js";
import { createClaudeRunner } from "./core/runner.js";
import { validateConfig, type OrchestratorConfig } from "./config.js";

export async function createOrchestrator(config: OrchestratorConfig) {
  const problems = validateConfig(config);
  if (problems.length) {
    throw new Error(`orchestrator config is invalid:\n${problems.map(p => `  - ${p}`).join("\n")}`);
  }
  const db = await openDb(config.db);
  await migrate(db, new URL("../migrations", import.meta.url).pathname);
  const repo = createRepo(db);

  // Reconcile the database to the config file. The file is the source of truth.
  const companyId = await repo.ensureCompany(config.company ?? "Scyne");
  for (const a of config.org) await repo.upsertAgent(companyId, a);

  // No runner is passed — the engine resolves one per step from config.runners.
  const engine = createEngine({ repo, config });
  await engine.recoverOrphans();
  return { db, repo, engine, companyId, config, close: () => db.close() };
}
```

- [ ] **Step 2: Write the CLI**

`packages/orchestrator/src/cli.ts` — a plain `process.argv` parser, no dependency.

```ts
#!/usr/bin/env node
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { createOrchestrator } from "./index.js";
import { filterRunLog } from "./core/transcript.js";

const [verb, ...rest] = process.argv.slice(2);

function flag(name: string): string | undefined {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
}

async function loadConfig() {
  const path = flag("config") ?? resolve(process.cwd(), "orchestrator.config.ts");
  const mod = await import(path);
  return mod.default;
}

const usage = `
scyne-orchestrator <verb>

  seed                             reconcile the database to orchestrator.config.ts
  run <workflow> --project P [--feature F]
  status <issueId>
  gate list [--issue ID] | approve <gateId> [--note "…"] | reject <gateId> [--note "…"]
  runs <issueId>
  log <runId> [--raw]
  serve [--port 3100]
`;

const main = async () => {
  if (!verb || verb === "help") { console.log(usage); return; }
  const orch = await createOrchestrator(await loadConfig());
  try {
    switch (verb) {
      case "seed": {
        const agents = await orch.repo.listAgents(orch.companyId);
        console.log(`✓ ${agents.length} agents reconciled`);
        break;
      }
      case "run": {
        const workflow = rest[0];
        const params: Record<string,string> = {};
        for (const k of ["project", "feature"]) { const v = flag(k); if (v) params[k] = v; }
        const issue = await orch.engine.start(workflow, params);
        console.log(`▶ ${issue.identifier}  ${issue.title}`);
        await orch.engine.advance(issue.id);
        const after = await orch.repo.getIssue(issue.id);
        console.log(`● ${after.status}  (step ${after.step_index})`);
        if (after.status === "in_review") {
          const g = (await orch.repo.listGates(issue.id)).find((x: any) => x.status === "pending");
          console.log(`\n⏸  Awaiting approval — gate ${g.id}\n   ${g.payload.title}`);
          console.log(`\n   scyne-orchestrator gate approve ${g.id}`);
        }
        break;
      }
      // status | gate | runs | log | serve — implement each following the same shape.
      default: console.log(usage);
    }
  } finally { await orch.close(); }
};

main().catch((e) => { console.error(`✗ ${e.message}`); process.exit(1); });
```

Implement the remaining verbs:
- `status <issueId>` — print issue, step index, comments, work products, gates.
- `gate list` — pending gates; `gate approve|reject <id>` — call `engine.decideGate`, then print the resulting status.
- `runs <issueId>` — one line per run: agent, phase, status, duration, tokens, cost.
- `log <runId>` — `--raw` prints the file verbatim; without it, `filterRunLog` output formatted one event per line.
- `serve --port` — mount the Task 9 router on a bare Express app.

- [ ] **Step 3: Add the root script**

In the root `package.json` `scripts`, add:

```json
"orch": "node --experimental-strip-types packages/orchestrator/src/cli.ts"
```

- [ ] **Step 4: Verify the CLI loads**

Run: `npm run orch -- help`
Expected: usage text, exit 0.

- [ ] **Step 5: Checkpoint**

Report the usage output. Note whether `--experimental-strip-types` works on Node 24 for this file set; if not, fall back to `tsx packages/orchestrator/src/cli.ts` and record the change.

---

## Task 9: HTTP router and OpenAPI docs

**Files:**
- Create: `packages/orchestrator/openapi.yaml`
- Create: `packages/orchestrator/src/http/theme.ts`
- Create: `packages/orchestrator/src/http/router.ts`
- Create: `packages/orchestrator/src/http/docs.ts`
- Create: `packages/orchestrator/test/router.test.ts`
- Create: `packages/orchestrator/test/openapi.test.ts`
- Create: `packages/orchestrator/test/theme.test.ts`

**Interfaces:**
- Consumes: `createOrchestrator` (Task 8)
- Produces:
  - `createRouter(orch: Awaited<ReturnType<typeof createOrchestrator>>): express.Router`
  - `ROUTES: Array<{ method: string; path: string }>` — exported for the drift test

- [ ] **Step 1: Write the theme module**

`packages/orchestrator/src/http/theme.ts`. Scyne is the default; the consumer
overrides by naming only the tokens it wants changed.

```ts
export interface Theme {
  brand: string; brandDeep: string; line: string; accent: string;
  ink50: string; ink100: string; ink200: string; ink500: string; glow: string;
  success: string; warning: string; danger: string; info: string;
  fontFamily: string; logoText: string;
}

/**
 * The Scyne palette, taken from scyne-chatbot/tailwind.config.js — the curated
 * set, not a fresh extraction. `scripts/extract-brand.mjs` against
 * https://www.scyne.com.au/ on 2026-08-17 independently confirmed `brand`
 * (#464e7e, by CSS frequency). Its accent pick (#220054) was a gradient stop and
 * is deliberately not used.
 */
export const SCYNE_THEME: Theme = {
  brand:      "#464E7E",
  brandDeep:  "#363C63",
  line:       "#E7E9F0",
  accent:     "#C8A878",
  ink50:      "#EEF0F7",
  ink100:     "#D9DDEB",
  ink200:     "#B6BDD6",
  ink500:     "#5C6593",
  glow:       "#7C82C8",
  success:    "#10B981",
  warning:    "#F59E0B",
  danger:     "#F43F5E",
  info:       "#3B82F6",
  fontFamily: 'Arial, "Helvetica Neue", Helvetica, sans-serif',
  logoText:   "Scyne Orchestrator",
};

export function resolveTheme(override: Partial<Theme> = {}): Theme {
  return { ...SCYNE_THEME, ...override };
}

const kebab = (k: string) => k.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);

/**
 * Tokens on bare `:root`, then redefined for dark. Defining both explicitly
 * matters: scripts/audit-a11y.mjs records that headless Chrome defaults to dark
 * and that a palette can pass one state while failing the other.
 */
export function themeCss(t: Theme): string {
  const vars = Object.entries(t)
    .filter(([k]) => k !== "logoText")
    .map(([k, v]) => `  --${kebab(k)}: ${v};`).join("\n");
  return `:root {
${vars}
  --bg: #ffffff;
  --fg: #1a1c2b;
  --surface: #f7f8fc;
  --border: var(--line);
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #14161f;
    --fg: #e9eaf2;
    --surface: #1c1f2c;
    --border: #2b2f42;
    --brand: ${t.glow};
    --line: #2b2f42;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--fg);
  font-family: ${t.fontFamily};
}`;
}
```

> No web fonts, no CDN, no external stylesheet. Same constraint as
> `render-companion-app.mjs` — the page must make zero network requests.

- [ ] **Step 2: Write the theme test**

`packages/orchestrator/test/theme.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { SCYNE_THEME, resolveTheme, themeCss } from "../src/http/theme.js";

describe("theme", () => {
  it("defaults to the Scyne palette", () => {
    expect(resolveTheme().brand).toBe("#464E7E");
    expect(resolveTheme().logoText).toBe("Scyne Orchestrator");
  });

  it("merges a partial override without dropping the rest", () => {
    const t = resolveTheme({ brand: "#1f4c71", logoText: "Acme Delivery" });
    expect(t.brand).toBe("#1f4c71");
    expect(t.logoText).toBe("Acme Delivery");
    expect(t.accent).toBe(SCYNE_THEME.accent);   // untouched
    expect(t.fontFamily).toBe(SCYNE_THEME.fontFamily);
  });

  it("emits kebab-case custom properties for every colour token", () => {
    const css = themeCss(resolveTheme());
    expect(css).toContain("--brand: #464E7E;");
    expect(css).toContain("--brand-deep: #363C63;");
    expect(css).toContain("--ink-500: #5C6593;");
    expect(css).not.toContain("--logo-text");   // not a colour
  });

  it("defines both light and dark explicitly", () => {
    const css = themeCss(resolveTheme());
    expect(css).toContain("prefers-color-scheme: dark");
    expect(css.match(/--bg:/g)?.length).toBe(2);   // light and dark
  });

  it("references no external resource", () => {
    const css = themeCss(resolveTheme());
    expect(css).not.toMatch(/@import|https?:\/\/|url\(/);
  });
});
```

- [ ] **Step 3: Run the theme tests**

Run: `cd packages/orchestrator && npx vitest run test/theme.test.ts`
Expected: all five PASS.

- [ ] **Step 4: Write `openapi.yaml`**

OpenAPI 3.1 covering exactly the spec §13 surface. Every path gets `summary`, `parameters`, request/response schemas and at least one example. Components: `Agent`, `Issue`, `Comment`, `WorkProduct`, `Gate`, `Run`, `Usage`, `Error`.

```yaml
openapi: 3.1.0
info:
  title: Scyne Orchestrator
  version: 0.1.0
  description: |
    Local orchestration for Claude Code agents. Workflows are declared as data;
    the engine executes them deterministically. No authentication — the service
    binds to loopback only.
servers:
  - url: http://127.0.0.1:3100
paths:
  /health:
    get:
      summary: Liveness and dependency check
      responses:
        "200":
          description: OK
          content:
            application/json:
              schema:
                type: object
                required: [ok, db, claude]
                properties:
                  ok:     { type: boolean }
                  db:     { type: string, example: "pglite 0.2.17 / PostgreSQL 16.4" }
                  claude: { type: string, example: "2.1.232" }
  # …every remaining path from spec §13
```

- [ ] **Step 5: Write the drift test**

`packages/orchestrator/test/openapi.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { ROUTES } from "../src/http/router.js";

const spec = parse(readFileSync(new URL("../openapi.yaml", import.meta.url), "utf8"));

const declared = new Set<string>(
  Object.entries(spec.paths).flatMap(([p, ops]: [string, any]) =>
    Object.keys(ops).map(m => `${m.toUpperCase()} ${p}`)));

const implemented = new Set(ROUTES.map(r => `${r.method} ${r.path}`));

describe("openapi contract", () => {
  it("documents every implemented route", () => {
    const undocumented = [...implemented].filter(r => !declared.has(r));
    expect(undocumented, `undocumented routes: ${undocumented.join(", ")}`).toEqual([]);
  });

  it("implements every documented route", () => {
    const unimplemented = [...declared].filter(r => !implemented.has(r));
    expect(unimplemented, `documented but missing: ${unimplemented.join(", ")}`).toEqual([]);
  });

  it("gives every operation a summary and at least one response", () => {
    for (const [p, ops] of Object.entries<any>(spec.paths)) {
      for (const [m, op] of Object.entries<any>(ops)) {
        expect(op.summary, `${m.toUpperCase()} ${p} has no summary`).toBeTruthy();
        expect(Object.keys(op.responses ?? {}).length, `${m.toUpperCase()} ${p} has no responses`).toBeGreaterThan(0);
      }
    }
  });
});
```

> This is the guard that keeps the documentation honest. Adding a route without documenting it fails the build.

- [ ] **Step 6: Run it to confirm it fails**

Run: `cd packages/orchestrator && npx vitest run test/openapi.test.ts`
Expected: FAIL — router module not found.

- [ ] **Step 7: Implement the router**

```ts
import { Router, type Request, type Response } from "express";
import { readFileSync } from "node:fs";
import { filterRunLog } from "../core/transcript.js";
import { docsHandler, openapiHandler } from "./docs.js";

export const ROUTES = [
  { method: "GET",  path: "/health" },
  { method: "GET",  path: "/agents" },
  { method: "GET",  path: "/agents/{key}" },
  { method: "PATCH",path: "/agents/{key}" },   // adapter · model · effort · fallbackModel · budget
  { method: "GET",  path: "/agents/{key}/runs" },
  { method: "GET",  path: "/runners" },        // registered adapters
  { method: "POST", path: "/issues" },
  { method: "GET",  path: "/issues" },
  { method: "GET",  path: "/issues/{id}" },
  { method: "PATCH",path: "/issues/{id}" },
  { method: "GET",  path: "/issues/{id}/comments" },
  { method: "POST", path: "/issues/{id}/comments" },
  { method: "GET",  path: "/issues/{id}/work-products" },
  { method: "GET",  path: "/issues/{id}/gates" },
  { method: "POST", path: "/gates/{id}/approve" },
  { method: "POST", path: "/gates/{id}/reject" },
  { method: "GET",  path: "/issues/{id}/runs" },
  { method: "GET",  path: "/runs/{id}" },
  { method: "GET",  path: "/runs/{id}/log" },
  { method: "GET",  path: "/runs/{id}/transcript" },
  { method: "GET",  path: "/usage" },
  { method: "GET",  path: "/config" },
  { method: "GET",  path: "/openapi.json" },
  { method: "GET",  path: "/docs" },
] as const;

export function createRouter(orch: any): Router {
  const r = Router();
  const ok = (res: Response, body: unknown) => res.json(body);
  const wrap = (fn: (req: Request, res: Response) => Promise<void>) =>
    (req: Request, res: Response) =>
      fn(req, res).catch((e) => res.status(500).json({ error: e.message }));

  r.get("/health", wrap(async (_req, res) => {
    const v = await orch.db.query(`select version()`);
    ok(res, { ok: true, db: v.rows[0].version, claude: process.env.CLAUDE_VERSION ?? "unknown" });
  }));

  r.post("/issues", wrap(async (req, res) => {
    const { workflow, params } = req.body ?? {};
    const issue = await orch.engine.start(workflow, params ?? {});
    void orch.engine.advance(issue.id);           // fire and forget; poll for progress
    res.status(201).json(issue);
  }));

  r.post("/gates/:id/approve", wrap(async (req, res) => {
    await orch.engine.decideGate(req.params.id, "approved", req.body?.note, req.body?.by);
    ok(res, { ok: true });
  }));

  r.get("/runs/:id/log", wrap(async (req, res) => {
    const run = await orch.repo.getRun(req.params.id);
    const offset = Number(req.query.offset ?? 0);
    const raw = readFileSync(run.log_path, "utf8");
    ok(res, { content: raw.slice(offset), nextOffset: raw.length });
  }));

  r.get("/runs/:id/transcript", wrap(async (req, res) => {
    const run = await orch.repo.getRun(req.params.id);
    const offset = Number(req.query.offset ?? 0);
    const raw = readFileSync(run.log_path, "utf8").slice(offset);
    const { events, consumed } = filterRunLog(raw);
    ok(res, { events, nextOffset: offset + consumed });
  }));

  r.get("/openapi.json", openapiHandler);
  r.get("/docs", docsHandler);

  // …implement the remaining routes listed in ROUTES
  return r;
}
```

`docs.ts` reads `openapi.yaml`, converts to JSON for `/openapi.json`, and serves an **inlined** reference page for `/docs` — no CDN script tags. A minimal hand-rolled renderer that walks `paths` and prints method, path, summary, parameters and response schemas is sufficient and keeps the zero-network rule.

It is themed from Task 9 Step 1:

```ts
import { resolveTheme, themeCss } from "./theme.js";

export function docsHandler(req: Request, res: Response) {
  const t = resolveTheme(orch.config.theme);
  res.type("html").send(`<!doctype html>
<html lang="en-AU"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${t.logoText} — API</title>
<style>${themeCss(t)}${DOCS_CSS}</style>
</head><body>
  <header><span class="wordmark">${t.logoText}</span><span class="ver">v${spec.info.version}</span></header>
  ${renderPaths(spec)}
</body></html>`);
}
```

`DOCS_CSS` styles the layout using only the custom properties `themeCss` defines
— `var(--brand)`, `var(--surface)`, `var(--border)` — so a consumer's theme
override repaints the page without touching this file.

- [ ] **Step 8: Write the router test**

`packages/orchestrator/test/router.test.ts` — boot an Express app with the router over a temp PGlite database and a fake runner; assert `/health` returns 200 with a Postgres version, `POST /issues` returns 201 with an identifier, and `GET /issues/:id` round-trips.

- [ ] **Step 9: Run all tests**

Run: `cd packages/orchestrator && npx vitest run`
Expected: every suite PASSES, including both openapi drift tests.

- [ ] **Step 10: Verify the docs page renders**

Run: `npm run orch -- serve --port 3100` then in another shell:
`curl -s localhost:3100/openapi.json | head -20` and open `http://127.0.0.1:3100/docs`.

Expected:
- Valid JSON from `/openapi.json`.
- The page renders every endpoint, headed **Scyne Orchestrator** in `#464E7E`.
- **Zero network requests** — check the browser Network tab; anything beyond the
  document itself is a bug.
- Toggling the OS between light and dark repaints it legibly in both.

Then confirm the override path works without editing library code:

```bash
curl -s localhost:3100/docs | grep -o '\-\-brand: #[0-9A-Fa-f]\{6\}'
# → --brand: #464E7E
```
Add `theme: { brand: "#1f4c71", logoText: "Acme Delivery" }` to
`orchestrator.config.ts`, restart, and re-run the grep — it must report
`#1f4c71` and the header must read *Acme Delivery*. Revert afterwards.

- [ ] **Step 11: Checkpoint**

Report: the route count, both drift tests passing, and a screenshot or description of `/docs`.

---

## Task 10: The consumer config and the thin BA bundle

**Files:**
- Create: `orchestrator.config.ts` (repo root)
- Create: `agent-instructions/ba.thin.md`

**Interfaces:**
- Consumes: `defineOrchestrator` (Task 3), `STAGES` from `scripts/pipeline.mjs`
- Produces: a default-exported `OrchestratorConfig` the CLI loads

- [ ] **Step 1: Write `orchestrator.config.ts`**

```ts
import { defineOrchestrator, createClaudeRunner } from "./packages/orchestrator/src/index.js";
import { STAGES } from "./scripts/pipeline.mjs";

const ORG = [
  { key: "ceo",          name: "CEO",            title: "Chief Executive", icon: "crown" },
  { key: "pm",           name: "Delivery Lead",  title: "Delivery Lead",   icon: "rocket",       reportsTo: "ceo" },
  { key: "businessLead", name: "Business Lead",  title: "Business Lead",   icon: "lightbulb",    reportsTo: "pm" },
  { key: "archLead",     name: "Architecture Lead", title: "Architecture Lead", icon: "circuit-board", reportsTo: "pm" },
  { key: "ba",           name: "BA",             title: "BA",              icon: "search",
    reportsTo: "businessLead",
    adapter: "claude_local",
    model: "claude-sonnet-4-6",
    // If Sonnet 4.6 is overloaded mid-run the pipeline should degrade, not stop.
    fallbackModel: ["claude-sonnet-4-5-20250929"],
    bundlePath: "agent-instructions/ba.thin.md", mcpEnabled: true,
    // A ceiling, not a target. One requirements run has never been measured;
    // Task 11 records the real number and this gets set from evidence.
    budget: { maxTokens: 1_000_000, maxCostUsd: 10, maxDurationMs: 30 * 60_000 } },
];

// Prototype scope: the `requirements` stage only.
const stage = STAGES.requirements;

export default defineOrchestrator({
  workspace: process.cwd(),
  company: "Scyne",
  db: { driver: "pglite", dir: ".orchestrator/pgdata" },

  // The adapter registry. One entry today; another project registers its own here.
  runners: { claude_local: createClaudeRunner() },

  defaults: { adapter: "claude_local", model: "claude-sonnet-4-6", effort: "medium" },

  org: ORG,
  workflows: [{
    key: "requirements",
    label: stage.label,
    assignee: stage.agentKey,
    steps: [
      { type: "exec",   cmd: `node scripts/stage.mjs {project} "{feature}" requirements` },
      // Reading a full discovery pack and writing 11 sections is the expensive
      // step in this workflow — it is the one worth the reasoning budget.
      { type: "agent",  phase: "generate", skill: stage.skill, effort: "high" },
      { type: "attach", files: stage.produces },
      { type: "gate",   title: `Approve ${stage.label} — {project} / {feature}` },
    ],
  }],
});
```

> The `publish` step is deliberately omitted from the prototype. Phase 2 of the
> spec adds it; publishing to Confluence during a prototype run would write to a
> real client space.

- [ ] **Step 2: Write the thin BA bundle**

`agent-instructions/ba.thin.md`. Produce it by taking the `content` field of `agent-instructions/ba.json` and **deleting every protocol section**:

Remove entirely:
- "## Paperclip API auth"
- The "Workflow — two phases" / "Decide phase" / "Disposition before EXIT" sections
- Every `curl` instruction
- Every instruction to post progress comments, attach work-products, raise an interaction, or set a status
- The Phase 2 publishing section (not used in the prototype)

Keep verbatim:
- "You are the BA for the Scyne workspace."
- "## Your scope"
- "## Inputs are organised by project + feature" including the `requirements/project/` explanation
- The house-style rules, the persona-reuse rule, the templates/examples fallback
- Anything describing *what a good product summary and story set look like*

Add at the top:

```markdown
You are the BA for the Scyne workspace.

The orchestrator manages your task's lifecycle. You do not call any API, set any
status, attach any files, or raise any approval. Your inputs are already staged.
Read them, invoke your skill, write your outputs, and exit.
```

Record the character count of the result — the reduction from 18,802 is a headline finding.

- [ ] **Step 3: Verify the config loads and validates**

Run: `npm run orch -- seed`
Expected: `✓ 5 agents reconciled`. A config error prints every problem at once.

- [ ] **Step 4: Checkpoint**

Report: the thin bundle's character count versus 18,802, and the `seed` output. Have a human read `ba.thin.md` before Task 11 spends tokens on it.

---

## Task 11: End-to-end validation against SAPN_DEMO

**Files:**
- Modify: none — this task runs the system and reports

**Interfaces:**
- Consumes: everything

- [ ] **Step 1: Preserve the known-good outputs**

```bash
cp -r "projects/SAPN_DEMO/interiam-benifits/outputs" \
      "/tmp/sapn-golden-outputs"
ls /tmp/sapn-golden-outputs
```
Expected: `extraction.json  gaps.md  product-summary.md  stories.json  stories.md`

- [ ] **Step 2: Run the workflow**

```bash
npm run orch -- run requirements --project SAPN_DEMO --feature interiam-benifits
```
Expected: the `exec` step stages inputs, the agent runs, work products attach, and the CLI parks at a gate printing the gate id.

- [ ] **Step 3: Inspect the run**

```bash
npm run orch -- runs <issueId>
npm run orch -- log <runId> | head -40
npm run orch -- log <runId> --raw | head -5
```
Expected: a run row with real token counts and a cost; the nice view shows the `Skill` invocation for `requirement-generator`; the raw view shows `{ts,stream,chunk}` envelopes.

- [ ] **Step 4: Diff against the golden outputs**

```bash
diff <(jq -S . /tmp/sapn-golden-outputs/stories.json) \
     <(jq -S . "projects/SAPN_DEMO/interiam-benifits/outputs/stories.json") | head -40

wc -l /tmp/sapn-golden-outputs/product-summary.md \
      "projects/SAPN_DEMO/interiam-benifits/outputs/product-summary.md"
```

The outputs will not be byte-identical — the model is not deterministic. Assess:
- Are all 11 Product Summary sections present?
- Are the placeholder sections (3.3.1, 7–11) preserved verbatim?
- Do stories follow `<L4.N.M> As a …, I want …, So that …`?
- Are persona names reused from the project rather than invented?

- [ ] **Step 5: Approve the gate and confirm completion**

```bash
npm run orch -- gate approve <gateId> --note "prototype validation"
npm run orch -- status <issueId>
```
Expected: status `done` (the prototype workflow has no publish step).

- [ ] **Step 6: Restore the golden outputs**

```bash
cp -r /tmp/sapn-golden-outputs/* "projects/SAPN_DEMO/interiam-benifits/outputs/"
```

- [ ] **Step 7: Write the findings**

Create `docs/superpowers/specs/2026-08-17-prototype-findings.md` recording:

| Question | Finding |
|---|---|
| Did the thin bundle produce equivalent output? | |
| Bundle size: 18,802 chars → ? | |
| Tokens for one `requirements` run (in / out / cache) | |
| Cost for one run | |
| Did the skill resolve from `.claude/skills/`? | |
| Spec open items 2, 3, 5 — resolved? | |
| Anything the five step types could not express | |

That last row is the one that matters: spec §18 says if this repo cannot express itself cleanly in five step types, **the step types are wrong and we fix them now**.

- [ ] **Step 8: Checkpoint**

Present the findings document. This is the decision point for whether phase 2 proceeds as specified.

---

## Task 12: Boundary and full-suite verification

**Files:**
- Create: `packages/orchestrator/test/boundaries.test.ts`

- [ ] **Step 1: Write the boundary test**

```ts
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

describe("library boundaries", () => {
  it("the core imports nothing from the consuming project", () => {
    const src = new URL("../src", import.meta.url).pathname;
    const offenders: string[] = [];
    for (const f of walk(src)) {
      const text = readFileSync(f, "utf8");
      for (const bad of ["scyne-chatbot", "scripts/pipeline", "scripts/stage", "requirement-generator"]) {
        if (new RegExp(`from\\s+["'][^"']*${bad}`).test(text)) offenders.push(`${f} → ${bad}`);
      }
    }
    expect(offenders, `library reaches into the consumer: ${offenders.join(", ")}`).toEqual([]);
  });

  it("exports no `any` from the public surface", () => {
    const idx = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
    expect(idx).not.toMatch(/export .*: any/);
  });
});
```

> This is the test that keeps the library reusable. Spec §18's risk is the joints being wrong; this catches the most common way that happens — the "library" quietly importing its only consumer.

- [ ] **Step 2: Run the full suite**

Run: `cd packages/orchestrator && npx vitest run`
Expected: every suite PASSES.

- [ ] **Step 3: Run the type check**

Run: `cd packages/orchestrator && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Final checkpoint**

Report the full suite output, the type-check result, and a list of every file created. **Leave everything uncommitted** — the user commits their own work.

---

## Post-plan

After Task 12, the phase-1 prototype is complete: a working library, a documented API, and empirical answers to spec open items 2–5.

**Phase 2 gets its own plan**, written after the findings document is reviewed — because what Task 11 learns about the thin-agent model determines whether the remaining ten bundles are rewritten as specified or the approach is adjusted first.
