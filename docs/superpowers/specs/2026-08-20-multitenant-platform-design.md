# Multi-tenant platform — orgs, control, Codex spend, Azure DevOps — design

**Date:** 2026-08-20
**Status:** Design, approved in chat (four forks answered by the user)
**Supersedes in part:** `2026-08-20-super-admin-tracking-design.md` (§1–§6, which
assumed a single company), `2026-08-20-azure-devops-publishing-design.md` (§3,
which recommended against an MCP)
**Builds on:** `2026-08-20-codex-cli-adapter-design.md` (merged)

---

## 0. What this is, and why it is one spec

Five subsystems, asked for together. They are listed here as one document
because three of them share a migration and two share an authentication
boundary — splitting them into five specs would have meant writing the same
schema three times. They are still built and reviewed in order, A → E, and each
is independently useful.

| | Workstream | Gates |
|---|---|---|
| **A** | Tenancy and identity — many orgs, one super-admin, auth on every route | — |
| **B** | Admin console — login, orgs, users, projects, features, spend, audit | A |
| **C** | Pause, force-pause and cancel a running issue | — |
| **D** | Codex everywhere — model catalogue, price table in the DB, estimated spend | — |
| **E** | Azure DevOps replaces Confluence and Jira, over MCP | — |

Most of the identity layer already exists and is NOT rebuilt: `users`,
`sessions`, `api_tokens`, `projects`, `features`, `project_members`, `actions`,
`installations`, `conversations`, scrypt password hashing, token minting, and
about thirty-five `/auth/*`, `/users`, `/projects`, `/spend` routes. The `scyne`
CLI already has `login`, `logout`, `whoami`, `user`, `member`, `spend` and
`audit`. What is missing is tenancy above them, a console that renders them, and
an authentication boundary that makes any of it mean anything.

### The four decisions this design was waiting on

1. **Many organisations, one super-admin above all.** Not one company with many
   projects.
2. **Pause is two verbs.** Graceful (park at the next step boundary) and force
   (kill the child now, park at this step). Cancel is terminal.
3. **Azure DevOps over MCP, for everything.** Chosen with the SCY-6 evidence
   stated. The REST scripts are still written, unwired, as a fallback.
4. **Codex spend is computed, labelled as an estimate, and enforced by cost
   budgets.** Prices live in the database, are seeded from a real fetched
   table, are editable, and can be refreshed on demand.

---

## 1. Workstream A — tenancy and identity

### 1.1 The tenancy model

`companies` already exists and every platform table already carries
`company_id`. Nothing in the application uses it as a dimension: `index.ts`
resolves `ensureCompany(config.company ?? "Scyne")` once at boot and every
caller passes that one id forever.

So the schema is right and the *resolution* is wrong. The change is to stop
treating the company as a constant.

```
superadmin   spans every organisation. Creates and archives them, sees every
             user, project, run and dollar in the install. This is us.
admin        an organisation's own administrator. Everything within their org,
             nothing outside it.
member       ordinary user. Projects they hold a membership on.
viewer       read-only, capped — a membership cannot promote past it.
```

`superadmin` is added to `GLOBAL_ROLES` in `core/auth.ts` and ranks above
`admin`. `effectiveProjectRole` already promotes `admin` to `owner` everywhere;
`superadmin` gets the same treatment, and additionally bypasses the
`company_id` filter rather than being granted membership of every org — a role
that works by holding ten thousand memberships is a role that breaks the day
someone deletes one.

### 1.2 Acting as an organisation

A `Principal` gains two fields:

```ts
interface Principal {
  user: UserRow;
  tokenId: string | null;
  installationId: string | null;
  companyId: string;        // the org this request acts within
  isSuperadmin: boolean;
}
```

`companyId` is the user's own `company_id`, except for a superadmin, who may
override it per request with `X-Scyne-Org: <uuid|slug>`. A non-superadmin
sending that header is refused with 403 rather than ignored — silently ignoring
an authorisation-shaped header teaches a caller that it worked.

Every platform repo method already takes `companyId` as its first argument, so
the change is confined to where that value comes from: the router stops reading
`orch.companyId` and starts reading `principal.companyId`.

`orch.companyId` survives as `orch.homeCompanyId` — the org the config file's
`company` names, used for boot-time reconciliation of the agent org chart and
as the default for an unauthenticated CLI in a single-org install.

### 1.3 Organisation routes

