# The workflow engine, the console and the API

Moved out of `CLAUDE.md` so it is not resident in every session. Read this
before changing `packages/orchestrator/`, `orchestrator.workflows.ts`, or
anything about how a run starts, parks, stops or retries.

### Signing in to the console

`/orch` serves its shell to anyone — it has to, or there would be nowhere to
show a login form. Everything BEHIND it needs a credential: every engine route
(`/issues`, `/runs`, `/agents`, `/config`, `/gates`) and every platform route.
Only `/health`, `/orch`, `/docs` and `/openapi.json` are open.

The credential is an **httpOnly `scyne_session` cookie**, set by
`POST /auth/login` and sent automatically because the console is same-origin.
No console code ever touches a token — `console.test.ts` asserts that the page
script contains no `localStorage`, no `sessionStorage` and no `Bearer`, because
a credential the page can read is one an injected script can steal. The CLI is
unaffected: it sends `Authorization: Bearer`, which wins over the cookie.

The first account claims the installation, as its **superadmin**:

```bash
node cli/index.ts init      # or: scyne init
```

**Admin tabs are hidden by role in the rail and REFUSED by the router.** Only
the second is a security boundary; hiding a tab makes a tidier screen, not a
permission. A superadmin also gets an **organisation switcher** beside their
email, which sends `X-Scyne-Org` — a header the server refuses outright from
anyone else rather than ignoring, because silently ignoring an
authorisation-shaped header teaches a caller that it worked.

The five admin tabs live in `http/console/admin.ts` and the login gate in
`http/console/auth.ts`, rather than as another four hundred lines in
`console.ts` (already 2100). Both are STRINGS spliced into that page, so the
rule that governs the rest of that script governs them: **no backtick and no
dollar-brace anywhere inside, comments included** — they sit in a TypeScript
template literal. Watch the escaping too: a `\n` written in the TypeScript
source becomes a REAL newline in the emitted browser string and breaks it; the
browser needs `\\n`.

### The workflow engine

Everything is a **workflow**: an ordered list of steps against one issue. Five
step types, and they are the whole vocabulary:

| Step | Does |
|---|---|
| `exec` | runs a shell command (staging, validators, the companion-app render). Non-zero exit blocks the issue with the stderr tail as a comment |
| `agent` | runs one Claude Code process with a system-prompt bundle and a prompt. `reads` pulls named files into the prompt as `{variables}` |
| `attach` | records the stage's outputs as work-products. A missing file blocks **before** any gate is raised — a human is never asked to approve output that was not produced |
| `gate` | raises the human approval gate and parks |
| `flow` | spawns a child workflow. Present but unused: parent-resume-on-child-completion is not implemented |

The engine owns every status transition (`todo → in_progress → in_review →
done/blocked`) and parks at anything waiting on a human. One issue, one workflow,
one gate per artefact.

**It also narrates itself.** Every step posts a comment to its issue — what an
`exec` step is doing, which agent is starting and with which skill, what it cost
when it finished, what `attach` recorded, that a gate is waiting, and a closing
total.

> **An `exec` narrates its `label`, never its command.** That timeline is what a
> CLIENT watches in the chatbot while their run proceeds, and `Step 7 of 7 ·
> running node scripts/render-companion-app.mjs SAPN` tells them nothing they
> wanted to know while disclosing a path on our machine. A step with no label
> says only "running" — describing a command is opt-IN, so a step added later
> cannot leak one by omission. The command IS recorded, verbatim, in the
> blocking comment when the step fails, inside the fence with the stderr, which
> is the one moment somebody needs it. That timeline is what the chatbot's Activity panel and the
console's issue detail render, and it is written by the ENGINE, not by the
agents. The Paperclip bundles used to instruct each agent to post its own
progress ("clients watch the chatbot timeline"); that was correctly deleted when
the bundles were thinned — an agent should not be calling an API — but nothing
replaced it, so a HEALTHY run produced no comments at all. The panel stayed
empty for the twenty-five minutes an agent takes, with no way to tell a working
run from a wedged one. Narration is best-effort: a failed comment insert is
logged and never fails the step it was describing.

**Workflows are compiled, not hand-written.** `orchestrator.workflows.ts` turns
each stage in `scripts/pipeline.mjs` into:

```
exec  stage.mjs   →  agent  generate  →  exec  validator  →  attach  →  gate
                                                    →  agent  publish  →  exec  render app
```

