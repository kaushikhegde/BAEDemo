// The authentication boundary, in one place, because there are two routers.
//
// platform-router.ts had its own copy of this and router.ts had none at all —
// every engine route (/issues, /runs, /agents, /config, /gates) was open to
// anything that could reach the port. Extracting this was the precondition for
// closing them without writing the check twice: two implementations of an
// authorisation check drift, and the one that drifts is the one nobody is
// looking at.

import type { Request, Response, RequestHandler } from "express";
import { atLeastGlobal, bearerFrom, isSuperadmin, type ProjectRole } from "../core/auth.js";
import type { PlatformRepo, Principal } from "../core/platform.js";

/** Express has no per-request user slot; this is ours. */
export interface AuthedRequest extends Request {
  principal?: Principal;
  projectRole?: ProjectRole;
}

/**
 * Raised when a credential is VALID but the organisation it asks to act in is
 * not available to it.
 *
 * Deliberately distinct from "no credential". Those are different answers —
 * "who are you" succeeded and "may you act there" failed — and collapsing them
 * into a 401 sends someone off to re-authenticate over what is actually an
 * authorisation problem, which they will not be able to fix by logging in
 * again.
 */
export class OrgScopeError extends Error {
  // Declared and assigned rather than a `constructor(readonly status: …)`
  // parameter property — the same constraint cli/client.ts documents. A
  // parameter property is the one TypeScript feature that needs code
  // GENERATED rather than erased, and this package is run by type-stripping.
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "OrgScopeError";
  }
}

/** The header a superadmin uses to act inside another organisation. */
export const ORG_HEADER = "x-scyne-org";

/**
 * The console's credential.
 *
 * httpOnly, so the page's own JavaScript cannot read it — which is the whole
 * reason to use a cookie here rather than localStorage. The console then needs
 * no token handling at all: its fetches are same-origin and the browser
 * attaches this by itself.
 *
 * `SameSite=Strict` rather than `Lax`, unlike the chatbot's: nothing links INTO
 * the console from elsewhere, so there is no first-navigation case to
 * accommodate, and Strict is the stronger setting.
 */
export const SESSION_COOKIE = "scyne_session";

export function sessionCookieHeader(token: string, maxAgeMs: number): string {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; ` +
         `Max-Age=${Math.floor(maxAgeMs / 1000)}`;
}

export const clearSessionCookieHeader = (): string =>
  `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;

/** Pull our session cookie out of a Cookie header, or null. */
export function cookieCredential(headers: Record<string, unknown>): string | null {
  const raw = headers["cookie"] ?? headers["Cookie"];
  if (typeof raw !== "string") return null;
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    // indexOf, not split("="): a base64url token can contain no "=", but the
    // value is percent-encoded and a future one might, and splitting would
    // silently truncate it into an invalid credential.
    if (part.slice(0, eq).trim() !== SESSION_COOKIE) continue;
    const value = decodeURIComponent(part.slice(eq + 1).trim());
    return value || null;
  }
  return null;
}

export function createAuth(platform: PlatformRepo, homeCompanyId: string) {
  /**
   * Resolve a credential to a principal, or null when there is none.
   *
   * Accepts an API token (the CLI, the chatbot server) and a session token
   * (the browser) interchangeably: they are indistinguishable on the wire and
   * a caller should not have to declare which kind it is holding.
   */
  const authenticate = async (req: AuthedRequest): Promise<Principal | null> => {
    // An explicit Authorization header wins: a caller that went to the trouble
    // of sending one means it. The cookie is the browser's fallback.
    const headers = req.headers as Record<string, unknown>;
    const secret = bearerFrom(headers) ?? cookieCredential(headers);
    if (!secret) return null;
    const principal = (await platform.principalFromToken(secret))
      ?? (await platform.principalFromSession(secret));
    if (!principal) return null;

    const raw = req.headers[ORG_HEADER];
    const asked = (Array.isArray(raw) ? raw[0] : raw)?.trim();
    if (!asked) return principal;

    if (!isSuperadmin(principal.user.role)) {
      throw new OrgScopeError(403, `${ORG_HEADER} is permitted only for a superadmin`);
    }

    // By id first, then by slug. `getCompany` binds to a `uuid` column, and
    // postgres RAISES on a non-uuid rather than returning no rows — so a slug
    // reaching it must be caught here, not allowed to surface as a 500.
    const byId = await platform.getCompany(asked).catch(() => null);
    const org = byId ?? (await platform.getCompanyBySlug(asked));
    if (!org) throw new OrgScopeError(404, `no organisation '${asked}'`);
    if (org.archived_at) throw new OrgScopeError(404, `organisation '${org.slug}' is archived`);

    return { ...principal, companyId: org.id };
  };

  const requireAuth = (): RequestHandler => (req, res, next) => {
    void authenticate(req as AuthedRequest)
      .then(p => {
        if (!p) { res.status(401).json({ error: "authentication required" }); return; }
        (req as AuthedRequest).principal = p;
        next();
      })
      .catch((err: unknown) => {
        if (err instanceof OrgScopeError) { res.status(err.status).json({ error: err.message }); return; }
        res.status(401).json({ error: "authentication required" });
      });
  };

  /**
   * Returns true when the request may proceed, having ALREADY responded when
   * it may not — so a handler reads as `if (!requireAdmin(req, res)) return;`.
   */
  const requireAdmin = (req: AuthedRequest, res: Response): boolean => {
    // The RANK decides, so a role added above admin is included automatically
    // rather than having to be remembered at every call site.
    if (!atLeastGlobal(req.principal?.user.role, "admin")) {
      res.status(403).json({ error: "administrator only" });
      return false;
    }
    return true;
  };

  const requireSuperadmin = (req: AuthedRequest, res: Response): boolean => {
    if (!isSuperadmin(req.principal?.user.role)) {
      res.status(403).json({ error: "superadmin only" });
      return false;
    }
    return true;
  };

  /**
   * The organisation an INTERNAL caller with no principal falls back to —
   * boot paths and the agent org chart. Never a substitute for a principal on
   * a request that has one.
   */
  const home = (): string => homeCompanyId;

  return { authenticate, requireAuth, requireAdmin, requireSuperadmin, home };
}

export type Auth = ReturnType<typeof createAuth>;