```
GET    /orgs                 superadmin: all. admin: their own, as a single-item list
POST   /orgs                 superadmin only — {name, slug}
GET    /orgs/{id}            counts: users, projects, features, issues, spend
PATCH  /orgs/{id}            name, status
DELETE /orgs/{id}            archive. Never a hard delete — issues reference it
```

Migration adds `companies.slug` (unique, generated from the name),
`companies.status` and `companies.archived_at`. Existing rows get a slug derived
from their name.

### 1.4 Project names on disk — a decision with a cost

The workspace is a flat `projects/<name>/` tree, read by `stage.mjs`,
`pipeline.mjs`, `render-companion-app.mjs`, `render-mockups.mjs`, the migration
script and the chatbot's `workspace.ts`. Namespacing it per organisation
(`projects/<org>/<name>/`) is correct and ripples through all six.

**Decision: keep the flat tree; enforce globally-unique project names across
every organisation.** `POST /projects` returns `409 name_taken` naming no other
detail when the name exists in another org.

The cost is honest and worth stating: the uniqueness check tells a caller that
*some* org already owns that name. In an install run by the people who built it,
that is acceptable. When a real client ever logs in to create their own project,
this becomes `projects/<org-slug>/<name>/` and a migration — it is deliberately
not being done now, because it is a day of script surgery that buys nothing
until that user exists.

### 1.5 Authentication on the engine routes — the part with teeth

Verified, not assumed: `packages/orchestrator/src/http/router.ts` contains no
`requireAuth` at all. `/issues`, `/runs`, `/agents`, `/config`, `/gates` and
`/orch` are open to anything that can reach port 3100. Putting users, orgs and
spend behind that would publish them.

- Every engine route gains `requireAuth()`.
- `/health` stays open — a health check that needs a credential is not one.
- `/orch`, `/docs` and `/openapi.json` serve their shell unauthenticated; the
  shell calls `/auth/whoami` and renders a login form until it succeeds. The
  data behind them is gated, which is where the boundary belongs.
- Admin-only routes gain `requireAdmin`; org-management routes gain
  `requireSuperadmin`. The UI hides what a role cannot use; the router refuses
  it. Only the second is a security boundary.
- `POST /issues` writes `created_by` from the principal and `company_id` from
  `principal.companyId`.

### 1.6 The ripple: three callers that currently send no credential

**The chatbot server.** `scyne-chatbot/server/orchestrator.ts` sends no
`Authorization` header. The moment the router requires one, every trigger 401s.

The fix is not a service token. The chatbot gets **real user login against the
same `users` table**, and forwards *that user's* token — so a run started from
chat is attributed to the person who started it, which is the whole point of
`issues.created_by`.

```
POST /api/auth/login    → proxies to orchestrator POST /auth/login
                          stores the session token in an httpOnly cookie
                          on the chatbot origin, never in localStorage
POST /api/auth/logout   → proxies to POST /auth/logout, clears the cookie
GET  /api/auth/whoami   → proxies to GET /auth/whoami
```

Every existing `/api/*` route that reaches the orchestrator forwards
`Authorization: Bearer <the caller's token>`. A request with no cookie gets 401
and the frontend shows the login screen.

`scyne-chatbot/src/components/Login.tsx` loses its hardcoded
`admin`/`scyne2026` and its `localStorage.scyne_session`, and posts to
`/api/auth/login`. It gains an organisation line under the email when the user
is a superadmin, and an org switcher in `Header.tsx`.

`SCYNE_API_TOKEN` is kept in the chatbot's `.env` for one narrow purpose:
server-side background work that belongs to no user (staleness polling). It is
never used to service a browser request.

**The CLI** already logs in, mints a long-lived token and stores it 0600 —
nothing to do beyond adding `--org` to act as another organisation.

**Order matters.** The router change and the chatbot change land in the same
commit, or the chatbot is dead between them.

### 1.7 Attribution

```sql
alter table issues add column created_by uuid references users(id) on delete set null;
```

Existing rows stay null and render `—`. Back-filling an attribution nobody
recorded would be inventing evidence; "started before we tracked this" is a true
and useful thing for a column to say.

---

## 2. Workstream B — the admin console

`http/console.ts` is 2106 lines and has eight tabs
(runs/issues/gates/org/skills/budgets/config/health), no login, and no rendering
for the admin routes that already exist.

### 2.1 The split, first and on its own

