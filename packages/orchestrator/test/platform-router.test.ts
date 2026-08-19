import { describe, it, expect, beforeEach, afterEach } from "vitest";
import express from "express";
import type { Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOrchestrator, type Orchestrator } from "../src/index.js";
import { defineOrchestrator } from "../src/config.js";
import { createRouter } from "../src/http/router.js";

const fakeRunner = { run: async () => ({ exitCode: 0, status: "succeeded" as const, stderrTail: "", usage: null }) };

function config(workspace: string) {
  return defineOrchestrator({
    workspace,
    db: { driver: "pglite", dir: join(workspace, "pg") },
    adapters: { claude_local: fakeRunner },
    org: [{ key: "ba", name: "BA" }],
    workflows: [{ key: "requirements", label: "Requirements", assignee: "ba", steps: [{ type: "gate", title: "g" }] }],
  });
}

let dir: string, orch: Orchestrator, server: Server, baseUrl: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "orch-plat-http-"));
  orch = await createOrchestrator(config(dir));
  const app = express();
  app.use(express.json());
  app.use(createRouter(orch));
  await new Promise<void>(r => { server = app.listen(0, "127.0.0.1", () => r()); });
  const addr = server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});
afterEach(async () => {
  await new Promise<void>(r => server.close(() => r()));
  await orch.close();
  rmSync(dir, { recursive: true, force: true });
});

