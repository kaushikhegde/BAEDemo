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

  it("records the adapter a run used", async () => {
    const issue = await repo.createIssue({
      companyId, title: "adapter round-trip", workflowKey: "requirements",
    });
    const run = await repo.startRun({
      issueId: issue.id, agentId: null, stepIndex: 0, phase: "generate",
      logPath: "/tmp/x.jsonl", adapter: "codex",
    });
    expect(run.adapter).toBe("codex");

    const back = await repo.listRuns(issue.id);
    expect(back[0].adapter).toBe("codex");
  });

  it("leaves the adapter null when the caller does not supply one", async () => {
    const issue = await repo.createIssue({
      companyId, title: "no adapter", workflowKey: "requirements",
    });
    const run = await repo.startRun({
      issueId: issue.id, agentId: null, stepIndex: 0, phase: "generate", logPath: "/tmp/y.jsonl",
    });
    expect(run.adapter).toBeNull();
  });

  it("decides a gate", async () => {
    const i = await repo.createIssue({ companyId, title: "X", workflowKey: "requirements", params: {} });
    const g = await repo.createGate(i.id, { title: "Approve", summary: "" });
    await repo.decideGate(g.id, "approved", "looks good", "tagari");
    expect((await repo.getGate(g.id))?.status).toBe("approved");
  });

  it("listIssues filters by parentId, both an explicit id and null", async () => {
    const parent = await repo.createIssue({ companyId, title: "Parent", workflowKey: "requirements", params: {} });
    const child = await repo.createIssue({ companyId, title: "Child", workflowKey: "requirements", params: {}, parentId: parent.id });

    const roots = await repo.listIssues(companyId, { parentId: null });
    const rootIds = roots.map(i => i.id);
    expect(rootIds).toContain(parent.id);
    expect(rootIds).not.toContain(child.id);

    const children = await repo.listIssues(companyId, { parentId: parent.id });
    expect(children.map(i => i.id)).toEqual([child.id]);
  });

  it("listIssues filters by assigneeAgentId, both an explicit id and null", async () => {
    await repo.upsertAgent(companyId, { key: "ba", name: "BA" });
    const agent = await repo.getAgentByKey(companyId, "ba");
    const assigned = await repo.createIssue({ companyId, title: "Assigned", workflowKey: "requirements", params: {}, assigneeAgentId: agent?.id });
    const unassigned = await repo.createIssue({ companyId, title: "Unassigned", workflowKey: "requirements", params: {} });

    const unassignedIssues = await repo.listIssues(companyId, { assigneeAgentId: null });
    const unassignedIds = unassignedIssues.map(i => i.id);
    expect(unassignedIds).toContain(unassigned.id);
    expect(unassignedIds).not.toContain(assigned.id);

    const assignedIssues = await repo.listIssues(companyId, { assigneeAgentId: agent?.id });
    expect(assignedIssues.map(i => i.id)).toEqual([assigned.id]);
  });

  it("createIssue survives concurrent calls, assigning distinct identifiers", async () => {
    const [a, b] = await Promise.all([
      repo.createIssue({ companyId, title: "One", workflowKey: "requirements", params: {} }),
      repo.createIssue({ companyId, title: "Two", workflowKey: "requirements", params: {} }),
    ]);
    expect(a.identifier).not.toBe(b.identifier);
    expect(new Set([a.identifier, b.identifier]).size).toBe(2);
  });

  it("upsertAgent persists a budget that getBudget reads back", async () => {
    await repo.upsertAgent(companyId, {
      key: "ba", name: "BA",
      budget: { maxTokens: 100000, maxCostUsd: 12.5, maxDurationMs: 600000 },
    });
    const budget = await repo.getBudget(companyId, "agent", "ba");
    expect(budget).not.toBeNull();
    expect(Number(budget?.max_tokens)).toBe(100000);
    expect(Number(budget?.max_cost_usd)).toBeCloseTo(12.5, 2);
    expect(Number(budget?.max_duration_ms)).toBe(600000);
  });
});

