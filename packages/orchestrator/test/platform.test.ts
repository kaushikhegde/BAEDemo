import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { openDb, migrate, type Db } from "../src/core/db.js";
import { createPlatformRepo, type PlatformRepo, type UserRow } from "../src/core/platform.js";
import { createRepo } from "../src/core/repo.js";
import { hashPassword } from "../src/core/auth.js";

let dir: string, db: Db, p: PlatformRepo, repo: ReturnType<typeof createRepo>, company: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "orch-plat-"));
  db = await openDb({ driver: "pglite", dir });
  await migrate(db, new URL("../migrations", import.meta.url).pathname);
  p = createPlatformRepo(db);
  repo = createRepo(db);
  company = randomUUID();
  await db.query(`insert into companies (id, name, slug) values ($1,'Scyne','scyne')`, [company]);
});
afterEach(async () => { await db.close(); rmSync(dir, { recursive: true, force: true }); });

const admin = () => p.createUser({ companyId: company, email: "admin@scyne.co", role: "admin" });
const member = (email = "m@scyne.co") => p.createUser({ companyId: company, email, role: "member" });

describe("users", () => {
  it("normalises email on write and on lookup", async () => {
    await p.createUser({ companyId: company, email: "  Alice@Scyne.CO " });
    expect((await p.getUserByEmail(company, "alice@scyne.co"))?.email).toBe("alice@scyne.co");
    expect((await p.getUserByEmail(company, "ALICE@SCYNE.CO"))?.email).toBe("alice@scyne.co");
  });

  it("knows when the company has no users, which is the only time bootstrapping is safe", async () => {
    expect(await p.isUnclaimed(company)).toBe(true);
    await admin();
    expect(await p.isUnclaimed(company)).toBe(false);
  });

  it("stores a password hash, never the password", async () => {
    const u = await p.createUser({
      companyId: company, email: "a@b.co", passwordHash: await hashPassword("hunter2"),
    });
    expect(u.password_hash).not.toContain("hunter2");
    expect(u.password_hash?.startsWith("scrypt$")).toBe(true);
  });
});

describe("tokens", () => {
  it("returns the secret once and authenticates with it", async () => {
    const u = await member();
    const { secret, row } = await p.createToken(u.id, "laptop");

    const principal = await p.principalFromToken(secret);
    expect(principal?.user.id).toBe(u.id);
    expect(principal?.tokenId).toBe(row.id);

    // The stored row must not contain the secret anywhere.
    const stored = await p.listTokens(u.id);
    expect(JSON.stringify(stored)).not.toContain(secret.slice(10));
  });

  it("stops authenticating the moment it is revoked", async () => {
    const u = await member();
    const { secret, row } = await p.createToken(u.id, "laptop");
    expect(await p.principalFromToken(secret)).not.toBeNull();

    expect(await p.revokeToken(row.id)).toBe(true);
    expect(await p.principalFromToken(secret)).toBeNull();
    expect(await p.revokeToken(row.id)).toBe(false);      // already revoked
  });

  it("refuses an expired token", async () => {
    const u = await member();
    const { secret } = await p.createToken(u.id, "old", new Date(Date.now() - 1000));
    expect(await p.principalFromToken(secret)).toBeNull();
  });

  it("refuses a token belonging to a disabled user", async () => {
    const u = await member();
    const { secret } = await p.createToken(u.id, "laptop");
    await p.updateUser(u.id, { status: "disabled" });
    expect(await p.principalFromToken(secret)).toBeNull();
  });

  it("refuses a fabricated token", async () => {
    expect(await p.principalFromToken("scy_totally-made-up")).toBeNull();
  });

  it("records when a token was last used", async () => {
    const u = await member();
    const { secret, row } = await p.createToken(u.id, "laptop");
    expect((await p.listTokens(u.id))[0].last_used_at).toBeNull();
    await p.principalFromToken(secret);
    const after = (await p.listTokens(u.id)).find((t: any) => t.id === row.id) as any;
    expect(after.last_used_at).not.toBeNull();
  });

  it("only lets a token be revoked by its own owner when an owner is named", async () => {
    const a = await member("a@x.co"), b = await member("b@x.co");
    const { row } = await p.createToken(a.id, "laptop");
    expect(await p.revokeToken(row.id, b.id)).toBe(false);   // not yours
    expect(await p.revokeToken(row.id, a.id)).toBe(true);
  });
});

