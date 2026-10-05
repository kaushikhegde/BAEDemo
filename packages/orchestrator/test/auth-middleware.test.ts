import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { openDb, migrate, type Db } from "../src/core/db.js";
import { createPlatformRepo, type PlatformRepo } from "../src/core/platform.js";
import { createAuth, OrgScopeError, type AuthedRequest } from "../src/http/auth-middleware.js";

let dir: string, db: Db, p: PlatformRepo, home: string, other: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "orch-authmw-"));
  db = await openDb({ driver: "pglite", dir });
  await migrate(db, fileURLToPath(new URL("../migrations", import.meta.url)));
  p = createPlatformRepo(db);
  home = randomUUID();
  await db.query(`insert into companies (id, name, slug) values ($1,'Scyne','scyne')`, [home]);
  other = (await p.createCompany({ name: "Acme" })).id;
});
afterEach(async () => { await db.close(); rmSync(dir, { recursive: true, force: true }); });

let seq = 0;
const tokenFor = async (companyId: string, role: string): Promise<string> => {
  const u = await p.createUser({ companyId, email: `u${seq++}@test.co`, role });
  return (await p.createToken(u.id, "test")).secret;
};
const reqWith = (headers: Record<string, string>) => ({ headers } as unknown as AuthedRequest);

describe("createAuth().authenticate", () => {
  it("resolves a credential to the holder's own organisation", async () => {
    const auth = createAuth(p, home);
    const principal = await auth.authenticate(
      reqWith({ authorization: `Bearer ${await tokenFor(home, "admin")}` }));
    expect(principal?.companyId).toBe(home);
    expect(principal?.isSuperadmin).toBe(false);
  });

  it("returns null with no credential at all", async () => {
    expect(await createAuth(p, home).authenticate(reqWith({}))).toBeNull();
  });

  it("returns null for a credential that is not ours", async () => {
    expect(await createAuth(p, home).authenticate(reqWith({ authorization: "Bearer scy_nonsense" })))
      .toBeNull();
  });

  it("lets a superadmin retarget the organisation, by id or by slug", async () => {
    const auth = createAuth(p, home);
    const secret = await tokenFor(home, "superadmin");
    expect((await auth.authenticate(reqWith({ authorization: `Bearer ${secret}`, "x-scyne-org": other })))?.companyId)
      .toBe(other);
    expect((await auth.authenticate(reqWith({ authorization: `Bearer ${secret}`, "x-scyne-org": "acme" })))?.companyId)
      .toBe(other);
  });

  it("REFUSES an X-Scyne-Org from anyone else rather than ignoring it", async () => {
    const auth = createAuth(p, home);
    const secret = await tokenFor(home, "admin");
    // Silently ignoring an authorisation-shaped header teaches a caller that
    // it worked. It did not.
    await expect(auth.authenticate(reqWith({ authorization: `Bearer ${secret}`, "x-scyne-org": other })))
      .rejects.toThrow(OrgScopeError);
  });

  it("refuses an unknown organisation, even from a superadmin", async () => {
    const auth = createAuth(p, home);
    const secret = await tokenFor(home, "superadmin");
    await expect(auth.authenticate(reqWith({ authorization: `Bearer ${secret}`, "x-scyne-org": "does-not-exist" })))
      .rejects.toThrow(/organisation/i);
  });

  it("refuses an ARCHIVED organisation", async () => {
    const auth = createAuth(p, home);
    const secret = await tokenFor(home, "superadmin");
    await p.archiveCompany(other);
    await expect(auth.authenticate(reqWith({ authorization: `Bearer ${secret}`, "x-scyne-org": "acme" })))
      .rejects.toThrow(/archived/i);
  });

  it("ignores an EMPTY org header rather than treating it as a request", async () => {
    const auth = createAuth(p, home);
    const secret = await tokenFor(home, "admin");
    const principal = await auth.authenticate(
      reqWith({ authorization: `Bearer ${secret}`, "x-scyne-org": "   " }));
    expect(principal?.companyId).toBe(home);
  });

  it("does not confuse a slug with a uuid when looking one up", async () => {
    // getCompany() is tried first and takes a uuid column; a slug passed to it
    // RAISES in postgres rather than returning no rows, so the fallback has to
    // survive that rather than propagate it as a 500.
    const auth = createAuth(p, home);
    const secret = await tokenFor(home, "superadmin");
    expect((await auth.authenticate(reqWith({ authorization: `Bearer ${secret}`, "x-scyne-org": "acme" })))?.companyId)
      .toBe(other);
  });
});

