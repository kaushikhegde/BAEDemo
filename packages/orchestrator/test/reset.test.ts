import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, migrate, type Db } from "../src/core/db.js";
import { createRepo } from "../src/core/repo.js";

let dir: string, db: Db, repo: ReturnType<typeof createRepo>, companyId: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "orch-reset-"));
  db = await openDb({ driver: "pglite", dir: join(dir, "pg") });
  await migrate(db, new URL("../migrations", import.meta.url).pathname);
  repo = createRepo(db);
  companyId = await repo.ensureCompany("Scyne");
  await repo.upsertAgent(companyId, { key: "ba", name: "BA" });
  await repo.upsertAgent(companyId, { key: "dataModeler", name: "Data Modeler" });

  const ba = await repo.getAgentByKey(companyId, "ba");
  const issue = await repo.createIssue({
    companyId, title: "Generate requirements", workflowKey: "requirements",
    assigneeAgentId: ba!.id, status: "in_review",
  });
  await repo.addComment(issue.id, "working", { agentId: ba!.id });
  await repo.attachWorkProduct(issue.id, {
    type: "document", provider: "local", title: "x.md", url: "file:///x.md" });
  await repo.createGate(issue.id, { title: "Approve" });
  const run = await repo.startRun({ issueId: issue.id, agentId: ba!.id, stepIndex: 1, logPath: "/tmp/a.jsonl" });
  await repo.finishRun(run.id, { status: "succeeded", exitCode: 0, costUsd: 1.5 });
  await repo.setBudget(companyId, "agent", "ba", { maxCostUsd: 15 });
});
afterEach(async () => { await db.close(); rmSync(dir, { recursive: true, force: true }); });

describe("resetCompany", () => {
  it("clears the history and keeps the org", async () => {
    const summary = await repo.resetCompany(companyId);
    expect(summary).toMatchObject({ issues: 1, runs: 1, budgets: 1, agents: 0 });

    expect(await repo.listIssues(companyId)).toEqual([]);
    expect(await repo.listBudgets(companyId)).toEqual([]);
    // The agents are the point of "reinit with just agents".
    expect((await repo.listAgents(companyId)).map(a => a.key)).toEqual(["ba", "dataModeler"]);
  });

  it("cascades to comments, work products, gates and runs", async () => {
    await repo.resetCompany(companyId);
    for (const table of ["comments", "work_products", "gates", "runs"]) {
      const { rows } = await db.query<{ n: string }>(`select count(*) as n from ${table}`);
      expect(Number(rows[0].n), `${table} was left behind`).toBe(0);
    }
  });

  it("drops the org too when asked, despite issues referencing agents", async () => {
    // `issues.assignee_agent_id` and `runs.agent_id` reference agents WITHOUT a
    // cascade, so deleting agents first fails on a foreign key. Order is the
    // whole of this test.
    const summary = await repo.resetCompany(companyId, { agents: true });
    expect(summary.agents).toBe(2);
    expect(await repo.listAgents(companyId)).toEqual([]);
  });

  it("leaves another company's data alone", async () => {
    const other = await repo.ensureCompany("Acme");
    await repo.upsertAgent(other, { key: "ba", name: "BA" });
    await repo.createIssue({ companyId: other, title: "theirs" });

    await repo.resetCompany(companyId, { agents: true });
    expect((await repo.listIssues(other)).length).toBe(1);
    expect((await repo.listAgents(other)).length).toBe(1);
  });

  it("is idempotent — a second reset is a no-op, not an error", async () => {
    await repo.resetCompany(companyId);
    expect(await repo.resetCompany(companyId)).toMatchObject({ issues: 0, runs: 0, budgets: 0 });
  });
});