Adding a login screen plus five tabs to a 2106-line file produces a 3000-line
file. It splits before anything is added, as its own commit with no behaviour
change, so the split is reviewable separately from the features:

```
console/shell.ts    chrome, theme, hash routing, the login gate, the org switcher
console/engine.ts   runs · issues · gates · org · skills · budgets · config · health
console/admin.ts    orgs · users · projects · spend · audit
console/index.ts    renderConsole(), composing the three
```

### 2.2 The login gate

`/orch` serves the shell. The shell calls `/auth/whoami`; on 401 it renders a
centred login card and nothing else — no tab rail, no data fetches. On success
it renders the rail filtered by role. Logout posts `/auth/logout` and returns to
the card.

### 2.3 The five new tabs

| Tab | Role | Shows |
|---|---|---|
| **Orgs** | superadmin | every organisation: users, projects, features, issues by status, spend, last activity. Create, rename, archive. Drills into one org and scopes the whole console to it |
| **Users** | admin | every user in the current org: role, status, last seen, runs started, spend. Create, change role, disable, reset password, mint a token. Drills into one user's runs and actions |
| **Projects** | admin | every project with its features, issue counts by status, artefacts published, spend. Drills project → feature → that feature's issues |
| **Spend** | admin | the pivot: dimension selector (org / project / feature / user / agent / adapter / model) plus filters. Reported and estimated shown as separate columns, never summed into one |
| **Audit** | admin | the `actions` timeline with the same filters |

`OWNER` gains `user → users`, `project → projects`, `org → orgs` so a detail
route keeps the rail highlighted, matching `run`/`issue`/`agent` today.

**A visual preview of the Orgs and Spend tabs is shown before either is
built** — a console rebuild is UI work, and the layout is cheaper to argue about
as a mockup than as HTML.

---

## 3. Workstream C — pause, force-pause and cancel

Nothing today can stop a run. `spawn.ts` kills only on a budget breach; there is
no route, no CLI verb and no button. An agent run averages twenty-five minutes,
so "I started the wrong thing" currently costs twenty-five minutes and its spend.

### 3.1 Three verbs, one mechanism

| Verb | In-flight agent | Issue ends at | Resumable |
|---|---|---|---|
| **Pause** | runs to completion | `paused`, at the NEXT step | yes |
| **Pause now** | SIGTERM → SIGKILL | `paused`, at THIS step | yes, re-runs the step |
| **Cancel** | SIGTERM → SIGKILL | `cancelled` | no |

### 3.2 How it is expressed

```sql
alter table issues add column control_request        text;   -- pause | pause_now | cancel
alter table issues add column control_requested_by   uuid references users(id);
alter table issues add column control_requested_at   timestamptz;
```

A *request*, not a status, because the two are genuinely different: the request
is made by a human at an arbitrary moment, and the status changes when the
engine next reaches a point where it can honour it. Collapsing them would mean
either lying about the status for twenty minutes or losing the request.

`issues.status` gains `paused`. `cancelled` was already in the column's
documented vocabulary and was never written by anything.

`runs.status` gains `cancelled`, distinct from `failed`: a killed run did not
fail on its own terms, and the retry logic in `core/retry.ts` must never treat
one as a transient error and spend money re-running it. This is added to
`retry.ts`'s decision table as an explicit "no".

### 3.3 Killing a live child

`RunRequest` gains `runId`. `spawn.ts` keeps a module-level
`Map<runId, ChildProcess>`, registered when the child spawns and deleted when it
settles, and exports:

```ts
export function killRun(runId: string, grace = 5_000): boolean
export function liveRuns(): string[]
```

The same bounded SIGTERM → SIGKILL escalation the budget kill already uses, so
there is one kill path rather than two.

The registry is in-process, which is correct rather than a limitation: PGlite is
single-writer, so exactly one process owns the engine, and the CLI already
reaches it over HTTP. A CLI holding the database directly cannot also have a
live child belonging to the server.

### 3.4 Where the engine honours it

`advance()` already re-reads the issue at the top of every iteration. That is
where a graceful pause lands: if `control_request` is `pause`, set `paused`,
clear the request, post a comment naming who asked, and return. `pause_now` and
`cancel` additionally call `killRun` for the issue's live run before parking.

Resume clears the flag and calls the existing `retry`/`advance` path — a paused
issue resumes at the step it stopped at; steps that already succeeded are not
re-run.

### 3.5 Everywhere it is reachable, as asked