type Res = { status: number; body: any };
async function call(method: string, path: string, opts: { token?: string; body?: unknown } = {}): Promise<Res> {
  const res = await fetch(baseUrl + path, {
    method,
    headers: {
      "content-type": "application/json",
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

/** Bootstrap the first admin and return their token. */
async function bootstrap(): Promise<string> {
  const r = await call("POST", "/auth/bootstrap", { body: { email: "admin@scyne.co", password: "pw-admin" } });
  expect(r.status).toBe(201);
  return r.body.token;
}

async function makeUser(adminToken: string, email: string, role = "member"): Promise<{ id: string; token: string }> {
  const u = await call("POST", "/users", { token: adminToken, body: { email, password: "pw", role } });
  expect(u.status).toBe(201);
  const login = await call("POST", "/auth/login", { body: { email, password: "pw" } });
  expect(login.status).toBe(200);
  return { id: u.body.id, token: login.body.token };
}

describe("bootstrap and login", () => {
  it("claims an empty installation once, then refuses forever", async () => {
    const first = await call("POST", "/auth/bootstrap", { body: { email: "a@b.co", password: "pw" } });
    expect(first.status).toBe(201);
    expect(first.body.user.role).toBe("admin");
    expect(first.body.token).toMatch(/^scy_/);

    const second = await call("POST", "/auth/bootstrap", { body: { email: "c@d.co", password: "pw" } });
    expect(second.status).toBe(403);
    expect(second.body.error).toContain("already has users");
  });

  it("logs in, identifies itself, and logs out", async () => {
    await bootstrap();
    const login = await call("POST", "/auth/login", { body: { email: "admin@scyne.co", password: "pw-admin" } });
    expect(login.status).toBe(200);

    const me = await call("GET", "/auth/whoami", { token: login.body.token });
    expect(me.body).toMatchObject({ email: "admin@scyne.co", role: "admin", authenticatedBy: "session" });

    await call("POST", "/auth/logout", { token: login.body.token });
    expect((await call("GET", "/auth/whoami", { token: login.body.token })).status).toBe(401);
  });

  it("gives the same answer for a wrong password and an unknown address", async () => {
    await bootstrap();
    const wrongPw = await call("POST", "/auth/login", { body: { email: "admin@scyne.co", password: "nope" } });
    const noUser = await call("POST", "/auth/login", { body: { email: "ghost@scyne.co", password: "nope" } });
    expect(wrongPw.status).toBe(401);
    expect(noUser.status).toBe(401);
    expect(wrongPw.body.error).toBe(noUser.body.error);   // no account enumeration
  });
});

describe("authentication is required", () => {
  it("401s every protected route without a credential", async () => {
    await bootstrap();
    for (const [m, p] of [["GET", "/projects"], ["POST", "/projects"], ["GET", "/auth/whoami"],
                          ["GET", "/users"], ["GET", "/installations"], ["GET", "/spend"]] as const) {
      expect((await call(m, p, m === "POST" ? { body: {} } : {})).status, `${m} ${p}`).toBe(401);
    }
  });

  it("401s a revoked token", async () => {
    const admin = await bootstrap();
    const t = await call("POST", "/auth/tokens", { token: admin, body: { name: "cli" } });
    expect((await call("GET", "/auth/whoami", { token: t.body.token })).status).toBe(200);

    await call("DELETE", `/auth/tokens/${t.body.id}`, { token: admin });
    expect((await call("GET", "/auth/whoami", { token: t.body.token })).status).toBe(401);
  });

  it("401s a fabricated token", async () => {
    await bootstrap();
    expect((await call("GET", "/projects", { token: "scy_made-up" })).status).toBe(401);
  });
});

describe("project visibility", () => {
  it("hides another user's project as 404, not 403 — a 403 would confirm it exists", async () => {
    const admin = await bootstrap();
    const alice = await makeUser(admin, "alice@x.co");
    const bob = await makeUser(admin, "bob@x.co");

    const proj = await call("POST", "/projects", { token: alice.token, body: { name: "Alpha" } });
    expect(proj.status).toBe(201);

    expect((await call("GET", `/projects/${proj.body.id}`, { token: bob.token })).status).toBe(404);
    expect((await call("GET", "/projects", { token: bob.token })).body).toEqual([]);
    expect((await call("GET", "/projects", { token: alice.token })).body).toHaveLength(1);
  });

  it("shows an admin every project without a membership row", async () => {
    const admin = await bootstrap();
    const alice = await makeUser(admin, "alice@x.co");
    await call("POST", "/projects", { token: alice.token, body: { name: "Alpha" } });
    expect((await call("GET", "/projects", { token: admin })).body).toHaveLength(1);
  });

  it("makes the creator an owner so a new project is not immediately unreachable", async () => {
    const admin = await bootstrap();
    const alice = await makeUser(admin, "alice@x.co");
    const proj = await call("POST", "/projects", { token: alice.token, body: { name: "Alpha" } });
    expect((await call("GET", `/projects/${proj.body.id}`, { token: alice.token })).body.role).toBe("owner");
  });
});

describe("project roles", () => {
  it("lets an owner grant access, and a viewer read but not write", async () => {
    const admin = await bootstrap();
    const owner = await makeUser(admin, "owner@x.co");
    const guest = await makeUser(admin, "guest@x.co");
    const proj = (await call("POST", "/projects", { token: owner.token, body: { name: "Alpha" } })).body;

    await call("PUT", `/projects/${proj.id}/members/${guest.id}`, { token: owner.token, body: { role: "viewer" } });

    expect((await call("GET", `/projects/${proj.id}`, { token: guest.token })).status).toBe(200);
    // A viewer may not add a feature or upload a document.
    expect((await call("POST", `/projects/${proj.id}/features`, { token: guest.token, body: { name: "F" } })).status).toBe(403);
    expect((await call("POST", `/projects/${proj.id}/documents`,
      { token: guest.token, body: { path: "a.md", content: "x" } })).status).toBe(403);
  });

  it("refuses an editor the power to change who else has access", async () => {
    const admin = await bootstrap();
    const owner = await makeUser(admin, "owner@x.co");
    const editor = await makeUser(admin, "editor@x.co");
    const outsider = await makeUser(admin, "out@x.co");
    const proj = (await call("POST", "/projects", { token: owner.token, body: { name: "Alpha" } })).body;
    await call("PUT", `/projects/${proj.id}/members/${editor.id}`, { token: owner.token, body: { role: "editor" } });

    // An editor may add features…
    expect((await call("POST", `/projects/${proj.id}/features`, { token: editor.token, body: { name: "F" } })).status).toBe(201);
    // …but not grant access.
    expect((await call("PUT", `/projects/${proj.id}/members/${outsider.id}`,
      { token: editor.token, body: { role: "editor" } })).status).toBe(403);
  });

  it("validates the role name rather than storing whatever was sent", async () => {
    const admin = await bootstrap();
    const owner = await makeUser(admin, "owner@x.co");
    const guest = await makeUser(admin, "guest@x.co");
    const proj = (await call("POST", "/projects", { token: owner.token, body: { name: "Alpha" } })).body;
    const r = await call("PUT", `/projects/${proj.id}/members/${guest.id}`,
      { token: owner.token, body: { role: "superuser" } });
    expect(r.status).toBe(400);
  });
});

describe("administrator-only routes", () => {
  it("refuses a member installations and spend", async () => {
    const admin = await bootstrap();
    const alice = await makeUser(admin, "alice@x.co");
    for (const p of ["/installations", "/spend"]) {
      expect((await call("GET", p, { token: alice.token })).status, p).toBe(403);
      expect((await call("GET", p, { token: admin })).status, p).toBe(200);
    }
  });

  it("gives a member a redacted user directory, not a refusal", async () => {
    // Granting someone access to a project means naming them, so a project
    // owner who is not an administrator must be able to look colleagues up.
    // What they must NOT see is anything beyond identity.
    const admin = await bootstrap();
    const alice = await makeUser(admin, "alice@x.co");

    const asMember = await call("GET", "/users", { token: alice.token });
    expect(asMember.status).toBe(200);
    expect(asMember.body.length).toBeGreaterThan(0);
    for (const u of asMember.body) {
      expect(Object.keys(u).sort()).toEqual(["email", "id", "name"]);
      expect(u.role).toBeUndefined();
      expect(u.status).toBeUndefined();
    }

    const asAdmin = await call("GET", "/users", { token: admin });
    expect(asAdmin.body[0].role).toBeTruthy();
    expect(asAdmin.body.every((u: any) => u.password_hash === undefined)).toBe(true);
  });

  it("hides a disabled account from the member directory", async () => {
    const admin = await bootstrap();
    const alice = await makeUser(admin, "alice@x.co");
    const bob = await makeUser(admin, "bob@x.co");
    await call("PATCH", `/users/${bob.id}`, { token: admin, body: { status: "disabled" } });

    const emails = (await call("GET", "/users", { token: alice.token })).body.map((u: any) => u.email);
    expect(emails).toContain("alice@x.co");
    expect(emails).not.toContain("bob@x.co");
  });
});

describe("features and documents", () => {
  it("refuses a reserved feature name", async () => {
    const admin = await bootstrap();
    const proj = (await call("POST", "/projects", { token: admin, body: { name: "RTWSA" } })).body;
    const r = await call("POST", `/projects/${proj.id}/features`, { token: admin, body: { name: "personas" } });
    expect(r.status).toBe(400);
    expect(r.body.error).toContain("reserved");
  });

  it("uploads a document, reports a no-op re-upload, and reads the bytes back", async () => {
    const admin = await bootstrap();
    const proj = (await call("POST", "/projects", { token: admin, body: { name: "RTWSA" } })).body;
    await call("POST", `/projects/${proj.id}/features`, { token: admin, body: { name: "Appeals" } });

    const up = await call("POST", `/projects/${proj.id}/documents`, {
      token: admin,
      body: { feature: "Appeals", path: "requirements/SOP/policy.md", content: "the policy", category: "sop" },
    });
    expect(up.status).toBe(201);
    expect(up.body.changed).toBe(true);
    expect(up.body.version).toBe(1);

    const again = await call("POST", `/projects/${proj.id}/documents`, {
      token: admin, body: { feature: "Appeals", path: "requirements/SOP/policy.md", content: "the policy" },
    });
    expect(again.body.changed).toBe(false);
    expect(again.body.version).toBe(1);

    const read = await call("GET", `/projects/${proj.id}/documents/${up.body.id}`, { token: admin });
    expect(Buffer.from(read.body.content, "base64").toString()).toBe("the policy");
  });

  it("round-trips binary content through base64", async () => {
    const admin = await bootstrap();
    const proj = (await call("POST", "/projects", { token: admin, body: { name: "RTWSA" } })).body;
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);

    const up = await call("POST", `/projects/${proj.id}/documents`, {
      token: admin, body: { path: "design/logo.png", content: png.toString("base64"), encoding: "base64" },
    });
    const read = await call("GET", `/projects/${proj.id}/documents/${up.body.id}`, { token: admin });
    expect(Buffer.compare(Buffer.from(read.body.content, "base64"), png)).toBe(0);
  });

  it("404s a document listing for a feature that does not exist", async () => {
    const admin = await bootstrap();
    const proj = (await call("POST", "/projects", { token: admin, body: { name: "RTWSA" } })).body;
    expect((await call("GET", `/projects/${proj.id}/documents?feature=Nope`, { token: admin })).status).toBe(404);
  });
});

describe("audit", () => {
  it("records who did what, without being asked to", async () => {
    const admin = await bootstrap();
    const proj = (await call("POST", "/projects", { token: admin, body: { name: "RTWSA" } })).body;
    await call("POST", `/projects/${proj.id}/features`, { token: admin, body: { name: "Appeals" } });
    await call("POST", `/projects/${proj.id}/documents`, {
      token: admin, body: { feature: "Appeals", path: "a.md", content: "x" } });

    const actions = await call("GET", `/projects/${proj.id}/actions`, { token: admin });
    const verbs = actions.body.map((a: any) => a.verb);
    expect(verbs).toContain("project.create");
    expect(verbs).toContain("feature.create");
    expect(verbs).toContain("doc.upload");
    expect(actions.body.every((a: any) => a.user_id)).toBe(true);
  });
});

describe("installations", () => {
  it("registers a machine and revokes it", async () => {
    const admin = await bootstrap();
    const reg = await call("POST", "/installations", {
      token: admin, body: { machineId: "m1", hostname: "alice-mbp", os: "darwin", pluginVersion: "0.3.1" },
    });
    expect(reg.status).toBe(201);
    expect((await call("GET", "/installations", { token: admin })).body).toHaveLength(1);

    expect((await call("DELETE", `/installations/${reg.body.id}`, { token: admin })).status).toBe(200);
    expect((await call("GET", "/installations", { token: admin })).body[0].revoked_at).not.toBeNull();
  });
});

describe("conflicts", () => {
  it("reports a duplicate project name as 409, not 500", async () => {
    const admin = await bootstrap();
    await call("POST", "/projects", { token: admin, body: { name: "RTWSA" } });
    expect((await call("POST", "/projects", { token: admin, body: { name: "RTWSA" } })).status).toBe(409);
  });
});
