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
