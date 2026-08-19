import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { openDb, migrate, type Db } from "../src/core/db.js";
import { createPlatformRepo, type PlatformRepo, type UserRow } from "../src/core/platform.js";
import { hashPassword } from "../src/core/auth.js";

let dir: string, db: Db, p: PlatformRepo, company: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "orch-plat-"));
  db = await openDb({ driver: "pglite", dir });
  await migrate(db, new URL("../migrations", import.meta.url).pathname);
  p = createPlatformRepo(db);
  company = randomUUID();
  await db.query(`insert into companies (id, name) values ($1,'Scyne')`, [company]);
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
});