so adding a stage to the pipeline graph adds its workflow for free. Eighteen
exist: nine `<stage>`, eight `revise-<stage>`, and `baseline`.

A `revise-<stage>` is not a tenth stage — it is the SAME stage in another mode,
and says so: `reviseWorkflow` sets **`variantOf: <stage>`** and `variant:
"revise"` on the `WorkflowDef`. The engine ignores both (it runs a variant
exactly like any other workflow); the console reads them to list ten rows
instead of eighteen, and to group the New-run dropdown. Declared rather than
inferred, because the `revise-` prefix is a convention THIS consumer invented —
a library console that grepped for it would have learned one consumer's habits.

**A variant's budget is still its own.** The engine looks a limit up by the
literal workflow key, so `datamodel` and `revise-datamodel` are separate
ceilings; the Budgets tab indents one under the other but never merges them. A
revision is a small diff and should be allowed less than a generation from
scratch.

> **Paths are level-relative.** `produces[]` in `pipeline.mjs` is relative to the
> stage's OWN level root — `projects/<p>/` for a project stage,
> `projects/<p>/<feature>/` for a feature stage. Resolving a feature stage's
> outputs against the workspace root is what blocked a completed run during the
> prototype: the agent had written every file correctly and the attach step was
> looking one directory tree too high.

### Publishing

Publishing is an `agent` step **after** the gate, not a second phase the agent
detects it is in. It runs exactly once because `step_index` moves past it — which
is what deleted the marker-comment protocol the old bundles carried.

The publish prompt is generated per stage and always says: resolve the org,
project and wiki from the workflow params (falling back to `ADO_ORG` /
`ADO_PROJECT`), create-or-update the page **by path** with the markdown as it
stands, and record the path in `projects/<project>/.published.json` under
`ado.<artefact>` so a later revision updates that page instead of creating a
second one. For a document over about 40 KB it says to use
`scripts/ado-publish.mjs` rather than a tool call.

### The revision flow

A revision hands the owning agent its own previous output plus the reviewer's
instruction, verbatim, and asks for a small diff.

`revise-<stage>` is a workflow like any other, with one difference: its `agent`
step declares

```ts
reads: { previous: "projects/{project}/{feature}/solutions/DataModel/outputs/salesforce-data-model.md" }
```

so the file's contents arrive in the prompt as `{previous}`. The skill enters its
**Revision mode**: preserve everything the instruction does not touch, apply the
change and its genuine consequences, append a `## Revision History` entry. On
approval the publish step **updates** the existing wiki page, using
`projects/<project>/.published.json` for page identity.

A missing `previous` file blocks the issue **before** the agent is spawned,
naming the variable and the resolved path — a revision with nothing to revise is
a caller error, not a model task, and it leaves no zero-token mystery run behind.

The discipline is a small diff. A regenerate-from-scratch produces a diff too
large for a reviewer to check, which defeats the gate.

### Rejecting and retrying

Rejecting a gate rewinds to the step that generated the artefact and
**regenerates on its own** — the decision is recorded synchronously and the
resume runs in the background, so the click returns immediately (202) rather
than holding the connection open for the length of a run.

A blocked issue is restarted with `POST /issues/:id/advance`, from the console's
Resume button or the chatbot's Request-changes path. It resumes at the step that
blocked; steps that already succeeded are not re-run.

### Stopping a run

An agent run averages twenty-five minutes and real money, so "I started the
wrong thing" used to cost both. Three verbs now, and the difference between the
first two is the whole point:

| Verb | The agent in flight | The issue ends at | Resumable |
|---|---|---|---|
| **Pause** | runs to completion | `paused`, before the NEXT step | yes |
| **Pause now** (`--force`) | SIGTERM → SIGKILL | `paused`, at THIS step | yes — that step re-runs |
| **Cancel** | SIGTERM → SIGKILL | `cancelled` | no |

```bash
scyne run pause  SCY-7            # the step in flight finishes first
scyne run pause  SCY-7 --force    # stop the agent now, losing that step's work
scyne run cancel SCY-7            # for good; prompts unless --yes
scyne run resume SCY-7
```

Also `POST /issues/{id}/{pause,cancel,resume}` (each 202, each recording an
`actions` row naming who asked), and three controls in the chatbot's Workflow
panel.