```
POST /issues/{id}/pause    {force?: boolean}
POST /issues/{id}/cancel
POST /issues/{id}/resume                      # named, rather than reusing /advance
```

- **CLI:** `scyne run pause <SCY-7> [--force]`, `scyne run cancel <SCY-7>`,
  `scyne run resume <SCY-7>`; and in the REPL.
- **Console:** Pause / Pause now / Cancel on the issue detail and on the Runs
  row of a live run, with a confirm on the two destructive ones.
- **Chatbot:** the same three in `ProgressPanel.tsx`, beside the stage pill.

Every one of them posts an `actions` row, so "who cancelled this" is answerable.

---

## 4. Workstream D — Codex everywhere, and what it costs

### 4.1 Codex as the default

`SCYNE_ADAPTER=codex` in the root `.env`. The per-agent, per-project and
per-step overrides already exist and are unchanged. `orchestrator.config.ts`
already refuses to boot when the named default is not registered, and `codex` is
registered when the binary is on PATH — verified present, `codex-cli 0.148.0`.

### 4.2 The model catalogue and its prices — in the database

Codex reports token counts and no dollar figure. Until now this repository
deliberately held no price table, so a Codex run rendered `—` and **a cost
budget could not fire on it** — which means moving every agent to Codex silently
removes the dollar ceiling. That is the real reason to price it.

```sql
create table model_prices (
  provider              text not null,          -- openai | anthropic | google
  model                 text not null,
  input_per_mtok        numeric(12,4),
  cached_input_per_mtok numeric(12,4),
  output_per_mtok       numeric(12,4),
  currency              text not null default 'USD',
  retires_on            date,
  source_url            text,
  fetched_at            timestamptz,
  updated_by            uuid references users(id) on delete set null,
  updated_at            timestamptz not null default now(),
  primary key (provider, model)
);
```

Seeded by the migration from a table fetched today from
`developers.openai.com/api/docs/pricing`, $/1M tokens:

| model | input | cached | output |
|---|---|---|---|
| gpt-5.6-sol | 5.00 | 0.50 | 30.00 |
| gpt-5.6-terra | 2.00 | 0.20 | 12.00 |
| gpt-5.6-luna | 0.20 | 0.02 | 1.20 |
| gpt-5.5 | 5.00 | 0.50 | 30.00 |
| gpt-5.4 | 2.50 | 0.25 | 15.00 |
| gpt-5.4-mini | 0.75 | 0.075 | 4.50 |
| gpt-5.2 | 1.75 | 0.175 | 14.00 |
| gpt-5.3-codex | 1.75 | 0.175 | 14.00 |
| gpt-5.1 / gpt-5 | 1.25 | 0.125 | 10.00 |
| gpt-5-mini | 0.25 | 0.025 | 2.00 |
| gpt-5-nano | 0.05 | 0.005 | 0.40 |
| gpt-4.1 | 2.00 | 0.50 | 8.00 |
| o3 | 2.00 | 0.50 | 8.00 |
| o4-mini | 1.10 | 0.275 | 4.40 |

`gpt-5.4` and `gpt-5.4-mini` carry `retires_on = 2026-08-31` — eleven days from
this spec — and `gpt-5.3-codex-spark` is seeded **unpriced**, because its price
was not published on the page. An unpriced model computes no cost and renders
`—`; it never guesses.

### 4.3 Which model ran

A price needs a model, and nothing records one. The Codex transcript fixture in
this repo carries no model field, and the engine is the only place that knows —
the value can come from the step, the agent, a project setting or the default.
So, exactly as migration 004 did for `adapter`:

```sql
alter table runs add column model         text;
alter table runs add column est_cost_usd  numeric(12,6);
alter table runs add column cost_source   text;   -- reported | estimated | null
```

`runs.cost_usd` keeps its meaning untouched: **reported by the CLI, never
computed by us**. The estimate lives in its own column. This is what lets the
console say `$4.10 reported + ~$1.23 est` instead of one number nobody can
audit.

### 4.4 Computing and enforcing

`core/usage.ts` gains `priceRun(usage, price)` — pure, no I/O, unit-testable —
returning null when the model is unknown or unpriced. The engine calls it after
a run settles and writes `est_cost_usd` + `cost_source`.

Cost budgets check `coalesce(cost_usd, est_cost_usd)`. A run over an estimated
ceiling is flagged `over_budget` with a comment saying the figure was estimated
and from which price row, because being stopped by an arithmetic nobody can see
is worse than not being stopped.

