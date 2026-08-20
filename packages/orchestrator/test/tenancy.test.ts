// Cross-organisation isolation.
//
// Every other test in this workstream asserts that a capability WORKS. This
// one asserts that it does not work across a tenant boundary, which is the
// only thing standing between the design and one client seeing another
// client's work. A failure here is a data leak, not a bug — fix the code, do
// not adjust the expectation.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, migrate, type Db } from "../src/core/db.js";
import { createPlatformRepo, type PlatformRepo } from "../src/core/platform.js";
import { createRepo } from "../src/core/repo.js";

let dir: string, db: Db, p: PlatformRepo, repo: ReturnType<typeof createRepo>;
let orgA: string, orgB: string, userA: string, userB: string;
let projA: string, projB: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "orch-tenancy-"));
  db = await openDb({ driver: "pglite", dir });
  await migrate(db, new URL("../migrations", import.meta.url).pathname);
  p = createPlatformRepo(db);
  repo = createRepo(db);

  orgA = (await p.createCompany({ name: "Alpha Council" })).id;
  orgB = (await p.createCompany({ name: "Beta Insurance" })).id;
  userA = (await p.createUser({ companyId: orgA, email: "a@alpha.co", role: "admin" })).id;
  userB = (await p.createUser({ companyId: orgB, email: "b@beta.co", role: "admin" })).id;
  projA = (await p.createProject({ companyId: orgA, name: "Alpha Claims", createdBy: userA })).id;
  projB = (await p.createProject({ companyId: orgB, name: "Beta Claims", createdBy: userB })).id;
});
afterEach(async () => { await db.close(); rmSync(dir, { recursive: true, force: true }); });

describe("two organisations cannot see each other", () => {
  it("projects", async () => {
    expect((await p.listProjects(orgA, { userId: userA })).map(x => x.name)).toEqual(["Alpha Claims"]);
    expect((await p.listProjects(orgB, { userId: userB })).map(x => x.name)).toEqual(["Beta Claims"]);
  });

  it("projects, even for an admin — who holds `owner` on every project they can SEE", async () => {
    // effectiveProjectRole promotes an admin to owner, which is exactly why
    // the COMPANY filter and not the role has to be the boundary.
    const seen = await p.listProjects(orgA, { userId: userA, isAdmin: true });
    expect(seen.map(x => x.name)).toEqual(["Alpha Claims"]);
    expect(seen.map(x => x.id)).not.toContain(projB);
  });

  it("users", async () => {
    expect((await p.listUsers(orgA)).map(u => u.email)).toEqual(["a@alpha.co"]);
    expect((await p.listUsers(orgB)).map(u => u.email)).toEqual(["b@beta.co"]);
  });

  it("features", async () => {
    await p.createFeature({ projectId: projA, name: "Alpha Feature" });
    await p.createFeature({ projectId: projB, name: "Beta Feature" });
    expect((await p.listFeatures(projA)).map(f => f.name)).toEqual(["Alpha Feature"]);
    expect((await p.listFeatures(projB)).map(f => f.name)).toEqual(["Beta Feature"]);
  });

  it("issues", async () => {
    await repo.createIssue({ companyId: orgA, title: "Alpha work", createdBy: userA });
    await repo.createIssue({ companyId: orgB, title: "Beta work", createdBy: userB });
    expect((await repo.listIssues(orgA)).map(i => i.title)).toEqual(["Alpha work"]);
    expect((await repo.listIssues(orgB)).map(i => i.title)).toEqual(["Beta work"]);
  });

  it("audit actions", async () => {
    await p.recordAction({ companyId: orgA, userId: userA, verb: "project.create" });
    await p.recordAction({ companyId: orgB, userId: userB, verb: "project.create" });
    const a = await p.listActions(orgA);
    expect(a).toHaveLength(1);
    expect(a[0].user_id).toBe(userA);
  });

  it("spend", async () => {
    expect(await p.spend(orgA)).toEqual([]);
    expect(await p.spend(orgB)).toEqual([]);
  });

  it("conversations", async () => {
    await p.createConversation({ companyId: orgA, userId: userA, title: "Alpha chat" });
    await p.createConversation({ companyId: orgB, userId: userB, title: "Beta chat" });
    expect((await p.listConversations(orgA)).map(c => c.title)).toEqual(["Alpha chat"]);
  });

  it("installations", async () => {
    await p.registerInstallation({ companyId: orgA, userId: userA, machineId: "m-a" });
    await p.registerInstallation({ companyId: orgB, userId: userB, machineId: "m-b" });
    expect((await p.listInstallations(orgA)).map(i => i.machine_id)).toEqual(["m-a"]);
  });

  it("a project id from another organisation does not resolve by name", async () => {
    expect(await p.getProjectByName(orgA, "Beta Claims")).toBeNull();
  });

  it("an identifier sequence is per-organisation, so SCY-1 exists in both", async () => {
    const a = await repo.createIssue({ companyId: orgA, title: "first" });
    const b = await repo.createIssue({ companyId: orgB, title: "first" });
    expect(a.identifier).toBe("SCY-1");
    expect(b.identifier).toBe("SCY-1");
    expect(a.id).not.toBe(b.id);
  });
});

describe("archiving an organisation", () => {
  it("removes it from the listing but keeps every row it owns", async () => {
    await p.archiveCompany(orgB);
    expect((await p.listCompanies()).map(c => c.id)).not.toContain(orgB);
    expect(await p.getUser(userB)).not.toBeNull();
    expect(await p.getProject(projB)).not.toBeNull();
  });

  it("is still reachable by id, so its history and spend survive", async () => {
    await p.archiveCompany(orgB);
    const org = await p.getCompany(orgB);
    expect(org?.status).toBe("archived");
    expect(org?.archived_at).not.toBeNull();
  });
});

describe("install-wide facts are install-wide on purpose", () => {
  it("counts the queue across every organisation", async () => {
    await repo.createIssue({ companyId: orgA, title: "a", status: "todo" });
    await repo.createIssue({ companyId: orgB, title: "b", status: "todo" });
    expect((await repo.queueDepth()).todo).toBe(2);
  });

  it("finds an agent's open issues across every organisation", async () => {
    const agentId = await repo.upsertAgent(orgA, { key: "ba", name: "BA" });
    await repo.createIssue({ companyId: orgA, title: "a", assigneeAgentId: agentId, status: "todo" });
    await repo.createIssue({ companyId: orgB, title: "b", assigneeAgentId: agentId, status: "todo" });
    // Agents are shared across the install, so disabling one must see ALL of
    // its work — a home-scoped check would let it be disabled mid-flight for
    // another tenant.
    expect(await repo.openIssuesForAgent(agentId)).toHaveLength(2);
  });
});