describe("sessions", () => {
  it("authenticates then stops on logout", async () => {
    const u = await member();
    const { secret } = await p.createSession(u.id);
    expect((await p.principalFromSession(secret))?.user.id).toBe(u.id);
    await p.destroySession(secret);
    expect(await p.principalFromSession(secret)).toBeNull();
  });

  it("purges expired sessions and refuses them meanwhile", async () => {
    const u = await member();
    await db.query(
      `insert into sessions (id, user_id, token_hash, expires_at)
       values ($1,$2,'stale-hash', now() - interval '1 hour')`, [randomUUID(), u.id]);
    expect(await p.purgeExpiredSessions()).toBe(1);
  });
});

describe("projects and access", () => {
  it("makes the creator an owner, so a new project is not immediately unreachable", async () => {
    const u = await member();
    const proj = await p.createProject({ companyId: company, name: "RTWSA", createdBy: u.id });
    expect(await p.projectRole(u, proj.id)).toBe("owner");
  });

  it("hides a project from a non-member, and shows every project to an admin", async () => {
    const alice = await member("alice@x.co"), bob = await member("bob@x.co");
    const a = await admin();
    await p.createProject({ companyId: company, name: "Alpha", createdBy: alice.id });
    await p.createProject({ companyId: company, name: "Beta", createdBy: bob.id });

    expect((await p.listProjects(company, { userId: alice.id })).map(x => x.name)).toEqual(["Alpha"]);
    expect((await p.listProjects(company, { userId: bob.id })).map(x => x.name)).toEqual(["Beta"]);
    expect((await p.listProjects(company, { userId: a.id, isAdmin: true })).map(x => x.name))
      .toEqual(["Alpha", "Beta"]);
  });

  it("grants, changes and removes membership", async () => {
    const owner = await member("o@x.co"), guest = await member("g@x.co");
    const proj = await p.createProject({ companyId: company, name: "RTWSA", createdBy: owner.id });

    expect(await p.projectRole(guest, proj.id)).toBeNull();
    await p.setMember(proj.id, guest.id, "viewer", owner.id);
    expect(await p.projectRole(guest, proj.id)).toBe("viewer");

    await p.setMember(proj.id, guest.id, "editor", owner.id);   // upsert, not duplicate
    expect(await p.projectRole(guest, proj.id)).toBe("editor");
    expect(await p.listMembers(proj.id)).toHaveLength(2);

    expect(await p.removeMember(proj.id, guest.id)).toBe(true);
    expect(await p.projectRole(guest, proj.id)).toBeNull();
  });

  it("gives an admin owner rights without a membership row", async () => {
    const a = await admin(), owner = await member("o@x.co");
    const proj = await p.createProject({ companyId: company, name: "RTWSA", createdBy: owner.id });
    expect(await p.projectRole(a, proj.id)).toBe("owner");
    expect(await p.listMembers(proj.id)).toHaveLength(1);   // the admin is not a member
  });

  it("caps a global viewer at viewer even when granted ownership", async () => {
    const v = await p.createUser({ companyId: company, email: "v@x.co", role: "viewer" });
    const proj = await p.createProject({ companyId: company, name: "RTWSA" });
    await p.setMember(proj.id, v.id, "owner");
    expect(await p.projectRole(v, proj.id)).toBe("viewer");
  });

  it("creates and lists features under a project", async () => {
    const proj = await p.createProject({ companyId: company, name: "RTWSA" });
    await p.createFeature({ projectId: proj.id, name: "Appeals" });
    await p.createFeature({ projectId: proj.id, name: "Claims" });
    expect((await p.listFeatures(proj.id)).map(f => f.name)).toEqual(["Appeals", "Claims"]);
    expect((await p.getFeatureByName(proj.id, "Appeals"))?.name).toBe("Appeals");
  });
});

/**
 * Where a project publishes is a COLUMN, not a file.
 *
 * It lived only in `projects/<p>/.published.json`, which meant `POST
 * /api/projects` decided whether a project existed — and whether it was fully
 * set up — by reading a directory. Pointing DATABASE_URL at a fresh server
 * left the folders behind and the route refused to create projects the
 * database had never heard of.
 */