**It is a REQUEST, not a status.** `issues.control_request` is written by the
route; the ENGINE decides when to honour it, at its next step boundary. The two
are genuinely different — the request is made by a human at an arbitrary
moment, and the status can only change when the engine reaches a point where it
can act. Collapsing them would mean either lying about the status for twenty
minutes while an agent still burns tokens, or losing the request when the
running step finishes and overwrites it.

Three consequences worth knowing, each of which was a bug found by testing this
against a live server rather than only in unit tests:

- **An issue parked at a gate or `blocked` can still be stopped.** The control
  check runs BEFORE the parked-status early-returns in `advance()`. With that
  ordering reversed, a cancel on an issue awaiting approval was recorded and
  then silently never honoured — and waiting for a human is the single most
  likely moment to call something off.
- **A request made while a step is running survives that step blocking.** When
  a step parks or blocks, `advance()` re-reads once before returning. Without
  it, an exec that failed seconds after a cancel left the request pending
  forever, the issue read `blocked`, and the next resume quietly cleared it.
- **A killed run is `cancelled`, not `failed`,** and `core/retry.ts` refuses it
  explicitly. A cancel a few seconds in with no usage recorded matches the
  "died cheaply, retry it" rule exactly — so without that branch, pressing
  Cancel would have spawned the agent again.

Cancelling also cancels any `pending` gate on the issue, so abandoned work does
not sit in an approval queue inviting someone to approve it.

### Self-healing

A failed **agent** step is retried **once, automatically** — but only when the
first attempt demonstrably **spent nothing**. `src/core/retry.ts` decides, and
the test is deliberately about money rather than about how transient the error
text looks:

| First attempt | Retried? | Why |
|---|---|---|
| No `result` event AND under 60s wall clock | **yes** | nothing was billed, so the retry cannot cost more than the failed spawn did |
| Reached its `result` event | no | it ran and failed on its own terms; a retry buys another full run |
| Over 60s with usage unrecorded | no | killed mid-flight — its spend is unknown, not zero |
| `over_budget` | no | the ceiling was reached once and would be billed again |
| Configuration error (missing bundle, `Unknown skill`, bad key) | no | it fails identically, and a retry line that means nothing teaches you to ignore the ones that do |
| `cancelled` — a person pressed Pause now or Cancel | no | a retry would undo the thing that was asked for. Checked BEFORE the transient-window rule, which a cancel a few seconds in would otherwise match exactly |

The retry gets its **own run row and its own log file** (`…-retry1.jsonl`), so
the console shows two attempts rather than two mysterious runs a second apart,
and one transcript never contains another attempt's events. The blocking
comment always names which row above applied — `after 1 attempt. Not retrying:
the agent ran to completion and failed on its own terms.`

`exec`, `attach`, `gate` and `flow` steps are never retried: a validator that
exits non-zero or a `produces` file that was not written will do exactly the
same thing next time.

### Staleness

`GET /api/staleness/:project[/:feature]` reports artefacts generated before one
of their declared inputs last changed, computed from file mtimes against the
shared pipeline graph. Nothing is stored and nothing regenerates automatically —
the chat says which artefacts predate a change and offers a refresh, and the user
decides. mtime over-reports rather than under-reports, which is the safe
direction: a refresh you decline costs nothing, a pack that contradicts itself
costs a client meeting.

The chatbot polls `/api/status/:issueId` every 3 seconds, surfaces comments as a
live activity timeline, renders approval gates inline with an Approve / Reject
card, and shows wiki + work item links the moment they appear.

## The orchestrator (`packages/orchestrator/`)

A standalone library — this repo is its first consumer, which is the discipline
that keeps it generic: nothing under `packages/orchestrator/` may import
`scripts/pipeline.mjs`, `orchestrator.config.ts`, or anything under `projects/`.

```
src/core/    db · repo · engine · runner · usage · transcript · interpolate · retry · overrides · skills
src/http/    router · console · docs · theme
src/cli.ts   seed · run · status · gate · runs · log · serve
```

### CLI

```bash
npm run orch -- seed                                     # reconcile the org chart
npm run orch -- reset [--hard] [--yes]                   # clear history, keep the org
npm run orch -- run <workflow> --project P [--feature F] # start and advance
npm run orch -- status <SCY-7|uuid>                      # comments, work products, gates
npm run orch -- gate list | approve <id> | reject <id> --note "…"
npm run orch -- runs <SCY-7>                             # agent, phase, duration, tokens, cost
npm run orch -- log <runId> [--raw]                      # the transcript
npm run serve                                            # HTTP + console on :3100
```

