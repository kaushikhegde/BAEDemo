# Workstream A — Tenancy and Authentication — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn a single-company install into a multi-organisation one with a super-admin above it, and put an authentication boundary in front of the engine routes that currently have none.

**Architecture:** The `companies` table and a `company_id` column on every platform table already exist; nothing uses them as a dimension because `index.ts` resolves one company id at boot and every caller passes it forever. This workstream stops treating the company as a constant: a `Principal` starts carrying the org it acts within, `superadmin` is added above `admin` as the role that may cross orgs, and the shared auth middleware moves out of `platform-router.ts` so `router.ts` can use the same implementation rather than a second one.

**Tech Stack:** TypeScript (Node 24, ESM, type-stripping — no TS features that emit code), Express 4, PGlite, vitest, React 18 + Vite (chatbot).

**Spec:** `docs/superpowers/specs/2026-08-20-multitenant-platform-design.md` §1

## Global Constraints

- **Australian English** in all user-facing copy (Organisation, Authorise, Behaviour).
- **No new runtime dependencies** in `packages/orchestrator`. It has three (`@electric-sql/pglite`, `express`, `yaml`) and that is a deliberate property. `node:crypto` covers hashing.
- **No parameter properties, enums, namespaces or decorators** anywhere in `cli/`. Node runs those files by *erasing* types; a parameter property is the one TypeScript feature that needs code generated rather than removed. See the comment at `cli/client.ts:12`.
- **A project a caller may not see returns 404, never 403.** A 403 confirms the project exists, which is the fact a caller without access must not be able to learn. This rule is already stated at the top of `platform-router.ts` and extends to issues, runs and organisations.
- **`GET /health` is never authenticated.** A health check that needs a credential is not a health check.
- **Filters live in SQL, not in JavaScript after the fact.** A listing endpoint must not be able to leak by forgetting to filter.
- **This repository's owner commits their own work.** Every task therefore ends with a *verification* step, not a `git commit`. Do not run `git commit` or `git push`.
- Run from the workspace root: `npm test` (vitest in `packages/orchestrator`), `npm run typecheck`, `npm run check:routing`.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `packages/orchestrator/src/core/auth.ts` | Password/token hashing, roles, ranking | Modify — add `superadmin` |
| `packages/orchestrator/migrations/005_tenancy.sql` | Org columns, issue attribution | **Create** |
| `packages/orchestrator/src/core/platform.ts` | Platform data access | Modify — org CRUD, principal carries org |
| `packages/orchestrator/src/http/auth-middleware.ts` | `authenticate` / `requireAuth` / `requireAdmin` / `requireSuperadmin`, shared by both routers | **Create** (extracted from `platform-router.ts`) |
| `packages/orchestrator/src/http/platform-router.ts` | Platform routes | Modify — use the shared middleware and `principal.companyId`; add `/orgs` |
| `packages/orchestrator/src/http/router.ts` | Engine routes | Modify — `requireAuth()` on every route but `/health` |
| `packages/orchestrator/src/core/engine.ts` | Workflow engine | Modify — `start()` takes a companyId and a createdBy |
| `packages/orchestrator/src/index.ts` | Boot | Modify — `companyId` → `homeCompanyId` |
| `cli/index.ts`, `cli/config.ts`, `cli/client.ts` | The `scyne` CLI | Modify — `--org`, `scyne org` |
| `scyne-chatbot/server/auth.ts` | Session cookie ↔ orchestrator token | **Create** |
| `scyne-chatbot/server/index.ts` | Chatbot API | Modify — auth routes, forward the caller's token |
| `scyne-chatbot/src/components/Login.tsx` | Login screen | Modify — real auth, no hardcoded credentials |
| `packages/orchestrator/test/tenancy.test.ts` | Cross-org isolation | **Create** |

---

## Task 1: `superadmin`, the role that crosses organisations

**Files:**
- Modify: `packages/orchestrator/src/core/auth.ts:135-190`
- Test: `packages/orchestrator/test/auth.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `GLOBAL_ROLES` now `["superadmin","admin","member","viewer"]`; `isSuperadmin(role: string): boolean`; `atLeastGlobal(held: string, required: GlobalRole): boolean`; `effectiveProjectRole` unchanged in signature, extended in behaviour.

- [ ] **Step 1: Write the failing tests**

Append to `packages/orchestrator/test/auth.test.ts`:

```ts
import { isSuperadmin, atLeastGlobal, effectiveProjectRole, GLOBAL_ROLES, isGlobalRole } from "../src/core/auth.js";