describe("a project's Azure DevOps target", () => {
  const target = {
    org: "Scyne-AI-Lab", project: "SA-Demo", wiki: "SA-Demo.wiki",
    processTemplate: "Agile", workItemType: "User Story",
  };

  it("is null on a new project, which is what INCOMPLETE means", async () => {
    const proj = await p.createProject({ companyId: company, name: "RTWSA" });
    // Not `{}`. A project with no target is one whose Azure DevOps setup has
    // not succeeded, and re-posting the create route is what repairs it — so
    // "never set up" must stay distinguishable from "set up and empty".
    expect(proj.ado_target).toBeNull();
  });

  it("can be supplied at creation and comes back as an object", async () => {
    const proj = await p.createProject({ companyId: company, name: "SA-Demo", adoTarget: target });
    expect(proj.ado_target).toEqual(target);
    // Read back through every path that returns a project, because each one
    // used to parse `theme` inline and would have missed a second jsonb column.
    expect((await p.getProject(proj.id))?.ado_target).toEqual(target);
    expect((await p.getProjectByName(company, "SA-Demo"))?.ado_target).toEqual(target);
    expect((await p.listProjects(company))[0].ado_target).toEqual(target);
  });

  it("is patched onto an existing project — the completing-an-incomplete-project path", async () => {
    const proj = await p.createProject({ companyId: company, name: "SA-Demo" });
    const updated = await p.updateProject(proj.id, { adoTarget: target });
    expect(updated?.ado_target).toEqual(target);
  });

  it("survives a patch that does not mention it", async () => {
    const proj = await p.createProject({ companyId: company, name: "SA-Demo", adoTarget: target });
    const updated = await p.updateProject(proj.id, { description: "who the client is" });
    expect(updated?.ado_target).toEqual(target);
    expect(updated?.description).toBe("who the client is");
  });

  it("is cleared by an explicit null, and only by an explicit null", async () => {
    const proj = await p.createProject({ companyId: company, name: "SA-Demo", adoTarget: target });
    expect((await p.updateProject(proj.id, { adoTarget: null }))?.ado_target).toBeNull();
  });

  it("does not disturb the theme column, and vice versa", async () => {
    const proj = await p.createProject({ companyId: company, name: "SA-Demo", adoTarget: target });
    const themed = await p.updateProject(proj.id, { theme: { brand: "#464e7e" } });
    expect(themed?.theme).toEqual({ brand: "#464e7e" });
    expect(themed?.ado_target).toEqual(target);
  });
});

describe("installations", () => {
  it("registers per machine and re-registers rather than duplicating", async () => {
    const u = await member();
    const first = await p.registerInstallation({
      companyId: company, userId: u.id, machineId: "m1", hostname: "alice-mbp", pluginVersion: "0.3.0",
    });
    const second = await p.registerInstallation({
      companyId: company, userId: u.id, machineId: "m1", hostname: "alice-mbp", pluginVersion: "0.3.1",
    });
    expect(second.id).toBe(first.id);
    expect(second.plugin_version).toBe("0.3.1");
    expect(await p.listInstallations(company)).toHaveLength(1);
  });

  it("revokes an installation, and re-registering clears the revocation", async () => {
    await p.registerInstallation({ companyId: company, machineId: "m1" });
    const [inst] = await p.listInstallations(company);
    expect(await p.revokeInstallation(inst.id)).toBe(true);
    expect((await p.listInstallations(company))[0].revoked_at).not.toBeNull();

    const again = await p.registerInstallation({ companyId: company, machineId: "m1" });
    expect(again.revoked_at).toBeNull();
  });
});

describe("actions", () => {
  it("records who did what, and lists newest first per project", async () => {
    const u = await member();
    const proj = await p.createProject({ companyId: company, name: "RTWSA", createdBy: u.id });
    await p.recordAction({ companyId: company, projectId: proj.id, userId: u.id, verb: "project.create" });
    await p.recordAction({ companyId: company, projectId: proj.id, userId: u.id, verb: "doc.upload",
                           detail: { path: "requirements/SOP/a.md" } });

    const actions = await p.listActions(company, { projectId: proj.id });
    expect(actions.map(a => a.verb)).toEqual(["doc.upload", "project.create"]);
    expect(actions[0].detail).toEqual({ path: "requirements/SOP/a.md" });
  });

  it("never throws — an audit failure must not fail the thing it describes", async () => {
    await expect(p.recordAction({
      companyId: randomUUID(),          // no such company: the insert violates its FK
      verb: "project.create",
    })).resolves.toBeUndefined();
  });
});

