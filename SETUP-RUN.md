# Running the stack, end to end

Every command below was run against a **clean database** while writing this
file, except the two marked *needs a live credential* — which are the two
blockers at the bottom.

Copy-paste from top to bottom and you will have exercised every feature in this
work: multi-tenancy, login and logout on all three surfaces, pause/cancel,
Codex spend, Azure DevOps publishing, and the standalone CLI.

---

## 0. Once per clone

```bash
npm run setup          # packages, skills, a local .env, and the first login
```

It installs root, `packages/orchestrator` and `scyne-chatbot`, runs
`npm run link-skills` (`.claude/` is gitignored — without it every agent run
dies with `Unknown skill: <slug>`), writes `.env` if there is none, and claims
the installation on a fresh database.

## 1. Start from a clean database

**Stop the server first.** PGlite is single-writer, and the CLI is refused
while `npm run dev` holds the directory.

```bash
npm run orch -- reset --all           # a PLAN. Prints what would go, deletes nothing
npm run orch -- reset --all --yes     # do it
```

Three depths, each a superset of the last:

| | Clears |
|---|---|
| `reset` | issues, comments, work products, gates, runs, budgets, and the raw `.jsonl` logs |
| `reset --hard` | + the agents and `.orchestrator/overrides.json`, so the next boot rebuilds the org from `orchestrator.config.ts` |
| `reset --all` | + users, projects, documents, installations and chats — and the only depth after which the installation can be claimed again with `scyne init` |

**`reset` clears ONE organisation, not the database.** It is scoped to the home
organisation, so another organisation's projects, people and issues survive a
`--all`. The plan names them:

```
  NOT touched — this resets one organisation, not the database:
    Beta Mutual (beta-mutual)
```

Use `--all` for this walkthrough. For a genuinely empty database, stop the
server and delete the directory:

```bash
rm -rf .orchestrator/pgdata     # also discards the migration state
```

Skills are files, not rows — no reset touches them. Agents need no reseeding
either: the org chart is reconciled from `orchestrator.config.ts` on every boot.

## 2. Check it works before spending anything

```bash
npm test               # 599 unit + integration tests
npm run typecheck      # orchestrator + CLI
npm run check:routing  # every chatbot title/description → the right workflow
npm run smoke          # 38 end-to-end checks against a THROWAWAY database
```

`npm run smoke` is the one that matters here. It starts an orchestrator on port
3299 with its own temp database — **your real `.orchestrator/pgdata` is never
opened** — claims it, creates two organisations with a user and project each,
proves neither can see the other, starts an issue and pauses / resumes /
cancels it, exercises the price catalogue and the proposal flow, and reads the
audit trail. Then it tears everything down.

```
38 passed, 0 failed
```

It deliberately does **not** spawn an agent or publish anything: both need live
credentials, cost real money and take tens of minutes. Those two are checked
separately, in steps 9 and 10.

## 3. Start it

```bash
npm run dev            # orchestrator on :3100 (console at /orch), chatbot on :5173
```

Start **both**, not just the orchestrator. `project create` and `feature add`
build the folder tree through the chatbot server on :4000; with only the
orchestrator up they still record the project in the database, but print
`chatbot server not running at http://127.0.0.1:4000` and create no folders.

## 4. Claim the installation

The first account is the installation's **superadmin** — the only role that can
create organisations and see every one of them.

```bash
node cli/index.ts init
#   Superadmin email: you@scyne.co
#   Password: ********
```

Then open **http://127.0.0.1:3100/orch** and sign in with those credentials.
The console shows you nothing until you do: every engine and platform route
requires a credential, and only `/health`, `/orch`, `/docs` and `/openapi.json`
are open.

## 5. Organisations, people, projects

```bash
node cli/index.ts org create "Alpha Council of SA"
node cli/index.ts org use alpha-council-of-sa        # act inside it
node cli/index.ts user create ana@alpha.co --role admin
node cli/index.ts project create "AlphaClaims" --description "…who the client is…"
node cli/index.ts use AlphaClaims                    # pin it, so later commands need no --project
node cli/index.ts feature add "Interim Benefit"
```

Or all of it in the console: **Organisations** → **Users** → **Projects**.

### Prove the tenancy actually holds

Make a second organisation with its own admin, then sign in as them **from a
separate config home**, which is what a second machine looks like:

```bash
node cli/index.ts org create "Beta Mutual"
node cli/index.ts org use beta-mutual
node cli/index.ts user create bob@beta.co --role admin --password 'BobPass123!'
node cli/index.ts org use --clear

SCYNE_HOME=/tmp/bob node cli/index.ts login --api http://127.0.0.1:3100 \
  --email bob@beta.co --password 'BobPass123!'

SCYNE_HOME=/tmp/bob node cli/index.ts project list    # (none)
SCYNE_HOME=/tmp/bob node cli/index.ts status SCY-1    # error: no issue 'SCY-1'
SCYNE_HOME=/tmp/bob node cli/index.ts org list        # only Beta Mutual
SCYNE_HOME=/tmp/bob node cli/index.ts org create Gamma   # (superadmin only)
```