describe("superadmin", () => {
  it("is a recognised global role, ranked above admin", () => {
    expect(isGlobalRole("superadmin")).toBe(true);
    expect(GLOBAL_ROLES[0]).toBe("superadmin");
    expect(atLeastGlobal("superadmin", "admin")).toBe(true);
    expect(atLeastGlobal("admin", "superadmin")).toBe(false);
    expect(atLeastGlobal("member", "admin")).toBe(false);
  });

  it("owns every project, exactly as an admin does", () => {
    expect(effectiveProjectRole("superadmin", null)).toBe("owner");
  });

  it("is identifiable without a string comparison at every call site", () => {
    expect(isSuperadmin("superadmin")).toBe(true);
    expect(isSuperadmin("admin")).toBe(false);
    expect(isSuperadmin("")).toBe(false);
  });

  it("does not promote a viewer, however they are granted", () => {
    expect(effectiveProjectRole("viewer", "owner")).toBe("viewer");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test -- auth`
Expected: FAIL — `isSuperadmin is not a function`, and `isGlobalRole("superadmin")` returns false.

- [ ] **Step 3: Implement**

In `packages/orchestrator/src/core/auth.ts`, replace the `GLOBAL_ROLES` declaration and add the two helpers below it:

```ts
/**
 * Global roles: what KIND of thing a user may do, anywhere.
 *
 * `superadmin` is the operator of the whole install — us — and is the ONLY
 * role that crosses organisations. It works by bypassing the company filter
 * rather than by holding a membership of every org: a role implemented as ten
 * thousand memberships is a role that breaks the day someone deletes one.
 *
 * Ordered strongest-first so the array doubles as the rank.
 */
export const GLOBAL_ROLES = ["superadmin", "admin", "member", "viewer"] as const;
export type GlobalRole = (typeof GLOBAL_ROLES)[number];

const GLOBAL_RANK: Record<GlobalRole, number> = {
  superadmin: 4, admin: 3, member: 2, viewer: 1,
};

/** "at least this much", so a check does not have to enumerate roles. */
export function atLeastGlobal(held: string, required: GlobalRole): boolean {
  if (!isGlobalRole(held)) return false;
  return GLOBAL_RANK[held] >= GLOBAL_RANK[required];
}

export function isSuperadmin(role: string | null | undefined): boolean {
  return role === "superadmin";
}
```

Then extend `effectiveProjectRole` — its `admin` branch becomes:

```ts
  if (role === "superadmin" || role === "admin") return "owner";
```

(the existing parameter is named `globalRole`; keep that name and change only the condition.)

- [ ] **Step 4: Run the tests**

Run: `npm test -- auth`
Expected: PASS, and the pre-existing `admin`/`member`/`viewer` cases still pass.

- [ ] **Step 5: Export it**

In `packages/orchestrator/src/index.ts`, add `isSuperadmin, atLeastGlobal,` to the existing `export { … } from "./core/auth.js";` block.

- [ ] **Step 6: Verify**

Run: `npm test -- auth && npm run typecheck`
Expected: both green.

---

## Task 2: Migration 005 — organisations and issue attribution

**Files:**
- Create: `packages/orchestrator/migrations/005_tenancy.sql`
- Test: `packages/orchestrator/test/platform-schema.test.ts`

**Interfaces:**
- Consumes: Task 1's role vocabulary.
- Produces: `companies.slug` (unique, not null), `companies.status`, `companies.archived_at`; `issues.created_by uuid`.

- [ ] **Step 1: Write the failing test**

Append to `packages/orchestrator/test/platform-schema.test.ts`:

```ts
describe("005_tenancy", () => {
  const columns = async (table: string): Promise<Set<string>> => {
    const { rows } = await db.query<{ column_name: string }>(
      `select column_name from information_schema.columns where table_name = $1`, [table]);
    return new Set(rows.map(r => r.column_name));
  };

  it("gives every organisation a slug, a status and an archive marker", async () => {
    const c = await columns("companies");
    expect(c.has("slug")).toBe(true);
    expect(c.has("status")).toBe(true);
    expect(c.has("archived_at")).toBe(true);
  });

  it("derives a slug for an organisation that predates the column", async () => {
    const { rows } = await db.query<{ slug: string }>(`select slug from companies where name = 'Scyne'`);
    expect(rows[0]?.slug).toBe("scyne");
  });

  it("refuses two organisations with the same slug", async () => {
    await db.query(`insert into companies (id, name, slug) values (gen_random_uuid(), 'Acme', 'acme')`);
    await expect(
      db.query(`insert into companies (id, name, slug) values (gen_random_uuid(), 'Acme Two', 'acme')`),
    ).rejects.toThrow();
  });

  it("records who started an issue, and tolerates not knowing", async () => {
    expect((await columns("issues")).has("created_by")).toBe(true);
  });
});
```

> The `'Scyne'` row is inserted by this test file's existing `beforeEach`. If your local copy of `platform-schema.test.ts` seeds a different name, use that name in the second test instead.

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test -- platform-schema`
Expected: FAIL — `slug` is not a column of `companies`.

- [ ] **Step 3: Write the migration**

Create `packages/orchestrator/migrations/005_tenancy.sql`:

```sql
-- Many organisations in one install, and a super-admin above them.
--
-- `companies` and a `company_id` on every platform table have existed since
-- 001. Nothing used them as a DIMENSION: index.ts resolved one company id at
-- boot and handed that same value to every call for the life of the process,
-- so the schema was multi-tenant and the application was not.
--
-- Nothing here changes an existing row's meaning. It adds the three columns an
-- organisation needs to be addressable (a slug), suspendable (a status) and
-- retirable (archived_at, never a delete — issues reference it), plus the
-- attribution column that makes `who started this run` answerable.

alter table companies add column slug        text;
alter table companies add column status      text not null default 'active';
alter table companies add column archived_at timestamptz;

-- A slug for rows that predate the column, derived from the name rather than
-- invented: lowercase, non-alphanumerics collapsed to a single hyphen, ends
-- trimmed. 'Scyne AI Lab' -> 'scyne-ai-lab'.
update companies
   set slug = trim(both '-' from regexp_replace(lower(name), '[^a-z0-9]+', '-', 'g'))
 where slug is null;

-- Two organisations may not share a slug: it is what an operator types and
-- what `X-Scyne-Org` carries, so an ambiguous one is an authorisation bug.
-- Applied AFTER the backfill, or the backfill itself could violate it.
alter table companies alter column slug set not null;
create unique index companies_slug_key on companies (slug);
create index on companies (status) where archived_at is null;

-- Who started this issue.
--
-- `on delete set null`, not cascade: deleting a user must not delete the work
-- they did. Existing rows stay null and render '—'. Back-filling an
-- attribution nobody recorded would be inventing evidence, and "started
-- before we tracked this" is a true and useful thing for a column to say.
alter table issues add column created_by uuid references users(id) on delete set null;
create index on issues (created_by);
```

- [ ] **Step 4: Run the tests**

Run: `npm test -- platform-schema`
Expected: PASS.

- [ ] **Step 5: Confirm the migration is idempotent across a real boot**

Run: `npm test -- db platform`
Expected: PASS. `migrate()` records applied files in `_migrations`, so a second boot must skip 005 rather than fail on `add column`.

- [ ] **Step 6: Verify**

Run: `npm test && npm run typecheck`
Expected: green. If `reset.test.ts` fails, it is asserting a table list — add `companies.slug` to whatever it snapshots.

---

## Task 3: A principal knows which organisation it is acting in

**Files:**
- Modify: `packages/orchestrator/src/core/platform.ts:60-75` (the `Principal` interface), `:200-260` (`principalFromToken`, `principalFromSession`)
- Test: `packages/orchestrator/test/platform.test.ts`

**Interfaces:**
- Consumes: Task 1 (`isSuperadmin`), Task 2 (`companies.slug`).
- Produces:
  ```ts
  interface Principal {
    user: UserRow; tokenId: string | null; installationId: string | null;
    companyId: string;        // the org this request acts within
    isSuperadmin: boolean;
  }
  ```
  plus `platform.getCompanyBySlug(slug: string): Promise<CompanyRow | null>` and `platform.getCompany(id: string): Promise<CompanyRow | null>`, where
  ```ts
  interface CompanyRow { id: string; name: string; slug: string; status: string; created_at: string; archived_at: string | null }
  ```

- [ ] **Step 1: Write the failing tests**

Append to `packages/orchestrator/test/platform.test.ts`:

```ts
describe("principal carries its organisation", () => {
  it("resolves a token to the user's own org", async () => {
    const u = await admin();
    const { secret } = await p.createToken(u.id, "cli");
    const principal = await p.principalFromToken(secret);
    expect(principal?.companyId).toBe(company);
    expect(principal?.isSuperadmin).toBe(false);
  });

  it("flags a superadmin so a caller does not compare role strings", async () => {
    const u = await p.createUser({ companyId: company, email: "root@scyne.co", role: "superadmin" });
    const { secret } = await p.createToken(u.id, "cli");
    expect((await p.principalFromToken(secret))?.isSuperadmin).toBe(true);
  });

  it("resolves a session the same way", async () => {
    const u = await admin();
    const { secret } = await p.createSession(u.id);
    const principal = await p.principalFromSession(secret);
    expect(principal?.companyId).toBe(company);
  });
});

describe("organisations", () => {
  it("finds one by slug, which is what a header carries", async () => {
    expect((await p.getCompanyBySlug("scyne"))?.id).toBe(company);
    expect(await p.getCompanyBySlug("nope")).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test -- platform`
Expected: FAIL — `companyId` is undefined, `getCompanyBySlug` is not a function.

- [ ] **Step 3: Implement**

In `packages/orchestrator/src/core/platform.ts`:

Add the row type beside the others near the top:

```ts
export interface CompanyRow {
  id: string; name: string; slug: string; status: string;
  created_at: string; archived_at: string | null;
}
```

Extend `Principal`:

```ts
/** Who a request is acting as, once a credential has been resolved. */
export interface Principal {
  user: UserRow;
  /** The token row's id when authenticated by token, null for a session. */
  tokenId: string | null;
  installationId: string | null;
  /**
   * The organisation this request acts within. A user's own company, except
   * for a superadmin, who may retarget it per request with `X-Scyne-Org`.
   * Every repo call takes a companyId; this is where it comes from, and
   * reading it off the principal rather than off a module-level constant is
   * the whole of the multi-tenancy change.
   */
  companyId: string;
  isSuperadmin: boolean;
}
```

Import `isSuperadmin` from `./auth.js` alongside the existing imports, then make both resolvers populate the new fields. `principalFromToken`'s return becomes:

```ts
      return {
        user: user as UserRow, tokenId: token_id, installationId: null,
        companyId: (user as UserRow).company_id,
        isSuperadmin: isSuperadmin((user as UserRow).role),
      };
```

and `principalFromSession`'s:

```ts
      return rows[0]
        ? {
            user: rows[0], tokenId: null, installationId: null,
            companyId: rows[0].company_id, isSuperadmin: isSuperadmin(rows[0].role),
          }
        : null;
```

Add a company section to the returned object, above `// ------- users`:

```ts
    // --------------------------------------------------------- companies

    async getCompany(id: string): Promise<CompanyRow | null> {
      const { rows } = await db.query<CompanyRow>(`select * from companies where id=$1`, [id]);
      return rows[0] ?? null;
    },

    async getCompanyBySlug(slug: string): Promise<CompanyRow | null> {
      const { rows } = await db.query<CompanyRow>(
        `select * from companies where slug=$1`, [slug.toLowerCase().trim()]);
      return rows[0] ?? null;
    },

    async listCompanies(): Promise<CompanyRow[]> {
      const { rows } = await db.query<CompanyRow>(
        `select * from companies where archived_at is null order by name`);
      return rows;
    },

    async createCompany(input: { name: string; slug?: string }): Promise<CompanyRow> {
      const slug = (input.slug ?? input.name).toLowerCase().trim()
        .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
      if (!slug) throw new Error(`'${input.name}' has no usable slug — give one explicitly`);
      const { rows } = await db.query<CompanyRow>(
        `insert into companies (id, name, slug) values ($1,$2,$3) returning *`,
        [newId(), input.name.trim(), slug]);
      return rows[0];
    },

    async updateCompany(id: string, patch: { name?: string; status?: string }): Promise<CompanyRow | null> {
      const sets: string[] = []; const params: unknown[] = [];
      const set = (col: string, v: unknown) => { params.push(v); sets.push(`${col}=$${params.length}`); };
      if (patch.name !== undefined) set("name", patch.name.trim());
      if (patch.status !== undefined) set("status", patch.status);
      if (!sets.length) return this.getCompany(id);
      params.push(id);
      const { rows } = await db.query<CompanyRow>(
        `update companies set ${sets.join(", ")} where id=$${params.length} returning *`, params);
      return rows[0] ?? null;
    },

    /** Archive, never delete — issues, runs and spend all reference it. */
    async archiveCompany(id: string): Promise<boolean> {
      const { rows } = await db.query<{ id: string }>(
        `update companies set archived_at=now(), status='archived'
          where id=$1 and archived_at is null returning id`, [id]);
      return rows.length > 0;
    },

    /** Headline counts for one organisation, for the Orgs tab and `scyne org list`. */
    async companyStats(id: string): Promise<{
      users: string; projects: string; features: string; issues: string;
    }> {
      const { rows } = await db.query<{ users: string; projects: string; features: string; issues: string }>(
        `select (select count(*) from users    where company_id=$1)::text as users,
                (select count(*) from projects where company_id=$1 and archived_at is null)::text as projects,
                (select count(*) from features f join projects p on p.id=f.project_id
                  where p.company_id=$1 and f.archived_at is null)::text as features,
                (select count(*) from issues   where company_id=$1)::text as issues`, [id]);
      return rows[0];
    },
```

- [ ] **Step 4: Run the tests**

Run: `npm test -- platform`
Expected: PASS.

- [ ] **Step 5: Export the new type**

In `packages/orchestrator/src/index.ts`, add `type CompanyRow,` to the existing `export { createPlatformRepo, … } from "./core/platform.js";` block.

- [ ] **Step 6: Verify**

Run: `npm test && npm run typecheck`
Expected: green.

---

## Task 4: One authentication middleware, shared by both routers

**Files:**
- Create: `packages/orchestrator/src/http/auth-middleware.ts`
- Modify: `packages/orchestrator/src/http/platform-router.ts:69-125` (delete the local copies, import them instead)
- Test: `packages/orchestrator/test/auth-middleware.test.ts` (**create**)

**Interfaces:**
- Consumes: Task 3's `Principal`, `platform.getCompany`/`getCompanyBySlug`.
- Produces:
  ```ts
  export interface AuthedRequest extends Request { principal?: Principal; projectRole?: ProjectRole }
  export function createAuth(platform: PlatformRepo, homeCompanyId: string): {
    authenticate(req: AuthedRequest): Promise<Principal | null>;
    requireAuth(): RequestHandler;
    requireAdmin(req: AuthedRequest, res: Response): boolean;
    requireSuperadmin(req: AuthedRequest, res: Response): boolean;
  };
  ```

**Why this is its own task:** `router.ts` needs the identical check, and a second implementation of an authorisation check drifts. Extracting it first means Task 6 is a one-line change per route rather than a copy.

- [ ] **Step 1: Write the failing test**

Create `packages/orchestrator/test/auth-middleware.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { openDb, migrate, type Db } from "../src/core/db.js";
import { createPlatformRepo, type PlatformRepo } from "../src/core/platform.js";
import { createAuth, type AuthedRequest } from "../src/http/auth-middleware.js";

let dir: string, db: Db, p: PlatformRepo, home: string, other: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "orch-authmw-"));
  db = await openDb({ driver: "pglite", dir });
  await migrate(db, new URL("../migrations", import.meta.url).pathname);
  p = createPlatformRepo(db);
  home = randomUUID();
  await db.query(`insert into companies (id, name, slug) values ($1,'Scyne','scyne')`, [home]);
  other = (await p.createCompany({ name: "Acme" })).id;
});
afterEach(async () => { await db.close(); rmSync(dir, { recursive: true, force: true }); });

const tokenFor = async (companyId: string, role: string) => {
  const u = await p.createUser({ companyId, email: `${role}@${companyId.slice(0, 4)}.co`, role });
  return (await p.createToken(u.id, "test")).secret;
};
const reqWith = (headers: Record<string, string>) => ({ headers } as unknown as AuthedRequest);

describe("createAuth", () => {
  it("resolves a credential to the holder's own organisation", async () => {
    const auth = createAuth(p, home);
    const principal = await auth.authenticate(reqWith({ authorization: `Bearer ${await tokenFor(home, "admin")}` }));
    expect(principal?.companyId).toBe(home);
  });

  it("lets a superadmin retarget the organisation with X-Scyne-Org", async () => {
    const auth = createAuth(p, home);
    const secret = await tokenFor(home, "superadmin");
    const byId = await auth.authenticate(reqWith({ authorization: `Bearer ${secret}`, "x-scyne-org": other }));
    expect(byId?.companyId).toBe(other);
    const bySlug = await auth.authenticate(reqWith({ authorization: `Bearer ${secret}`, "x-scyne-org": "acme" }));
    expect(bySlug?.companyId).toBe(other);
  });

  it("REFUSES an X-Scyne-Org from anyone else rather than ignoring it", async () => {
    const auth = createAuth(p, home);
    const secret = await tokenFor(home, "admin");
    await expect(
      auth.authenticate(reqWith({ authorization: `Bearer ${secret}`, "x-scyne-org": other })),
    ).rejects.toThrow(/not permitted|superadmin/i);
  });

  it("refuses an unknown organisation, even from a superadmin", async () => {
    const auth = createAuth(p, home);
    const secret = await tokenFor(home, "superadmin");
    await expect(
      auth.authenticate(reqWith({ authorization: `Bearer ${secret}`, "x-scyne-org": "does-not-exist" })),
    ).rejects.toThrow(/organisation/i);
  });

  it("returns null with no credential at all", async () => {
    expect(await createAuth(p, home).authenticate(reqWith({}))).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test -- auth-middleware`
Expected: FAIL — cannot resolve `../src/http/auth-middleware.js`.

- [ ] **Step 3: Implement**

Create `packages/orchestrator/src/http/auth-middleware.ts`:

```ts
// The authentication boundary, in one place because there are two routers.
//
// platform-router.ts had its own copy and router.ts had none at all — every
// engine route (/issues, /runs, /agents, /config, /gates) was open to anything
// that could reach the port. Extracting this was the precondition for fixing
// that without writing the check twice: two implementations of an
// authorisation check drift, and the one that drifts is the one nobody is
// looking at.

import type { Request, Response, NextFunction, RequestHandler } from "express";
import { bearerFrom, isSuperadmin, type ProjectRole } from "../core/auth.js";
import type { PlatformRepo, Principal } from "../core/platform.js";

/** Express has no per-request user slot; this is ours. */
export interface AuthedRequest extends Request {
  principal?: Principal;
  projectRole?: ProjectRole;
}

/** Raised by `authenticate` when a credential is valid but the ORG it asks for is not. */
export class OrgScopeError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "OrgScopeError";
  }
}

/** The header a superadmin uses to act inside another organisation. */
export const ORG_HEADER = "x-scyne-org";

export function createAuth(platform: PlatformRepo, homeCompanyId: string) {
  /**
   * Resolve a credential to a principal, or null when there is none.
   *
   * Accepts an API token (the CLI, the chatbot server) and a session token
   * (the browser) interchangeably: they are indistinguishable on the wire and
   * a caller should not have to declare which kind it holds.
   *
   * THROWS rather than returning null when the credential is good but the
   * requested organisation is not allowed. Those are different answers — "who
   * are you" succeeded and "may you act there" failed — and collapsing them
   * into 401 would send someone to re-authenticate over an authorisation
   * problem.
   */
  const authenticate = async (req: AuthedRequest): Promise<Principal | null> => {
    const secret = bearerFrom(req.headers as Record<string, unknown>);
    if (!secret) return null;
    const principal = (await platform.principalFromToken(secret))
      ?? (await platform.principalFromSession(secret));
    if (!principal) return null;

    const raw = req.headers[ORG_HEADER];
    const asked = Array.isArray(raw) ? raw[0] : raw;
    if (!asked || !asked.trim()) return principal;

    // Ignoring this header for a non-superadmin would teach a caller that it
    // worked. It did not.
    if (!isSuperadmin(principal.user.role)) {
      throw new OrgScopeError(403, `${ORG_HEADER} is permitted only for a superadmin`);
    }

    const org = (await platform.getCompany(asked.trim()).catch(() => null))
      ?? (await platform.getCompanyBySlug(asked.trim()));
    if (!org) throw new OrgScopeError(404, `no organisation '${asked.trim()}'`);
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

  const requireAdmin = (req: AuthedRequest, res: Response): boolean => {
    const role = req.principal?.user.role;
    if (role !== "admin" && !isSuperadmin(role)) {
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

  /** The org an UNAUTHENTICATED internal caller falls back to. Boot paths only. */
  const home = (): string => homeCompanyId;

  return { authenticate, requireAuth, requireAdmin, requireSuperadmin, home };
}

export type Auth = ReturnType<typeof createAuth>;
```

Note `getCompany(asked)` is tried first and `.catch(() => null)` guards it: `asked` may be a slug, and passing a non-uuid to a `uuid` column raises rather than returning no rows.

- [ ] **Step 4: Run the tests**

Run: `npm test -- auth-middleware`
Expected: PASS, all five.

- [ ] **Step 5: Make `platform-router.ts` use it**

In `packages/orchestrator/src/http/platform-router.ts`:
- Delete the local `AuthedRequest` interface (line ~69), the local `authenticate`, `requireAuth` and `requireAdmin` (lines ~100-125).
- Import instead: `import { createAuth, type AuthedRequest } from "./auth-middleware.js";`
- Inside `createPlatformRouter`, after `const docs = …`, add `const { requireAuth, requireAdmin, requireSuperadmin } = createAuth(platform, orch.homeCompanyId);`
- Delete `const companyId = orch.companyId;` and replace **every** remaining use of the bare `companyId` with `req.principal!.companyId`. In the `project()` helper, that means its signature gains the check `row.company_id !== req.principal!.companyId`.

> `orch.homeCompanyId` does not exist until Task 5. Do that rename first if the typechecker objects, or temporarily read `orch.companyId`.

- [ ] **Step 6: Verify**

Run: `npm test -- platform-router auth-middleware && npm run typecheck`
Expected: green. Every existing `platform-router.test.ts` case must still pass — this task changes where the company id comes from, not what any route does.

---

## Task 5: `homeCompanyId`, and the `/orgs` routes

**Files:**
- Modify: `packages/orchestrator/src/index.ts:76,101,125`
- Modify: `packages/orchestrator/src/http/platform-router.ts` (route table + handlers)
- Modify: `packages/orchestrator/openapi.yaml`
- Test: `packages/orchestrator/test/platform-router.test.ts`

**Interfaces:**
- Consumes: Task 3 (`createCompany`, `listCompanies`, `companyStats`, `archiveCompany`), Task 4 (`requireSuperadmin`).
- Produces: `Orchestrator.homeCompanyId` (replacing `companyId`); routes `GET /orgs`, `POST /orgs`, `GET /orgs/{id}`, `PATCH /orgs/{id}`, `DELETE /orgs/{id}`.

- [ ] **Step 1: Write the failing test**

Append to `packages/orchestrator/test/platform-router.test.ts`, following that file's existing supertest-or-fetch helper style:

```ts
describe("organisations", () => {
  it("lets a superadmin create and list them", async () => {
    const t = await superadminToken();
    const made = await api("POST", "/orgs", { name: "Acme Pty Ltd" }, t);
    expect(made.status).toBe(201);
    expect(made.body.slug).toBe("acme-pty-ltd");

    const list = await api("GET", "/orgs", undefined, t);
    expect(list.status).toBe(200);
    expect(list.body.map((o: { slug: string }) => o.slug)).toContain("acme-pty-ltd");
  });

  it("refuses an ordinary administrator", async () => {
    const t = await adminToken();
    expect((await api("POST", "/orgs", { name: "Nope" }, t)).status).toBe(403);
  });

  it("shows an administrator only their own organisation", async () => {
    const t = await adminToken();
    const list = await api("GET", "/orgs", undefined, t);
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);
  });

  it("archives rather than deletes", async () => {
    const t = await superadminToken();
    const made = await api("POST", "/orgs", { name: "Temp Co" }, t);
    expect((await api("DELETE", `/orgs/${made.body.id}`, undefined, t)).status).toBe(200);
    const list = await api("GET", "/orgs", undefined, t);
    expect(list.body.map((o: { slug: string }) => o.slug)).not.toContain("temp-co");
  });

  it("reports counts a console can render without a second call", async () => {
    const t = await superadminToken();
    const one = await api("GET", `/orgs/${company}`, undefined, t);
    expect(one.body.stats).toMatchObject({ users: expect.any(String), projects: expect.any(String) });
  });
});
```

Add `superadminToken()` beside the file's existing `adminToken()` helper, creating a user with `role: "superadmin"`.

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test -- platform-router`
Expected: FAIL — 404 on `/orgs`.

- [ ] **Step 3: Rename `companyId` → `homeCompanyId`**

In `packages/orchestrator/src/index.ts`: rename the `Orchestrator` field (line ~76), the local at line ~101 stays `companyId`, and the returned object becomes `homeCompanyId: companyId`. Add a doc comment on the field:

```ts
  /**
   * The organisation named by `config.company` — where the agent org chart is
   * reconciled on boot, and the default for an internal caller with no
   * principal. NOT the only organisation: a request acts within
   * `principal.companyId`, which a superadmin can retarget.
   */
  homeCompanyId: string;
```

Then fix every consumer the typechecker reports (`http/router.ts` has fourteen, `cli.ts` a handful). This is a mechanical rename; do it with the compiler, not with sed, because `companyId` is also a local variable name in several of those files.

- [ ] **Step 4: Add the routes**

In `PLATFORM_ROUTES`, add above `{ method: "GET", path: "/users" }`:

```ts
  { method: "GET",    path: "/orgs" },
  { method: "POST",   path: "/orgs" },
  { method: "GET",    path: "/orgs/{id}" },
  { method: "PATCH",  path: "/orgs/{id}" },
  { method: "DELETE", path: "/orgs/{id}" },
```

And the handlers, beside the other route definitions:

```ts
  // ------------------------------------------------------------- orgs

  r.get("/orgs", requireAuth(), wrap(async (req, res) => {
    // An administrator is not refused here — they are shown their own
    // organisation, as a single-item list. A 403 would make the console's
    // org switcher an error state for the majority of its users; a list of
    // one is the honest answer to "which organisations may I act in".
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
    if (!name?.trim()) { bad(res, "name is required"); return; }
    const org = await platform.createCompany({ name, slug });
    await platform.recordAction({
      companyId: org.id, userId: req.principal!.user.id,
      verb: "org.create", targetType: "company", targetId: org.id, detail: { name: org.name },
    });
    created(res, org);
  }));

  r.get("/orgs/:id", requireAuth(), wrap(async (req, res) => {
    const org = await platform.getCompany(String(req.params.id));
    // 404 rather than 403 for an org the caller may not see — the same rule
    // this file applies to projects, for the same reason.
    if (!org || (!req.principal!.isSuperadmin && org.id !== req.principal!.companyId)) {
      missing(res, "organisation"); return;
    }
    ok(res, { ...org, stats: await platform.companyStats(org.id) });
  }));

  r.patch("/orgs/:id", requireAuth(), wrap(async (req, res) => {
    if (!requireSuperadmin(req, res)) return;
    const { name, status } = (req.body ?? {}) as { name?: string; status?: string };
    const org = await platform.updateCompany(String(req.params.id), { name, status });
    if (!org) { missing(res, "organisation"); return; }
    await platform.recordAction({
      companyId: org.id, userId: req.principal!.user.id,
      verb: "org.update", targetType: "company", targetId: org.id, detail: { name, status },
    });
    ok(res, org);
  }));

  r.delete("/orgs/:id", requireAuth(), wrap(async (req, res) => {
    if (!requireSuperadmin(req, res)) return;
    const id = String(req.params.id);
    if (id === orch.homeCompanyId) {
      bad(res, "the home organisation cannot be archived — it is where the agent org chart lives");
      return;
    }
    if (!(await platform.archiveCompany(id))) { missing(res, "organisation"); return; }
    await platform.recordAction({
      companyId: id, userId: req.principal!.user.id,
      verb: "org.archive", targetType: "company", targetId: id,
    });
    ok(res, { archived: true });
  }));
```

- [ ] **Step 4b: Let `/auth/whoami` say which organisation it is answering for**

The console's org switcher, `scyne whoami` and the chatbot's header all need it,
and none of them should have to make a second call to learn it.

Keep the payload **flat**. `cli/index.ts`'s `cmdWhoami` does
`json({ ...me, apiUrl, project, feature })` — nesting the user under a `user`
key would break that spread silently. Add beside the existing fields:

```ts
  r.get("/auth/whoami", requireAuth(), wrap(async (req, res) => {
    const u = req.principal!.user;
    const org = await platform.getCompany(req.principal!.companyId);
    ok(res, {
      id: u.id, email: u.email, name: u.name, role: u.role,
      authenticatedBy: req.principal!.tokenId ? "token" : "session",
      // The org this request is ACTING IN, which for a superadmin with an
      // X-Scyne-Org header is not the same as the org they belong to.
      company: org ? { id: org.id, name: org.name, slug: org.slug } : null,
      isSuperadmin: req.principal!.isSuperadmin,
    });
  }));
```

Assert it:

```ts
it("says which organisation it is answering for", async () => {
  const me = await api("GET", "/auth/whoami", undefined, await adminToken());
  expect(me.body.company).toMatchObject({ slug: "scyne" });
  expect(me.body.isSuperadmin).toBe(false);
});
```

- [ ] **Step 5: Document the routes**

Add all five to `packages/orchestrator/openapi.yaml`, matching the shape of the neighbouring `/users` entries. `test/openapi.test.ts` diffs the table against the file in both directions, so a route added to one and not the other fails.

- [ ] **Step 6: Verify**

Run: `npm test -- platform-router openapi && npm run typecheck`
Expected: green.

---

## Task 6: Close the engine routes

**Files:**
- Modify: `packages/orchestrator/src/http/router.ts` (every `r.get`/`r.post`/`r.patch`/`r.put`/`r.delete`)
- Test: `packages/orchestrator/test/router.test.ts`

**Interfaces:**
- Consumes: Task 4 (`createAuth`), Task 5 (`homeCompanyId`).
- Produces: no new API; every engine route now 401s without a credential.

- [ ] **Step 1: Write the failing test**

Append to `packages/orchestrator/test/router.test.ts`:

```ts
describe("the engine routes are not public", () => {
  const CLOSED: ReadonlyArray<readonly [string, string]> = [
    ["GET", "/issues"], ["POST", "/issues"], ["GET", "/agents"], ["GET", "/config"],
    ["GET", "/runners"], ["GET", "/skills"], ["GET", "/budgets"], ["GET", "/usage"],
  ];

  it.each(CLOSED)("401s %s %s without a credential", async (method, path) => {
    expect((await api(method, path)).status).toBe(401);
  });

  it("still answers /health, because a health check with a credential is not one", async () => {
    expect((await api("GET", "/health")).status).toBe(200);
  });

  it("serves the console shell unauthenticated — the DATA behind it is what is gated", async () => {
    expect((await api("GET", "/orch")).status).toBe(200);
  });

  it("answers with a credential", async () => {
    expect((await api("GET", "/issues", undefined, await adminToken())).status).toBe(200);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test -- router`
Expected: FAIL — every closed route returns 200.

- [ ] **Step 3: Implement**

In `createRouter`, after the platform router is constructed, add:

```ts
  const auth = createAuth(createPlatformRepo(orch.db), orch.homeCompanyId);
  const guard = auth.requireAuth();
```

Then add `guard` as the first handler of **every** route except these four, which stay open deliberately:

| Route | Why it stays open |
|---|---|
| `GET /health` | a health check that needs a credential is not one |
| `GET /orch` | serves the app shell; it calls `/auth/whoami` and renders a login form until that succeeds |
| `GET /docs` | the API documentation page |
| `GET /openapi.json` | the contract the docs page renders |

So `r.get("/issues", wrap(async …))` becomes `r.get("/issues", guard, wrap(async …))`.

Replace every `orch.companyId` in this file with `(req as AuthedRequest).principal!.companyId`. Fourteen sites; the typechecker lists them all once `homeCompanyId` is renamed.

- [ ] **Step 4: Run the tests**

Run: `npm test -- router`
Expected: PASS.

- [ ] **Step 5: Check nothing else was reaching in unauthenticated**

Run: `npm test`
Expected: PASS. `console.test.ts` and `openapi.test.ts` both exercise this router; a failure here names the caller that needs a credential.

- [ ] **Step 6: Verify**

Run: `npm test && npm run typecheck`
Expected: green.

---

## Task 7: Attribute an issue to the person who started it

**Files:**
- Modify: `packages/orchestrator/src/core/engine.ts:583-600` (`start`)
- Modify: `packages/orchestrator/src/core/repo.ts` (`createIssue`, `listIssues`)
- Modify: `packages/orchestrator/src/http/router.ts` (`POST /issues`)
- Test: `packages/orchestrator/test/engine.test.ts`

**Interfaces:**
- Consumes: Task 2 (`issues.created_by`), Task 6 (`principal` on the request).
- Produces: `engine.start(workflowKey, params, opts?: { companyId?: string; createdBy?: string })`; `IssueRow.created_by: string | null`.

- [ ] **Step 1: Write the failing test**

Append to `packages/orchestrator/test/engine.test.ts`:

```ts
describe("attribution", () => {
  it("records who started an issue", async () => {
    const user = await platform.createUser({ companyId: company, email: "starter@scyne.co" });
    const issue = await engine.start("demo", { project: "P" }, { companyId: company, createdBy: user.id });
    expect((await repo.getIssue(issue.id))!.created_by).toBe(user.id);
  });

  it("tolerates not knowing, rather than inventing an attribution", async () => {
    const issue = await engine.start("demo", { project: "P" });
    expect((await repo.getIssue(issue.id))!.created_by).toBeNull();
  });

  it("starts the issue in the organisation it was asked for, not the home one", async () => {
    const other = await platform.createCompany({ name: "Acme" });
    // The agent org chart is reconciled into the home company only, so an
    // issue in another org has no assignee to resolve — which must not throw.
    const issue = await engine.start("demo", { project: "P" }, { companyId: other.id });
    expect((await repo.getIssue(issue.id))!.company_id).toBe(other.id);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test -- engine`
Expected: FAIL — `start` takes two arguments; `created_by` is undefined.

- [ ] **Step 3: Implement**

`engine.start` currently hardcodes the company. Replace it with:

```ts
    async start(workflowKey, params, opts = {}) {
      const wf = workflow(workflowKey);
      // The caller's organisation, falling back to the configured one. An
      // issue must land in the org the person who started it was acting in —
      // resolving it here from config would file every client's work under
      // whichever org happens to be first in the config file.
      const companyId = opts.companyId ?? await repo.ensureCompany(config.company ?? "Scyne");
      // The org chart is reconciled into the HOME company on boot, so an
      // agent lookup in another org legitimately finds nothing. An issue with
      // no assignee is already a supported state (the engine resolves the
      // agent per step), so this is a null, not an error.
      const agent = await repo.getAgentByKey(companyId, wf.assignee);
      const title = wf.title
        ? interpolate(wf.title, params)
        : `${wf.label} — ${params.project ?? ""}`.trim();
      return repo.createIssue({
        companyId, title,
        workflowKey, params, assigneeAgentId: agent?.id ?? null, status: "todo",
        createdBy: opts.createdBy ?? null,
      });
    },
```

and widen the `Engine` interface's `start` signature to match.

In `core/repo.ts`, `createIssue` gains `createdBy?: string | null` in its input type and `created_by` in its INSERT column list and values; `IssueRow` gains `created_by: string | null`.

In `http/router.ts`, `POST /issues` becomes:

```ts
  r.post("/issues", guard, wrap(async (req, res) => {
    const principal = (req as AuthedRequest).principal!;
    const { workflow, params } = (req.body ?? {}) as { workflow?: string; params?: Record<string, unknown> };
    if (!workflow) { badRequest(res, "workflow is required"); return; }
    let issue;
    try {
      issue = await orch.engine.start(workflow, (params ?? {}) as Record<string, string>, {
        companyId: principal.companyId,
        createdBy: principal.user.id,
      });
    } catch (err) {
      badRequest(res, err instanceof Error ? err.message : String(err));
      return;
    }
    orch.engine.advance(issue.id).catch((err: unknown) => {
      console.error(`[orchestrator] advance(${issue.id}) failed:`, err);
    });
    res.status(201).json(issue);
  }));
```

Leave the long comment about the bare `.catch()` exactly where it is — it records a real incident.

- [ ] **Step 4: Run the tests**

Run: `npm test -- engine repo router`
Expected: PASS.

- [ ] **Step 5: Verify**

Run: `npm test && npm run typecheck`
Expected: green.

---

## Task 8: A project name is unique across the whole install

**Files:**
- Modify: `packages/orchestrator/src/http/platform-router.ts` (`POST /projects`)
- Test: `packages/orchestrator/test/platform-router.test.ts`

**Interfaces:**
- Consumes: Task 4.
- Produces: `409 {"error":"name_taken", …}` when the name exists in ANY organisation.

**Why:** the workspace is a flat `projects/<name>/` tree read by six scripts. Namespacing it per org is a day of script surgery that buys nothing until a real client logs in; until then a collision must be refused rather than silently produce two organisations writing to one directory. See spec §1.4, including its statement of what this leaks.

- [ ] **Step 1: Write the failing test**

```ts
it("refuses a project name another organisation already owns", async () => {
  const su = await superadminToken();
  const other = await api("POST", "/orgs", { name: "Acme" }, su);
  await api("POST", "/projects", { name: "RTWSA" }, su);

  const clash = await api("POST", "/projects", { name: "RTWSA" }, su, { "x-scyne-org": other.body.id });
  expect(clash.status).toBe(409);
  expect(clash.body.error).toBe("name_taken");
});
```

(extend the test file's `api()` helper with an optional fifth `extraHeaders` argument if it does not have one.)

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test -- platform-router`
Expected: FAIL — 201, two projects called RTWSA.

- [ ] **Step 3: Implement**

Add to `core/platform.ts`:

```ts
    /**
     * Is this project name taken ANYWHERE in the install?
     *
     * Deliberately not scoped to one organisation. The workspace is a flat
     * `projects/<name>/` tree that six scripts read, so two organisations with
     * a project of the same name would write to one directory and silently
     * corrupt each other's artefacts. See the spec's §1.4 for what refusing
     * this leaks and why that is accepted for now.
     */
    async projectNameTaken(name: string): Promise<boolean> {
      const { rows } = await db.query<{ n: string }>(
        `select count(*)::text as n from projects where lower(name) = lower($1)`, [name.trim()]);
      return rows[0].n !== "0";
    },
```

and in `POST /projects`, before the insert:

```ts
    if (await platform.projectNameTaken(name)) {
      res.status(409).json({
        error: "name_taken",
        message: `a project named '${name.trim()}' already exists. Project folders are a flat ` +
                 `tree shared by every organisation, so names must be unique across the install.`,
      });
      return;
    }
```

- [ ] **Step 4: Run the tests**

Run: `npm test -- platform-router`
Expected: PASS.

- [ ] **Step 5: Verify**

Run: `npm test && npm run typecheck`
Expected: green.

---

## Task 9: Cross-organisation isolation, proved

**Files:**
- Create: `packages/orchestrator/test/tenancy.test.ts`

**Interfaces:**
- Consumes: Tasks 1-8.
- Produces: nothing. This is the test that decides whether the workstream is correct.

**Why its own task:** every other task adds a capability; this one is the only thing standing between the design and a data leak between two clients. A reviewer should be able to reject it independently.

- [ ] **Step 1: Write the test**

Create `packages/orchestrator/test/tenancy.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, migrate, type Db } from "../src/core/db.js";
import { createPlatformRepo, type PlatformRepo } from "../src/core/platform.js";

let dir: string, db: Db, p: PlatformRepo;
let orgA: string, orgB: string, userA: string, userB: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "orch-tenancy-"));
  db = await openDb({ driver: "pglite", dir });
  await migrate(db, new URL("../migrations", import.meta.url).pathname);
  p = createPlatformRepo(db);

  orgA = (await p.createCompany({ name: "Alpha Council" })).id;
  orgB = (await p.createCompany({ name: "Beta Insurance" })).id;
  userA = (await p.createUser({ companyId: orgA, email: "a@alpha.co", role: "admin" })).id;
  userB = (await p.createUser({ companyId: orgB, email: "b@beta.co",  role: "admin" })).id;

  await p.createProject({ companyId: orgA, name: "Alpha Claims", createdBy: userA });
  await p.createProject({ companyId: orgB, name: "Beta Claims",  createdBy: userB });
});
afterEach(async () => { await db.close(); rmSync(dir, { recursive: true, force: true }); });

describe("two organisations cannot see each other", () => {
  it("projects", async () => {
    const a = await p.listProjects(orgA, { userId: userA });
    const b = await p.listProjects(orgB, { userId: userB });
    expect(a.map(x => x.name)).toEqual(["Alpha Claims"]);
    expect(b.map(x => x.name)).toEqual(["Beta Claims"]);
  });

  it("users", async () => {
    expect((await p.listUsers(orgA)).map(u => u.email)).toEqual(["a@alpha.co"]);
    expect((await p.listUsers(orgB)).map(u => u.email)).toEqual(["b@beta.co"]);
  });

  it("audit actions", async () => {
    await p.recordAction({ companyId: orgA, userId: userA, verb: "project.create" });
    await p.recordAction({ companyId: orgB, userId: userB, verb: "project.create" });
    expect(await p.listActions(orgA)).toHaveLength(1);
    expect((await p.listActions(orgA))[0].user_id).toBe(userA);
  });

  it("spend", async () => {
    expect(await p.spend(orgA)).toEqual([]);
    expect(await p.spend(orgB)).toEqual([]);
  });

  it("an admin of one is NOT an admin of the other, even though admin owns every project", async () => {
    const a = (await p.getUser(userA))!;
    const beta = (await p.listProjects(orgB))[0];
    // effectiveProjectRole promotes an admin to owner — which is why the
    // COMPANY filter, not the role, has to be the boundary. Assert the filter.
    expect((await p.listProjects(orgA, { userId: userA, isAdmin: true })).map(x => x.name))
      .not.toContain(beta.name);
    expect(a.company_id).toBe(orgA);
  });

  it("an archived organisation disappears from the listing but keeps its rows", async () => {
    await p.archiveCompany(orgB);
    expect((await p.listCompanies()).map(c => c.id)).not.toContain(orgB);
    expect(await p.getUser(userB)).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run it**

Run: `npm test -- tenancy`
Expected: PASS. **A failure here is a data leak between two clients — stop and fix it before continuing, do not adjust the test.**

- [ ] **Step 3: Verify**

Run: `npm test`
Expected: all green.

---

## Task 10: The CLI acts as an organisation

**Files:**
- Modify: `cli/config.ts` (add `org?: string`), `cli/client.ts` (send the header), `cli/index.ts` (`scyne org`, `--org`)
- Test: manual, listed in Step 5 — the CLI has no unit suite; it is exercised through the API it calls.

**Interfaces:**
- Consumes: Tasks 4, 5.
- Produces: `scyne org list|create|use|show`, and a global `--org <slug>` on every command.

- [ ] **Step 1: Carry the org in the config**

In `cli/config.ts`, add to `CliConfig`:

```ts
  /** The organisation `scyne org use` pinned, by slug. Superadmins only. */
  org?: string;
```

- [ ] **Step 2: Send it**

In `cli/client.ts`, inside `call()`'s `headers` object, after the authorization line:

```ts
          ...(config.org ? { "x-scyne-org": config.org } : {}),
```

and add to the 403 branch of the error handling, so the refusal is legible:

```ts
      if (res.status === 403 && /x-scyne-org/i.test(detail)) {
        throw new ApiError(403,
          `you are not a superadmin, so you cannot act as another organisation.\n` +
          `  Clear the pin with \`scyne org use --clear\`.`);
      }
```

- [ ] **Step 3: Add the verb**

In `cli/index.ts`, add `cmdOrg` beside `cmdProject`:

```ts
async function cmdOrg(client: Client, args: string[]): Promise<void> {
  const [verb, name] = args;
  switch (verb) {
    case "list": case undefined: {
      const orgs = await client.get<Array<{
        name: string; slug: string; status: string;
        stats: { users: string; projects: string; features: string; issues: string };
      }>>("/orgs");
      if (has("json")) return json(orgs);
      table(orgs.map(o => ({
        name: o.name, slug: o.slug, status: o.status,
        users: o.stats.users, projects: o.stats.projects, issues: o.stats.issues,
      })));
      return;
    }
    case "create": {
      if (!name) throw new ApiError(400, "usage: scyne org create <name> [--slug <slug>]");
      const org = await client.post<{ name: string; slug: string }>("/orgs", { name, slug: flag("slug") });
      out(`✓ created ${org.name} (${org.slug})`);
      out(`  Work in it with \`scyne org use ${org.slug}\``);
      return;
    }
    case "use": {
      if (has("clear")) { patch({ org: undefined }); out("✓ acting as your own organisation"); return; }
      if (!name) throw new ApiError(400, "usage: scyne org use <slug> | --clear");
      // Resolve before pinning: a typo that is only discovered on the NEXT
      // command is a typo that looks like a permissions problem.
      const orgs = await client.get<Array<{ slug: string; name: string }>>("/orgs");
      const hit = orgs.find(o => o.slug === name.toLowerCase());
      if (!hit) {
        throw new ApiError(404,
          `no organisation '${name}'.\n  You can act as: ${orgs.map(o => o.slug).join(", ") || "(none)"}`);
      }
      patch({ org: hit.slug });
      out(`✓ acting as ${hit.name} (${hit.slug})`);
      return;
    }
    case "show": {
      const orgs = await client.get<Array<{ id: string; slug: string }>>("/orgs");
      const hit = orgs.find(o => o.slug === (name ?? load().org));
      if (!hit) throw new ApiError(404, `usage: scyne org show <slug>`);
      return json(await client.get(`/orgs/${hit.id}`));
    }
    default:
      throw new ApiError(400, `unknown: scyne org ${verb}. Try list, create, use, show.`);
  }
}
```

Register it in the dispatch switch (`cli/index.ts:906`), above `case "project":`:

```ts
    case "org":      return cmdOrg(client, rest);
```

Make `--org` win over the pin — in `main()`, where the client is built:

```ts
  const client = createClient({
    ...(flag("api") ? { apiUrl: flag("api") } : {}),
    ...(flag("org") ? { org: flag("org") } : {}),
  });
```

Add both to `USAGE`, in the Superadmin section that already exists at `cli/index.ts:867`:

```
    org list                         every organisation, with counts
    org create <name> [--slug s]     create one
    org use <slug> | --clear         act as one for subsequent commands
    org show [<slug>]                one organisation in detail
```

and to the Global flags line: `--org <slug>`.

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: green (it covers `cli/tsconfig.json`).

- [ ] **Step 5: Exercise it against a running server**

```bash
npm run serve &                       # or npm run dev
node cli/index.ts org list            # your own org, one row
node cli/index.ts org create "Acme Pty Ltd"
node cli/index.ts org use acme-pty-ltd
node cli/index.ts whoami              # apiUrl, org, project
node cli/index.ts org use --clear
```

Expected: as a superadmin all five succeed. As an `admin`, `org list` shows one row and `org create` fails with `superadmin only`.

- [ ] **Step 6: Verify**

Run: `npm run typecheck && npm test`
Expected: green.

---

## Task 11: The chatbot logs in as a real user

**Files:**
- Create: `scyne-chatbot/server/auth.ts`
- Modify: `scyne-chatbot/server/index.ts`, `scyne-chatbot/server/orchestrator.ts`
- Modify: `scyne-chatbot/src/components/Login.tsx`, `scyne-chatbot/src/App.tsx`, `scyne-chatbot/src/api.ts`
- Test: manual, listed in Step 6

**Interfaces:**
- Consumes: Tasks 4-7. Every orchestrator call now needs a credential.
- Produces: `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/whoami`; and `tokenFor(req): string | null` used by `orchestrator.ts` to forward the caller's credential.

**This task ships with Task 6 or the chatbot is dead.** `scyne-chatbot/server/orchestrator.ts` sends no `Authorization` header today; the moment the engine routes require one, every trigger 401s. If you are executing tasks separately, do 6 and 11 in one pass.

- [ ] **Step 1: Write the session module**

Create `scyne-chatbot/server/auth.ts`:

```ts
// The chatbot's half of authentication.
//
// It holds no user table and no passwords: it forwards credentials to the
// orchestrator, which owns identity for the whole install. What lives here is
// the browser half — an httpOnly cookie, so a token is never readable from
// JavaScript, which is the one thing localStorage cannot offer.
//
// The token in the cookie is the USER'S, not a service credential. A run
// started from chat is therefore attributed to the person who started it,
// which is the entire point of issues.created_by.

import type { Request, Response } from "express";

const COOKIE = "scyne_token";
const ORCHESTRATOR = process.env.ORCHESTRATOR_API_URL ?? "http://127.0.0.1:3100";

export function tokenFor(req: Request): string | null {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === COOKIE) return decodeURIComponent(v.join("="));
  }
  return null;
}

export function setSessionCookie(res: Response, token: string, maxAgeMs: number): void {
  // `SameSite=Lax` rather than `Strict`: the app is opened by following a link
  // as often as by typing the address, and Strict drops the cookie on that
  // first navigation, presenting a login screen to someone already logged in.
  // Not `Secure`, because this runs on http://127.0.0.1 — add it behind TLS.
  res.setHeader("Set-Cookie",
    `${COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(maxAgeMs / 1000)}`);
}

export function clearSessionCookie(res: Response): void {
  res.setHeader("Set-Cookie", `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
}

/**
 * Mirrors the orchestrator's `GET /auth/whoami` EXACTLY, which is flat rather
 * than nested under a `user` key — `cli/index.ts`'s cmdWhoami spreads it, so
 * the shape is load-bearing in two consumers. Do not "tidy" it into a nested
 * object without changing both.
 */
export interface Whoami {
  id: string; email: string; name: string | null; role: string;
  authenticatedBy: "token" | "session";
  company: { id: string; name: string; slug: string } | null;
  isSuperadmin: boolean;
}

/** Ask the orchestrator who a token belongs to. Null when it does not answer 200. */
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
  await fetch(`${ORCHESTRATOR}/auth/logout`, {
    method: "POST", headers: { authorization: `Bearer ${token}` },
  }).catch(() => { /* a failed remote logout must not block clearing the cookie */ });
}

/** Express guard: 401 unless the request carries a session cookie. */
export function requireSession(req: Request, res: Response, next: () => void): void {
  if (!tokenFor(req)) { res.status(401).json({ error: "not_authenticated" }); return; }
  next();
}
```

- [ ] **Step 2: Wire the routes**

In `scyne-chatbot/server/index.ts`, near the other route registrations:

```ts
import { login, logout, whoami, tokenFor, setSessionCookie, clearSessionCookie, requireSession } from "./auth.js";

const SESSION_MS = 12 * 60 * 60 * 1000;   // matches the orchestrator's SESSION_TTL_MS

app.post("/api/auth/login", async (req, res) => {
  const { email, password } = (req.body ?? {}) as { email?: string; password?: string };
  if (!email || !password) { res.status(400).json({ error: "email and password are required" }); return; }
  const result = await login(email, password);
  // One message for a bad email and a bad password alike: telling them apart
  // turns the login form into a directory of who has an account here.
  if (!result) { res.status(401).json({ error: "invalid email or password" }); return; }
  setSessionCookie(res, result.token, SESSION_MS);
  res.json({ user: result.user });
});

app.post("/api/auth/logout", async (req, res) => {
  const token = tokenFor(req);
  if (token) await logout(token);
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.get("/api/auth/whoami", async (req, res) => {
  const token = tokenFor(req);
  const me = token ? await whoami(token) : null;
  if (!me) { clearSessionCookie(res); res.status(401).json({ error: "not_authenticated" }); return; }
  res.json(me);
});
```

Then guard every other `/api/*` route with `requireSession`, except `/api/auth/*` and any health endpoint. The blunt way, registered **after** the auth routes and **before** everything else:

```ts
app.use("/api", (req, res, next) => {
  if (req.path.startsWith("/auth/")) { next(); return; }
  requireSession(req, res, next);
});
```

- [ ] **Step 3: Forward the credential**

In `scyne-chatbot/server/orchestrator.ts`, every `fetch` to the orchestrator gains the caller's token. Thread a `token: string | null` parameter through the exported functions rather than reading a module global — a module global would be one user's credential serving another user's request.

```ts
const headers = (token: string | null, json = true): Record<string, string> => ({
  ...(json ? { "content-type": "application/json" } : {}),
  ...(token ? { authorization: `Bearer ${token}` } : {}),
});
```

Every call site in `index.ts` passes `tokenFor(req)`.

- [ ] **Step 4: Replace the hardcoded login**

In `scyne-chatbot/src/components/Login.tsx`:
- Delete `VALID_USER`, `VALID_PASS`, `SESSION_KEY`, `loadSession` and `clearSession`.
- The submit handler posts to `/api/auth/login` with `credentials: "include"` and calls `onAuthenticated` with the returned user on 200, or shows the server's message on 401.
- Rename the "user" field to "email" with `type="email"` and `autoComplete="username"`; the password field gets `autoComplete="current-password"`.

In `scyne-chatbot/src/App.tsx`:
- Replace the `loadSession()` boot check with a `GET /api/auth/whoami` on mount: 200 renders the app, 401 renders `<Login>`.
- Logout posts `/api/auth/logout` and returns to `<Login>`.
- Keep `localStorage.scyne_parent_issue_id`; that is workflow state, not a credential.

In `scyne-chatbot/src/api.ts`, add `credentials: "include"` to every `fetch`, and treat a 401 as "session expired — show the login screen" rather than as a generic error.

- [ ] **Step 5: Remove the demo credentials from the docs**

Search and update: `CLAUDE.md` mentions `admin` / `scyne2026` in the chatbot section. Replace with a line saying the chatbot authenticates against the orchestrator's user table and that the first account is created by `scyne init`.

Run: `grep -rn "scyne2026" --include=*.ts --include=*.tsx --include=*.md . | grep -v node_modules`
Expected: no hits.

- [ ] **Step 6: Exercise it**

```bash
npm run dev        # orchestrator :3100 + chatbot :5173
```

1. Open `http://127.0.0.1:5173` — the login screen appears.
2. Wrong password → "invalid email or password", and no cookie is set.
3. Correct credentials → the app loads; DevTools ▸ Application ▸ Cookies shows `scyne_token` marked **HttpOnly**.
4. `curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:5173/api/features` → **401**.
5. Trigger a stage from chat, then check attribution:
   `node cli/index.ts status <SCY-n> --json | grep created_by` → your user's uuid, not null.
6. Log out → the login screen returns and step 4 still gives 401.

- [ ] **Step 7: Verify the whole workstream**

```bash
npm test && npm run typecheck && npm run check:routing
```
Expected: all three green.

---

## Done when

- [ ] `npm test` green, including the new `tenancy.test.ts` and `auth-middleware.test.ts`.
- [ ] `npm run typecheck` green across `packages/orchestrator` and `cli`.
- [ ] `npm run check:routing` green.
- [ ] `curl -s -o /dev/null -w '%{http_code}' localhost:3100/issues` → **401**; `…/health` → **200**.
- [ ] `grep -rn "scyne2026"` finds nothing outside `node_modules`.
- [ ] Two organisations exist; a user in each cannot see the other's projects from the CLI.
- [ ] A run started from the chatbot records `created_by`.
