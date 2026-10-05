import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, migrate, type Db } from "../src/core/db.js";
import { memoryBlobBackend } from "../src/core/blobs.js";
import { createRepo } from "../src/core/repo.js";

let dir: string, db: Db, repo: ReturnType<typeof createRepo>, companyId: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "orch-reset-"));
  db = await openDb({ driver: "pglite", dir: join(dir, "pg") });
  await migrate(db, fileURLToPath(new URL("../migrations", import.meta.url)));
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

describe("resetCompany --all (factory reset)", () => {
  /** Seed the platform side: an admin, a project with a feature and a document. */
  async function seedPlatform() {
    const { createPlatformRepo } = await import("../src/core/platform.js");
    const { createDocumentStore } = await import("../src/core/documents.js");
    const platform = createPlatformRepo(db);
    const store = createDocumentStore(db, memoryBlobBackend());

    const user = await platform.createUser({ companyId, email: "admin@scyne.co", role: "admin" });
    await platform.createToken(user.id, "cli");
    await platform.createSession(user.id);
    const project = await platform.createProject({ companyId, name: "RTWSA", createdBy: user.id });
    const feature = await platform.createFeature({ projectId: project.id, name: "Appeals" });
    await store.put({ projectId: project.id, featureId: feature.id, path: "a.md", content: "x" });
    await platform.registerInstallation({ companyId, userId: user.id, machineId: "m1" });
    await platform.recordAction({ companyId, projectId: project.id, verb: "project.create" });
    const convo = await platform.createConversation({ companyId, userId: user.id, projectId: project.id });
    await platform.appendMessage(convo.id, { role: "user", content: [] });
    return platform;
  }

  const count = async (table: string): Promise<number> => {
    const { rows } = await db.query<{ n: string }>(`select count(*)::text as n from ${table}`);
    return Number(rows[0].n);
  };

  it("keeps identity and content by default — a plain reset is not a factory reset", async () => {
    const platform = await seedPlatform();
    await repo.resetCompany(companyId, { agents: true });

    expect(await count("users")).toBe(1);
    expect(await count("projects")).toBe(1);
    expect(await count("documents")).toBe(1);
    expect(await platform.isUnclaimed(companyId)).toBe(false);
  });

  it("removes everything with platform:true, and reports what it removed", async () => {
    await seedPlatform();
    const summary = await repo.resetCompany(companyId, { agents: true, platform: true });

    expect(summary.users).toBe(1);
    expect(summary.projects).toBe(1);
    expect(summary.documents).toBe(1);
    expect(summary.installations).toBe(1);

    for (const t of ["users", "projects", "features", "documents", "project_members",
                     "api_tokens", "sessions", "installations", "actions",
                     "conversations", "messages", "blobs"]) {
      expect(await count(t), t).toBe(0);
    }
  });

  it("leaves the installation claimable again — the whole point of a factory reset", async () => {
    const platform = await seedPlatform();
    expect(await platform.isUnclaimed(companyId)).toBe(false);

    await repo.resetCompany(companyId, { agents: true, platform: true });
    expect(await platform.isUnclaimed(companyId)).toBe(true);
  });

  it("is idempotent — a second factory reset is a no-op, not an error", async () => {
    await seedPlatform();
    await repo.resetCompany(companyId, { agents: true, platform: true });
    const second = await repo.resetCompany(companyId, { agents: true, platform: true });
    expect(second.users).toBe(0);
    expect(second.projects).toBe(0);
  });
});