describe("createAuth() role guards", () => {
  const resSpy = () => {
    const out = { status: 0, body: null as unknown };
    return {
      res: {
        status(code: number) { out.status = code; return this; },
        json(body: unknown) { out.body = body; return this; },
      } as never,
      out,
    };
  };

  it("requireAdmin accepts an admin and a superadmin, refuses a member", async () => {
    const auth = createAuth(p, home);
    for (const [role, expected] of [["superadmin", true], ["admin", true], ["member", false], ["viewer", false]] as const) {
      const { res, out } = resSpy();
      const req = { principal: { user: { role } } } as unknown as AuthedRequest;
      expect(auth.requireAdmin(req, res)).toBe(expected);
      if (!expected) expect(out.status).toBe(403);
    }
  });

  it("requireSuperadmin accepts ONLY a superadmin", async () => {
    const auth = createAuth(p, home);
    for (const [role, expected] of [["superadmin", true], ["admin", false], ["member", false]] as const) {
      const { res, out } = resSpy();
      const req = { principal: { user: { role } } } as unknown as AuthedRequest;
      expect(auth.requireSuperadmin(req, res)).toBe(expected);
      if (!expected) expect(out.status).toBe(403);
    }
  });

  it("refuses when there is no principal at all", async () => {
    const auth = createAuth(p, home);
    const { res } = resSpy();
    expect(auth.requireAdmin({} as AuthedRequest, res)).toBe(false);
    expect(auth.requireSuperadmin({} as AuthedRequest, res)).toBe(false);
  });
});

describe("the browser's credential", () => {
  it("reads a session cookie, so the console never handles a token itself", async () => {
    const auth = createAuth(p, home);
    const u = await p.createUser({ companyId: home, email: "browser@test.co", role: "admin" });
    const { secret } = await p.createSession(u.id);
    // An httpOnly cookie is the one credential JavaScript cannot read — which
    // is the point. The console's fetches carry it automatically, same-origin,
    // and no console code ever touches a token.
    const principal = await auth.authenticate(
      { headers: { cookie: `scyne_session=${encodeURIComponent(secret)}` } } as unknown as AuthedRequest);
    expect(principal?.user.email).toBe("browser@test.co");
  });

  it("prefers an explicit Authorization header over a cookie", async () => {
    const auth = createAuth(p, home);
    const cli = await p.createUser({ companyId: home, email: "cli@test.co", role: "admin" });
    const browser = await p.createUser({ companyId: home, email: "browser2@test.co", role: "admin" });
    const token = (await p.createToken(cli.id, "cli")).secret;
    const cookie = (await p.createSession(browser.id)).secret;
    // A tool that went to the trouble of sending a header means it.
    const principal = await auth.authenticate({
      headers: { authorization: `Bearer ${token}`, cookie: `scyne_session=${encodeURIComponent(cookie)}` },
    } as unknown as AuthedRequest);
    expect(principal?.user.email).toBe("cli@test.co");
  });

  it("ignores an unrelated cookie", async () => {
    const auth = createAuth(p, home);
    expect(await auth.authenticate(
      { headers: { cookie: "other=1; theme=dark" } } as unknown as AuthedRequest)).toBeNull();
  });

  it("survives a cookie value containing an = sign", async () => {
    const auth = createAuth(p, home);
    const u = await p.createUser({ companyId: home, email: "eq@test.co", role: "admin" });
    const { secret } = await p.createSession(u.id);
    expect((await auth.authenticate({
      headers: { cookie: `a=1; scyne_session=${encodeURIComponent(secret)}; z=2` },
    } as unknown as AuthedRequest))?.user.email).toBe("eq@test.co");
  });
});
