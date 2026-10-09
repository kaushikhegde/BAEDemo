// The platform HTTP surface: identity, projects, features, documents, access,
// installations, chats, audit and spend.
//
// A separate router from http/router.ts, mounted beside it, for the same
// reason core/platform.ts is separate from core/repo.ts: that one is the
// engine's API (issues, runs, gates) and this one is the product's. Its route
// table is re-exported into `ROUTES` so the OpenAPI contract test still checks
// both directions across the whole surface — one contract, two files.
//
// Every route here authenticates. The exceptions are deliberate and narrow:
// `POST /auth/bootstrap`, which works only while the company has no users at
// all, `GET /auth/status`, which says whether that is still the case, and
// `POST /auth/login`.
//
// The rule that shapes the rest: a project a caller may not see returns 404,
// never 403. A 403 confirms the project exists, which is exactly the fact a
// caller without access should not be able to learn.

import { Router, type Request, type Response, type NextFunction } from "express";
import { createDocumentStore } from "../core/documents.js";
import {
  createAuth, clearSessionCookieHeader, cookieCredential, sessionCookieHeader, type AuthedRequest,
} from "./auth-middleware.js";
import { createPlatformRepo, type PlatformRepo, type Principal } from "../core/platform.js";
import {
  bearerFrom, hashPassword, verifyPassword, isGlobalRole, isProjectRole, atLeast,
  atLeastGlobal, isSuperadmin,
  type ProjectRole,
} from "../core/auth.js";
import type { Orchestrator } from "../index.js";

export const PLATFORM_ROUTES = [
  { method: "POST",   path: "/auth/bootstrap" },
  { method: "GET",    path: "/auth/status" },
  { method: "POST",   path: "/auth/login" },
  { method: "POST",   path: "/auth/logout" },
  { method: "GET",    path: "/auth/whoami" },
  { method: "GET",    path: "/auth/tokens" },
  { method: "POST",   path: "/auth/tokens" },
  { method: "DELETE", path: "/auth/tokens/{id}" },
  { method: "GET",    path: "/orgs" },
  { method: "POST",   path: "/orgs" },
  { method: "GET",    path: "/orgs/{id}" },
  { method: "PATCH",  path: "/orgs/{id}" },
  { method: "DELETE", path: "/orgs/{id}" },
  { method: "GET",    path: "/users" },
  { method: "POST",   path: "/users" },
  { method: "PATCH",  path: "/users/{id}" },
  { method: "GET",    path: "/projects" },
  { method: "POST",   path: "/projects" },
  { method: "GET",    path: "/projects/{id}" },
  { method: "PATCH",  path: "/projects/{id}" },
  { method: "GET",    path: "/projects/{id}/members" },
  { method: "PUT",    path: "/projects/{id}/members/{userId}" },
  { method: "DELETE", path: "/projects/{id}/members/{userId}" },
  { method: "GET",    path: "/projects/{id}/features" },
  { method: "POST",   path: "/projects/{id}/features" },
  { method: "GET",    path: "/projects/{id}/documents" },
  { method: "POST",   path: "/projects/{id}/documents" },
  { method: "GET",    path: "/projects/{id}/documents/{docId}" },
  { method: "DELETE", path: "/projects/{id}/documents" },
  { method: "GET",    path: "/projects/{id}/actions" },
  { method: "GET",    path: "/actions" },
  { method: "GET",    path: "/admin/overview" },
  { method: "GET",    path: "/settings" },
  { method: "PUT",    path: "/settings" },
  { method: "DELETE", path: "/settings" },
  { method: "GET",    path: "/installations" },
  { method: "POST",   path: "/installations" },
  { method: "DELETE", path: "/installations/{id}" },
  { method: "GET",    path: "/conversations" },
  { method: "POST",   path: "/conversations" },
  { method: "GET",    path: "/conversations/{id}/messages" },
  { method: "POST",   path: "/conversations/{id}/messages" },
  { method: "DELETE", path: "/conversations/{id}" },
  { method: "GET",    path: "/spend" },
  { method: "GET",    path: "/models" },
  { method: "PUT",    path: "/models/{provider}/{model}" },
  { method: "GET",    path: "/models/refresh" },
  { method: "POST",   path: "/models/refresh" },
  { method: "POST",   path: "/models/refresh/apply" },
  { method: "DELETE", path: "/models/refresh" },
] as const;

