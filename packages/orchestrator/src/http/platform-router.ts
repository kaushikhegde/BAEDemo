// The platform HTTP surface: identity, projects, features, documents, access,
// installations, chats, audit and spend.
//
// A separate router from http/router.ts, mounted beside it, for the same
// reason core/platform.ts is separate from core/repo.ts: that one is the
// engine's API (issues, runs, gates) and this one is the product's. Its route
// table is re-exported into `ROUTES` so the OpenAPI contract test still checks
// both directions across the whole surface — one contract, two files.
//
// Every route here authenticates. The two exceptions are deliberate and
// narrow: `POST /auth/bootstrap`, which works only while the company has no
// users at all, and `POST /auth/login`.
//
// The rule that shapes the rest: a project a caller may not see returns 404,
// never 403. A 403 confirms the project exists, which is exactly the fact a
// caller without access should not be able to learn.

import { Router, type Request, type Response, type NextFunction } from "express";
import { createDocumentStore } from "../core/documents.js";
import { createPlatformRepo, type PlatformRepo, type Principal } from "../core/platform.js";
import {
  bearerFrom, hashPassword, verifyPassword, isGlobalRole, isProjectRole, atLeast,
  type ProjectRole,
} from "../core/auth.js";
import type { Orchestrator } from "../index.js";

export const PLATFORM_ROUTES = [
  { method: "POST",   path: "/auth/bootstrap" },
  { method: "POST",   path: "/auth/login" },
  { method: "POST",   path: "/auth/logout" },
  { method: "GET",    path: "/auth/whoami" },
  { method: "GET",    path: "/auth/tokens" },
  { method: "POST",   path: "/auth/tokens" },
  { method: "DELETE", path: "/auth/tokens/{id}" },
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
  { method: "GET",    path: "/projects/{id}/actions" },
  { method: "GET",    path: "/installations" },
  { method: "POST",   path: "/installations" },
  { method: "DELETE", path: "/installations/{id}" },
  { method: "GET",    path: "/conversations" },
  { method: "POST",   path: "/conversations" },
  { method: "GET",    path: "/conversations/{id}/messages" },
  { method: "POST",   path: "/conversations/{id}/messages" },
  { method: "GET",    path: "/spend" },
] as const;

/** Express has no per-request user slot; this is ours. */
interface AuthedRequest extends Request {
  principal?: Principal;
  projectRole?: ProjectRole;
}