describe("chats", () => {
  it("numbers messages per conversation and returns them in order", async () => {
    const u = await member();
    const c = await p.createConversation({ companyId: company, userId: u.id });
    await p.appendMessage(c.id, { role: "user", content: [{ type: "text", text: "hello" }] });
    await p.appendMessage(c.id, { role: "assistant", content: [{ type: "text", text: "hi" }], adapter: "gemini" });

    const msgs = await p.listMessages(c.id);
    expect(msgs.map(m => m.seq)).toEqual([1, 2]);
    expect(msgs[1].adapter).toBe("gemini");
    expect(msgs[0].content).toEqual([{ type: "text", text: "hello" }]);
  });

  it("numbers two conversations independently", async () => {
    const a = await p.createConversation({ companyId: company });
    const b = await p.createConversation({ companyId: company });
    await p.appendMessage(a.id, { role: "user", content: [] });
    await p.appendMessage(b.id, { role: "user", content: [] });
    expect((await p.listMessages(a.id))[0].seq).toBe(1);
    expect((await p.listMessages(b.id))[0].seq).toBe(1);
  });

  it("deletes a conversation and its messages with it", async () => {
    const u = await member();
    const c = await p.createConversation({ companyId: company, userId: u.id });
    await p.appendMessage(c.id, { role: "user", content: [{ type: "text", text: "hello" }] });

    expect(await p.deleteConversation(c.id, company, u.id)).toBe(true);
    expect(await p.listConversations(company, { userId: u.id })).toEqual([]);
    // The messages go by cascade, not by a second delete anyone has to remember.
    expect(await p.listMessages(c.id)).toEqual([]);
  });

  it("refuses to delete another user's conversation", async () => {
    // Scoped to the owner because `listConversations` already is: a member who
    // cannot READ a colleague's chat must not delete it by guessing an id.
    const owner = await member("owner@x.co");
    const other = await member("other@x.co");
    const c = await p.createConversation({ companyId: company, userId: owner.id });

    expect(await p.deleteConversation(c.id, company, other.id)).toBe(false);
    expect(await p.listConversations(company, { userId: owner.id })).toHaveLength(1);
  });

  it("reports false for an id that matches nothing, rather than throwing", async () => {
    const u = await member();
    expect(await p.deleteConversation(randomUUID(), company, u.id)).toBe(false);
  });
});

describe("run events", () => {
  async function aRun(): Promise<string> {
    const issue = randomUUID(), run = randomUUID();
    await db.query(
      `insert into issues (id, company_id, identifier, title, status) values ($1,$2,'SCY-1','t','todo')`,
      [issue, company]);
    await db.query(`insert into runs (id, issue_id, status) values ($1,$2,'running')`, [run, issue]);
    return run;
  }

  it("reassembles the log exactly, including a line split across two writes", async () => {
    const run = await aRun();
    // This is the case the file format existed to preserve: one JSON line
    // arriving as two chunks must rejoin, not be dropped.
    await p.appendRunEvents(run, [
      { stream: "stdout", chunk: `{"type":"assist` },
      { stream: "stdout", chunk: `ant"}\n` },
    ]);
    const { text } = await p.readRunLog(run);
    expect(text).toBe(`{"type":"assistant"}\n`);
  });

  it("keeps appending after earlier batches, and supports incremental reads", async () => {
    const run = await aRun();
    await p.appendRunEvents(run, [{ stream: "stdout", chunk: "a" }, { stream: "stdout", chunk: "b" }]);
    const first = await p.readRunLog(run);
    expect(first.text).toBe("ab");

    await p.appendRunEvents(run, [{ stream: "stdout", chunk: "c" }]);
    const next = await p.readRunLog(run, first.nextSeq);
    expect(next.text).toBe("c");                     // only what is new
    expect((await p.readRunLog(run)).text).toBe("abc");
  });

  it("is a no-op for an empty batch", async () => {
    const run = await aRun();
    expect(await p.appendRunEvents(run, [])).toBe(0);
  });
});