describe("createIssue attributes the issue to its project and feature", () => {
  // 002_platform added `issues.project_id` and `issues.feature_id` saying "cost
  // per project is a group-by once this exists" — and nothing ever wrote them.
  // `/spend?by=project` returned one anonymous row holding the whole
  // installation, for every run ever recorded. It survived because every spend
  // test seeded the column by hand with an UPDATE, exercising the report and
  // never the path that was missing. These tests go through createIssue.

  const project = async (name: string) => {
    const { rows } = await db.query<{ id: string }>(
      `insert into projects (id, company_id, name) values (gen_random_uuid(), $1, $2) returning id`,
      [companyId, name]);
    return rows[0].id;
  };
  const feature = async (projectId: string, name: string) => {
    const { rows } = await db.query<{ id: string }>(
      `insert into features (id, project_id, name) values (gen_random_uuid(), $1, $2) returning id`,
      [projectId, name]);
    return rows[0].id;
  };

  it("resolves params.project by name", async () => {
    const p = await project("SAPN");
    const issue = await repo.createIssue({
      companyId, title: "Capability map — SAPN", params: { project: "SAPN" },
    });
    expect((issue as unknown as { project_id: string }).project_id).toBe(p);
  });

  it("resolves params.feature through the project, not by name alone", async () => {
    // Two clients with a feature of the same name is the ordinary case, and
    // matching on name alone would file one client's work under the other's.
    const sapn = await project("SAPN");
    const rtwsa = await project("RTWSA");
    await feature(sapn, "Appeals");
    const theirs = await feature(rtwsa, "Appeals");

    const issue = await repo.createIssue({
      companyId, title: "Requirements — RTWSA / Appeals",
      params: { project: "RTWSA", feature: "Appeals" },
    });
    const row = issue as unknown as { project_id: string; feature_id: string };
    expect(row.project_id).toBe(rtwsa);
    expect(row.feature_id).toBe(theirs);
  });

  it("still creates the issue when the project is not in the database", async () => {
    // The folder tree and the database genuinely disagree — a `reset` clears
    // one and leaves the other. An unattributed run is a gap in a chart; a
    // refused run is somebody's afternoon.
    const issue = await repo.createIssue({
      companyId, title: "Requirements — Ghost", params: { project: "Ghost", feature: "X" },
    });
    const row = issue as unknown as { project_id: string | null; feature_id: string | null };
    expect(row.project_id).toBeNull();
    expect(row.feature_id).toBeNull();
    expect(issue.identifier).toBeTruthy();
  });

  it("leaves a feature unattributed when its project did not resolve", async () => {
    await feature(await project("SAPN"), "Appeals");
    const issue = await repo.createIssue({
      companyId, title: "x", params: { project: "Ghost", feature: "Appeals" },
    });
    expect((issue as unknown as { feature_id: string | null }).feature_id).toBeNull();
  });

  it("ignores a blank or non-string project rather than throwing", async () => {
    for (const params of [{}, { project: "" }, { project: "   " }, { project: 42 }]) {
      const issue = await repo.createIssue({ companyId, title: "x", params });
      expect((issue as unknown as { project_id: string | null }).project_id).toBeNull();
    }
  });
});

describe("008 backfills issues created before attribution existed", () => {
  // The fix above only helps issues created from now on. Every run already
  // recorded is joined through `issues.project_id`, so without a backfill the
  // Spend view would keep showing one anonymous row for all of the history —
  // and the project was never actually missing, only in the wrong column.
  //
  // This runs the migration's real SQL against rows shaped the way the old
  // code left them, rather than a paraphrase of it.
  const backfill = async () => {
    const { readFileSync } = await import("node:fs");
    const sql = readFileSync(
      new URL("../migrations/008_issue_project_backfill.sql", import.meta.url).pathname, "utf8");
    // Strip `--` line comments BEFORE splitting. Splitting first and then
    // discarding chunks that begin with `--` throws away the statement the
    // comment introduces, which is every statement in a file written this way.
    const bare = sql.split("\n").filter(l => !l.trim().startsWith("--")).join("\n");
    for (const stmt of bare.split(";").map(x => x.trim()).filter(Boolean)) {
      await db.query(stmt);
    }
  };

  const legacyIssue = async (params: Record<string, unknown>) => {
    const { rows } = await db.query<{ id: string }>(
      `insert into issues (id, company_id, identifier, title, status, params)
       values (gen_random_uuid(), $1, 'SCY-legacy-' || floor(random()*100000)::text, 't', 'done', $2)
       returning id`,
      [companyId, JSON.stringify(params)]);
    return rows[0].id;
  };
  const projectId = async (name: string) => {
    const { rows } = await db.query<{ id: string }>(
      `insert into projects (id, company_id, name) values (gen_random_uuid(), $1, $2) returning id`,
      [companyId, name]);
    return rows[0].id;
  };
  const scopeOf = async (id: string) => {
    const { rows } = await db.query<{ project_id: string | null; feature_id: string | null }>(
      `select project_id, feature_id from issues where id=$1`, [id]);
    return rows[0];
  };

  it("lifts the project out of params and into the foreign key", async () => {
    const p = await projectId("SAPN");
    const issue = await legacyIssue({ project: "SAPN", adoOrg: "Scyne-AI-Lab" });
    await backfill();
    expect((await scopeOf(issue)).project_id).toBe(p);
  });

  it("resolves the feature through the project it just set", async () => {
    const p = await projectId("SAPN");
    const { rows } = await db.query<{ id: string }>(
      `insert into features (id, project_id, name) values (gen_random_uuid(), $1, 'interim-benefit') returning id`,
      [p]);
    const issue = await legacyIssue({ project: "SAPN", feature: "interim-benefit" });
    await backfill();
    const scope = await scopeOf(issue);
    expect(scope.project_id).toBe(p);
    expect(scope.feature_id).toBe(rows[0].id);
  });

  it("leaves a name that resolves to nothing alone, rather than guessing", async () => {
    const issue = await legacyIssue({ project: "DeletedClient" });
    await backfill();
    expect((await scopeOf(issue)).project_id).toBeNull();
  });

  it("is idempotent, and never overwrites an attribution that is already set", async () => {
    const right = await projectId("SAPN");
    const wrong = await projectId("RTWSA");
    const issue = await legacyIssue({ project: "SAPN" });
    // Someone (or something) has already attributed it differently on purpose.
    await db.query(`update issues set project_id=$2 where id=$1`, [issue, wrong]);
    await backfill();
    await backfill();
    expect((await scopeOf(issue)).project_id).toBe(wrong);
    expect(right).not.toBe(wrong);
  });
});