A cross-tenant read answers **404, not 403** — a 403 would confirm the issue
exists. And the org-switch header is **refused**, not ignored:

```bash
TOKEN=$(python3 -c "import json;print(json.load(open('/tmp/bob/config.json'))['token'])")
curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer $TOKEN" \
     -H "X-Scyne-Org: alpha-council-of-sa" http://127.0.0.1:3100/issues     # 403
curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer $TOKEN" \
     http://127.0.0.1:3100/issues                                           # 200
```

Silently ignoring an authorisation-shaped header teaches a caller that it worked.

## 6. Login and logout, on all three surfaces

Same accounts everywhere — there is one user table.

| Surface | In | Out |
|---|---|---|
| **CLI** | `node cli/index.ts login --api http://127.0.0.1:3100` | `node cli/index.ts logout` |
| **Console** `:3100/orch` | the sign-in form | the button beside your email |
| **Chatbot** `:5173` | the `Login` screen | the header |

The CLI stores a bearer token in `~/.scyne/config.json`, written 0600 inside a
0700 directory. The console and chatbot use **httpOnly cookies** — a credential
JavaScript cannot read is one an injected script cannot steal. Confirm any of
them with `node cli/index.ts whoami`.

A superadmin also gets an **organisation switcher** beside their email in the
console, and `--org <slug>` / `scyne org use <slug>` on the CLI.

## 7. Run a stage, and stop it

```bash
node cli/index.ts run                                  # what this server can run
node cli/index.ts run capabilities --project AlphaClaims
node cli/index.ts status SCY-1                         # activity, gates, work products

node cli/index.ts run pause  SCY-1          # the step in flight finishes first
node cli/index.ts run pause  SCY-1 --force  # stop the agent NOW, losing that step
node cli/index.ts run resume SCY-1
node cli/index.ts run cancel SCY-1 --yes    # for good; it does not resume
```

All four are also on the console's issue page and in the chatbot's Workflow
panel, and every one is recorded against the person who asked
(`node cli/index.ts audit`).

A stage parked at `blocked` names its cause in the comment — a non-zero `exec`,
a missing `produces` file, an unreadable `reads` path. Fix it and
`run resume`; it restarts at the step that blocked, not from the beginning.

### Approve, reject, revise

```bash
node cli/index.ts gate list
node cli/index.ts gate approve <id>
node cli/index.ts gate reject  <id> --note "personas are too generic"

# a revision is the same stage in another mode, and needs its instruction
node cli/index.ts run revise-datamodel --project AlphaClaims \
  --feature "Interim Benefit" --instruction "Add an SLA breach field to Case."
```

Rejecting rewinds to the step that generated the artefact and regenerates on
its own. Both return **202** and continue in the background — a response that
waited for a twenty-five-minute agent would time out on a click that worked.

## 8. Cost

```bash
node cli/index.ts spend --by model     # or project | feature | user | agent | adapter
node cli/index.ts models list          # the price catalogue, retirements flagged
node cli/index.ts models set gpt-5.6-terra --input 2.5 --output 14 --cached 0.25
node cli/index.ts models proposal      # a proposed table, as a DIFF
node cli/index.ts models apply         # superadmin only
```

Reported and estimated cost are **separate columns and never added together**.
Codex reports no dollar figure of its own, so on this install the estimated
column is most of the bill — computed from token counts against this table.

Two rules worth testing by hand, because both were bugs found while writing
this file and both are now covered by `npm run smoke`:

- **A hand correction leaves what it does not mention alone.**
  `models set … --input 3` keeps the cached and output rates. Silently dropping
  a cache discount would raise the recorded cost of every run afterwards, and
  most of a long agent run's input is cached.
- **A refresh is a proposal in either spelling.** `inputPerMTok` and
  `input_per_mtok` both work; a row naming no rate at all is refused with 400
  rather than accepted as a proposal that changes nothing.

## 9. An actual agent run — *needs a live credential*

Everything above is free. This is the first step that spawns Claude Code or
Codex and spends money.

```bash
node cli/index.ts adapter list            # what is registered, and what runs where
node cli/index.ts adapter set claude_local --project AlphaClaims   # or codex
node cli/index.ts run requirements --project AlphaClaims --feature "Interim Benefit"
node cli/index.ts logs <runId> --follow
```

Watch it in the console at `#runs`, or in the chatbot's Live Transcript.
Budgets are a ceiling, not a target: 10M tokens / $15 / 45 minutes per run.

> **Blocked today.** `SCYNE_ADAPTER=codex` is the default and Codex is not
> authenticated on this machine — see blocker 2.

## 10. Publish to Azure DevOps — *needs a live credential*

Publishing runs through the **Azure DevOps MCP**: `wiki_upsert_page` for the
page, `wit_work_item_write` for the stories.