### 4.5 Choosing a model, and refreshing the prices

```
GET   /models                    the catalogue: id, provider, prices, retires_on, in-use count
PUT   /models/{provider}/{model} upsert one row by hand (admin)
POST  /models/refresh            propose an update (admin)
POST  /models/refresh/apply      apply a proposal (superadmin)
```

The model picker in the console and the chatbot reads `/models`, so it can never
offer a model the install cannot price. A model within thirty days of
`retires_on` is shown with a warning; past it, it is not offered at all.

**Refresh is agent-driven, and gated.** `POST /models/refresh` spawns one short
run on the configured adapter asking it to fetch the current published pricing
and return strict JSON. The result is validated (every field a finite positive
number, every model id already known or explicitly new) and stored as a
**proposal with a diff** — it is never written straight into `model_prices`. A
superadmin applies it. An agent that hallucinates a price must not be able to
silently change what every run in the install is billed at.

---

## 5. Workstream E — Azure DevOps, over MCP

Confluence becomes ADO Wiki; Jira stories become User Story work items.
Atlassian is retired, not run alongside.

### 5.1 The MCP

`.mcp.json`'s `atlassian` entry is replaced with Microsoft's first-party server
in **PAT mode** — a configuration the client has already tested end to end and
published with, so it is recorded here as fact rather than researched:

```json
"azure-devops": {
  "command": "npx",
  "args": ["-y", "@azure-devops/mcp", "Scyne-AI-Lab", "--authentication", "pat"],
  "env": { "PERSONAL_ACCESS_TOKEN": "${MCP_TOKEN_FOR_AZURE}" }
}
```

Organisation `Scyne-AI-Lab`, project `Scyne AI Project`. The token is **read
from the root `.env`**, never inlined — `.mcp.json` is committed and a PAT in it
is a PAT in the git history. The value is passed through **verbatim**: this
server's PAT field has been documented in two different forms (a raw PAT, and
base64 of `<email>:<pat>`), the client's token is known to work as it stands,
and transforming a credential to match documentation is how a working setup
gets broken.

This server has both wiki write tools and work-item tools, which resolves the
gap that the PAT-capable third-party server
(`@tiberriver256/mcp-server-azure-devops`) has: that one exposes
`get_wikis`/`get_wiki_page`/`search_wiki` and no wiki writes at all.

#### Two things this needs from the runners

**`${VAR}` expansion.** Claude Code expands `${VAR}` in `.mcp.json` itself.
`readMcpServers` in `core/codex-runner.ts` does not — it parses the JSON and
re-encodes each value as TOML, so a Codex run would hand the MCP server the
literal string `${MCP_TOKEN_FOR_AZURE}` and every ADO call would 401 with a
credential that looks present. Since the whole org is moving to Codex, this is
not an edge case: `readMcpServers` gains `${VAR}` / `${VAR:-default}` expansion
against `process.env`, and a variable that resolves to nothing is a hard error
naming the variable rather than a silent empty string.

**Reading it from `.env` works.** `orchestrator.config.ts` already loads the
root `.env` and `.env.local` through Node's built-in `process.loadEnvFile`
before the adapter registry is built, so `MCP_TOKEN_FOR_AZURE` reaches
`process.env` with nothing added. Only the expansion above is missing.

### 5.2 The fallback that gets written and not wired

Publishing a 110 KB document through a tool call was measured on run SCY-6: the
agent read the document three times building the call, hit compaction thirteen
minutes in, started over, cost $2.73 and produced no page. That is why
`confluence-publish.mjs` exists.

MCP-for-everything was chosen with that evidence in hand. `scripts/ado-publish.mjs`
and `scripts/ado-workitems.mjs` are therefore still written — REST, PAT, Basic
auth, idempotent by wiki path, `--verify` for a target check — and left
**unwired**, documented in CLAUDE.md as the escape hatch for the day a large
document wedges a publish. Two hundred lines against a failure that has already
happened once. **If this is unwanted, say so and it comes out.**

### 5.3 Everything else that changes