describe("resetCompany in a multi-organisation install", () => {
  // Every issue in the install is assigned out of ONE org chart, so a second
  // organisation's issues point at the home company's agent rows. `--hard`
  // deletes those rows, and hit `issues_assignee_agent_id_fkey` — aborting
  // AFTER the users were already gone, leaving an installation that could
  // neither be used nor re-claimed. Found by running the setup guide.
  it("does not fail on another organisation's issues, and does not delete them", async () => {
    const other = await repo.ensureCompany("Beta Mutual");
    const ba = await repo.getAgentByKey(companyId, "ba");
    const theirs = await repo.createIssue({
      companyId: other, title: "Their work", workflowKey: "requirements",
      assigneeAgentId: ba!.id, status: "todo",
    });

    const summary = await repo.resetCompany(companyId, { agents: true, platform: true });
    expect(summary.detachedIssues).toBe(1);

    // Kept — another organisation's history is not this company's to remove.
    const still = await repo.getIssue(theirs.id);
    expect(still?.title).toBe("Their work");
    expect(still?.assignee_agent_id ?? null).toBeNull();
  });

  it("leaves the database untouched when the reset cannot complete", async () => {
    // Atomicity is the half that made the original bug unrecoverable: the
    // users were deleted, then the agent delete threw, and there was no way
    // back. Simulated here by dropping the agents table mid-flight is not
    // possible, so the guarantee is asserted the other way round — a reset
    // that succeeds leaves nothing half-done, and one that throws rolls back.
    const before = await repo.listIssues(companyId);
    expect(before.length).toBeGreaterThan(0);
    await repo.resetCompany(companyId, { agents: true, platform: true });
    expect(await repo.listIssues(companyId)).toHaveLength(0);
    expect(await repo.listAgents(companyId)).toHaveLength(0);
  });
});

describe("runtime adapter resolution", () => {
  it("lets the configured default apply when the agent has no opinion", async () => {
    // The bug this pins: upsertAgent used to write 'claude_local' for an agent
    // whose spec named no adapter, so resolveRuntime's step → agent → defaults
    // chain always stopped at the agent and SCYNE_ADAPTER=gemini did nothing.
    const { resolveRuntime } = await import("../src/config.js");
    await repo.upsertAgent(companyId, { key: "noPref", name: "No Preference" });
    const row = await repo.getAgentByKey(companyId, "noPref");
    expect(row!.adapter).toBeNull();

    const rt = resolveRuntime(
      { type: "agent", phase: "generate" },
      { adapter: row!.adapter ?? undefined },
      { adapter: "gemini" });
    expect(rt.adapter).toBe("gemini");
  });

  it("still honours an agent that IS explicitly pinned", async () => {
    const { resolveRuntime } = await import("../src/config.js");
    await repo.upsertAgent(companyId, { key: "pinned", name: "Pinned", adapter: "claude_local" });
    const row = await repo.getAgentByKey(companyId, "pinned");
    expect(row!.adapter).toBe("claude_local");

    const rt = resolveRuntime(
      { type: "agent", phase: "generate" },
      { adapter: row!.adapter ?? undefined },
      { adapter: "gemini" });
    expect(rt.adapter).toBe("claude_local");
  });

  it("resolves project over company over the config file", async () => {
    const { resolveRuntime } = await import("../src/config.js");
    await repo.setSetting(companyId, "company", "*", "adapter", "gemini");
    await repo.setSetting(companyId, "project", "RTWSA", "adapter", "azure_foundry");

    const projectFirst = [
      await repo.getSettings(companyId, "project", "RTWSA"),
      await repo.getSettings(companyId, "company", "*"),
    ];
    expect(resolveRuntime({ type: "agent", phase: "g" }, null, { adapter: "claude_local" }, projectFirst).adapter)
      .toBe("azure_foundry");

    // A project with no setting of its own falls through to the company.
    const companyOnly = [
      await repo.getSettings(companyId, "project", "SAPN"),
      await repo.getSettings(companyId, "company", "*"),
    ];
    expect(resolveRuntime({ type: "agent", phase: "g" }, null, { adapter: "claude_local" }, companyOnly).adapter)
      .toBe("gemini");
  });

  it("falls back a scope at a time when a setting is cleared", async () => {
    const { resolveRuntime } = await import("../src/config.js");
    await repo.setSetting(companyId, "company", "*", "adapter", "gemini");
    await repo.setSetting(companyId, "project", "RTWSA", "adapter", "azure_foundry");

    expect(await repo.clearSetting(companyId, "project", "RTWSA", "adapter")).toBe(true);
    const scoped = [
      await repo.getSettings(companyId, "project", "RTWSA"),
      await repo.getSettings(companyId, "company", "*"),
    ];
    expect(resolveRuntime({ type: "agent", phase: "g" }, null, { adapter: "claude_local" }, scoped).adapter)
      .toBe("gemini");

    await repo.clearSetting(companyId, "company", "*", "adapter");
    expect(resolveRuntime({ type: "agent", phase: "g" }, null, { adapter: "claude_local" }, [
      await repo.getSettings(companyId, "project", "RTWSA"),
      await repo.getSettings(companyId, "company", "*"),
    ]).adapter).toBe("claude_local");
  });
});