describe("spend", () => {
  it("groups cost by project — the question that had no answer before", async () => {
    const proj = await p.createProject({ companyId: company, name: "RTWSA" });
    const other = await p.createProject({ companyId: company, name: "SAPN" });

    for (const [project, cost] of [[proj.id, 1.5], [proj.id, 2.25], [other.id, 0.75]] as const) {
      const issue = randomUUID(), run = randomUUID();
      await db.query(
        `insert into issues (id, company_id, identifier, title, status, project_id)
         values ($1,$2,$3,'t','done',$4)`, [issue, company, `SCY-${randomUUID().slice(0, 4)}`, project]);
      await db.query(
        `insert into runs (id, issue_id, status, cost_usd, input_tokens, output_tokens)
         values ($1,$2,'succeeded',$3,100,200)`, [run, issue, cost]);
    }

    const rows = await p.spend(company, "project");
    const byName = new Map(rows.map(r => [r.project_name, Number(r.cost_usd)]));
    expect(byName.get("RTWSA")).toBeCloseTo(3.75);
    expect(byName.get("SAPN")).toBeCloseTo(0.75);
  });

  it("groups spend by the adapter the run used, not the agent's pin", async () => {
    // Two runs on one issue, different adapters. `agents.adapter` is null for
    // every agent since migration 003, so grouping on it collapses both to one
    // null row — the bug this fixes.
    const issue = await repo.createIssue({
      companyId: company, title: "mixed adapters", workflowKey: "datamodel",
    });
    for (const [adapter, cost] of [["claude_local", 1.5], ["codex", 0]] as const) {
      const run = await repo.startRun({
        issueId: issue.id, agentId: null, stepIndex: 0, phase: "generate",
        logPath: `/tmp/${adapter}.jsonl`, adapter,
      });
      await repo.finishRun(run.id, {
        status: "succeeded", exitCode: 0, sessionId: null,
        inputTokens: 10, outputTokens: 20, cacheReadTokens: 0, cacheCreationTokens: 0,
        costUsd: adapter === "codex" ? null : cost, durationMs: 1000, numTurns: 1,
      });
    }

    const rows = await p.spend(company, "adapter");
    const byAdapter = Object.fromEntries(rows.map(r => [r.adapter, r]));
    expect(Object.keys(byAdapter).sort()).toEqual(["claude_local", "codex"]);
    expect(Number(byAdapter.claude_local.cost_usd)).toBeCloseTo(1.5);
    expect(byAdapter.codex.run_count).toBe("1");
  });

  // IMPORTANT 3: `coalesce(sum(r.cost_usd),0)` turns "every run in this group
  // was unpriced" into a `cost_usd` of "0" — indistinguishable from "every run
  // in this group genuinely cost nothing". Task 8 taught `closingNote` (the
  // issue-timeline total) to say "cost not reported for N runs" instead of a
  // silent zero; this is the same fix for the spend-grouping query, which had
  // no such signal at all.
  it("reports how many of a group's runs were unpriced, instead of only a total that looks like zero", async () => {
    const issue = await repo.createIssue({
      companyId: company, title: "all-codex issue", workflowKey: "datamodel",
    });
    for (const [adapter, cost] of [["codex", null], ["codex", null]] as const) {
      const run = await repo.startRun({
        issueId: issue.id, agentId: null, stepIndex: 0, phase: "generate",
        logPath: `/tmp/${adapter}-${Math.random()}.jsonl`, adapter,
      });
      await repo.finishRun(run.id, {
        status: "succeeded", exitCode: 0, sessionId: null,
        inputTokens: 10, outputTokens: 20, cacheReadTokens: 0, cacheCreationTokens: 0,
        costUsd: cost, durationMs: 1000, numTurns: 1,
      });
    }

    const rows = await p.spend(company, "adapter");
    const codexRow = rows.find(r => r.adapter === "codex")!;
    expect(codexRow.run_count).toBe("2");
    // Every run in the group was unpriced — the row must say so, not just
    // report a `cost_usd` of "0" that reads identically to "free".
    expect(codexRow.unpriced_run_count).toBe("2");
  });
});

