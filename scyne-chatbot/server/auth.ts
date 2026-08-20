// The chatbot's half of authentication.
//
// It holds no user table and no passwords: identity belongs to the
// orchestrator, for the whole install. What lives here is the BROWSER half —
// an httpOnly cookie, so a credential is never readable from JavaScript, which
// is the one thing localStorage cannot offer.
//
// The token in that cookie is the USER'S, not a service credential. A run
// started from chat is therefore attributed to the person who started it,
// which is the entire point of issues.created_by. It also means project
// visibility, organisation scope and role checks are the orchestrator's
// answers rather than a second implementation living here.

import { AsyncLocalStorage } from "node:async_hooks";
import type { Request, Response, NextFunction } from "express";

const COOKIE = "scyne_token";
const ORCHESTRATOR = process.env.ORCHESTRATOR_API_URL || "http://127.0.0.1:3100";

/** Matches the orchestrator's SESSION_TTL_MS, so the cookie and the session expire together. */
export const SESSION_MS = 12 * 60 * 60 * 1000;

/**
 * The credential for the request currently being served.
 *
 * AsyncLocalStorage rather than a module-level `let`, and rather than a
 * parameter threaded through server/orchestrator.ts's thirty-three call
 * sites. A module global would be one user's token serving another user's
 * request the moment two people use the app at once — a cross-tenant leak
 * that would not show up in single-user testing.
 */
export const requestAuth = new AsyncLocalStorage<{ token: string | null }>();

/** The token for the in-flight request, for server/orchestrator.ts's `call()`. */
export function currentToken(): string | null {
  return requestAuth.getStore()?.token ?? null;
}

export function tokenFor(req: Request): string | null {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === COOKIE) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

export function setSessionCookie(res: Response, token: string): void {
  // `SameSite=Lax` rather than `Strict`: this app is opened by following a
  // link as often as by typing the address, and Strict drops the cookie on
  // that first navigation — presenting a login screen to someone who is
  // already logged in. Not `Secure`, because it runs on http://127.0.0.1;
  // add it the moment this is served over TLS.
  res.setHeader("Set-Cookie",
    `${COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(SESSION_MS / 1000)}`);
}

export function clearSessionCookie(res: Response): void {
  res.setHeader("Set-Cookie", `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
}

/**
 * Mirrors the orchestrator's `GET /auth/whoami` EXACTLY, which is FLAT rather
 * than nested under a `user` key — cli/index.ts's cmdWhoami spreads it, so the
 * shape is load-bearing in two consumers. Do not tidy it into a nested object
 * without changing both.
 */
export interface Whoami {
  id: string;
  email: string;
  name: string | null;
  role: string;
  authenticatedBy: "token" | "session";
  company: { id: string; name: string; slug: string } | null;
  isSuperadmin: boolean;
}

export async function whoami(token: string): Promise<Whoami | null> {
  const res = await fetch(`${ORCHESTRATOR}/auth/whoami`, {
    headers: { authorization: `Bearer ${token}` },
  }).catch(() => null);
  if (!res?.ok) return null;
  return (await res.json()) as Whoami;
}

export async function login(email: string, password: string):
  Promise<{ token: string; user: { id: string; email: string; role: string } } | null> {
  const res = await fetch(`${ORCHESTRATOR}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  }).catch(() => null);
  if (!res?.ok) return null;
  return (await res.json()) as { token: string; user: { id: string; email: string; role: string } };
}

export async function logout(token: string): Promise<void> {
  // A failed remote logout must not stop the cookie being cleared — otherwise
  // an orchestrator that is briefly down leaves someone unable to sign out.
  await fetch(`${ORCHESTRATOR}/auth/logout`, {
    method: "POST", headers: { authorization: `Bearer ${token}` },
  }).catch(() => { /* best effort */ });
}

/**
 * Put the request's credential where `orchestrator.call()` can find it.
 * Mounted before every route, including the unauthenticated ones — carrying a
 * null token is correct and lets a route decide for itself.
 */
export function carryAuth(req: Request, _res: Response, next: NextFunction): void {
  requestAuth.run({ token: tokenFor(req) }, () => next());
}

/** 401 unless the request carries a session cookie. */
export function requireSession(req: Request, res: Response, next: NextFunction): void {
  if (!tokenFor(req)) { res.status(401).json({ error: "not_authenticated" }); return; }
  next();
}