Check the target before a stage does. It takes two seconds and saves a run:

```bash
npm run ado:verify     # org, project, wiki scope and work-item scope, separately
npm run mcp:test       # the same, THROUGH the MCP, exactly as an agent reaches it
npm run mcp:test -- --write    # also creates, updates and deletes a real work item
```

`mcp:test` is the one that proves the wiring: it loads `.mcp.json` through the
same `readMcpServers` the Codex runner uses and starts the server with exactly
the argv and env an agent gets.

```
✓ the ${VAR} in .mcp.json was expanded        116 chars
✓ it is BASIC credentials                     base64 of ":<pat>"
✓ the server starts and speaks MCP            40 tools
✓ the PAT authenticates THROUGH the MCP       Scyne AI Project
✗ the PAT has the WIKI scope                  401      ← blocker 1
✓ creating / updating / deleting an 'Issue' work item
```

One value has to be right up front. **No MCP tool lists a project's work item
types** (checked against all 40), so the type is handed to the agent as
`ADO_WORK_ITEM_TYPE` — `Issue` here, because this project runs the **Basic**
template, whose types are Epic → Issue → Task with no `User Story` at all. Get
it wrong and every story fails, after the gate was approved and the page
published.

## 11. The deliverable

```bash
npm run app AlphaClaims                                    # the companion app
open generated-apps/AlphaClaims/index.html
curl -s http://127.0.0.1:4000/api/staleness/AlphaClaims    # what predates its inputs
```

## 12. Ship the CLI to your users

They do not need a clone — the CLI is an HTTP client with **zero npm
dependencies**, and since `cli/stages.ts` it reads the stage list from the
server rather than from the repository.

```bash
npm run pack:cli       # dist/cli/ and dist/scyne-cli-<version>.tgz  (~21 KB)
```

Send them the tarball, and they run **one** of:

```bash
npm install -g ./scyne-cli-0.1.0.tgz                     # the tarball you sent
npm install -g https://…/releases/…/scyne-cli-0.1.0.tgz  # a GitHub release asset
npm install -g @scyne/cli                                # a registry, if you publish
cp scyne.mjs ~/bin/scyne                                 # no npm at all
```

Then:

```bash
scyne login --api-url https://scyne.example.com
scyne whoami
scyne run
```

They need **Node 20+** and nothing else. No engine, no PGlite, no workspace, no
skills. Because the stage list comes from the server at call time, they do not
have to upgrade in step with it.

Publishing to a registry needs `npm login`, and the `@scyne` scope needs that
org to exist — rename with `SCYNE_CLI_NAME=scyne-cli npm run pack:cli`. The
tarball and copy-the-file routes need neither.

---

# Two things that must be fixed before a run can succeed

Both are credentials on this machine, not code. Everything else is done and
verified.

### 1. The Azure DevOps PAT has no wiki scope

`npm run ado:verify` reports:

```
✓ organisation reachable and the token is valid — 1 project(s)
✓ project exists — Scyne AI Project
✗ token has the WIKI scope        ← 401
✓ token has the WORK ITEM scope — 12 type(s)
```

Azure DevOps answers a **missing scope with 401**, not 403, so this reads
exactly like a bad token. It is not — work items already write with it.

**Fix:** add `vso.wiki_write` (keeping `vso.work_write`) at
<https://dev.azure.com/Scyne-AI-Lab/_usersSettings/tokens>, put the new value in
the root `.env` as `MCP_TOKEN_FOR_AZURE`, and re-run `npm run ado:verify`.

> The MCP needs that PAT as **`base64(":" + pat)`**, not raw — measured against
> the live server, where a raw PAT 401s. `orchestrator.config.ts` derives
> `ADO_MCP_BASIC` from `MCP_TOKEN_FOR_AZURE` for you, so `.env` holds the one
> value a human copies out of Azure DevOps and nothing else changes.

### 2. Codex is not actually authenticated

`codex login status` says "Logged in using an API key", but a real run gets:

```
401 Unauthorized: Incorrect API key provided … url: https://api.openai.com/v1/responses
```

The key currently in `CODEX_CLI` has **Azure** key shape and is being sent to
`api.openai.com`, which rejects it.

`SCYNE_ADAPTER=codex` is the default, so **every agent run fails at its first
request until this is sorted.**

**Fix — pick one:**

- `codex login` with a real OpenAI API key or a ChatGPT sign-in; or
- point Codex at Azure through its own provider configuration, if that key is
  meant for an Azure deployment; or
- set `SCYNE_ADAPTER=claude_local` in `.env` to keep working on Claude Code
  while you sort it. Everything else here is adapter-independent — though a
  Claude run reports its own cost, so the estimated column stays empty.

Also set **`CODEX_MODEL`** when running on Codex. Without it a run still works,
but the transcript carries no model name, so every run shows `—` for cost and
no cost budget can fire on it.

> That key was printed into the working transcript while diagnosing this.
> Worth rotating if the log is shared.