export function createPlatformRouter(orch: Orchestrator): Router {
  const r = Router();
  const platform: PlatformRepo = createPlatformRepo(orch.db);
  const docs = createDocumentStore(orch.db);
  const companyId = orch.companyId;

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

  /**
   * Resolve a credential to a principal. Accepts both an API token (the CLI
   * and the plugin) and a session token (the browser), because they are
   * indistinguishable on the wire and a caller should not have to say which
   * kind it holds.
   */
  const authenticate = async (req: AuthedRequest): Promise<Principal | null> => {
    const secret = bearerFrom(req.headers as Record<string, unknown>);
    if (!secret) return null;
    return (await platform.principalFromToken(secret)) ?? (await platform.principalFromSession(secret));
  };

  const requireAuth = (): ((req: Request, res: Response, next: NextFunction) => void) =>
    (req, res, next) => {
      void authenticate(req as AuthedRequest).then(p => {
        if (!p) { res.status(401).json({ error: "authentication required" }); return; }
        (req as AuthedRequest).principal = p;
        next();
      }).catch(() => res.status(401).json({ error: "authentication required" }));
    };

  const requireAdmin = (req: AuthedRequest, res: Response): boolean => {
    if (req.principal?.user.role !== "admin") { denied(res, "administrator only"); return false; }
    return true;
  };

  /**
   * Resolve `:id` to a project the caller may act on at `need`, or answer 404.
   *
   * Returns null having ALREADY responded, so a handler reads as
   * `const p = await project(...); if (!p) return;`.
   */
  const project = async (req: AuthedRequest, res: Response, need: ProjectRole) => {
    const row = await platform.getProject(String(req.params.id));
    if (!row || row.company_id !== companyId) { missing(res, "project"); return null; }
    const role = await platform.projectRole(req.principal!.user, row.id);
    // No access is reported as absence, not as refusal — see the header.
    if (!role) { missing(res, "project"); return null; }
    if (!atLeast(role, need)) { denied(res, `this action needs ${need} on the project`); return null; }
    req.projectRole = role;
    return row;
  };

  const audit = (req: AuthedRequest, verb: string, extra: Record<string, unknown> = {}) =>
    platform.recordAction({
      companyId, verb, userId: req.principal?.user.id ?? null,
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
    if (!(await platform.isUnclaimed(companyId))) {
      return denied(res, "this installation already has users — ask an administrator for an account");
    }
    const user = await platform.createUser({
      companyId, email, name: name ?? null, role: "admin", passwordHash: await hashPassword(password),
    });
    const { secret } = await platform.createToken(user.id, "bootstrap");
    await audit(req, "auth.bootstrap", { userId: user.id, targetType: "user", targetId: user.id });
    created(res, { user: { id: user.id, email: user.email, role: user.role }, token: secret });
  }));

  r.post("/auth/login", wrap(async (req, res) => {
    const { email, password } = req.body ?? {};
    if (!email || !password) return bad(res, "email and password are required");
    const user = await platform.getUserByEmail(companyId, String(email));
    // One message for "no such user" and "wrong password": distinguishing them
    // tells an attacker which addresses are real.
    const okPass = user && user.status === "active" && await verifyPassword(String(password), user.password_hash);
    if (!user || !okPass) { res.status(401).json({ error: "invalid email or password" }); return; }

    const session = await platform.createSession(user.id);
    await platform.recordAction({ companyId, verb: "auth.login", userId: user.id });
    ok(res, {
      token: session.secret, expiresAt: session.expiresAt,
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
    });
  }));

  r.post("/auth/logout", requireAuth(), wrap(async (req, res) => {
    const secret = bearerFrom(req.headers as Record<string, unknown>);
    if (secret) await platform.destroySession(secret);
    ok(res, { ok: true });
  }));

  r.get("/auth/whoami", requireAuth(), wrap(async (req, res) => {
    const u = req.principal!.user;
    ok(res, {
      id: u.id, email: u.email, name: u.name, role: u.role,
      authenticatedBy: req.principal!.tokenId ? "token" : "session",
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

  // ----------------------------------------------------------------- users

  r.get("/users", requireAuth(), wrap(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const users = await platform.listUsers(companyId);
    ok(res, users.map(({ password_hash, ...u }) => u));
  }));

  r.post("/users", requireAuth(), wrap(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const { email, password, name, role } = req.body ?? {};
    if (!email) return bad(res, "email is required");
    if (role && !isGlobalRole(String(role))) return bad(res, `role must be one of admin, member, viewer`);
    const user = await platform.createUser({
      companyId, email: String(email), name: name ?? null, role: role ? String(role) : "member",
      passwordHash: password ? await hashPassword(String(password)) : null,
    });
    await audit(req, "user.create", { targetType: "user", targetId: user.id, detail: { email: user.email } });
    const { password_hash, ...safe } = user;
    created(res, safe);
  }));

  r.patch("/users/:id", requireAuth(), wrap(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const { name, role, status, password } = req.body ?? {};
    if (role && !isGlobalRole(String(role))) return bad(res, `role must be one of admin, member, viewer`);
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
    ok(res, await platform.listProjects(companyId, { userId: u.id, isAdmin: u.role === "admin" }));
  }));

  r.post("/projects", requireAuth(), wrap(async (req, res) => {
    const u = req.principal!.user;
    if (u.role === "viewer") return denied(res, "a viewer cannot create projects");
    const { name, description, website } = req.body ?? {};
    if (!name) return bad(res, "name is required");
    const row = await platform.createProject({
      companyId, name: String(name), description: description ?? null,
      website: website ?? null, createdBy: u.id,
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
    const { description, website, theme } = req.body ?? {};
    const updated = await platform.updateProject(row.id, { description, website, theme });
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
    const { feature: featureName, path, content, category, encoding } = req.body ?? {};
    if (!path || content === undefined) return bad(res, "path and content are required");

    const feature = featureName ? await platform.getFeatureByName(row.id, String(featureName)) : null;
    if (featureName && !feature) return missing(res, "feature");

    // base64 for anything that is not text — a .docx or a screenshot cannot
    // survive a JSON string, and silently corrupting one would be discovered
    // much later, by a model reading gibberish.
    const bytes = encoding === "base64"
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
    ok(res, { id: req.params.docId, encoding: "base64", content: content.toString("base64") });
  }));

  // ----------------------------------------------------------------- audit

  r.get("/projects/:id/actions", requireAuth(), wrap(async (req, res) => {
    const row = await project(req, res, "viewer"); if (!row) return;
    ok(res, await platform.listActions(companyId, {
      projectId: row.id, limit: req.query.limit ? Number(req.query.limit) : undefined,
    }));
  }));

  // --------------------------------------------------------- installations

  r.post("/installations", requireAuth(), wrap(async (req, res) => {
    const { machineId, hostname, os, pluginVersion } = req.body ?? {};
    if (!machineId) return bad(res, "machineId is required");
    const inst = await platform.registerInstallation({
      companyId, userId: req.principal!.user.id, machineId: String(machineId),
      hostname: hostname ?? null, os: os ?? null, pluginVersion: pluginVersion ?? null,
    });
    await audit(req, "install.register", { targetType: "installation", targetId: inst.id });
    created(res, inst);
  }));

  r.get("/installations", requireAuth(), wrap(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    ok(res, await platform.listInstallations(companyId));
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
    ok(res, await platform.listConversations(companyId, {
      userId: req.principal!.user.id,
      ...(req.query.projectId ? { projectId: String(req.query.projectId) } : {}),
    }));
  }));

  r.post("/conversations", requireAuth(), wrap(async (req, res) => {
    const { projectId, featureId, title } = req.body ?? {};
    created(res, await platform.createConversation({
      companyId, userId: req.principal!.user.id,
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

  // ----------------------------------------------------------------- spend

  r.get("/spend", requireAuth(), wrap(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const by = String(req.query.by ?? "project");
    if (!["project", "agent", "adapter"].includes(by)) return bad(res, "by must be project, agent or adapter");
    ok(res, await platform.spend(companyId, by as "project" | "agent" | "adapter"));
  }));

  return r;
}

/**
 * Names that would be unreachable as a feature: the CLI resolves a project
 * stage before a feature name, and these are the project's own folders.
 * Duplicated from scripts/pipeline.mjs deliberately — the library must not
 * import a consumer's file — and asserted equal by a test there.
 */
export const RESERVED_FEATURE_NAMES = new Set([
  "capabilities", "personas", "app", "all", "baseline",
  "solutions", "documents", "design", "original-files", "outputs",
]);