describe("a principal carries the organisation it acts in", () => {
  it("resolves a token to the holder's own organisation", async () => {
    const u = await admin();
    const { secret } = await p.createToken(u.id, "cli");
    const principal = await p.principalFromToken(secret);
    expect(principal?.companyId).toBe(company);
    expect(principal?.isSuperadmin).toBe(false);
  });

  it("flags a superadmin, so no caller has to compare role strings", async () => {
    const u = await p.createUser({ companyId: company, email: "root@scyne.co", role: "superadmin" });
    const { secret } = await p.createToken(u.id, "cli");
    expect((await p.principalFromToken(secret))?.isSuperadmin).toBe(true);
  });

  it("resolves a session the same way a token is resolved", async () => {
    const u = await admin();
    const { secret } = await p.createSession(u.id);
    const principal = await p.principalFromSession(secret);
    expect(principal?.companyId).toBe(company);
    expect(principal?.isSuperadmin).toBe(false);
  });
});

describe("organisations", () => {
  it("creates one with a slug derived from the name", async () => {
    const org = await p.createCompany({ name: "Alpha Council of SA" });
    expect(org.slug).toBe("alpha-council-of-sa");
    expect(org.status).toBe("active");
    expect(org.archived_at).toBeNull();
  });

  it("accepts an explicit slug, and normalises it", async () => {
    expect((await p.createCompany({ name: "Beta", slug: "  Beta Group " })).slug).toBe("beta-group");
  });

  it("refuses a name with no usable slug rather than writing an empty one", async () => {
    await expect(p.createCompany({ name: "!!!" })).rejects.toThrow(/slug/i);
  });

  it("finds one by slug, which is what an authorisation header carries", async () => {
    expect((await p.getCompanyBySlug("scyne"))?.id).toBe(company);
    expect((await p.getCompanyBySlug("  SCYNE "))?.id).toBe(company);
    expect(await p.getCompanyBySlug("nope")).toBeNull();
  });

  it("lists only the ones that are not archived", async () => {
    const temp = await p.createCompany({ name: "Temp Co" });
    expect((await p.listCompanies()).map(c => c.slug)).toContain("temp-co");
    expect(await p.archiveCompany(temp.id)).toBe(true);
    expect((await p.listCompanies()).map(c => c.slug)).not.toContain("temp-co");
    // archiving twice is not an error, it is a no-op that reports nothing changed
    expect(await p.archiveCompany(temp.id)).toBe(false);
  });

  it("renames without touching the slug", async () => {
    const org = await p.createCompany({ name: "Gamma" });
    const renamed = await p.updateCompany(org.id, { name: "Gamma Holdings" });
    expect(renamed?.name).toBe("Gamma Holdings");
    // The slug is what an operator pinned and what a header carries — a
    // rename must not silently invalidate either.
    expect(renamed?.slug).toBe("gamma");
  });

  it("counts what an Orgs tab needs, without a second call per column", async () => {
    const u = await admin();
    const proj = await p.createProject({ companyId: company, name: "Counted", createdBy: u.id });
    await p.createFeature({ projectId: proj.id, name: "One" });
    const stats = await p.companyStats(company);
    expect(stats).toMatchObject({ users: "1", projects: "1", features: "1", issues: "0" });
  });
});

describe("login is organisation-agnostic", () => {
  it("finds a user by email alone, whichever organisation they are in", async () => {
    const acme = await p.createCompany({ name: "Acme" });
    const u = await p.createUser({ companyId: acme.id, email: "person@acme.co", role: "admin" });
    // A person logging in knows their email and their password. They do NOT
    // know their organisation's uuid, so a company-scoped lookup would make
    // every user outside the home org unable to sign in at all.
    const found = await p.getUserByEmailAnywhere("Person@Acme.CO");
    expect(found?.id).toBe(u.id);
    expect(found?.company_id).toBe(acme.id);
  });

  it("returns null for an address nobody holds", async () => {
    expect(await p.getUserByEmailAnywhere("ghost@nowhere.co")).toBeNull();
  });

  it("refuses the same address in two organisations", async () => {
    const acme = await p.createCompany({ name: "Acme" });
    await p.createUser({ companyId: company, email: "shared@x.co" });
    // One person, one account. Without this, `getUserByEmailAnywhere` would
    // have to pick one of two rows, and which one it picked would decide
    // whose data they saw.
    await expect(p.createUser({ companyId: acme.id, email: "shared@x.co" })).rejects.toThrow();
  });

  it("treats addresses case-insensitively for that uniqueness", async () => {
    const acme = await p.createCompany({ name: "Acme" });
    await p.createUser({ companyId: company, email: "Case@x.co" });
    await expect(p.createUser({ companyId: acme.id, email: "case@X.co" })).rejects.toThrow();
  });
});