export function createPlatformRouter(orch: Orchestrator): Router {
  const r = Router();
  const platform: PlatformRepo = createPlatformRepo(orch.db);
  // The backend the CONSUMER configured. There is no fallback: `blobs.content`
  // was dropped by 011, so an install without one has nowhere to put a
  // document — and storing them somewhere nobody chose is worse than saying so.
  // `createOrchestrator` refuses to boot without it, so this is unreachable.
  const docs = createDocumentStore(orch.db, orch.config.blobs!);

  const ok = (res: Response, body: unknown): void => { res.json(body); };
  const created = (res: Response, body: unknown): void => { res.status(201).json(body); };
  const bad = (res: Response, m: string): void => { res.status(400).json({ error: m }); };
  const denied = (res: Response, m = "forbidden"): void => { res.status(403).json({ error: m }); };
  const missing = (res: Response, what: string): void => { res.status(404).json({ error: `${what} not found` }); };
  const wrap = (fn: (req: AuthedRequest, res: Response) => Promise<void>) =>
    (req: Request, res: Response): void => {
      void fn(req as AuthedRequest, res).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        // A unique-violation is a caller error (that name is taken), not a
        // server fault; reporting it as 500 sends a user to the logs for
        // something they can fix in the next command.
        const conflict = /duplicate key|unique constraint/i.test(message);
        res.status(conflict ? 409 : 500).json({ error: message });
      });
    };

  // Identity is resolved by the SHARED middleware, not by a copy living here:
  // http/router.ts needs the identical check, and two implementations of an
  // authorisation check drift. See http/auth-middleware.ts.
  const { requireAuth, requireAdmin, requireSuperadmin } = createAuth(platform, orch.homeCompanyId);

  /**
   * Only a superadmin may grant or revoke `superadmin`.
   *
   * Without this, adding `superadmin` to GLOBAL_ROLES silently handed every
   * ORDINARY administrator a privilege-escalation path: `POST /users` and
   * `PATCH /users/{id}` both validate the role with `isGlobalRole`, which now
   * accepts it. An admin could mint themselves a superadmin account and cross
   * into every other organisation in the install.
   *
   * Returns true when the request may proceed, having ALREADY responded when
   * it may not — same shape as requireAdmin below.
   */
  const mayAssignRole = (req: AuthedRequest, res: Response, role: unknown): boolean => {
    if (role === undefined || role === null) return true;
    if (!isSuperadmin(String(role))) return true;
    if (isSuperadmin(req.principal?.user.role)) return true;
    denied(res, "only a superadmin may grant the superadmin role");
    return false;
  };

  /**
   * Resolve `:id` to a project the caller may act on at `need`, or answer 404.
   *
   * Returns null having ALREADY responded, so a handler reads as
   * `const p = await project(...); if (!p) return;`.
   */
  const project = async (req: AuthedRequest, res: Response, need: ProjectRole) => {
    const row = await platform.getProject(String(req.params.id));
    if (!row || row.company_id !== req.principal!.companyId) { missing(res, "project"); return null; }
    const role = await platform.projectRole(req.principal!.user, row.id);
    // No access is reported as absence, not as refusal — see the header.
    if (!role) { missing(res, "project"); return null; }
    if (!atLeast(role, need)) { denied(res, `this action needs ${need} on the project`); return null; }
    req.projectRole = role;
    return row;
  };

  const audit = (req: AuthedRequest, verb: string, extra: Record<string, unknown> = {}) =>
    platform.recordAction({
      // `?? homeCompanyId` for /auth/bootstrap, the one audited route with no
      // principal yet — it is claiming the installation, so home is correct.
      companyId: req.principal?.companyId ?? orch.homeCompanyId,
      verb, userId: req.principal?.user.id ?? null,
      installationId: req.principal?.installationId ?? null, ...extra,
    });

  // ------------------------------------------------------------------ auth

  /**
   * Claim an empty installation. Open by necessity — there is no one to
   * authenticate as yet — and closed the instant a first user exists, which
   * `isUnclaimed` checks inside the same request rather than trusting a flag.
   */
  r.post("/auth/bootstrap", wrap(async (req, res) => {
    const { email, password, name } = req.body ?? {};
    if (!email || !password) return bad(res, "email and password are required");
    if (!(await platform.isUnclaimed(orch.homeCompanyId))) {
      return denied(res, "this installation already has users — ask an administrator for an account");
    }
    const user = await platform.createUser({
      // Claiming an installation is exactly what `superadmin` means: this
      // person operates the whole thing, not one organisation inside it.
      companyId: orch.homeCompanyId, email, name: name ?? null,
      role: "superadmin", passwordHash: await hashPassword(password),
    });
    const { secret } = await platform.createToken(user.id, "bootstrap");
    await audit(req, "auth.bootstrap", { userId: user.id, targetType: "user", targetId: user.id });
    created(res, { user: { id: user.id, email: user.email, role: user.role }, token: secret });
  }));

  /**
   * Whether the installation has been claimed. Open for the same reason as
   * bootstrap — it is asked before anyone can sign in — and it reveals nothing
   * a 403 from bootstrap does not. Setup reads it to decide whether to ask for
   * a first login at all.
   */
  r.get("/auth/status", wrap(async (_req, res) => {
    res.json({ claimed: !(await platform.isUnclaimed(orch.homeCompanyId)) });
  }));

  r.post("/auth/login", wrap(async (req, res) => {
    const { email, password } = req.body ?? {};
    if (!email || !password) return bad(res, "email and password are required");
    const user = await platform.getUserByEmailAnywhere(String(email));
    // One message for "no such user" and "wrong password": distinguishing them
    // tells an attacker which addresses are real.
    const okPass = user && user.status === "active" && await verifyPassword(String(password), user.password_hash);
    if (!user || !okPass) { res.status(401).json({ error: "invalid email or password" }); return; }

    const session = await platform.createSession(user.id);
    await platform.recordAction({ companyId: user.company_id, verb: "auth.login", userId: user.id });
    // Set for the CONSOLE, which is served from this same origin and would
    // otherwise have to hold the token in page-readable storage. A CLI caller
    // ignores the header and keeps using the token in the body, so this costs
    // nothing and serves both.
    res.setHeader("Set-Cookie",
      sessionCookieHeader(session.secret, session.expiresAt.getTime() - Date.now()));
    ok(res, {
      token: session.secret, expiresAt: session.expiresAt,
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
    });
  }));

  r.post("/auth/logout", requireAuth(), wrap(async (req, res) => {
    // Whichever credential got them here — header or cookie — is the one to
    // destroy. Clearing only the cookie would leave a live session behind.
    const headers = req.headers as Record<string, unknown>;
    const secret = bearerFrom(headers) ?? cookieCredential(headers);
    if (secret) await platform.destroySession(secret);
    res.setHeader("Set-Cookie", clearSessionCookieHeader());
    ok(res, { ok: true });
  }));

  r.get("/auth/whoami", requireAuth(), wrap(async (req, res) => {
    const u = req.principal!.user;
    const org = await platform.getCompany(req.principal!.companyId);
    // FLAT, deliberately. cli/index.ts's cmdWhoami spreads this object
    // (`json({ ...me, apiUrl, project, feature })`), so nesting the user under
    // a `user` key would break that silently rather than loudly.
    ok(res, {
      id: u.id, email: u.email, name: u.name, role: u.role,
      authenticatedBy: req.principal!.tokenId ? "token" : "session",
      // The org this request is ACTING IN — which, for a superadmin sending
      // X-Scyne-Org, is not the org they belong to.
      company: org ? { id: org.id, name: org.name, slug: org.slug } : null,
      isSuperadmin: req.principal!.isSuperadmin,
    });
  }));

  r.get("/auth/tokens", requireAuth(), wrap(async (req, res) => {
    ok(res, await platform.listTokens(req.principal!.user.id));
  }));

  r.post("/auth/tokens", requireAuth(), wrap(async (req, res) => {
    const name = String(req.body?.name ?? "cli");
    const { row, secret } = await platform.createToken(req.principal!.user.id, name);
    await audit(req, "token.create", { targetType: "token", targetId: row.id, detail: { name } });
    // The only time the secret is ever returned.
    created(res, { id: row.id, prefix: row.prefix, name, token: secret });
  }));

  r.delete("/auth/tokens/:id", requireAuth(), wrap(async (req, res) => {
    const done = await platform.revokeToken(String(req.params.id), req.principal!.user.id);
    if (!done) return missing(res, "token");
    await audit(req, "token.revoke", { targetType: "token", targetId: String(req.params.id) });
    ok(res, { ok: true });
  }));

  // ---------------------------------------------------------- organisations

  r.get("/orgs", requireAuth(), wrap(async (req, res) => {
    // An ordinary administrator is NOT refused here — they are shown their own
    // organisation as a single-item list. A 403 would make the console's org
    // switcher an error state for most of its users, and "which organisations
    // may I act in" has an honest one-item answer for them.
    if (!req.principal!.isSuperadmin) {
      const own = await platform.getCompany(req.principal!.companyId);
      ok(res, own ? [{ ...own, stats: await platform.companyStats(own.id) }] : []);
      return;
    }
    const orgs = await platform.listCompanies();
    ok(res, await Promise.all(orgs.map(async o => ({ ...o, stats: await platform.companyStats(o.id) }))));
  }));

  r.post("/orgs", requireAuth(), wrap(async (req, res) => {
    if (!requireSuperadmin(req, res)) return;
    const { name, slug } = (req.body ?? {}) as { name?: string; slug?: string };
    if (!name?.trim()) return bad(res, "name is required");
    const org = await platform.createCompany({ name, slug });
    // Recorded against the ACTOR's organisation, not the new one. The audit
    // trail answers "what did people here do", and creating another
    // organisation is something a person here did — filing it under the new
    // org instead makes it invisible from the only place anyone would look,
    // unless they first switch to the org whose creation they are looking for.
    await platform.recordAction({
      companyId: req.principal!.companyId, userId: req.principal!.user.id,
      verb: "org.create", targetType: "company", targetId: org.id,
      detail: { name: org.name, slug: org.slug },
    });
    created(res, org);
  }));

  r.get("/orgs/:id", requireAuth(), wrap(async (req, res) => {
    const org = await platform.getCompany(String(req.params.id)).catch(() => null);
    // 404 rather than 403 for an org the caller may not see — the same rule
    // this file applies to projects, for the same reason.
    if (!org || (!req.principal!.isSuperadmin && org.id !== req.principal!.companyId)) {
      return missing(res, "organisation");
    }
    ok(res, { ...org, stats: await platform.companyStats(org.id) });
  }));

  r.patch("/orgs/:id", requireAuth(), wrap(async (req, res) => {
    if (!requireSuperadmin(req, res)) return;
    const { name, status } = (req.body ?? {}) as { name?: string; status?: string };
    const org = await platform.updateCompany(String(req.params.id), { name, status });
    if (!org) return missing(res, "organisation");
    await platform.recordAction({
      companyId: req.principal!.companyId, userId: req.principal!.user.id,
      verb: "org.update", targetType: "company", targetId: org.id, detail: { name, status },
    });
    ok(res, org);
  }));

  r.delete("/orgs/:id", requireAuth(), wrap(async (req, res) => {
    if (!requireSuperadmin(req, res)) return;
    const id = String(req.params.id);
    // The home organisation is where the agent org chart is reconciled on every
    // boot. Archiving it would leave every workflow with no assignee to resolve.
    if (id === orch.homeCompanyId) {
      return bad(res, "the home organisation cannot be archived — it owns the agent org chart");
    }
    if (!(await platform.archiveCompany(id))) return missing(res, "organisation");
    await platform.recordAction({
      companyId: req.principal!.companyId, userId: req.principal!.user.id,
      verb: "org.archive", targetType: "company", targetId: id,
    });
    ok(res, { archived: true });
  }));

  // ----------------------------------------------------------------- users

  /**
   * The user directory, at two levels of detail.
   *
   * Administrators see the full rows. Everyone else sees id, email and name
   * only — because granting someone access to a project requires being able to
   * NAME them, and a project owner who is not an administrator would otherwise
   * be unable to share their own project with anyone. Withholding the
   * directory entirely does not protect much either: membership lists already
   * expose colleagues' addresses to anyone on the same project.
   *
   * What stays administrator-only is everything that is not identity: role,
   * status, and when the account was created.
   */
  r.get("/users", requireAuth(), wrap(async (req, res) => {
    const users = await platform.listUsers(req.principal!.companyId);
    // `atLeastGlobal`, not `=== "admin"`. A superadmin outranks an admin, and
    // a literal comparison silently gives the HIGHER role the LESSER view —
    // a failure that looks like a permissions bug rather than like a typo.
    if (atLeastGlobal(req.principal!.user.role, "admin")) {
      return ok(res, users.map(({ password_hash, ...u }) => u));
    }
    ok(res, users
      .filter(u => u.status === "active")
      .map(u => ({ id: u.id, email: u.email, name: u.name })));
  }));

  r.post("/users", requireAuth(), wrap(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const { email, password, name, role } = req.body ?? {};
    if (!email) return bad(res, "email is required");
    if (role && !isGlobalRole(String(role))) return bad(res, `role must be one of superadmin, admin, member, viewer`);
    if (!mayAssignRole(req, res, role)) return;
    const user = await platform.createUser({
      companyId: req.principal!.companyId, email: String(email), name: name ?? null, role: role ? String(role) : "member",
      passwordHash: password ? await hashPassword(String(password)) : null,
    });
    await audit(req, "user.create", { targetType: "user", targetId: user.id, detail: { email: user.email } });
    const { password_hash, ...safe } = user;
    created(res, safe);
  }));

  r.patch("/users/:id", requireAuth(), wrap(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const { name, role, status, password } = req.body ?? {};
    if (role && !isGlobalRole(String(role))) return bad(res, `role must be one of superadmin, admin, member, viewer`);
    if (!mayAssignRole(req, res, role)) return;
    const user = await platform.updateUser(String(req.params.id), {
      ...(name !== undefined ? { name } : {}),
      ...(role !== undefined ? { role: String(role) } : {}),
      ...(status !== undefined ? { status: String(status) } : {}),
      ...(password !== undefined ? { passwordHash: await hashPassword(String(password)) } : {}),
    });
    if (!user) return missing(res, "user");
    await audit(req, "user.update", { targetType: "user", targetId: user.id });
    const { password_hash, ...safe } = user;
    ok(res, safe);
  }));

  // -------------------------------------------------------------- projects

  r.get("/projects", requireAuth(), wrap(async (req, res) => {
    const u = req.principal!.user;
    ok(res, await platform.listProjects(req.principal!.companyId, {
      userId: u.id, isAdmin: atLeastGlobal(u.role, "admin"),
    }));
  }));

  r.post("/projects", requireAuth(), wrap(async (req, res) => {
    const u = req.principal!.user;
    if (u.role === "viewer") return denied(res, "a viewer cannot create projects");
    const { name, description, website, adoTarget } = req.body ?? {};
    if (!name) return bad(res, "name is required");
    if (await platform.projectNameTaken(String(name))) {
      res.status(409).json({
        error: "name_taken",
        message: `a project named '${String(name).trim()}' already exists. Project folders are a ` +
                 `flat tree shared by every organisation, so the name must be unique across the install.`,
      });
      return;
    }
    const row = await platform.createProject({
      companyId: req.principal!.companyId, name: String(name), description: description ?? null,
      website: website ?? null, adoTarget: adoTarget ?? null, createdBy: u.id,
    });
    await audit(req, "project.create", { projectId: row.id, targetType: "project", targetId: row.id });
    created(res, row);
  }));

  r.get("/projects/:id", requireAuth(), wrap(async (req, res) => {
    const row = await project(req, res, "viewer"); if (!row) return;
    ok(res, { ...row, role: req.projectRole });
  }));

  r.patch("/projects/:id", requireAuth(), wrap(async (req, res) => {
    const row = await project(req, res, "editor"); if (!row) return;
    const { description, website, theme, adoTarget } = req.body ?? {};
    const updated = await platform.updateProject(row.id, { description, website, theme, adoTarget });
    await audit(req, "project.update", { projectId: row.id });
    ok(res, updated);
  }));

  // ---------------------------------------------------------------- access

  r.get("/projects/:id/members", requireAuth(), wrap(async (req, res) => {
    const row = await project(req, res, "viewer"); if (!row) return;
    ok(res, await platform.listMembers(row.id));
  }));

  r.put("/projects/:id/members/:userId", requireAuth(), wrap(async (req, res) => {
    // Owner, not editor: changing who else has access is the one thing an
    // editor must not be able to do.
    const row = await project(req, res, "owner"); if (!row) return;
    const role = String(req.body?.role ?? "");
    if (!isProjectRole(role)) return bad(res, `role must be one of owner, editor, viewer`);
    if (!(await platform.getUser(String(req.params.userId)))) return missing(res, "user");

    await platform.setMember(row.id, String(req.params.userId), role, req.principal!.user.id);
    await audit(req, "member.grant", {
      projectId: row.id, targetType: "user", targetId: String(req.params.userId), detail: { role },
    });
    ok(res, { ok: true, role });
  }));

  r.delete("/projects/:id/members/:userId", requireAuth(), wrap(async (req, res) => {
    const row = await project(req, res, "owner"); if (!row) return;
    const done = await platform.removeMember(row.id, String(req.params.userId));
    if (!done) return missing(res, "membership");
    await audit(req, "member.revoke", { projectId: row.id, targetType: "user", targetId: String(req.params.userId) });
    ok(res, { ok: true });
  }));

  // -------------------------------------------------------------- features

  r.get("/projects/:id/features", requireAuth(), wrap(async (req, res) => {
    const row = await project(req, res, "viewer"); if (!row) return;
    ok(res, await platform.listFeatures(row.id));
  }));

  r.post("/projects/:id/features", requireAuth(), wrap(async (req, res) => {
    const row = await project(req, res, "editor"); if (!row) return;
    const name = String(req.body?.name ?? "");
    if (!name) return bad(res, "name is required");
    // The same reserved words the CLI's stage resolution and the chatbot
    // already refuse — a feature by one of these names is unreachable.
    if (RESERVED_FEATURE_NAMES.has(name.toLowerCase())) {
      return bad(res, `'${name}' is reserved — it would be read as a stage or a project folder`);
    }
    const feature = await platform.createFeature({ projectId: row.id, name, createdBy: req.principal!.user.id });
    await audit(req, "feature.create", {
      projectId: row.id, featureId: feature.id, targetType: "feature", targetId: feature.id,
    });
    created(res, feature);
  }));

  // ------------------------------------------------------------- documents

  r.get("/projects/:id/documents", requireAuth(), wrap(async (req, res) => {
    const row = await project(req, res, "viewer"); if (!row) return;
    const featureName = req.query.feature ? String(req.query.feature) : null;
    const feature = featureName ? await platform.getFeatureByName(row.id, featureName) : null;
    if (featureName && !feature) return missing(res, "feature");

    ok(res, await docs.list(row.id, {
      ...(req.query.all === "true" ? { anyLevel: true } : { featureId: feature?.id ?? null }),
      ...(req.query.category ? { category: String(req.query.category) } : {}),
      ...(req.query.prefix ? { prefix: String(req.query.prefix) } : {}),
    }));
  }));

  r.post("/projects/:id/documents", requireAuth(), wrap(async (req, res) => {
    const row = await project(req, res, "editor"); if (!row) return;

    // Two shapes, and the RAW one is how a document of any size should arrive.
    //
    // A document used to travel base64'd inside a JSON body, which inflates it
    // by a third and put it under two ceilings: this router's 100 MB JSON limit
    // and V8's 512 MB cap on a single string. 100 MB of document base64s to
    // 133 MB, so anything over roughly 75 MB failed its row while landing on
    // disk perfectly — silently, because that write is best-effort.
    //
    // The JSON form is kept because the CLI and older callers still send it.
    const raw = req.headers["content-type"] === "application/octet-stream";
    const q = req.query as Record<string, string | undefined>;
    const featureName = raw ? q.feature : req.body?.feature;
    const path = raw ? q.path : req.body?.path;
    const category = raw ? q.category : req.body?.category;
    const content = raw ? req.body : req.body?.content;
    const encoding = raw ? undefined : req.body?.encoding;
    if (!path || content === undefined) return bad(res, "path and content are required");

    const feature = featureName ? await platform.getFeatureByName(row.id, String(featureName)) : null;
    if (featureName && !feature) return missing(res, "feature");

    // base64 for anything that is not text on the JSON path — a .docx or a
    // screenshot cannot survive a JSON string, and silently corrupting one
    // would be discovered much later, by a model reading gibberish.
    const bytes = raw
      ? (Buffer.isBuffer(content) ? content : Buffer.from(content as any))
      : encoding === "base64"
        ? Buffer.from(String(content), "base64")
        : Buffer.from(String(content), "utf8");

    const { doc, changed } = await docs.put({
      projectId: row.id, featureId: feature?.id ?? null, path: String(path),
      content: bytes, category: category ? String(category) : null,
      uploadedBy: req.principal!.user.id,
    });
    await audit(req, "doc.upload", {
      projectId: row.id, featureId: feature?.id ?? null, targetType: "document", targetId: doc.id,
      detail: { path: doc.path, version: doc.version, changed },
    });
    created(res, { ...doc, changed });
  }));

  r.get("/projects/:id/documents/:docId", requireAuth(), wrap(async (req, res) => {
    const row = await project(req, res, "viewer"); if (!row) return;
    const content = await docs.read(String(req.params.docId));
    if (!content) return missing(res, "document");

    // Raw bytes when asked for, JSON+base64 otherwise.
    //
    // The base64 form is what every existing caller reads, so it stays — but it
    // cannot serve a large document: base64 inflates by a third and V8 refuses
    // a string over 512 MB, so the JSON form tops out around 384 MB no matter
    // what any limit says. Bytes are in object storage now and are not bounded
    // by that, so a caller that wants a file gets a file.
    if (String(req.headers.accept ?? "").includes("application/octet-stream")) {
      res.type("application/octet-stream").send(content);
      return;
    }
    ok(res, { id: req.params.docId, encoding: "base64", content: content.toString("base64") });
  }));

  /**
   * Retire the current version at a path.
   *
   * By PATH rather than by document id, matching `put()` and `get()` — a path
   * is what a caller knows and what the level predicate is built around, and
   * the id of a version is an implementation detail of the history.
   *
   * The BYTES survive: content is addressed by its own hash and shared by every
   * path holding the same file, so removing the blob would silently corrupt the
   * others. `remove()` clears `is_current`, which is also what lets the same
   * path be uploaded again afterwards as a new version rather than colliding
   * with the partial unique index.
   */
  r.delete("/projects/:id/documents", requireAuth(), wrap(async (req, res) => {
    const row = await project(req, res, "editor"); if (!row) return;
    const docPath = req.query.path ? String(req.query.path) : "";
    // Without this, a caller that forgot the parameter would be asking to
    // delete the document at the empty path — which reads far too much like
    // asking to delete all of them.
    if (!docPath) return bad(res, "path is required");

    const featureName = req.query.feature ? String(req.query.feature) : null;
    const feature = featureName ? await platform.getFeatureByName(row.id, featureName) : null;
    // An unknown feature must NOT fall through to project level: that is how a
    // delete aimed at one feature takes a client-wide policy document instead.
    if (featureName && !feature) return missing(res, "feature");

    const removed = await docs.remove(row.id, feature?.id ?? null, docPath);
    if (!removed) return missing(res, "document");

    await audit(req, "doc.delete", {
      projectId: row.id, featureId: feature?.id ?? null, targetType: "document",
      detail: { path: docPath, feature: featureName },
    });
    ok(res, { ok: true, path: docPath, feature: featureName });
  }));

  // ----------------------------------------------------------------- audit

  r.get("/projects/:id/actions", requireAuth(), wrap(async (req, res) => {
    const row = await project(req, res, "viewer"); if (!row) return;
    ok(res, await platform.listActions(req.principal!.companyId, {
      projectId: row.id, limit: req.query.limit ? Number(req.query.limit) : undefined,
    }));
  }));

  /**
   * Audit across every project. Administrators only — the per-project feed
   * above is what a member gets, and it is already scoped by the membership
   * check. `listActions` always supported this; there was simply no route, so
   * an administrator could see who did what on one project at a time and never
   * across the organisation.
   */
  r.get("/actions", requireAuth(), wrap(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    ok(res, await platform.listActions(req.principal!.companyId, {
      ...(req.query.projectId ? { projectId: String(req.query.projectId) } : {}),
      limit: req.query.limit ? Number(req.query.limit) : 100,
    }));
  }));

  /**
   * Everything an administrator needs in one request.
   *
   * Assembled server-side rather than left to the caller to stitch together
   * from six endpoints: the point of an overview is that it is ONE answer, and
   * a client composing it would have to know which of those six it is allowed
   * to call.
   */
  r.get("/admin/overview", requireAuth(), wrap(async (req, res) => {
    if (!requireAdmin(req, res)) return;

    const [users, installs, projects, spend, actions] = await Promise.all([
      platform.listUsers(req.principal!.companyId),
      platform.listInstallations(req.principal!.companyId),
      platform.listProjects(req.principal!.companyId, { isAdmin: true }),
      platform.spend(req.principal!.companyId, "project"),
      platform.listActions(req.principal!.companyId, { limit: 15 }),
    ]);

    // Counts come from the same query the detail does, so the summary can
    // never disagree with the list underneath it.
    const { rows: issueRows } = await orch.db.query<{ status: string; n: string }>(
      `select status, count(*)::text as n from issues where company_id=$1 group by status`, [req.principal!.companyId]);
    const { rows: docRows } = await orch.db.query<{ n: string; bytes: string }>(
      `select count(*)::text as n, coalesce(sum(b.bytes),0)::text as bytes
         from documents d join blobs b on b.sha256 = d.sha256
         join projects p on p.id = d.project_id
        where p.company_id=$1 and d.is_current`, [req.principal!.companyId]);

    ok(res, {
      users: users.map(({ password_hash, ...u }) => u),
      installations: installs,
      projects,
      spend,
      issues: Object.fromEntries(issueRows.map(r => [r.status, Number(r.n)])),
      documents: { count: Number(docRows[0]?.n ?? 0), bytes: Number(docRows[0]?.bytes ?? 0) },
      recentActions: actions,
      totals: {
        costUsd: spend.reduce((n, r) => n + Number(r.cost_usd ?? 0), 0),
        runs: spend.reduce((n, r) => n + Number(r.run_count ?? 0), 0),
      },
    });
  }));


  // ------------------------------------------------------- runtime settings

  /**
   * Which adapter (and model, and effort) a run uses, per scope.
   *
   * Before this the only dimensions were per-step, per-agent, and one global
   * default read from `$SCYNE_ADAPTER` at boot — so "this client runs on
   * Azure" meant restarting the server for everybody.
   *
   * Readable by any authenticated user, because knowing which model produced
   * an artefact is part of reading it. Writable by administrators only.
   */
  r.get("/settings", requireAuth(), wrap(async (req, res) => {
    const rows = await orch.repo.listSettings(req.principal!.companyId);
    ok(res, {
      settings: rows,
      // What the server can actually run, so a caller is not left guessing
      // which names are valid.
      available: Object.keys(orch.config.adapters),
      configuredDefault: orch.config.defaults?.adapter ?? "claude_local",
      scopes: orch.config.runtimeScopes ?? [],
    });
  }));

  r.put("/settings", requireAuth(), wrap(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const { scope, scopeKey, key, value } = req.body ?? {};
    if (!scope || !key || value === undefined) return bad(res, "scope, key and value are required");
    if (!SETTABLE.has(String(key))) return bad(res, `key must be one of ${[...SETTABLE].join(", ")}`);

    // An adapter that is not registered would fail at the first run, twenty
    // minutes after someone set it. Refuse it now, naming what exists.
    if (key === "adapter" && !orch.config.adapters[String(value)]) {
      return bad(res,
        `adapter '${value}' is not registered on this server — available: ` +
        `${Object.keys(orch.config.adapters).join(", ")}`);
    }
    const scopes = new Set(["company", ...(orch.config.runtimeScopes ?? [])]);
    if (!scopes.has(String(scope))) return bad(res, `scope must be one of ${[...scopes].join(", ")}`);

    // A project scope is keyed by project NAME, which is what an issue's
    // params carry; check it exists so a typo is caught here and not by a run
    // that silently used the default.
    const resolvedKey = String(scope) === "company" ? "*" : String(scopeKey ?? "");
    if (String(scope) !== "company") {
      if (!resolvedKey) return bad(res, `scope '${scope}' needs a scopeKey`);
      if (!(await platform.getProjectByName(req.principal!.companyId, resolvedKey))) return missing(res, "project");
    }

    await orch.repo.setSetting(req.principal!.companyId, String(scope), resolvedKey, String(key), String(value),
      req.principal!.user.id);
    await audit(req, "setting.set", {
      targetType: "setting", targetId: `${scope}:${resolvedKey}:${key}`, detail: { value },
    });
    ok(res, { scope, scopeKey: resolvedKey, key, value });
  }));

  r.delete("/settings", requireAuth(), wrap(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const scope = String(req.query.scope ?? "");
    const key = String(req.query.key ?? "");
    if (!scope || !key) return bad(res, "scope and key are required");
    const scopeKey = scope === "company" ? "*" : String(req.query.scopeKey ?? "");
    const done = await orch.repo.clearSetting(req.principal!.companyId, scope, scopeKey, key);
    if (!done) return missing(res, "setting");
    await audit(req, "setting.clear", { targetType: "setting", targetId: `${scope}:${scopeKey}:${key}` });
    ok(res, { ok: true });
  }));

  // --------------------------------------------------------- installations

  r.post("/installations", requireAuth(), wrap(async (req, res) => {
    const { machineId, hostname, os, pluginVersion } = req.body ?? {};
    if (!machineId) return bad(res, "machineId is required");
    const inst = await platform.registerInstallation({
      companyId: req.principal!.companyId, userId: req.principal!.user.id, machineId: String(machineId),
      hostname: hostname ?? null, os: os ?? null, pluginVersion: pluginVersion ?? null,
    });
    await audit(req, "install.register", { targetType: "installation", targetId: inst.id });
    created(res, inst);
  }));

  r.get("/installations", requireAuth(), wrap(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    ok(res, await platform.listInstallations(req.principal!.companyId));
  }));

  r.delete("/installations/:id", requireAuth(), wrap(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const done = await platform.revokeInstallation(String(req.params.id));
    if (!done) return missing(res, "installation");
    await audit(req, "install.revoke", { targetType: "installation", targetId: String(req.params.id) });
    ok(res, { ok: true });
  }));

  // ----------------------------------------------------------------- chats

  r.get("/conversations", requireAuth(), wrap(async (req, res) => {
    ok(res, await platform.listConversations(req.principal!.companyId, {
      userId: req.principal!.user.id,
      ...(req.query.projectId ? { projectId: String(req.query.projectId) } : {}),
    }));
  }));

  r.post("/conversations", requireAuth(), wrap(async (req, res) => {
    const { projectId, featureId, title } = req.body ?? {};
    created(res, await platform.createConversation({
      companyId: req.principal!.companyId, userId: req.principal!.user.id,
      projectId: projectId ?? null, featureId: featureId ?? null, title: title ?? null,
    }));
  }));

  r.get("/conversations/:id/messages", requireAuth(), wrap(async (req, res) => {
    ok(res, await platform.listMessages(String(req.params.id)));
  }));

  r.post("/conversations/:id/messages", requireAuth(), wrap(async (req, res) => {
    const { role, content, adapter, model } = req.body ?? {};
    if (!role || content === undefined) return bad(res, "role and content are required");
    created(res, await platform.appendMessage(String(req.params.id), {
      role: String(role), content, adapter: adapter ?? null, model: model ?? null,
    }));
  }));

  r.delete("/conversations/:id", requireAuth(), wrap(async (req, res) => {
    const done = await platform.deleteConversation(
      String(req.params.id), req.principal!.companyId, req.principal!.user.id);
    if (!done) return missing(res, "conversation");
    await audit(req, "chat.clear", { targetType: "conversation", targetId: String(req.params.id) });
    ok(res, { ok: true });
  }));

  // ----------------------------------------------------------------- spend

  const SPEND_DIMENSIONS = ["project", "feature", "user", "agent", "adapter", "model"] as const;

  r.get("/spend", requireAuth(), wrap(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const by = String(req.query.by ?? "project");
    if (!(SPEND_DIMENSIONS as readonly string[]).includes(by)) {
      return bad(res, `by must be one of ${SPEND_DIMENSIONS.join(", ")}`);
    }
    const str = (v: unknown): string | undefined =>
      typeof v === "string" && v.trim() ? v.trim() : undefined;
    ok(res, await platform.spend(req.principal!.companyId, {
      by: by as (typeof SPEND_DIMENSIONS)[number],
      project: str(req.query.project), feature: str(req.query.feature), user: str(req.query.user),
      since: str(req.query.since), until: str(req.query.until),
    }));
  }));

  // ------------------------------------------------------- model prices
  //
  // Codex reports tokens and no dollar figure, so a Codex run is priced from
  // this table. That makes these rows load-bearing: they decide what every
  // run in the install is recorded as costing, and whether a cost budget
  // fires. Which is exactly why a refresh is a PROPOSAL rather than a write.

  /**
   * A rate that could actually be real.
   *
   * The ceiling is deliberately generous — o1-pro is $150/M input — but a
   * refresh that comes back with 15000 has misread a page, and applying it
   * would trip every cost budget in the install on the next run.
   */
  const MAX_RATE = 10_000;
  const validRate = (v: unknown): v is number | null =>
    v === null || v === undefined
    || (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= MAX_RATE);

  /**
   * The four price fields, and every spelling this API answers to.
   *
   * The table, the diff and the apply all use snake_case; the write endpoints
   * have always ALSO accepted camelCase, because that is what the rest of the
   * JSON API looks like. Proposals were the one path that did not — they were
   * stored verbatim, and `diffProposal` / `applyProposal` look for snake_case
   * only. A camelCase refresh was therefore accepted with 200, reported "it
   * changes nothing", and applied as a no-op that answered `applied: 1`.
   *
   * Worse than useless: the sanity ceiling below is what stands between a
   * hallucinated rate and every cost budget in the install, and it too was
   * reading a key that was not there.
   *
   * So rows are canonicalised HERE, once, before they are validated and
   * before they are stored — rather than teaching three more call sites about
   * a second spelling.
   */
  const FIELD_ALIASES: Record<string, string[]> = {
    input_per_mtok:        ["input_per_mtok", "inputPerMTok"],
    cached_input_per_mtok: ["cached_input_per_mtok", "cachedInputPerMTok"],
    output_per_mtok:       ["output_per_mtok", "outputPerMTok"],
    retires_on:            ["retires_on", "retiresOn"],
  };
  const PRICE_FIELDS = Object.keys(FIELD_ALIASES);

  /**
   * One row, with every field under its canonical name.
   *
   * A field is copied only when a spelling of it is actually PRESENT: absent
   * means "leave it alone" and an explicit null means "clear it", and
   * collapsing the two is how a refresh that simply omitted a column would
   * wipe every cached rate in the catalogue.
   */
  const canonicaliseRow = (raw: Record<string, unknown>): Record<string, unknown> => {
    const row: Record<string, unknown> = {
      model: raw.model,
      ...(("provider" in raw) ? { provider: raw.provider } : {}),
    };
    for (const [canonical, aliases] of Object.entries(FIELD_ALIASES)) {
      for (const alias of aliases) {
        if (alias in raw && raw[alias] !== undefined) { row[canonical] = raw[alias]; break; }
      }
    }
    return row;
  };

  const canonicaliseRows = (rows: unknown): Record<string, unknown>[] =>
    Array.isArray(rows)
      ? rows.map(r => (typeof r === "object" && r !== null
          ? canonicaliseRow(r as Record<string, unknown>) : r as Record<string, unknown>))
      : [];

  /** Returns the problems with a proposed row set; empty means it is usable. */
  const validateRows = (rows: unknown): string[] => {
    if (!Array.isArray(rows) || !rows.length) return ["expected a non-empty array of rows"];
    const problems: string[] = [];
    const seen = new Set<string>();
    for (const [i, raw] of rows.entries()) {
      if (typeof raw !== "object" || raw === null) { problems.push(`row ${i}: not an object`); continue; }
      const row = raw as Record<string, unknown>;
      const model = typeof row.model === "string" ? row.model.trim() : "";
      if (!model) { problems.push(`row ${i}: no model id`); continue; }
      const key = `${String(row.provider ?? "openai")}/${model}`;
      if (seen.has(key)) problems.push(`row ${i}: '${key}' appears twice`);
      seen.add(key);
      for (const f of ["input_per_mtok", "cached_input_per_mtok", "output_per_mtok"]) {
        if (!validRate(row[f])) {
          problems.push(`row ${i} (${model}): '${f}' must be a number between 0 and ${MAX_RATE}, or null`);
        }
      }
      if (row.retires_on != null && Number.isNaN(Date.parse(String(row.retires_on)))) {
        problems.push(`row ${i} (${model}): 'retires_on' is not a date`);
      }
      // A row naming no field at all asks for nothing. Refusing it is what
      // turns a misspelled rate into a 400 that says so, rather than a
      // proposal that reports "it changes nothing" and applies successfully
      // without changing anything — which is how this was missed.
      if (!PRICE_FIELDS.some(f => f in row)) {
        problems.push(`row ${i} (${model}): states no price — expected one of ${PRICE_FIELDS.join(", ")}`);
      }
    }
    return problems;
  };

  r.get("/models", requireAuth(), wrap(async (req, res) => {
    ok(res, await platform.listModelPrices(req.principal!.companyId));
  }));

  /**
   * Correct one row by hand.
   *
   * MERGED over what is already there, not replaced. `scyne models set
   * gpt-5.6-terra --input 2 --output 12` used to clear that model's cached
   * rate, because an omitted field arrived as null — and since most of a long
   * agent run's input is cached, silently dropping the cache discount inflates
   * the recorded cost of every run afterwards. Same rule as a refresh, for the
   * same reason: absent means leave it alone, an explicit null clears it.
   */
  r.put("/models/:provider/:model", requireAuth(), wrap(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const provider = String(req.params.provider), model = String(req.params.model);
    const submitted = canonicaliseRow({ ...(req.body ?? {}), provider, model });
    const problems = validateRows([submitted]);
    if (problems.length) return bad(res, problems.join("; "));

    const current = (await platform.listModelPrices(req.principal!.companyId))
      .find(m => m.provider === provider && m.model === model);
    const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
    const merge = (field: "input_per_mtok" | "cached_input_per_mtok" | "output_per_mtok"): number | null =>
      field in submitted ? num(submitted[field]) : num(current?.[field]);

    const body = req.body ?? {};
    const row = await platform.upsertModelPrice({
      provider, model,
      inputPerMTok: merge("input_per_mtok"),
      cachedInputPerMTok: merge("cached_input_per_mtok"),
      outputPerMTok: merge("output_per_mtok"),
      retiresOn: "retires_on" in submitted
        ? (submitted.retires_on === null ? null : String(submitted.retires_on))
        : (current?.retires_on ?? null),
      sourceUrl: body.sourceUrl ?? body.source_url ?? "set by hand",
      updatedBy: req.principal!.user.id,
    });
    await audit(req, "model.price.set", {
      targetType: "model", targetId: `${req.params.provider}/${req.params.model}`, detail: { ...body },
    });
    ok(res, row);
  }));

  r.get("/models/refresh", requireAuth(), wrap(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const proposal = await platform.pendingProposal(req.principal!.companyId);
    if (!proposal) { ok(res, null); return; }
    ok(res, { ...proposal, diff: await platform.diffProposal(proposal.rows as Array<Record<string, unknown>>) });
  }));

  /**
   * Propose a new price table.
   *
   * The rows may come from anywhere — an agent that fetched the vendor's
   * pricing page, a script, a person pasting a table. What matters is that
   * they are VALIDATED and stored as a proposal rather than written: a model
   * that hallucinates a rate must not be able to change what every run in the
   * install is billed at, or to trip every cost budget at once.
   */
  r.post("/models/refresh", requireAuth(), wrap(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const { rows: submitted, source } = (req.body ?? {}) as { rows?: unknown; source?: string };
    // Canonicalised BEFORE validation and before storage, so the sanity
    // ceiling sees the rates whichever way they were spelled, and what is
    // stored is what `diffProposal` and `applyProposal` know how to read.
    const rows = Array.isArray(submitted) ? canonicaliseRows(submitted) : submitted;
    const problems = validateRows(rows);
    if (problems.length) {
      res.status(400).json({ error: "invalid_rows", problems });
      return;
    }
    const proposal = await platform.createProposal({
      companyId: req.principal!.companyId, proposedBy: req.principal!.user.id,
      source: source ?? null, rows: rows as unknown[],
    });
    const diff = await platform.diffProposal(rows as Array<Record<string, unknown>>);
    await audit(req, "model.price.propose", { targetType: "proposal", targetId: proposal.id,
      detail: { rows: (rows as unknown[]).length, changes: diff.length } });
    // 200 with the diff, not 201 with the rows: what the caller needs to see
    // is what would CHANGE, and usually that is two lines out of forty.
    ok(res, { ...proposal, diff });
  }));

  r.post("/models/refresh/apply", requireAuth(), wrap(async (req, res) => {
    // Superadmin, not admin. Applying this changes the recorded cost of every
    // future run in the install.
    if (!requireSuperadmin(req, res)) return;
    const proposal = await platform.pendingProposal(req.principal!.companyId);
    if (!proposal) return missing(res, "pending proposal");
    const applied = await platform.applyProposal(proposal.id, req.principal!.user.id);
    await audit(req, "model.price.apply", { targetType: "proposal", targetId: proposal.id, detail: { applied } });
    ok(res, { applied });
  }));

  r.delete("/models/refresh", requireAuth(), wrap(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const proposal = await platform.pendingProposal(req.principal!.companyId);
    if (!proposal) return missing(res, "pending proposal");
    await platform.discardProposal(proposal.id, req.principal!.user.id);
    await audit(req, "model.price.discard", { targetType: "proposal", targetId: proposal.id });
    ok(res, { discarded: true });
  }));

  return r;
}

/**
 * Names that would be unreachable as a feature: the CLI resolves a project
 * stage before a feature name, and these are the project's own folders.
 * Duplicated from scripts/pipeline.mjs deliberately — the library must not
 * import a consumer's file — and asserted equal by a test there.
 */
/** Runtime keys a scope may override. Anything else is refused. */
const SETTABLE = new Set(["adapter", "model", "effort"]);

export const RESERVED_FEATURE_NAMES = new Set([
  "capabilities", "personas", "app", "all", "baseline",
  "solutions", "documents", "design", "original-files", "outputs",
]);
