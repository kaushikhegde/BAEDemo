# Super-admin tracking — console, CLI and attribution — design

**Date:** 2026-08-20
**Status:** Design, awaiting review
**Sibling specs:** `2026-08-20-codex-cli-adapter-design.md`, `2026-08-20-azure-devops-publishing-design.md`

---

## 1. Why

An administrator needs to answer "who ran what, against which project and which
feature, and what did it cost" — in the console and from the CLI. Most of the
data already exists. Three things stop it being answerable.

**Nothing records which user started a run.** `issues` carries `project_id` and
`feature_id` but no `created_by`, so every run in the system is attributable to
an agent and a project and to nobody at all. `SpendRow` already declares a
`user_id` field; every query hard-codes it to `null::uuid` because there is
nothing to select.

**`spend()` groups by project, agent or adapter — and the adapter case is
broken.** It groups by `agents.adapter`, which migration 003 deliberately set to
null for every agent so the configured default would apply. That view returns
one null row today. There is no feature dimension at all.

**The console has no admin surface.** `TABS` is runs/issues/gates/org/skills/
budgets/config/health. `/admin/overview`, `/spend`, `/actions`, `/users` and
`/projects` all exist and are admin-gated; nothing renders them.

## 2. Attribution — migration 004

```sql
alter table issues add column created_by uuid references users(id) on delete set null;
alter table runs   add column adapter text;
```

`created_by` is set by `POST /issues` from the authenticated principal. Existing
rows stay null and render as `—`: back-filling an attribution we do not have
would be inventing evidence, and "started before we tracked this" is a true and
useful thing for the column to say.

`runs.adapter` is written by the engine from `resolveRuntime` — the only place
that knows the answer, since it can come from the step, the agent, a project
setting or the default. It is **shared with the Codex spec**, which needs it to
select a transcript decoder, and it is what fixes spend-by-adapter.

## 3. Authentication — the part with teeth

`/orch` is served with no auth, and so is every engine route it calls:
`/issues`, `/agents`, `/runs`, `/gates`, `/config`. Only the platform routes
require a credential. Putting users and spend on that page without a login would
publish them to anything that can reach port 3100.

So: **the console gets a login, and the engine routes get the same
`requireAuth` the platform routes already use.**

- `GET /orch` serves the app shell; the app calls `/auth/whoami` and renders a
  login form until it succeeds. Session cookie via the existing `POST /auth/login`
  — `auth.ts` already has scrypt passwords, sessions and expiry.
- Admin-only tabs are gated on `user.role === "admin"` in the UI **and** on
  `requireAdmin` in the router. The UI gate is convenience; the router gate is
  the security boundary.
- `GET /health` stays open, because a health check that needs a credential is
  not a health check.

### The ripple that will bite

`scyne-chatbot/server/orchestrator.ts` calls the orchestrator with **no
Authorization header at all**. The moment engine routes require auth, every
chatbot trigger 401s.

Fix: the chatbot server holds a service API token (`SCYNE_API_TOKEN` in its
`.env`), minted by `scyne user create chatbot@scyne --role admin` plus
`POST /auth/tokens`, and sends it as `Authorization: Bearer`. `auth.ts` already
mints, hashes and prefixes tokens; `looksLikeToken`/`bearerFrom` already accept
them. Nothing new is needed except sending the header and a one-line setup step
in the chatbot's README.

The CLI is already fine — `scyne login` trades a session for a long-lived token
and stores it 0600.

**Order matters:** the chatbot change ships in the same commit as the router
change, or the chatbot is dead between them.

## 4. Spend and audit, by every dimension

`platform.spend()` becomes:

```ts
spend(companyId, {
  by: "project" | "feature" | "user" | "agent" | "adapter",
  project?, feature?, user?, since?, until?,
}): Promise<SpendRow[]>
```

- `feature` joins `features` through `issues.feature_id`; `user` joins through
  the new `issues.created_by`; `adapter` groups by `runs.adapter`.
- `SpendRow` gains `feature_id`/`feature_name` and finally populates `user_id`
  (plus `user_email` for display).
- Filters compose with the dimension, so "spend by feature, for project RTWSA,
  since 1 August" is one call.
- Rows carry `run_count`, input/output tokens and `cost_usd`. **`cost_usd` is
  summed over runs where it is non-null and the row reports how many runs
  reported no cost**, because a Codex run records null and a naive `sum` would
  present a partial total as a complete one.

`listActions()` gains the same `featureId`, `userId`, `since`, `until` filters
alongside its existing `projectId`.

New route: `GET /spend?by=&project=&feature=&user=&since=&until=`, replacing the
current unparameterised one. `openapi.yaml` is updated and `openapi.test.ts`
diffs it both directions.

## 5. The console

Four tabs added to `TABS`, `ICONS`, `ROUTES` in `http/console.ts`, admin-only:

| Tab | Shows |
|---|---|
| **Users** | every user, role, status, last activity, runs started, spend. Create, change role, disable. Drills into one user's runs and actions |
| **Projects** | every project with its features, issue counts by status, artefacts published, spend. Drills into a project → its features → that feature's issues |
| **Spend** | the pivot: a dimension selector (project / feature / user / agent / adapter) plus project, feature and date filters. Every row drills into the runs behind it |
| **Audit** | the `actions` timeline with the same filters — who did what, when, to which project |

`OWNER` gains `user → users` and `project → projects` so a detail route keeps
the rail highlighted, matching how `run`/`issue`/`agent` already behave.

`console.ts` is 2067 lines. These four tabs plus a login screen would push it
past 2800, which is past the point where it is comfortably editable. It splits
first: `console/shell.ts` (chrome, routing, auth), `console/engine.ts` (runs,
issues, gates, org, skills, budgets, config, health) and `console/admin.ts` (the
four new tabs). No behaviour change in that move — it lands as its own commit so
the split is reviewable separately from the features.

## 6. The CLI

```
scyne spend   [--by project|feature|user|agent|adapter]
              [--project P] [--feature F] [--user email] [--since D] [--until D] [--json]
scyne actions [--project P] [--feature F] [--user email] [--since D] [--limit N] [--json]
scyne admin                       # unchanged summary, plus per-adapter spend
scyne user show <email>           # NEW: role, projects, runs started, spend
scyne project show <name>         # extended: per-feature issue counts and spend
```

`--json` on each, because the first thing anyone does with a spend table is pipe
it somewhere.

## 7. Testing

- `platform.test.ts`: each dimension returns the right grouping; filters compose;
  a run with null `cost_usd` is counted in `run_count` and reported in
  `unpriced_runs` rather than silently summed as zero.
- `auth.test.ts`: every engine route 401s without a credential and 200s with one;
  `/health` stays open; a non-admin gets 403 on `/users`, `/spend`, `/admin/*`.
- `openapi.test.ts` green in both directions.
- `check:routing` green — the chatbot's calls now carry a header, and its
  title→workflow mapping must still resolve.
- **Acceptance:** from a clean database, two users each start a run against
  different features of one project; `scyne spend --by user` and the console's
  Spend tab both attribute correctly, and the numbers agree.

## 8. Risks

| Risk | Handling |
|---|---|
| Adding auth locks the operator out of their own console | `scyne user create --role admin` works from the CLI with the token it already has; documented in CLAUDE.md's troubleshooting table |
| Chatbot 401s after the router change | Same commit, and an acceptance test that fires a chatbot trigger end to end |
| Historic runs show no user | `—`, deliberately. See §2 |
| Partial cost totals once Codex lands | `unpriced_runs` on every spend row; the console shows "n runs unpriced" beside the total |