Any `--key value` after the workflow name becomes a workflow param, so
`--adoProject "Scyne AI Project"` reaches the publish prompt without a code change.

### HTTP API

`GET /health` · `/agents` · `/agents/{key}` (PATCH) · `/agents/{key}/runs` ·
`/agents/{key}/bundle` (**PUT**) · **`/skills`** · **`/skills/{name}`** (**PUT**) ·
**`/workflows/{key}`** ·
`/runners` · `POST /issues` · `GET /issues` ·
`/issues/{id}` (PATCH) · **`POST /issues/{id}/advance`** · **`/issues/{id}/pause`** · **`/issues/{id}/cancel`** · **`/issues/{id}/resume`** · `/issues/{id}/comments`
(POST) · `/issues/{id}/work-products` · `/issues/{id}/gates` ·
`POST /gates/{id}/approve|reject` · `/issues/{id}/runs` · `/runs/{id}` ·
`/runs/{id}/log` · `/runs/{id}/transcript` · `/usage` · **`DELETE /projects/{id}/documents`** · **`/models`** · **`/models/{provider}/{model}`** (PUT) · **`/models/refresh`** (GET/POST/DELETE) · **`/models/refresh/apply`** · **`/orgs`** · **`/orgs/{id}`** · `/config` · `/orch` ·
`/openapi.json` · `/docs`.

`GET /config` reports, per workflow, a **`params`** list and a **`stepList`**.
Both are *derived by scanning the workflow*, never declared beside it — the
eighteen workflows are compiled from `scripts/pipeline.mjs`, so there is no
hand-written site a declaration could live on, and a derived list cannot drift
when a stage starts reading a new variable. `params` uses the engine's own
placeholder grammar (`placeholdersIn`, exported from `core/interpolate.ts`) so
the console's New-run form asks for exactly what the steps interpolate.
`stepList` carries each step's type and phase and **nothing else** — never its
prompt, command or `reads` paths.

> **A doubled brace is a literal.** `interpolate` leaves `{{NAME}}` untouched
> and substitutes only `{name}`. Without that escape the inner `{NAME}` matched,
> missed and threw: the requirements workflow's publish prompt says «replace
> `{{PRODUCT_SUMMARY_URL}}` in the description», so **every requirements run
> blocked at publish with `unknown placeholder {PRODUCT_SUMMARY_URL}` — right
> after a human had approved its gate.**

`openapi.yaml` is diffed against the router's `ROUTES` table **in both
directions** by `test/openapi.test.ts`: every route must be documented and every
documented route must exist. Adding a route means editing both.

### Gotchas

- **PGlite is single-writer — but it does not enforce that itself.** Measured:
  a second process opens the same `.orchestrator/pgdata` happily, gets its own
  view of the data, and the two diverge **silently** — one can delete every row
  while the other goes on reporting them, and whichever flushes last wins. No
  error, no warning, nothing in the data afterwards recording it. `openDb`
  therefore takes its own lock, a `pgdata.lock` sidecar holding the owning pid,
  so the second opener is refused with a message naming the process that holds
  it. A lock whose pid is dead is stale and gets taken over — a SIGKILL must not
  leave a database nobody can reopen. While `npm run dev` or `orch serve` is up,
  CLI verbs are refused and point at the HTTP API.
- **Gate decisions and `POST /issues` return 202 and resume in the background.**
  A resumed workflow runs an agent step for tens of minutes; a response that
  waited for it would time out on a click that actually worked. Poll
  `GET /issues/{id}`.
- **A declared-but-missing agent bundle** makes Claude Code fail fast with
  `System prompt file not found`, before any network call. The run is recorded
  `failed` with that stderr — but check `GET /agents/{key}/bundle`, which reports
  the missing path rather than 404ing, and the console's **Edit instructions**
  screen, which offers to create the file on the spot.
- **`.claude/skills/` must be symlinked** or every agent run dies with
  `Unknown skill: <slug>`. `npm run link-skills`. `.claude/` is gitignored, so a
  fresh clone always needs it.
- **Orphan recovery runs once, at startup.** A run with no `finished_at` is
  marked `orphaned` and its issue returned to `todo`. It must never be wired to a
  timer — `listUnfinishedRuns()` has no age filter, so running it mid-flight
  would kill a live run.

