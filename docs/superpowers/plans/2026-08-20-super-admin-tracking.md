# Super-Admin Tracking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Answer "who ran what, against which project and which feature, and what did it cost" — in the console and from the CLI — with every surface behind a login.

**Architecture:** Three layers. Attribution (`issues.created_by`, written from the authenticated principal, since nothing records the human today). Authentication (the engine routes get the same `requireAuth` the platform routes already have, and the console gets a login screen). Presentation (`spend()` gains feature and user dimensions plus filters; four admin tabs; CLI filters).

**Tech Stack:** TypeScript (ESM, NodeNext), Express 4, PGlite, vitest 2.1, vanilla JS console (no build step, zero network requests beyond its own API).

**Spec:** `docs/superpowers/specs/2026-08-20-super-admin-tracking-design.md`

## Global Constraints

- **Commit inside this worktree, on branch `sdd/2026-08-20-codex-ado-admin`, and nowhere else.**
  The user commits their own work on their own branch — `feat-paperclip` is never
  touched. This branch exists so the review machinery (which is entirely
  `git diff BASE HEAD`) has something to read; the user chooses at the end what,
  if anything, is integrated.
- **Correction to the spec:** the spec says "session cookie". The auth layer is bearer-only — `bearerFrom()` reads `Authorization: Bearer` and `X-Scyne-Token`, never a cookie. `POST /auth/login` already returns a session token, so the console stores that and sends it as a bearer header. No cookie support is added, and no CSRF surface is created.
- The spec's "migration 004" is split so each plan stands alone: the Codex plan owns `004_run_adapter.sql`, this plan owns `005_issue_attribution.sql`.
- `openapi.yaml` is diffed against `ROUTES` **in both directions** by `test/openapi.test.ts`. Any route added or given a new query parameter means editing both.
- Postgres `bigint`/`numeric` come back as **strings**. `Number()` them before arithmetic.
- Australian English in user-facing strings.
- Tests: `npm test`. Type check: `npm run typecheck`. Routing: `npm run check:routing`.
- **Never sum a null cost as zero.** A Codex run records `cost_usd = null`; a naive `sum` presents a partial total as a complete one. Every aggregate reports how many runs were unpriced.

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/orchestrator/migrations/005_issue_attribution.sql` | NEW — `issues.created_by` |
| `packages/orchestrator/src/core/repo.ts` | MODIFY — `createIssue` accepts `createdBy` |
| `packages/orchestrator/src/core/engine.ts` | MODIFY — `start()` takes `{ createdBy }` |
| `packages/orchestrator/src/core/platform.ts` | MODIFY — `spend()` dimensions + filters, `listActions()` filters |
| `packages/orchestrator/src/http/auth-middleware.ts` | NEW — `requireAuth`/`requireAdmin`, shared by both routers |
| `packages/orchestrator/src/http/router.ts` | MODIFY — engine routes require auth; `POST /issues` records the principal |
| `packages/orchestrator/src/http/platform-router.ts` | MODIFY — imports the shared middleware; `/spend` and `/actions` take query params |
| `packages/orchestrator/src/http/console/shell.ts` | NEW — chrome, hash routing, login (split out of `console.ts`) |
| `packages/orchestrator/src/http/console/engine.ts` | NEW — runs, issues, gates, org, skills, budgets, config, health |
| `packages/orchestrator/src/http/console/admin.ts` | NEW — Users, Projects, Spend, Audit |
| `packages/orchestrator/openapi.yaml` | MODIFY |
| `cli/index.ts` | MODIFY — `spend`/`actions` filters, `user show`, `project show` |
| `scyne-chatbot/src/components/Login.tsx` | MODIFY — real auth against the orchestrator |
| `scyne-chatbot/server/orchestrator.ts` | MODIFY — forward the caller's token |
| `CLAUDE.md` | MODIFY |

---

### Task 1: Record who started an issue

`issues` carries `project_id` and `feature_id` but no user, so every run in the system is attributable to an agent and a project and to nobody at all. `SpendRow` already declares `user_id`; every query hard-codes `null::uuid` because there is nothing to select.

**Files:**
- Create: `packages/orchestrator/migrations/005_issue_attribution.sql`
- Modify: `packages/orchestrator/src/core/repo.ts` (`createIssue`), `packages/orchestrator/src/core/engine.ts:599-610`
- Test: `packages/orchestrator/test/repo.test.ts`, `packages/orchestrator/test/engine.test.ts`

**Interfaces:**
- Consumes: `users.id` from migration 002.
- Produces: `issues.created_by uuid null`; `CreateIssueInput.createdBy?: string | null`; `engine.start(key, params, opts?: { createdBy?: string | null })`.

- [ ] **Step 1: Write the failing test**

Add to `packages/orchestrator/test/repo.test.ts`:

```ts
it("records who created an issue, and leaves it null when nobody is known", async () => {
  const user = await platform.createUser({ companyId, email: "ops@scyne.test", role: "admin" });

  const attributed = await repo.createIssue({
    companyId, title: "attributed",
    workflowKey: "datamodel", createdBy: user.id,
  });
  expect(attributed.created_by).toBe(user.id);

  const anonymous = await repo.createIssue({
    companyId, title: "anonymous", workflowKey: "datamodel",
  });
  expect(anonymous.created_by).toBeNull();
});
```

Add to `packages/orchestrator/test/engine.test.ts`:

```ts
it("carries the caller through start() onto the issue", async () => {
  const user = await platform.createUser({ companyId, email: "starter@scyne.test", role: "member" });
  const issue = await engine.start("datamodel", { project: "SADA", feature: "x" }, { createdBy: user.id });
  expect(issue.created_by).toBe(user.id);
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npm test -- repo engine`
Expected: FAIL — `createdBy` is not a known property, `created_by` is `undefined`.

- [ ] **Step 3: Add the migration**

Create `packages/orchestrator/migrations/005_issue_attribution.sql`:

```sql
-- Who started this issue.
--
-- Until now nothing recorded it. `issues` carried project_id and feature_id, so
-- a run could be attributed to an agent and to a project and to nobody at all —
-- which is why platform.spend()'s SpendRow has always declared a `user_id` that
-- every query fills with `null::uuid`. There was nothing to select.
--
-- `on delete set null` rather than cascade: deleting a person must not delete
-- the record of the work. The issue survives, unattributed.
alter table issues add column created_by uuid references users(id) on delete set null;

create index on issues (created_by);

-- No backfill. Every existing issue was started before this column existed, and
-- writing a plausible user into them would be inventing evidence. They render
-- as `—`, which is true and useful: "started before we tracked this".
```

- [ ] **Step 4: Thread it through repo and engine**

In `packages/orchestrator/src/core/repo.ts`, add `createdBy?: string | null` to `CreateIssueInput` and `created_by: string | null` to `IssueRow`, then add the column to `createIssue`'s insert (add `created_by` to the column list and `$N` to the values, passing `input.createdBy ?? null`).

In `packages/orchestrator/src/core/engine.ts`, widen `start`:

```ts
    async start(workflowKey, params, opts = {}) {
      const wf = workflow(workflowKey);
      const companyId = await repo.ensureCompany(config.company ?? "Scyne");
      const agent = await repo.getAgentByKey(companyId, wf.assignee);
      const title = wf.title
        ? interpolate(wf.title, params)
        : `${wf.label} — ${params.project ?? ""}`.trim();
      return repo.createIssue({
        companyId, title,
        workflowKey, params, assigneeAgentId: agent?.id ?? null, status: "todo",
        // Optional because the library has no opinion about who its callers
        // are: a CLI knows, a cron does not, and a run started by neither is
        // legitimately unattributed rather than wrongly attributed.
        createdBy: opts.createdBy ?? null,
      });
    },
```

Update the `Engine` interface's `start` signature to match.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -- repo engine && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Checkpoint**

Stop.

---

### Task 2: Authenticate every route, and keep the chatbot alive through it

`/orch` and every engine route (`/issues`, `/agents`, `/runs`, `/gates`, `/config`) are served with no credential. Putting user and spend data on that page without a login would publish it to anything that can reach port 3100.

**The ripple that will bite:** `scyne-chatbot/server/orchestrator.ts:15` calls the orchestrator with **no Authorization header at all**. The moment engine routes require auth, every chatbot trigger 401s. Both changes land in this one task.

**Files:**
- Create: `packages/orchestrator/src/http/auth-middleware.ts`
- Modify: `packages/orchestrator/src/http/platform-router.ts:101-119` (import instead of define)
- Modify: `packages/orchestrator/src/http/router.ts` (apply to engine routes; `POST /issues` records the principal)
- Modify: `scyne-chatbot/server/orchestrator.ts`
- Test: `packages/orchestrator/test/auth-middleware.test.ts` (new), `packages/orchestrator/test/router.test.ts`

**Interfaces:**
- Consumes: `platform.principalFromToken`, `platform.principalFromSession`, `bearerFrom` (all existing).
- Produces:
  ```ts
  export interface AuthedRequest extends Request { principal?: Principal; projectRole?: ProjectRole }
  export function createAuth(platform: PlatformRepo): {
    authenticate(req: AuthedRequest): Promise<Principal | null>;
    requireAuth(): RequestHandler;
    requireAdmin(req: AuthedRequest, res: Response): boolean;
  };
  ```

- [ ] **Step 1: Write the failing test**

Create `packages/orchestrator/test/auth-middleware.test.ts`:

Copy the `beforeEach`/`afterEach` harness and the `call()` helper verbatim from
`packages/orchestrator/test/platform-router.test.ts:11-55` — an express app over
`createRouter(orch)` on an ephemeral port, plus its bootstrap helper that creates
the first admin and returns a token. Then:

```ts
import { describe, it, expect } from "vitest";

let adminToken: string, memberToken: string, adminUserId: string;

beforeEach(async () => {
  const boot = await call("POST", "/auth/bootstrap",
    { body: { email: "admin@scyne.test", password: "correct horse battery staple", name: "Admin" } });
  adminToken = boot.body.token;
  adminUserId = boot.body.user.id;

  const member = await call("POST", "/users", {
    token: adminToken,
    body: { email: "member@scyne.test", password: "another long passphrase", role: "member" },
  });
  const login = await call("POST", "/auth/login",
    { body: { email: "member@scyne.test", password: "another long passphrase" } });
  memberToken = login.body.token;
  expect(member.status).toBe(201);
});

describe("authentication across the whole surface", () => {
  it("refuses an engine route without a credential", async () => {
    expect((await call("GET", "/issues")).status).toBe(401);
  });

  it("allows it with a valid token", async () => {
    expect((await call("GET", "/issues", { token: adminToken })).status).toBe(200);
  });

  it("leaves /health open, because a health check that needs a credential is not a health check", async () => {
    expect((await call("GET", "/health")).status).toBe(200);
  });

  it("serves the console shell unauthenticated, so there is somewhere to log in", async () => {
    // The SHELL is public; every byte of data it renders is not.
    const res = await fetch(baseUrl + "/orch");
    expect(res.status).toBe(200);
  });

  it("refuses an admin route to a non-admin with 403, not 401", async () => {
    expect((await call("GET", "/spend", { token: memberToken })).status).toBe(403);
  });

  it("attributes a run to the caller who started it", async () => {
    const res = await call("POST", "/issues", {
      token: adminToken,
      body: { workflow: "requirements", params: { project: "SADA", feature: "x" } },
    });
    expect(res.body.created_by).toBe(adminUserId);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test -- auth-middleware`
Expected: FAIL — `/issues` returns 200 without a credential, and `created_by` is null.

- [ ] **Step 3: Extract the middleware**

Create `packages/orchestrator/src/http/auth-middleware.ts` and move `AuthedRequest`, `authenticate`, `requireAuth` and `requireAdmin` out of `platform-router.ts:67-119` **verbatim**, wrapped in a `createAuth(platform)` factory. Header:

```ts
// Who is calling, for both routers.
//
// This lived in platform-router.ts while only the platform routes needed it.
// The engine routes — /issues, /agents, /runs, /gates, /config — were served
// with no credential at all, which was survivable while the console showed only
// operational data and stopped being survivable the moment it showed users and
// spend. One definition, applied in both places, so the two cannot drift into
// disagreeing about what a valid caller is.
//
// Bearer only. `bearerFrom` reads `Authorization: Bearer` and `X-Scyne-Token`,
// never a cookie — which is also why the console stores a session token and
// sends a header rather than relying on the browser, and why there is no CSRF
// surface here to defend.
```

In `platform-router.ts`, replace the definitions with:

```ts
const { requireAuth, requireAdmin } = createAuth(platform);
```

- [ ] **Step 4: Apply it to the engine routes**

In `packages/orchestrator/src/http/router.ts`, build the same auth from the platform repo and apply `requireAuth()` to every route **except**:

- `GET /health` — a health check that needs a credential is not a health check.
- `GET /orch` — the shell has to be reachable for there to be somewhere to log in. It ships no data; every fetch it makes is authenticated.
- `GET /docs`, `GET /openapi.json` — the API description, not the API.

Record the principal on `POST /issues`:

```ts
  r.post("/issues", requireAuth(), wrap(async (req: AuthedRequest, res) => {
    const { workflow, params } = (req.body ?? {}) as { workflow?: string; params?: Record<string, unknown> };
    if (!workflow) { badRequest(res, "workflow is required"); return; }
    let issue;
    try {
      issue = await orch.engine.start(workflow, (params ?? {}) as Record<string, string>,
                                      { createdBy: req.principal?.user.id ?? null });
    } catch (err) {
```

- [ ] **Step 5: Give the chatbot a service token**

In `scyne-chatbot/server/orchestrator.ts`, send a credential on every call:

```ts
  const res = await fetch(BASE + path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      // The orchestrator authenticates every route now. A caller's own token
      // wins when the browser supplied one, so a run started by a person is
      // attributed to that person; SCYNE_API_TOKEN is the fallback for
      // server-initiated work with no human behind it.
      ...(callerToken ? { Authorization: `Bearer ${callerToken}` }
                      : process.env.SCYNE_API_TOKEN
                        ? { Authorization: `Bearer ${process.env.SCYNE_API_TOKEN}` } : {}),
      ...(init?.headers ?? {}),
    },
  });
```

Thread `callerToken` from the Express request through the call sites in `server/index.ts` (Task 6 makes the browser send one).

Add to `scyne-chatbot/.env.example` and the README:

```
# Minted with:  npm run scyne -- user create chatbot@scyne --role admin
#               npm run scyne -- login   (as that user, then copy the token)
SCYNE_API_TOKEN=scy_...
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm test && npm run typecheck && npm run check:routing`
Expected: PASS. Existing `router.test.ts` cases will need a token added to their requests — that is a real consequence of the change, not a test to weaken.

- [ ] **Step 7: Checkpoint**

Stop. Report that the chatbot needs `SCYNE_API_TOKEN` set before it will work.

---

### Task 3: A login screen on the console

**Files:**
- Modify: `packages/orchestrator/src/http/console.ts` (the `api`/`send` helpers around lines 543-556, plus the shell)
- Test: `packages/orchestrator/test/console.test.ts`

**Interfaces:**
- Consumes: `POST /auth/login` → `{ token, user: { email, role } }`; `GET /auth/whoami`.
- Produces: console-side `TOKEN` state in `sessionStorage`, attached to every request.

- [ ] **Step 1: Write the failing test**

Add to `packages/orchestrator/test/console.test.ts`:

```ts
it("sends the stored credential on every request it makes", () => {
  const html = renderConsole(theme);
  // Both helpers must attach it — one that forgets is an intermittent 401 that
  // looks like a session expiring.
  expect(html).toContain("Authorization");
  expect(html.match(/Authorization/g)!.length).toBeGreaterThanOrEqual(2);
});

it("ships a login form and a sign-out control", () => {
  const html = renderConsole(theme);
  expect(html).toContain('id="login"');
  expect(html).toContain("/auth/login");
  expect(html).toContain("Sign out");
});

it("never hardcodes a credential", () => {
  const html = renderConsole(theme);
  expect(html).not.toMatch(/scyne2026|password\s*[:=]\s*["'][^"']+["']/i);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test -- console`
Expected: FAIL — no `Authorization`, no `#login`.

- [ ] **Step 3: Attach the credential and add the gate**

In the console script, above the fetch helpers:

```js
/* The session token, from POST /auth/login.
   sessionStorage rather than localStorage: this is the admin surface, the
   token IS a session (the server expires it in hours), and a shared machine
   should not keep an administrator signed in across browser restarts. */
const TOKEN_KEY = "scyne_orch_token";
let TOKEN = sessionStorage.getItem(TOKEN_KEY) || "";
const authHeaders = () => (TOKEN ? { Authorization: "Bearer " + TOKEN } : {});
```

Add `...authHeaders()` to the headers of BOTH helpers (lines 543 and 552), and make a 401 clear the token and show the login screen rather than rendering an error:

```js
  if (r.status === 401) { TOKEN = ""; sessionStorage.removeItem(TOKEN_KEY); showLogin(); throw new Error("signed out"); }
```

Add the login screen to the shell markup — a `<div id="login" hidden>` overlay with email, password and a submit — and:

```js
async function doLogin(email, password) {
  const r = await fetch("/auth/login", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!r.ok) { document.getElementById("login-err").textContent = "Email or password not recognised."; return; }
  const out = await r.json();
  TOKEN = out.token;
  sessionStorage.setItem(TOKEN_KEY, TOKEN);
  ME = out.user;
  document.getElementById("login").hidden = true;
  applyRole();     // Task 5 defines this — it hides the admin tabs from a non-admin
  route();
}
```

On boot, call `GET /auth/whoami`; on failure show the login overlay instead of routing. Add a **Sign out** control in the rail footer that clears `sessionStorage` and calls `showLogin()`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- console && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Verify by hand**

```bash
npm run serve &
sleep 5
open http://127.0.0.1:3100/orch
```
Expected: a login form. Signing in with an admin account renders the Runs tab. Reloading keeps you signed in; closing the browser does not.

- [ ] **Step 6: Checkpoint**

Stop.

---

### Task 4: Spend and audit, by every dimension

**Files:**
- Modify: `packages/orchestrator/src/core/platform.ts` (`spend`, `listActions`, `SpendRow`)
- Modify: `packages/orchestrator/src/http/platform-router.ts:600-605` and the `/actions` handlers
- Modify: `packages/orchestrator/openapi.yaml`
- Test: `packages/orchestrator/test/platform.test.ts`, `packages/orchestrator/test/openapi.test.ts`

**Interfaces:**
- Consumes: `issues.created_by` (Task 1), `runs.adapter` (Codex plan Task 1).
- Produces:
  ```ts
  export interface SpendFilter {
    by?: "project" | "feature" | "user" | "agent" | "adapter";
    project?: string; feature?: string; user?: string; since?: string; until?: string;
  }
  spend(companyId: string, filter?: SpendFilter | SpendFilter["by"]): Promise<SpendRow[]>
  ```
  `SpendRow` gains `feature_id`, `feature_name`, `user_email`, `unpriced_runs`.

> **Dependency:** the `adapter` dimension groups on `runs.adapter`, which the
> Codex plan's Task 1 adds. Run that task before this one. Do not implement a
> fallback onto `agents.adapter` — that column has been null for every agent
> since migration 003, so the fallback would return one null row and look like
> a working feature.

- [ ] **Step 1: Write the failing test**

Add to `packages/orchestrator/test/platform.test.ts`:

```ts
describe("spend, by every dimension", () => {
  // Two users, one project, two features, mixed adapters, one unpriced run.
  // Built once in beforeAll and asserted from every angle.

  it("groups by feature", async () => {
    const rows = await platform.spend(companyId, { by: "feature" });
    const names = rows.map(r => r.feature_name).sort();
    expect(names).toEqual(["interim-benefit", "reviews"]);
  });

  it("groups by the user who started the work", async () => {
    const rows = await platform.spend(companyId, { by: "user" });
    expect(rows.map(r => r.user_email).sort()).toEqual(["one@scyne.test", "two@scyne.test"]);
  });

  it("filters and groups together", async () => {
    const rows = await platform.spend(companyId, { by: "feature", project: "SADA" });
    expect(rows.every(r => r.project_name === "SADA" || r.project_name === null)).toBe(true);
  });

  it("counts unpriced runs instead of summing them as zero", async () => {
    // A Codex run records cost_usd = null. `sum` over a column with nulls
    // yields a number that looks complete and is not — the row has to say how
    // much of it is missing.
    const rows = await platform.spend(companyId, { by: "adapter" });
    const codex = rows.find(r => r.adapter === "codex")!;
    expect(Number(codex.unpriced_runs)).toBeGreaterThan(0);
    expect(Number(codex.cost_usd)).toBe(0);
  });

  it("honours a date window", async () => {
    const none = await platform.spend(companyId, { by: "project", since: "2099-01-01" });
    expect(none).toEqual([]);
  });

  it("still accepts the old positional form, so existing callers keep working", async () => {
    const rows = await platform.spend(companyId, "project");
    expect(Array.isArray(rows)).toBe(true);
  });
});

describe("listActions filters", () => {
  it("filters by user, feature and date as well as project", async () => {
    const rows = await platform.listActions(companyId, { userId: userOne.id, limit: 10 });
    expect(rows.every(a => a.user_id === userOne.id)).toBe(true);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test -- platform`
Expected: FAIL — `by: "feature"` is not accepted; `unpriced_runs` is undefined.

- [ ] **Step 3: Rewrite `spend()`**

Replace `spend()` in `packages/orchestrator/src/core/platform.ts`:

```ts
    /**
     * What has been spent, sliced any way an administrator asks.
     *
     * Accepts the old positional dimension as well as a filter object: the
     * console and `scyne spend` both called `spend(companyId, "project")` before
     * this existed, and breaking them to add filters would be gratuitous.
     *
     * `cost_usd` sums only the rows that HAVE a cost, and `unpriced_runs`
     * reports the rest. Codex does not price its own runs, so a plain
     * `sum(cost_usd)` would present a partial figure as a complete one — the
     * one way this table can lie to someone making a budget decision.
     */
    async spend(companyId: string, filter: SpendFilter | SpendFilter["by"] = {}): Promise<SpendRow[]> {
      const f: SpendFilter = typeof filter === "string" ? { by: filter } : filter;
      const by = f.by ?? "project";

      const dimension = {
        project: `p.id, p.name`,
        feature: `p.name, ft.id, ft.name`,
        user:    `u.id, u.email`,
        agent:   `a.key`,
        adapter: `r.adapter`,
      }[by];

      const NUL = {
        project_id: "null::uuid as project_id", project_name: "null::text as project_name",
        feature_id: "null::uuid as feature_id", feature_name: "null::text as feature_name",
        agent_key: "null::text as agent_key", adapter: "null::text as adapter",
        user_id: "null::uuid as user_id", user_email: "null::text as user_email",
      };
      const LIVE: Record<string, string> = {
        project_id: "p.id as project_id", project_name: "p.name as project_name",
        feature_id: "ft.id as feature_id", feature_name: "ft.name as feature_name",
        agent_key: "a.key as agent_key", adapter: "r.adapter as adapter",
        user_id: "u.id as user_id", user_email: "u.email as user_email",
      };
      /** Each dimension selects the columns it groups by and nulls the rest,
       *  so every row has the same shape whatever `by` was asked for. */
      const pick = (...live: string[]): string =>
        Object.entries(NUL).map(([k, nul]) => (live.includes(k) ? LIVE[k] : nul)).join(", ");
      const select = {
        project: pick("project_id", "project_name"),
        feature: pick("project_name", "feature_id", "feature_name"),
        user:    pick("user_id", "user_email"),
        agent:   pick("agent_key"),
        adapter: pick("adapter"),
      }[by];

      const params: unknown[] = [companyId];
      const where: string[] = [`i.company_id = $1`];
      const add = (sql: string, v: unknown): void => { params.push(v); where.push(sql.replace("$?", `$${params.length}`)); };

      if (f.project) add(`p.name = $?`, f.project);
      if (f.feature) add(`ft.name = $?`, f.feature);
      if (f.user)    add(`u.email = $?`, f.user.toLowerCase().trim());
      if (f.since)   add(`r.started_at >= $?`, f.since);
      if (f.until)   add(`r.started_at < $?`, f.until);

      const { rows } = await db.query<SpendRow>(
        `select ${select},
                count(r.id)::text                                  as run_count,
                count(*) filter (where r.cost_usd is null)::text   as unpriced_runs,
                coalesce(sum(r.input_tokens),0)::text              as input_tokens,
                coalesce(sum(r.output_tokens),0)::text             as output_tokens,
                coalesce(sum(r.cost_usd),0)::text                  as cost_usd
           from runs r
           join issues i    on i.id = r.issue_id
           left join projects p on p.id = i.project_id
           left join features ft on ft.id = i.feature_id
           left join users u    on u.id = i.created_by
           left join agents a   on a.id = r.agent_id
          where ${where.join(" and ")}
          group by ${dimension}
          order by sum(r.cost_usd) desc nulls last, count(r.id) desc`,
        params);
      return rows;
    },
```

Widen `SpendRow`:

```ts
export interface SpendRow {
  project_id: string | null; project_name: string | null;
  feature_id: string | null; feature_name: string | null;
  agent_key: string | null; adapter: string | null;
  user_id: string | null; user_email: string | null;
  run_count: string; unpriced_runs: string;
  input_tokens: string; output_tokens: string; cost_usd: string;
}

export interface SpendFilter {
  by?: "project" | "feature" | "user" | "agent" | "adapter";
  project?: string; feature?: string; user?: string; since?: string; until?: string;
}
```

Extend `listActions`'s filter the same way — add `featureId`, `userId`, `since`, `until` beside the existing `projectId`, each appended as a parameterised clause.

- [ ] **Step 4: Widen the routes**

Replace the `/spend` handler:

```ts
  const SPEND_DIMENSIONS = ["project", "feature", "user", "agent", "adapter"] as const;

  r.get("/spend", requireAuth(), wrap(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const by = String(req.query.by ?? "project");
    if (!SPEND_DIMENSIONS.includes(by as typeof SPEND_DIMENSIONS[number])) {
      return bad(res, `by must be one of ${SPEND_DIMENSIONS.join(", ")}`);
    }
    ok(res, await platform.spend(companyId, {
      by: by as SpendFilter["by"],
      project: req.query.project ? String(req.query.project) : undefined,
      feature: req.query.feature ? String(req.query.feature) : undefined,
      user:    req.query.user    ? String(req.query.user)    : undefined,
      since:   req.query.since   ? String(req.query.since)   : undefined,
      until:   req.query.until   ? String(req.query.until)   : undefined,
    }));
  }));
```

Do the same for `GET /actions`.

- [ ] **Step 5: Update openapi.yaml**

Add the query parameters to `/spend` and `/actions`. The route paths are unchanged, so `ROUTES` needs no edit — but `openapi.test.ts` must still pass in both directions.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm test -- platform platform-router openapi && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Checkpoint**

Stop.

---

### Task 5: Split `console.ts` before adding to it

`console.ts` is 2067 lines. Four tabs plus a login screen pushes it past 2800, which is past the point where it can be held in context and edited reliably. The split lands **on its own**, with no behaviour change, so it is reviewable separately from the features.

**Files:**
- Create: `packages/orchestrator/src/http/console/shell.ts`, `console/engine.ts`, `console/admin.ts`
- Modify: `packages/orchestrator/src/http/console.ts` → becomes a thin composer
- Test: `packages/orchestrator/test/console.test.ts` (unchanged — the regression harness)

**Interfaces:**
- Produces:
  ```ts
  // console/shell.ts
  export function shellHtml(theme: Theme, tabs: ReadonlyArray<readonly [string, string]>): string;
  export const SHELL_SCRIPT: string;   // fetch helpers, auth, routing, formatting
  // console/engine.ts
  export const ENGINE_SCRIPT: string;  // renderRuns … renderHealth
  // console/admin.ts
  export const ADMIN_SCRIPT: string;   // renderUsers, renderProjects, renderSpend, renderAudit
  ```
  `renderConsole(theme)` concatenates them, so the page is still one document with zero network requests.

- [ ] **Step 1: Move, do not rewrite**

Cut each region into its module as a template-literal string export. Nothing is reworded, renamed or "tidied" — a behaviour change hidden inside a 2000-line move is unfindable.

- [ ] **Step 2: Recompose**

```ts
export function renderConsole(theme: Theme): string {
  return shellHtml(theme, TABS) + `<script>` + SHELL_SCRIPT + ENGINE_SCRIPT + ADMIN_SCRIPT + `</script></body></html>`;
}
```

- [ ] **Step 3: Verify nothing changed**

Run: `npm test -- console && npm run typecheck`
Expected: PASS with `console.test.ts` **unedited**. If a test needed changing, something moved that should not have.

- [ ] **Step 4: Verify in a browser**

```bash
npm run serve &
sleep 5 && open http://127.0.0.1:3100/orch
```
Expected: every existing tab renders as before. Check the browser console for errors — a mis-ordered concatenation shows up as `X is not defined`.

- [ ] **Step 5: Checkpoint**

Stop.

---

### Task 6: The four admin tabs

**Files:**
- Modify: `packages/orchestrator/src/http/console/admin.ts`, `console/shell.ts` (TABS, ICONS, ROUTES, OWNER)
- Test: `packages/orchestrator/test/console.test.ts`

**Interfaces:**
- Consumes: `GET /users`, `GET /projects`, `GET /projects/{id}/features`, `GET /spend?by=…`, `GET /actions?…`, `GET /admin/overview`.
- Produces: hash routes `#users`, `#projects`, `#spend`, `#audit`, plus details `#user/<id>` and `#project/<id>`.

- [ ] **Step 1: Write the failing test**

Add to `packages/orchestrator/test/console.test.ts`:

```ts
it("carries the four admin tabs and their detail routes", () => {
  const html = renderConsole(theme);
  for (const tab of ["users", "projects", "spend", "audit"]) {
    expect(html).toContain(`data-tab="${tab}"`);
  }
  // A detail route must light its own tab in the rail, or drilling in loses
  // your place — the same reason run/issue/agent are already in OWNER.
  expect(html).toContain('user: "users"');
  expect(html).toContain('project: "projects"');
});

it("offers every spend dimension", () => {
  const html = renderConsole(theme);
  for (const by of ["project", "feature", "user", "agent", "adapter"]) {
    expect(html).toContain(`value="${by}"`);
  }
});

it("hides the admin tabs from a non-admin", () => {
  const html = renderConsole(theme);
  // The UI gate is convenience; requireAdmin in the router is the boundary.
  expect(html).toContain("applyRole");
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test -- console`
Expected: FAIL — no `data-tab="users"`.

- [ ] **Step 3: Register the tabs**

In `console/shell.ts`:

```ts
const TABS: ReadonlyArray<readonly [string, string]> = [
  ["runs", "Runs"], ["issues", "Issues"], ["gates", "Gates"],
  ["org", "Org"], ["skills", "Skills"], ["budgets", "Budgets"],
  ["users", "Users"], ["projects", "Projects"], ["spend", "Spend"], ["audit", "Audit"],
  ["config", "Config"], ["health", "Health"],
];

const ADMIN_TABS = new Set(["users", "projects", "spend", "audit"]);
```

Add an icon for each (16×16, same `I()` helper and stroke conventions as the existing eight). Extend `ROUTES` with `users: renderUsers, projects: renderProjects, spend: renderSpend, audit: renderAudit`, and `OWNER` with `user: "users", project: "projects"`.

Add role gating in the shell script:

```js
/* Convenience only — the router's requireAdmin is the actual boundary. A
   non-admin who types #spend still gets a 403 from the API, and this only
   stops the rail advertising a tab they cannot use. */
let ME = null;
function applyRole() {
  const admin = ME && ME.role === "admin";
  document.querySelectorAll('nav a').forEach(a => {
    if (ADMIN_TABS.has(a.dataset.tab)) a.hidden = !admin;
  });
}
```

- [ ] **Step 4: Write the four renderers**

In `console/admin.ts`, following the existing renderers' conventions exactly (`setHead`, `table`, `on(sel, ev, fn)`, `location.hash` for drill-in):

- **`renderUsers`** — `GET /users` joined with `GET /spend?by=user`. Columns: email · role · status · runs started · spend · since. Row click → `#user/<id>`. Header actions: Create user, and on a row: change role, disable/enable. The detail pane lists that user's issues and their `GET /actions?user=<email>`.
- **`renderProjects`** — `GET /projects` joined with `GET /spend?by=project`. Columns: project · features · issues by status · spend. Row click → `#project/<id>`, which lists `GET /projects/{id}/features` with per-feature spend from `GET /spend?by=feature&project=<name>`, each feature drilling into its issues.
- **`renderSpend`** — a dimension `<select>` (project / feature / user / agent / adapter) plus project, feature and since/until inputs, all reflected into the hash so a filtered view is linkable. The table shows the dimension, runs, tokens and cost — and **`unpriced_runs` as an explicit "n unpriced" note beside the total**, never folded into it. A row click drills into the runs behind it.
- **`renderAudit`** — `GET /actions` with the same filters. Columns: when · who (user email, else agent key) · verb · target · project.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -- console && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Verify in a browser**

Sign in as an admin, click each tab, drill into a user and a project, change the spend dimension, and confirm a filtered spend view survives a reload (it is in the hash). Then sign in as a `member` and confirm the four tabs are absent and `#spend` typed directly reports a refusal rather than an empty table.

- [ ] **Step 7: Checkpoint**

Stop.

---

### Task 7: The CLI

**Files:**
- Modify: `cli/index.ts` (`cmdSpend`, `cmdActions`, `cmdUser`, `cmdProject`)
- Test: manual — `cli/` has no test runner and adding one for flag plumbing is not worth the dependency (the same reasoning `check-routing.mts` records).

**Interfaces:**
- Consumes: `GET /spend?by=&project=&feature=&user=&since=&until=`, `GET /actions?…`.
- Produces:
  ```
  scyne spend   [--by project|feature|user|agent|adapter] [--project P] [--feature F]
                [--user email] [--since D] [--until D] [--json]
  scyne actions [--project P] [--feature F] [--user email] [--since D] [--limit N] [--json]
  scyne user show <email>
  scyne project show <name>          (extended)
  ```

- [ ] **Step 1: Rewrite `cmdSpend`**

```ts
const SPEND_DIMENSIONS = ["project", "feature", "user", "agent", "adapter"];

async function cmdSpend(client: Client): Promise<void> {
  const by = flag("by") ?? "project";
  if (!SPEND_DIMENSIONS.includes(by)) {
    throw new ApiError(400, `--by must be one of ${SPEND_DIMENSIONS.join(", ")}`);
  }
  const q = new URLSearchParams({ by });
  for (const k of ["project", "feature", "user", "since", "until"]) {
    const v = flag(k);
    if (v) q.set(k, v);
  }
  const rows = await client.get<any[]>(`/spend?${q}`);
  if (has("json")) return json(rows);

  const label = (r: any) =>
    r.feature_name ?? r.user_email ?? r.project_name ?? r.agent_key ?? r.adapter ?? "—";

  table(rows.map(r => ({
    [by]: label(r),
    runs: r.run_count,
    tokens: Number(r.input_tokens) + Number(r.output_tokens),
    // An unpriced run is one an adapter did not cost (Codex reports tokens and
    // no dollars). Shown beside the figure rather than folded into it: a total
    // that quietly omits runs is the one way this table can mislead a budget
    // decision.
    cost: `$${Number(r.cost_usd).toFixed(4)}` +
          (Number(r.unpriced_runs) ? `  (+${r.unpriced_runs} unpriced)` : ""),
  })), [by, "runs", "tokens", "cost"]);
}
```

- [ ] **Step 2: Extend `cmdActions`**

Take the same five filters, build the query the same way, and add a `who` column resolving `user_id` to an email (fall back to `agent_key`, then `—`).

- [ ] **Step 3: Add `scyne user show`**

In `cmdUser`, add a `show` case: `GET /users` for the row, `GET /spend?by=user&user=<email>` for the spend, `GET /actions?user=<email>&limit=20` for the activity. Print role, status, projects they are a member of, runs started, spend, and the last twenty actions.

- [ ] **Step 4: Extend `scyne project show`**

Add per-feature issue counts and spend from `GET /spend?by=feature&project=<name>` beneath the existing output.

- [ ] **Step 5: Verify by hand**

```bash
npm run scyne -- login
npm run scyne -- spend --by user
npm run scyne -- spend --by feature --project SADA
npm run scyne -- spend --by adapter --json
npm run scyne -- actions --user you@example.com --limit 10
npm run scyne -- user show you@example.com
npm run scyne -- project show SADA
```
Expected: each prints a table; `--json` prints parseable JSON; a bad `--by` reports the valid list.

- [ ] **Step 6: Checkpoint**

Stop.

---

### Task 8: Real identity in the chatbot

Without this, "track by user" is delivered for the CLI and the console and **not** for the surface people actually use: `scyne-chatbot/src/components/Login.tsx:18-19` checks a hardcoded `admin` / `scyne2026` entirely in the browser and never contacts a server, so every chatbot-started run would attribute to the service token rather than to a person.

**Files:**
- Modify: `scyne-chatbot/src/components/Login.tsx`, `scyne-chatbot/src/api.ts`, `scyne-chatbot/server/index.ts`
- Test: manual

**Interfaces:**
- Consumes: `POST /auth/login` on the orchestrator, proxied through the chatbot's Express server.
- Produces: `LoginSession` gains `token` and `email`; every `/api/*` call carries it; the server forwards it as `callerToken` (Task 2).

- [ ] **Step 1: Replace the hardcoded check**

Delete `VALID_USER`/`VALID_PASS`. `handleSubmit` posts to a new `POST /api/auth/login` on the chatbot's own server, which proxies to the orchestrator and returns `{ token, user }`. Store `{ email, token, ts }` under `scyne_session`.

Keep the existing look and the shake-on-failure behaviour — this is an auth change, not a redesign.

- [ ] **Step 2: Send the token on every call**

In `scyne-chatbot/src/api.ts`, add `Authorization: Bearer <token>` from the stored session to every request, and treat a 401 as "session expired": clear it and show the login screen.

- [ ] **Step 3: Forward it server-side**

In `scyne-chatbot/server/index.ts`, read the incoming `Authorization` header and pass it into the orchestrator client as `callerToken` (the parameter Task 2 added), so an issue created from the chatbot records the person who clicked, not the service account.

- [ ] **Step 4: Verify attribution end to end**

```bash
npm run scyne -- user create alice@scyne.test --role member --password "..."
# sign into the chatbot as alice, start any stage, approve nothing
npm run scyne -- spend --by user
```
Expected: a row for `alice@scyne.test` with the run she started. If it lands on the service account instead, the token is not being forwarded.

- [ ] **Step 5: Update CLAUDE.md**

Correct the chatbot section — the demo credentials are gone:

```markdown
- **Login gate**: `Login.tsx` authenticates against the orchestrator's
  `POST /auth/login` (proxied through the chatbot's own server). Create accounts
  with `npm run scyne -- user create <email> --role member|admin`. The session
  token is stored in `localStorage.scyne_session` and forwarded on every `/api/*`
  call, which is what attributes a run to the person who started it.
```

Add to the troubleshooting table:

```markdown
| Every chatbot trigger 401s | The orchestrator authenticates every route now, and the chatbot has no credential. | Set `SCYNE_API_TOKEN` in `scyne-chatbot/.env` (mint with `scyne user create` then `scyne login`), or sign in through the chatbot's own login. |
| `scyne spend --by user` shows one service account for everything | The chatbot is not forwarding the browser's token, so every run is attributed to `SCYNE_API_TOKEN`. | Check `server/index.ts` passes the incoming `Authorization` header through as `callerToken`. |
```

Add a **Users and access** section documenting `scyne user create|role|disable`, `scyne member add`, and the four admin console tabs.

- [ ] **Step 6: Checkpoint**

Stop.

---

### Task 9: End-to-end acceptance

**Files:** none — verification. Anything it uncovers is fixed in the task that owns the file.

- [ ] **Step 1: From a clean database**

```bash
npm run orch -- reset --hard --yes
npm run scyne -- user create alice@scyne.test --role admin --password "..."
npm run scyne -- user create bob@scyne.test   --role member --password "..."
```

- [ ] **Step 2: Two users, two features, one project**

Sign in as each and start a stage against a different feature of the same project.

- [ ] **Step 3: Verify each claim, with output**

| Claim | Command | Expected |
|---|---|---|
| Attribution works | `npm run scyne -- spend --by user` | two rows, one per user, correct run counts |
| Feature dimension works | `npm run scyne -- spend --by feature --project SADA` | one row per feature |
| Console agrees with the CLI | Spend tab, dimension = user | the same numbers |
| Unpriced runs are declared | `npm run scyne -- spend --by adapter` | any Codex row shows `(+N unpriced)`, not a silent `$0.0000` |
| Nothing is open | `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3100/issues` | `401` |
| Health stays open | `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3100/health` | `200` |
| A member cannot see spend | sign in as bob, type `#spend` | refused, and the tab is not in the rail |
| The chatbot still works | start a stage from the chatbot | the run appears, attributed to the signed-in person |
| Historic issues are honest | Users tab | pre-migration issues show `—`, not a guessed user |

- [ ] **Step 4: Report honestly**

Write down what actually happened, including anything that failed or was skipped.

- [ ] **Step 5: Checkpoint**

Stop. Hand back for review and commit.
