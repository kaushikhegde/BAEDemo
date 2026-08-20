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
async function call(
  method: string, path: string,
  opts: { token?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<Res> {
  const res = await fetch(baseUrl + path, {
    method,
    headers: {
      "content-type": "application/json",
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      ...(opts.headers ?? {}),
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
    // Claiming an installation IS what superadmin means — this person operates
    // the whole install, not one organisation inside it.
    expect(first.body.user.role).toBe("superadmin");
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
    expect(me.body).toMatchObject({
      email: "admin@scyne.co", role: "superadmin", authenticatedBy: "session",
    });

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

describe("the superadmin role cannot be granted sideways", () => {
  /** A genuine `admin` — bootstrap's claimer is a superadmin and cannot test this. */
  async function ordinaryAdmin(): Promise<string> {
    const root = await bootstrap();
    const made = await call("POST", "/users", {
      token: root, body: { email: "ordinary-admin@scyne.co", password: "pw", role: "admin" },
    });
    expect(made.status).toBe(201);
    const login = await call("POST", "/auth/login", {
      body: { email: "ordinary-admin@scyne.co", password: "pw" },
    });
    expect(login.status).toBe(200);
    return login.body.token;
  }

  it("refuses an ordinary administrator creating a superadmin", async () => {
    const token = await ordinaryAdmin();
    const me = await call("GET", "/auth/whoami", { token });
    // Guard the guard: if this ever starts handing back a superadmin the test
    // would pass for the wrong reason and stop protecting anything.
    expect(me.body.role).toBe("admin");

    const attempt = await call("POST", "/users", {
      token, body: { email: "escalate@scyne.co", password: "pw", role: "superadmin" },
    });
    expect(attempt.status).toBe(403);
    expect(String(attempt.body.error)).toMatch(/superadmin/i);
  });

  it("refuses an ordinary administrator promoting an existing user", async () => {
    const token = await ordinaryAdmin();
    const made = await call("POST", "/users", {
      token, body: { email: "ordinary@scyne.co", password: "pw", role: "member" },
    });
    expect(made.status).toBe(201);

    const promote = await call("PATCH", `/users/${made.body.id}`, { token, body: { role: "superadmin" } });
    expect(promote.status).toBe(403);
  });

  it("still allows the ordinary roles", async () => {
    const token = await bootstrap();
    for (const role of ["admin", "member", "viewer"]) {
      const r = await call("POST", "/users", {
        token, body: { email: `role-${role}@scyne.co`, password: "pw", role },
      });
      expect(r.status).toBe(201);
      expect(r.body.role).toBe(role);
    }
  });
});

describe("organisations", () => {
  /** The install-claimer is a superadmin; that is the only role that may manage orgs. */
  const root = () => bootstrap();

  async function adminOf(rootToken: string, email: string): Promise<string> {
    const made = await call("POST", "/users", {
      token: rootToken, body: { email, password: "pw", role: "admin" },
    });
    expect(made.status).toBe(201);
    const login = await call("POST", "/auth/login", { body: { email, password: "pw" } });
    return login.body.token;
  }

  it("lets a superadmin create and list them", async () => {
    const token = await root();
    const made = await call("POST", "/orgs", { token, body: { name: "Acme Pty Ltd" } });
    expect(made.status).toBe(201);
    expect(made.body.slug).toBe("acme-pty-ltd");

    const list = await call("GET", "/orgs", { token });
    expect(list.status).toBe(200);
    expect(list.body.map((o: { slug: string }) => o.slug)).toContain("acme-pty-ltd");
  });

  it("refuses an ordinary administrator creating one", async () => {
    const token = await adminOf(await root(), "org-admin@scyne.co");
    expect((await call("POST", "/orgs", { token, body: { name: "Nope" } })).status).toBe(403);
  });

  it("shows an ordinary administrator their own organisation, as a list of one", async () => {
    // Not a 403: the console's organisation switcher would then be an error
    // state for the majority of its users. A list of one is the honest answer
    // to "which organisations may I act in".
    const token = await adminOf(await root(), "org-admin2@scyne.co");
    const list = await call("GET", "/orgs", { token });
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].slug).toBe("scyne");
  });

  it("archives rather than deletes", async () => {
    const token = await root();
    const made = await call("POST", "/orgs", { token, body: { name: "Temp Co" } });
    expect((await call("DELETE", `/orgs/${made.body.id}`, { token })).status).toBe(200);
    const list = await call("GET", "/orgs", { token });
    expect(list.body.map((o: { slug: string }) => o.slug)).not.toContain("temp-co");
  });

  it("refuses to archive the home organisation, which owns the agent org chart", async () => {
    const token = await root();
    const list = await call("GET", "/orgs", { token });
    const home = list.body.find((o: { slug: string }) => o.slug === "scyne");
    const attempt = await call("DELETE", `/orgs/${home.id}`, { token });
    expect(attempt.status).toBe(400);
    expect(String(attempt.body.error)).toMatch(/home organisation/i);
  });

  it("reports counts a console can render without a call per column", async () => {
    const token = await root();
    const list = await call("GET", "/orgs", { token });
    const home = list.body.find((o: { slug: string }) => o.slug === "scyne");
    const one = await call("GET", `/orgs/${home.id}`, { token });
    expect(one.status).toBe(200);
    expect(one.body.stats).toMatchObject({
      users: expect.any(String), projects: expect.any(String),
      features: expect.any(String), issues: expect.any(String),
    });
  });

  it("hides another organisation from an ordinary administrator as 404, not 403", async () => {
    const rootToken = await root();
    const other = await call("POST", "/orgs", { token: rootToken, body: { name: "Hidden Co" } });
    const token = await adminOf(rootToken, "org-admin3@scyne.co");
    // 403 would confirm it exists. See this router's header.
    expect((await call("GET", `/orgs/${other.body.id}`, { token })).status).toBe(404);
  });

  it("renames, and the slug does not move under anyone's feet", async () => {
    const token = await root();
    const made = await call("POST", "/orgs", { token, body: { name: "Delta" } });
    const renamed = await call("PATCH", `/orgs/${made.body.id}`, { token, body: { name: "Delta Group" } });
    expect(renamed.status).toBe(200);
    expect(renamed.body.name).toBe("Delta Group");
    expect(renamed.body.slug).toBe("delta");
  });

  it("says which organisation whoami is answering for", async () => {
    const token = await root();
    const me = await call("GET", "/auth/whoami", { token });
    expect(me.body.company).toMatchObject({ slug: "scyne" });
    expect(me.body.isSuperadmin).toBe(true);
  });

  it("lets a superadmin act inside another organisation with X-Scyne-Org", async () => {
    const token = await root();
    const other = await call("POST", "/orgs", { token, body: { name: "Elsewhere" } });
    const me = await call("GET", "/auth/whoami", { token, headers: { "x-scyne-org": "elsewhere" } });
    expect(me.body.company.id).toBe(other.body.id);

    // and a project created there belongs there, not to the home org
    const proj = await call("POST", "/projects", {
      token, headers: { "x-scyne-org": "elsewhere" }, body: { name: "Elsewhere Claims" },
    });
    expect(proj.status).toBe(201);
    const homeProjects = await call("GET", "/projects", { token });
    expect(homeProjects.body.map((p: { name: string }) => p.name)).not.toContain("Elsewhere Claims");
  });
});

describe("project names are unique across the whole install", () => {
  it("refuses a name another organisation already owns", async () => {
    const token = await bootstrap();
    await call("POST", "/orgs", { token, body: { name: "Other Org" } });
    expect((await call("POST", "/projects", { token, body: { name: "RTWSA" } })).status).toBe(201);

    const clash = await call("POST", "/projects", {
      token, headers: { "x-scyne-org": "other-org" }, body: { name: "RTWSA" },
    });
    expect(clash.status).toBe(409);
    expect(clash.body.error).toBe("name_taken");
    expect(String(clash.body.message)).toMatch(/flat tree/i);
  });

  it("is case-insensitive, because the filesystem may be too", async () => {
    const token = await bootstrap();
    await call("POST", "/projects", { token, body: { name: "RTWSA" } });
    expect((await call("POST", "/projects", { token, body: { name: "rtwsa" } })).status).toBe(409);
  });
});

describe("the model price catalogue", () => {
  it("lists the seeded models, flagging retirement and unpriced rows", async () => {
    const token = await bootstrap();
    const res = await call("GET", "/models", { token });
    expect(res.status).toBe(200);

    const terra = res.body.find((m: any) => m.model === "gpt-5.6-terra");
    expect(Number(terra.input_per_mtok)).toBe(2);
    expect(terra.unpriced).toBe(false);

    // gpt-5.4 retires from Codex on 2026-08-31.
    const retiring = res.body.find((m: any) => m.model === "gpt-5.4");
    expect(retiring.retiring_soon || retiring.retired).toBe(true);

    // A model with no published price is UNPRICED, not free.
    const spark = res.body.find((m: any) => m.model === "gpt-5.3-codex-spark");
    expect(spark.unpriced).toBe(true);
    expect(spark.input_per_mtok).toBeNull();
  });

  it("lets an administrator correct one by hand", async () => {
    const token = await bootstrap();
    const res = await call("PUT", "/models/openai/gpt-5.6-terra", {
      token, body: { inputPerMTok: 2.5, outputPerMTok: 13 },
    });
    expect(res.status).toBe(200);
    expect(Number(res.body.input_per_mtok)).toBe(2.5);
  });

  it("refuses a negative or implausible rate rather than storing it", async () => {
    const token = await bootstrap();
    // NB: not Infinity — JSON.stringify turns it into `null`, which is the
    // legitimate "unpriced" value, so it never reaches the server as Infinity.
    for (const body of [{ inputPerMTok: -1 }, { inputPerMTok: 999_999 }, { outputPerMTok: "12.00" }]) {
      const res = await call("PUT", "/models/openai/gpt-5.6-terra", { token, body });
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });

  it("stores a refresh as a PROPOSAL with a diff, and does not apply it", async () => {
    const token = await bootstrap();
    const res = await call("POST", "/models/refresh", {
      token,
      body: {
        source: "https://developers.openai.com/api/docs/pricing",
        rows: [
          { provider: "openai", model: "gpt-5.6-terra", input_per_mtok: 3, output_per_mtok: 12 },
          { provider: "openai", model: "gpt-5.6-luna", input_per_mtok: 0.2, output_per_mtok: 1.2 },
        ],
      },
    });
    expect(res.status).toBe(200);
    // Only the one row that actually changes is in the diff — a proposal of
    // forty rows that alters two must not present forty for review.
    expect(res.body.diff.map((d: any) => d.model)).toEqual(["gpt-5.6-terra"]);
    expect(res.body.diff[0]).toMatchObject({ field: "input_per_mtok", from: "2.0000", to: "3" });

    // Nothing changed yet.
    const models = await call("GET", "/models", { token });
    expect(Number(models.body.find((m: any) => m.model === "gpt-5.6-terra").input_per_mtok)).toBe(2);
  });

  it("rejects a hallucinated price before it can be proposed", async () => {
    const token = await bootstrap();
    const res = await call("POST", "/models/refresh", {
      token, body: { rows: [{ model: "gpt-5.6-terra", input_per_mtok: 15000 }] },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_rows");
    expect(String(res.body.problems[0])).toMatch(/between 0 and/);
  });

  it("rejects a row with no model id, and a duplicated one", async () => {
    const token = await bootstrap();
    expect((await call("POST", "/models/refresh", {
      token, body: { rows: [{ input_per_mtok: 1 }] } })).status).toBe(400);
    expect((await call("POST", "/models/refresh", {
      token, body: { rows: [{ model: "x", input_per_mtok: 1 }, { model: "x", input_per_mtok: 2 }] } })).status)
      .toBe(400);
  });

  it("applies only on a superadmin's say-so", async () => {
    const token = await bootstrap();     // the claimer IS the superadmin
    await call("POST", "/models/refresh", {
      token, body: { rows: [{ provider: "openai", model: "gpt-5.6-terra", input_per_mtok: 3, output_per_mtok: 12 }] },
    });

    // An ordinary administrator may propose but not apply.
    await call("POST", "/users", { token, body: { email: "priceadmin@scyne.co", password: "pw", role: "admin" } });
    const adminToken = (await call("POST", "/auth/login", {
      body: { email: "priceadmin@scyne.co", password: "pw" } })).body.token;
    expect((await call("POST", "/models/refresh/apply", { token: adminToken })).status).toBe(403);

    const applied = await call("POST", "/models/refresh/apply", { token });
    expect(applied.status).toBe(200);
    expect(applied.body.applied).toBe(1);

    const models = await call("GET", "/models", { token });
    expect(Number(models.body.find((m: any) => m.model === "gpt-5.6-terra").input_per_mtok)).toBe(3);
  });

  it("keeps only one proposal outstanding", async () => {
    const token = await bootstrap();
    await call("POST", "/models/refresh", { token, body: { rows: [{ model: "gpt-5", input_per_mtok: 9 }] } });
    await call("POST", "/models/refresh", { token, body: { rows: [{ model: "gpt-5", input_per_mtok: 8 }] } });
    const pending = await call("GET", "/models/refresh", { token });
    // Two competing sets with no ordering between them is a way to apply the
    // older one by accident.
    expect(pending.body.rows).toHaveLength(1);
    expect(Number(pending.body.rows[0].input_per_mtok)).toBe(8);
  });

  it("can be discarded", async () => {
    const token = await bootstrap();
    await call("POST", "/models/refresh", { token, body: { rows: [{ model: "gpt-5", input_per_mtok: 9 }] } });
    expect((await call("DELETE", "/models/refresh", { token })).status).toBe(200);
    expect((await call("GET", "/models/refresh", { token })).body).toBeNull();
  });

  // A refresh submitted in the camelCase the rest of this API uses for writes
  // was accepted with 200, diffed as "changes nothing", and applied as a no-op
  // that answered `applied: 1`. Found by hand while walking the setup guide:
  // the whole price-refresh flow was inert unless you happened to spell the
  // fields the way the table does.
  it("reads a refresh written in camelCase, not only snake_case", async () => {
    const token = await bootstrap();
    const res = await call("POST", "/models/refresh", {
      token, body: { source: "pasted by hand", rows: [
        { provider: "openai", model: "gpt-5.6-terra", inputPerMTok: 2.5, outputPerMTok: 14 },
      ] },
    });
    expect(res.status).toBe(200);
    // It changes two fields, and says so.
    expect(res.body.diff).toHaveLength(2);

    expect((await call("POST", "/models/refresh/apply", { token })).body.applied).toBe(1);
    const after = (await call("GET", "/models", { token }))
      .body.find((m: any) => m.model === "gpt-5.6-terra");
    expect(Number(after.input_per_mtok)).toBe(2.5);
    expect(Number(after.output_per_mtok)).toBe(14);
  });

  it("applies the sanity ceiling whichever way the rate is spelled", async () => {
    const token = await bootstrap();
    // The ceiling is what stands between a hallucinated rate and every cost
    // budget in the install; it was reading a key camelCase rows never carry.
    const res = await call("POST", "/models/refresh", {
      token, body: { rows: [{ model: "gpt-5", inputPerMTok: 15_000 }] },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_rows");
  });

  it("refuses a row that names no price at all", async () => {
    const token = await bootstrap();
    // Otherwise a misspelled field is a proposal that reports "it changes
    // nothing" and then applies successfully, having changed nothing.
    const res = await call("POST", "/models/refresh", {
      token, body: { rows: [{ model: "gpt-5", inputRate: 3 }] },
    });
    expect(res.status).toBe(400);
    expect(res.body.problems.join(" ")).toContain("states no price");
  });

  it("keeps the cached rate when a hand correction does not mention it", async () => {
    const token = await bootstrap();
    const before = (await call("GET", "/models", { token }))
      .body.find((m: any) => m.model === "gpt-5.6-terra");
    expect(Number(before.cached_input_per_mtok)).toBeGreaterThan(0);

    // `scyne models set gpt-5.6-terra --input 2 --output 12` — no --cached.
    // This used to clear it, and since most of a long agent run's input is
    // cached, that silently raised the recorded cost of every run afterwards.
    const res = await call("PUT", "/models/openai/gpt-5.6-terra", {
      token, body: { inputPerMTok: 2, outputPerMTok: 12 },
    });
    expect(res.status).toBe(200);
    expect(Number(res.body.cached_input_per_mtok)).toBe(Number(before.cached_input_per_mtok));

    // An EXPLICIT null still clears it — absent and null are different facts.
    const cleared = await call("PUT", "/models/openai/gpt-5.6-terra", {
      token, body: { cachedInputPerMTok: null },
    });
    expect(cleared.body.cached_input_per_mtok).toBeNull();
  });
});

describe("the audit trail records organisation management where it can be seen", () => {
  it("files org.create under the ACTOR's organisation, not the new one", async () => {
    const token = await bootstrap();
    const made = await call("POST", "/orgs", { token, body: { name: "Audited Co" } });
    expect(made.status).toBe(201);

    // Looked at from the home organisation, which is where the superadmin was
    // standing. Filing it under the new org hides it from the only place
    // anyone would look — unless they first switch to the org whose creation
    // they are trying to find.
    const actions = await call("GET", "/actions", { token });
    const created = actions.body.find((a: { verb: string }) => a.verb === "org.create");
    expect(created).toBeTruthy();
    expect(created.target_id).toBe(made.body.id);
    expect(created.detail).toMatchObject({ name: "Audited Co", slug: "audited-co" });
  });

  it("records the archive too", async () => {
    const token = await bootstrap();
    const made = await call("POST", "/orgs", { token, body: { name: "Short Lived" } });
    await call("DELETE", `/orgs/${made.body.id}`, { token });
    const actions = await call("GET", "/actions", { token });
    expect(actions.body.some((a: { verb: string }) => a.verb === "org.archive")).toBe(true);
  });
});