| File | Change |
|---|---|
| `orchestrator.workflows.ts` | `publishPrompt` → ADO wiki + work items via MCP; gate summaries say so |
| `agent-instructions/*.thin.md` | eight bundles mention Confluence/Jira; each rewritten |
| `scyne-chatbot/server/orchestrator.ts` | `confluenceSpace`/`jiraProjectKey`/`parentEpicKey` → `adoOrg`/`adoProject`/`adoWiki`/`adoParentEpicId`. `npm run check:routing` must pass |
| `services/atlassianProvision.ts` | → `adoVerify.ts`. **Verify only, never create** — an ADO project create is a long-running async operation and a half-created project is worse than a clear refusal |
| `.env` (both) | `ATLASSIAN_*`, `DEFAULT_CONFLUENCE_*`, `DEFAULT_JIRA_*` out. In: `ADO_ORG=Scyne-AI-Lab`, `ADO_PROJECT=Scyne AI Project`, `ADO_WIKI`. The PAT keeps its existing name `MCP_TOKEN_FOR_AZURE` — it is already set, already works, and renaming a working credential buys nothing |
| `projects/<p>/.published.json` | gains an `ado` namespace; any existing `confluence` block is left in place and ignored. Nothing migrates — inventing a mapping from a Confluence pageId to a wiki path would be guessing |
| `scripts/confluence-*.mjs` | moved to `scripts/legacy-atlassian/` with a README, following the `legacy-react-scaffold/` precedent |
| `pipeline.mjs` | unchanged — it describes stages, not destinations |

ADO Wiki takes **markdown natively**, so the markdown → Confluence storage
format conversion disappears, and with it the whole Mermaid → PNG →
`confluence-attach.mjs` chain: ADO renders ` ```mermaid ` fences itself.

---

## 6. Migrations

One per workstream, so a failed one is diagnosable:

```
005_tenancy.sql        companies.slug/status/archived_at; issues.created_by;
                       superadmin seeding for the existing first admin
006_issue_control.sql  issues.control_request/_by/_at; status vocabulary comment
007_model_prices.sql   model_prices + seed; runs.model/est_cost_usd/cost_source
```

---

## 7. Testing

- `auth.test.ts` — every engine route 401s without a credential and 200s with
  one; `/health` open; a member gets 403 on `/users`; an admin gets 403 on
  `/orgs`; `X-Scyne-Org` from a non-superadmin is 403, not ignored.
- `tenancy.test.ts` — two orgs, two users: neither sees the other's projects,
  issues, runs, actions or spend. A superadmin sees both. This is the test that
  matters most; a leak here is the whole feature failing.
- `control.test.ts` — graceful pause parks at the next step and does not kill;
  force pause kills and parks at this step; cancel is terminal; a cancelled run
  is never retried by `retry.ts`; resume re-runs only the parked step.
- `prices.test.ts` — `priceRun` arithmetic including cached input; an unknown
  model returns null rather than zero; a refresh proposal with a non-finite or
  negative price is rejected; budgets fire on an estimate.
- `openapi.test.ts` green in both directions for every new route.
- `npm run check:routing` green after the ADO param rename.
- `npm run typecheck` green.

**Acceptance, end to end:** from a clean database — claim the install, create
two orgs, a user in each, a project and feature in each; start a run in org A on
the Codex adapter; pause it, resume it, then cancel it; confirm org B's user can
see none of it in console, CLI or chatbot; confirm `scyne spend --by user` and
the console's Spend tab agree and show the Codex run's cost as estimated; then
run one `requirements` workflow to an ADO wiki page and its work items.

---

## 8. Risks

| Risk | Handling |
|---|---|
| Adding auth locks the operator out of the console | `scyne login` already works from the CLI and mints its own token; the first-run `scyne init` claim flow is unchanged. Documented in CLAUDE.md's troubleshooting table |
| Chatbot 401s after the router change | Same commit, plus an end-to-end test that fires a chatbot trigger |
| A tenancy leak | `tenancy.test.ts` asserts isolation on every listing endpoint, and the filters live in SQL rather than being applied afterwards, so an endpoint cannot leak by forgetting one |
| Flat project namespace collides across orgs | `409 name_taken`, and the information leak is stated in §1.4 rather than hidden |
| A wrong price silently overcharges or over-caps | Estimates are a separate column and a separate total; a refresh is a validated proposal a superadmin applies, never a direct write |
| A model retires mid-flight (gpt-5.4, 31 Aug 2026) | `retires_on` in the catalogue; warned within thirty days, not offered past it |
| Publishing a large document through MCP repeats SCY-6 | REST scripts written and documented as the escape hatch (§5.2) |
| Killing a child leaves a half-written artefact | `attach` already blocks on a missing `produces` file before any gate is raised, so a killed step cannot present partial output for approval |