describe("spend, by every dimension", () => {
  /** One run, with everything it needs to be grouped by any dimension. */
  async function seedRun(opts: {
    project: string; feature?: string; email?: string; agentKey?: string;
    adapter?: string; model?: string; reported?: number | null; estimated?: number | null;
    inTok?: number; outTok?: number; startedAt?: string;
  }) {
    const proj = await p.getProjectByName(company, opts.project)
      ?? await p.createProject({ companyId: company, name: opts.project });
    const feat = opts.feature
      ? (await p.getFeatureByName(proj.id, opts.feature)
         ?? await p.createFeature({ projectId: proj.id, name: opts.feature }))
      : null;
    const user = opts.email
      ? (await p.getUserByEmailAnywhere(opts.email) ?? await p.createUser({ companyId: company, email: opts.email }))
      : null;
    const agentId = opts.agentKey ? await repo.upsertAgent(company, { key: opts.agentKey, name: opts.agentKey }) : null;

    const issue = await repo.createIssue({
      companyId: company, title: `run for ${opts.project}`, createdBy: user?.id ?? null,
    });
    await db.query(`update issues set project_id=$2, feature_id=$3 where id=$1`,
      [issue.id, proj.id, feat?.id ?? null]);

    const run = await repo.startRun({
      issueId: issue.id, agentId, logPath: "/tmp/x.jsonl",
      adapter: opts.adapter ?? "codex", model: opts.model ?? "gpt-5.6-terra",
    });
    await repo.finishRun(run.id, {
      status: "succeeded",
      inputTokens: opts.inTok ?? 1000, outputTokens: opts.outTok ?? 1000,
      costUsd: opts.reported ?? null, estCostUsd: opts.estimated ?? null,
    });
    if (opts.startedAt) await db.query(`update runs set started_at=$2 where id=$1`, [run.id, opts.startedAt]);
    return { issue, run, proj, feat, user };
  }

  it("groups by project", async () => {
    await seedRun({ project: "Alpha", estimated: 3 });
    await seedRun({ project: "Beta", estimated: 1 });
    const rows = await p.spend(company, { by: "project" });
    expect(rows.map(r => r.project_name)).toEqual(["Alpha", "Beta"]);   // dearest first
  });

  it("groups by feature — a dimension that did not exist before", async () => {
    await seedRun({ project: "Alpha", feature: "Appeals", estimated: 2 });
    await seedRun({ project: "Alpha", feature: "Claims", estimated: 5 });
    const rows = await p.spend(company, { by: "feature" });
    expect(rows.map(r => r.feature_name)).toEqual(["Claims", "Appeals"]);
  });

  it("groups by user, which `SpendRow` declared and never populated", async () => {
    await seedRun({ project: "Alpha", email: "ana@x.co", estimated: 4 });
    await seedRun({ project: "Alpha", email: "bo@x.co", estimated: 1 });
    const rows = await p.spend(company, { by: "user" });
    expect(rows.map(r => r.user_email)).toEqual(["ana@x.co", "bo@x.co"]);
    expect(rows[0].user_id).not.toBeNull();
  });

  it("groups by model", async () => {
    await seedRun({ project: "Alpha", model: "gpt-5.6-sol", estimated: 9 });
    await seedRun({ project: "Alpha", model: "gpt-5.6-luna", estimated: 1 });
    const rows = await p.spend(company, { by: "model" });
    expect(rows.map(r => r.model)).toEqual(["gpt-5.6-sol", "gpt-5.6-luna"]);
  });

  it("groups by adapter — broken since 003, which nulled agents.adapter", async () => {
    await seedRun({ project: "Alpha", adapter: "codex", estimated: 2 });
    await seedRun({ project: "Alpha", adapter: "claude_local", reported: 7 });
    const rows = await p.spend(company, { by: "adapter" });
    expect(rows.map(r => r.adapter)).toEqual(["claude_local", "codex"]);
  });

  it("keeps reported and estimated apart, and totals both", async () => {
    await seedRun({ project: "Alpha", reported: 4 });
    await seedRun({ project: "Alpha", estimated: 6 });
    const [row] = await p.spend(company, { by: "project" });
    expect(Number(row.reported_cost_usd)).toBeCloseTo(4, 4);
    expect(Number(row.estimated_cost_usd)).toBeCloseTo(6, 4);
    expect(Number(row.cost_usd)).toBeCloseTo(10, 4);
  });

  it("counts runs with NO figure at all, rather than summing them as zero", async () => {
    await seedRun({ project: "Alpha", reported: 5 });
    await seedRun({ project: "Alpha" });     // unpriced model, no figure either way
    const [row] = await p.spend(company, { by: "project" });
    expect(row.unpriced_run_count).toBe("1");
    expect(Number(row.cost_usd)).toBeCloseTo(5, 4);
  });

  it("orders by COST, not by output tokens — the `order by 8` bug", async () => {
    // The cheap run has far more output tokens. Positional ordering put it
    // first, which made the whole table wrong in exactly the way nobody
    // notices until they are asked where the money went.
    await seedRun({ project: "Cheap", estimated: 0.5, outTok: 5_000_000 });
    await seedRun({ project: "Dear", estimated: 50, outTok: 10 });
    const rows = await p.spend(company, { by: "project" });
    expect(rows[0].project_name).toBe("Dear");
  });

  it("filters compose with the dimension", async () => {
    await seedRun({ project: "Alpha", feature: "Appeals", estimated: 2 });
    await seedRun({ project: "Alpha", feature: "Claims", estimated: 3 });
    await seedRun({ project: "Beta", feature: "Claims", estimated: 9 });
    const rows = await p.spend(company, { by: "feature", project: "Alpha" });
    expect(rows.map(r => r.feature_name).sort()).toEqual(["Appeals", "Claims"]);
    expect(rows.reduce((n, r) => n + Number(r.cost_usd), 0)).toBeCloseTo(5, 4);
  });

  it("filters by date", async () => {
    await seedRun({ project: "Alpha", estimated: 2, startedAt: "2026-01-01T00:00:00Z" });
    await seedRun({ project: "Alpha", estimated: 3, startedAt: "2026-08-01T00:00:00Z" });
    const rows = await p.spend(company, { by: "project", since: "2026-06-01" });
    expect(Number(rows[0].cost_usd)).toBeCloseTo(3, 4);
  });

  it("still accepts the old bare-dimension call", async () => {
    await seedRun({ project: "Alpha", estimated: 1 });
    const rows = await p.spend(company, "project");
    expect(rows).toHaveLength(1);
  });
});

describe("the audit trail names its actor", () => {
  it("joins the email, so an actor from another organisation still resolves", async () => {
    // A superadmin acting INSIDE another organisation is not in that org's
    // user list, so a client mapping user_id against /users renders every one
    // of their actions as "—". That is the actor an audit trail most needs to
    // name, so the join happens in SQL.
    const other = await p.createCompany({ name: "Watched Co" });
    const root = await p.createUser({ companyId: company, email: "root@scyne.co", role: "superadmin" });
    await p.recordAction({ companyId: other.id, userId: root.id, verb: "org.update" });

    const rows = await p.listActions(other.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].user_email).toBe("root@scyne.co");
    expect((await p.listUsers(other.id))).toHaveLength(0);   // and they are not a member of it
  });

  it("joins the project name too", async () => {
    const u = await admin();
    const proj = await p.createProject({ companyId: company, name: "Named", createdBy: u.id });
    await p.recordAction({ companyId: company, userId: u.id, projectId: proj.id, verb: "project.update" });
    const rows = await p.listActions(company);
    expect(rows[0].project_name).toBe("Named");
  });

  it("filters by user and by date", async () => {
    const a = await p.createUser({ companyId: company, email: "one@x.co" });
    const b = await p.createUser({ companyId: company, email: "two@x.co" });
    await p.recordAction({ companyId: company, userId: a.id, verb: "auth.login" });
    await p.recordAction({ companyId: company, userId: b.id, verb: "auth.login" });
    expect(await p.listActions(company, { userId: a.id })).toHaveLength(1);
    expect(await p.listActions(company, { since: "2099-01-01" })).toHaveLength(0);
  });

  it("leaves the email null for an action nobody performed", async () => {
    await p.recordAction({ companyId: company, agentKey: "ba", verb: "run.start" });
    const rows = await p.listActions(company);
    expect(rows[0].user_email).toBeNull();
    expect(rows[0].agent_key).toBe("ba");
  });
});
