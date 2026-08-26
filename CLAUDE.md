# Scyne Requirements Generator — CLAUDE.md

This document is the orientation guide for anyone (Claude included) working on this repository. Read it before making changes.

## Answer concisely

Keep replies short and on point. Lead with the answer, name the file and line,
skip the preamble and the recap. Explain the mechanism only when it changes what
the reader does next. Long, structured write-ups are for when they are asked
for — not the default.

## What this project is

A local end-to-end workflow that turns a client's raw discovery artefacts
(meeting transcripts, SOP/policy docs, UI screens, notes) into a delivery pack.

It works at **two levels**, and getting this distinction right is the thing
everything else hangs off:

**PROJECT level — describes the CLIENT ORGANISATION. Generated once; every
feature reads it.**

1. A **Business Capability Map + L1/L2/L3 Process Model**, derived from every
   document the client has given us, across all their features. Published to its
   own Azure DevOps wiki page per project.
2. An **evidence-traced persona set + a journey map per persona**, published to
   one wiki page per project — plus `personas.json` and `journey-map.json`,
   which are a **build contract for the companion app**. Needs (1): journey
   stages align to the capability model's L1 lifecycle phases.

**FEATURE level — describes ONE slice of work. Repeated per feature.**

3. A **wiki-ready Product Summary** (11-section markdown) and a set of
   **Azure DevOps work items**, one per story, created under an optional parent.
4. A set of **UI mockups** (wireframes) — one screen specification rendered as
   self-contained themed HTML pages, one per screen, each carrying its error /
   empty / blocked states and tracing back to the stories and capabilities it
   realises. Local artefacts; they appear on the companion app's **UI** tab.
5. A **Salesforce Data Model** (objects, custom fields, Mermaid ER diagram),
   published to its own wiki page.
6. A **Salesforce Service Cloud Solution Architecture Document**
   (capability-to-component map, Flow/LWC/Apex inventory with a justification per
   custom component, integration interface catalogue, ADRs, architecture
   diagrams), published to its own wiki page.
7. A **test pack** (executable test cases, requirements traceability matrix,
   coverage gap analysis, optional CSV/Gherkin exports), published to its own
   wiki page.
8. Optionally, a **Salesforce Solution Design Document** (declarative-first
   component design, Mermaid flow diagram) — a narrower deliverable that overlaps
   (6). Most features need only the architecture.

**PROJECT level again — the deliverable.**

9. A **companion app** — ONE self-contained, interactive HTML page **per
   project**, assembling everything the pipeline has produced. Project tabs
   (personas, journeys with a satisfaction chart, capabilities, process model)
   plus feature tabs (product summary, stories, UI, data model, architecture,
   test cases) that open on a grid of feature cards and drill into one feature's
   document. WCAG 2.0 AA verified.

### Why UI mockups run at position 4

Deliberately ahead of the data model: a client wants to see screens before
committing to a schema. The cost is real — the first pass has no API names,
picklist values or catalogued failure states — so `mockups.json` records which
inputs it had in `generatedFrom`, each screen page says "designed without: …",
and the staleness check offers a refresh once the data model and test pack exist.

### What gates on what

Stages 1 and 9 have no prerequisite. Stage 2 needs stage 1. Stage 3 needs
nothing. Stages 4–8 each need that feature's **Product Summary only** — they
consume each other's output when it exists and say so in their own documents,
but never block waiting for it.

> **Solution design (8) vs solution architecture (6)** are two different
> deliverables that may both exist for one feature. The Architecture Lead runs
> `solution-design-document` in `solutions/Design/`; the Solution Architect runs
> `salesforce-service-cloud-architecture` in `solutions/Architecture/`. Their
> issue title prefixes share their first two words, so the Delivery Lead must
> read as far as `design` / `architecture` before routing.

### Two things the chat does

The chatbot is not only a way to *run* stages. It also **changes** what they
produced: "add an SLA breach field to the data model", "reword story 2.4.1.3",
"the personas are too generic". That is the **revision flow** — a full agent
round-trip to the specialist that owns the artefact, which revises rather than
regenerates, raises its own approval gate, and on approval updates the existing
wiki page rather than creating a second one.

The user drives everything from a Scyne-branded chatbot UI. The chatbot does not do the work itself — it posts a workflow to the orchestrator, which runs the agent org on the local machine via Claude Code. Every stage raises its own human approval gate, and the stages that publish do so after it. See **How it runs** below.

> **Diagrams need no rendering.** Azure DevOps wiki takes **markdown
> natively** and renders ` ```mermaid ` fences itself, so there is no
> storage-format conversion, no `npx @mermaid-js/mermaid-cli` PNG pass, and
> nothing to attach. That entire chain existed for Confluence and is gone with
> it — see `scripts/legacy-atlassian/README.md` for what it was and the two
> lessons that came out of it.
>
> **Publishing goes through the Azure DevOps MCP**, configured in `.mcp.json`
> with the PAT read from the root `.env` as `${MCP_TOKEN_FOR_AZURE}` — never
> inlined, because that file is committed and a PAT in it is a PAT in the git
> history. `scripts/ado-publish.mjs` and `scripts/ado-workitems.mjs` are the
> REST equivalents, kept as fallbacks. The publish prompt reaches for the first
> when a document exceeds about 40 KB — `wiki_upsert_page` takes the page body
> as a `content` STRING parameter, with no publish-from-file form, so the whole
> document must travel through the agent's context to reach it. Passing 110 KB
> that way is measured to fail (run SCY-6: $2.73, no page).
>
> **Two scopes, and a 401 that lies.** The PAT needs `vso.wiki_write` AND
> `vso.work_write`. Azure DevOps answers a MISSING SCOPE with **401**, not 403 —
> so a wiki call failing beside a working project call means a scope, not a bad
> token. `node scripts/ado-publish.mjs --verify` says which.
>
> **The PAGE goes through the MCP; the BACKLOG does not.** The publishing
> agent calls `wiki_upsert_page` and stops there. The work items are created by
> the step after it — an `exec` running `scripts/ado-workitems.mjs` — and the
> publish prompt now says, in as many words, not to call `wit_work_item_write`.
>
> That split is the whole lesson of SA-Power-Networks / CRM-Management: 45
> stories, the wiki page published cleanly, **zero** work items, and the agent's
> turn finished normally, so the run recorded `succeeded`. Only
> `verify-published.mjs` caught it, one step later, with the stage already paid
> for. An exit code says a model stopped talking; it has never said the work
> happened, and 45 sequential tool calls in one turn is where it stops.
>
> A step cannot half-finish quietly (non-zero exit blocks the issue with the
> real stderr), it is idempotent (`adoId` is written back per story, so a re-run
> UPDATES rather than duplicating a client's backlog — the one failure here that
> re-running cannot undo), and it discovers the work item type itself. The
> prompt half was deleted rather than kept as a fallback: an instruction a model
> may or may not follow, running beside a script that always does, is how you
> get 90 work items instead of 45. `check-workflows.mts` asserts both halves.
>
> It needs no `--summary-url`: that URL does not exist when the command is
> compiled, so the script reads it back out of the `ado.<artefact>` record the
> publish step wrote moments earlier — which is why the publish prompt now
> insists on the `url` field and not the path alone.
>
> **An optional param reaches an `exec` step through the environment**, as
> `SCYNE_PARAM_<NAME>`, never as a `{placeholder}`: `interpolate` THROWS on a
> placeholder the issue does not carry, so `--parent {adoParentEpicId}` would
> block every run that sets none. That is the same trap that broke every
> requirements publish once already, and why `ensureAdoProjectStep` restricts
> itself to `{project}`.
>
> **The work item type is a PARAMETER, because no MCP tool lists them.** None of
> those 40 can enumerate a project's work item types, and the name depends
> entirely on the process template: "User Story" exists only under **Agile**,
> while **Basic** has Epic → Issue → Task with no User Story at all — so an
> agent guessing a familiar name fails every story at once, after the gate was
> approved and the page already published.
>
> It is now **per project**, not per install: `ado_target.workItemType` on the
> project ROW (`projects.ado_target`), written when the project is created and
> confirmed to exist BY NAME at that moment. New projects use the Agile
> template and therefore `User Story`, which is what the BA's house style has
> always described; SAPN predates this and is backfilled to Basic / `Issue`.
> `npm run ado:verify` and the approval-time check both still confirm the exact
> name before anything runs. `ADO_WORK_ITEM_TYPE` is retired.
>
> `scripts/ado-workitems.mjs` remains the deterministic fallback — it discovers
> the type itself, refuses to write a description still containing
> `{{PRODUCT_SUMMARY_URL}}`, and writes the created ids back so a re-run cannot
> duplicate a backlog.

## How it runs

The user drives everything from a Scyne-branded chatbot UI. The chatbot does not
do the work itself — it posts a **workflow** to **`@scyne/orchestrator`**
(`packages/orchestrator/`), which runs the Scyne agent org on the local machine
via Claude Code.

There is no Delivery Lead routing layer any more, and no Paperclip. A workflow
names its own assignee, so the chatbot's title is mapped straight to a workflow
key and the engine takes it from there.

```bash
npm run dev          # orchestrator on :3100 (console at /orch), chatbot on :5173
```

| | |
|---|---|
| **Console** | `http://127.0.0.1:3100/orch` — **sign in**, then: start a run, runs with live transcripts, issues that **drill in** to their activity, work products, gates, cost and **Pause / Stop now / Cancel**, pending gates with approve/reject, a top-down **org chart with live agent state**, an editable **Skills** inventory, **editable agent instructions**, budgets, config, health — and below a divider, the administration tabs: **Organisations**, **Users**, **Projects**, **Spend**, **Audit** |
| **API docs** | `http://127.0.0.1:3100/docs` — generated from `openapi.yaml`, which is diffed against the router in both directions by a test |
| **Chatbot** | `http://127.0.0.1:5173` |

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

### Agents

Twelve, addressed **by key** (`ba`, `dataModeler`, `capArchitect`, …) — there are
no hired UUIDs and no `ids.json`. The org chart in `orchestrator.config.ts` is the
source of truth and is reconciled into the database on every boot.

Each worker's system prompt is `agent-instructions/<agent>.thin.md` — domain only.
No API calls, no status transitions, no phase detection, no idempotency markers:
the engine does all of it. `mcpEnabled` is granted only to the agents that
publish.

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

### What the chatbot posts

Same endpoints as before; the mapping to workflows happens in
`scyne-chatbot/server/orchestrator.ts`.

```
POST /api/project/bootstrap            → baseline
POST /api/capability-map/trigger       → capabilities
POST /api/personas/trigger             → personas
POST /api/trigger                      → requirements
POST /api/ui-mockups/trigger           → ui
POST /api/data-model/trigger           → datamodel
POST /api/solution-architecture/trigger→ architecture
POST /api/test-cases/trigger           → qa
POST /api/solution-design/trigger      → design
POST /api/ui-agent/trigger             → app
POST /api/revise                       → revise-<stage>
```

That mapping parses a generated markdown description, which nothing type-checks.
`npm run check:routing` asserts every title and description shape routes to the
right workflow with the right params — run it after touching either file.

**Staging is shared with the CLI.** Every workflow's first step is
`node scripts/stage.mjs <project> ["<feature>"] <stage>` — the same code path
`npm run stage` uses, so the agent and the CLI cannot drift on what an input is.

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

## Folder layout

```
requirement-generator/                         workspace root (cwd for all agents)
├── CLAUDE.md                                  this file
├── .mcp.json                                  project-scope MCP config (atlassian)
│
├── projects/<project>/                        ===== PROJECT LEVEL =====
│   ├── description.md            PROJECT DEFINITION — who the client is, what they are
│   │                             regulated to do, who their customers really are. Read by
│   │                             EVERY skill before any discovery document.
│   ├── documents/                Client-wide policy, legislation, standards, current-state
│   │                             architecture. .md ONLY (uploads convert on arrival).
│   ├── original-files/documents/ Archived upload sources — moved, never deleted.
│   ├── design/                   ONE per project, because there is ONE companion app
│   │   ├── style-guides/theme.json   palette + wordmark + logo (npm run brand)
│   │   ├── personas/             optional persona artwork, <persona-id>.png
│   │   ├── journeys/             optional journey artwork, <persona-id>-journey.png
│   │   └── example-screens/
│   ├── .published.json           wiki page identity per artefact, so a REVISION
│   │                             updates the page instead of creating a second one.
│   │                             DERIVED — `projects.ado_target` is the record for
│   │                             the publish target; the per-artefact paths live here
│   └── solutions/
│       ├── Capabilities/         (Capabilities Process Architect)
│       │   ├── documents/project/<category>/     from projects/<p>/documents/
│       │   ├── documents/<feature>/<category>/   from every feature's discovery docs
│       │   ├── capability-reference/             optional house taxonomy
│       │   └── outputs/          capability-map.json, process-model.json,
│       │                         capability-process.md
│       └── Experience/           (Service Designer)
│           ├── documents/<scope>/<category>/     same two-level shape
│           ├── capabilities/                     from Capabilities/outputs/ (REQUIRED)
│           ├── productsummary/                   <feature>-product-summary.md each
│           └── outputs/          personas-journeys.md, personas.json, journey-map.json
│
└── projects/<project>/<feature>/               ===== FEATURE LEVEL =====
    ├── requirements/
    │   ├── SOP/            one or more .docx/.txt/.md — SOP / policy docs
    │   ├── Transcripts/    one or more .docx/.txt/.md
    │   ├── Notes/          optional — additional notes
    │   ├── UI/             one or more .png/.jpg mockups (client-supplied designs)
    │   ├── templates/      optional per-project house-style templates; override examples/
    │   └── project/        STAGED DOWN from the parent project (see below)
    ├── outputs/            extraction.json, product-summary.md, stories.json,
    │                       stories.md, gaps.md
    └── solutions/          each stage stages its own inputs
        ├── UI/             documents/ · project/ · personas/ · capabilities/ ·
        │                   productsummary/ · DataModel/ · Architecture/ · QA/ ·
        │                   outputs/mockups.json          (JSON only — never HTML)
        ├── DataModel/      productsummary/ · datamodel-reference/ · project/ ·
        │                   outputs/salesforce-data-model.md
        ├── Architecture/   productsummary/ · DataModel/ · landscape/ · project/ ·
        │                   outputs/solution-architecture.md
        ├── QA/             productsummary/ · DataModel/ · Architecture/ · project/ ·
        │                   outputs/test-cases.md (+ optional .csv / .feature)
        └── Design/         productsummary/ · DataModel/ · project/ ·
                            outputs/solution-design.md      (optional side stage)

├── datamodel-reference/    STATIC global Salesforce PSS / Social-Insurance object
│                           catalogue — seeds each feature's datamodel-reference/
├── skills/                 the company's skills — source of truth. Symlinked into
│   │                       .claude/skills/ by `npm run link-skills`
│   ├── capability-process-map/SKILL.md          (project)
│   ├── persona-journey-map/SKILL.md             (project)
│   ├── requirement-generator/SKILL.md           (feature)
│   ├── ui-mockup-generator/SKILL.md             (feature)
│   ├── salesforce-data-modeler/SKILL.md         (feature)
│   ├── salesforce-service-cloud-architecture/SKILL.md  (feature)
│   ├── requirements-test-case-generator/SKILL.md       (feature)
│   └── solution-design-document/SKILL.md        (feature, optional)
├── generated-apps/<project>/       ONE page per project
│   ├── index.html
│   └── mockups/<feature>/          one page per screen + index.html
├── examples/               gold-standard reference docs — house style for the BA; the
│                           FALLBACK when a project has no requirements/templates/
├── agent-instructions/     one <agent>.thin.md per worker — domain-only system prompts,
│                           read from disk at spawn time. legacy/ holds the retired
│                           Paperclip-era JSON bundles.
├── orchestrator.config.ts  org chart · adapters · budgets · workflows
├── orchestrator.workflows.ts  compiles scripts/pipeline.mjs into workflows
├── docs/superpowers/specs/ design specs
├── scyne-chatbot/          the React + Vite + Express chatbot — see its own CLAUDE.md
└── packages/orchestrator/  @scyne/orchestrator — the engine, HTTP API and console
```

### Read-down: what a feature sees of its project

Every feature stage stages the parent project's material into its working folder
before invoking its skill. It is opportunistic — a project with nothing generated
stages nothing extra and every feature stage still runs.

```
projects/<project>/documents/*.md                       → <work>/project/documents/
projects/<project>/solutions/Experience/outputs/*       → <work>/project/  (UI: personas/)
projects/<project>/solutions/Capabilities/outputs/*     → <work>/project/  (UI: capabilities/)
```

`description.md` is **not** copied — every skill reads it in place from its stable
path, and duplicating it into eight working folders would only create drift.

The point is that a feature is written in the client's terms rather than in
isolation: the BA reuses the project's persona names verbatim instead of coining
new ones, the Data Modeler names fields in the client's vocabulary, the QA
Architect knows which permission sets each case runs as.

### Read-up: what a project stage sees of its features

A project stage reads the project's own `documents/` **and every feature's
discovery documents**, tagged by scope:

```
documents/project/<category>/     client-wide — outranks any single feature's view
documents/<feature>/<category>/   one folder per feature
```

That is deliberate. A client's capability map should cover all the work
discovered so far, not only what happened to be uploaded at project level — and
it means a project whose documents all live under features keeps working with no
manual migration. Deduplicate by what the organisation does, not by feature: a
capability exercised in three features is ONE capability citing all three.

## Configuration

`orchestrator.config.ts` is the whole of it — the org chart, the adapter
registry, the defaults, and the workflows compiled from `scripts/pipeline.mjs`.
It is reconciled into the database on **every** boot, so the file is the source
of truth and cannot drift from what is running.

**Adapters.** `claude_local` (Claude Code), `codex` (Codex CLI), `gemini` and
`azure_foundry` (both loop-driven). `SCYNE_ADAPTER` picks the org-wide default;
`scyne adapter set <name> --project <p>` overrides it per project, and an agent
or a step can pin its own.

`codex` is registered when the binary is on PATH — auth is `codex login`, not an
API key, so there is nothing in the environment to detect. Install with
`npm i -g @openai/codex && codex login`.

`CODEX_MODEL` is only read when the org-wide default adapter is `codex`
(`SCYNE_ADAPTER=codex`) — it names the model `codex exec` is called with
(`--model`). It must be one this account actually serves; naming one it does
not is how an entire org's runs die on their first request.

**Setting it is what makes Codex runs costable.** A price needs a model name,
and the Codex transcript carries none — verified against a real capture, whose
events are `thread.started`, `turn.started`, `item.completed`, `turn.completed`
and `error`, with no model field anywhere. So the only record of what a run was
billed at is what `resolveRuntime` resolved, written to `runs.model` for exactly
the reason 004 wrote `runs.adapter`. Leave `CODEX_MODEL` unset and Codex still
runs — but every run shows `—` for cost, and no cost budget can fire on it.

> Current Codex models are **gpt-5.6-sol** (detail and polish), **gpt-5.6-terra**
> (the everyday workhorse) and **gpt-5.6-luna** (fast and cheap). **gpt-5.4 and
> gpt-5.4-mini retire from Codex on 31 August 2026**; gpt-5.2 and gpt-5.3-codex
> are already deprecated there. `scyne models list` flags both states — a
> retired model is not a slow run, it is every run failing on its first request.

> **Codex reports no cost — so we compute one, and label it.** `core/usage.ts`
> still records `total_cost_usd` verbatim from Claude Code's result event into
> `runs.cost_usd`, which continues to mean REPORTED BY THE CLI and nothing
> else. Codex emits token counts and no dollar figure, so since migration 007 a
> Codex run is priced by `priceRun()` from the `model_prices` table and stored
> in **`runs.est_cost_usd`**, with `runs.cost_source` recording which of the two
> a reader is looking at. Totals read `$4.10 reported + ~$1.23 est` rather than
> being merged — a single figure cannot be audited, because nobody reading it
> can tell which half came from a vendor's billing and which from a price table
> somebody typed.
>
> **A cost budget now fires on the estimate.** It could not before, which meant
> moving the org onto Codex silently removed the dollar ceiling from every
> agent. The blocking comment says the figure was estimated and names the model
> — being stopped by an arithmetic nobody can see is worse than not being
> stopped. Token and duration ceilings are unchanged.
>
> **A model with no published price stays unpriced** — `—`, never `$0.00`,
> which would read as a run that cost nothing.
>
> **A run is attributed to its project at CREATION.** `002_platform` added
> `issues.project_id` / `issues.feature_id` saying "cost per project is a
> group-by once this exists" — and then nothing ever wrote them, for months.
> `/spend?by=project` joins through those columns, so every row came back
> `project_name: null`: ONE anonymous row holding the whole installation's
> cost, by project, by feature, for every run ever recorded. The project was
> never missing — it sat in `issues.params` as jsonb, because that is what the
> workflow is parameterised by. `repo.createIssue` now resolves it into the
> foreign key, by name within the company, and `008_issue_project_backfill`
> lifts the history. A name that resolves to nothing leaves a null rather than
> guessing, and the issue is still created: the tree and the database do
> disagree (a `reset` clears one and leaves the other), and an unattributed run
> is a gap in a chart where a refused run is somebody's afternoon.
>
> It survived that long because every spend test seeded `project_id` by hand
> with an `update`, exercising the report and never the path that was missing.

There are no agent UUIDs to keep in sync, no placeholder swap, and no
`.bootstrap/ids.json` — all of that belonged to Paperclip's hire flow and is
gone. Agents are addressed by key:

| Key | Agent | Bundle | MCP |
|---|---|---|---|
| `ceo` / `pm` / `businessLead` | CEO, Delivery Lead, Business Lead | — | — |
| `archLead` | Architecture Lead | `architect-lead.thin.md` | yes |
| `ba` | BA | `ba.thin.md` | yes |
| `qaArchitect` | QA Architect | `qa-architect.thin.md` | yes |
| `capArchitect` | Capabilities Process Architect | `capabilities-process-architect.thin.md` | yes |
| `serviceDesigner` | Service Designer | `service-designer.thin.md` | yes |
| `dataModeler` | Data Modeler | `data-modeler.thin.md` | yes |
| `solutionArchitect` | Solution Architect | `solution-architect.thin.md` | yes |
| `uxDesigner` | UX Designer | `ux-designer.thin.md` | no |
| `ui` | Developer | `ui.thin.md` | no |

The Delivery Lead, CEO and Business Lead exist for the org chart only — no
workflow assigns to them, because a routing layer that reads a title to create
one child issue is what the workflow key replaced.

**Budgets** are a ceiling, not a target: 10M tokens / $15 / 45 minutes per agent
run. The one measured requirements run took 25 minutes and $3.19. A run that
breaches the duration limit is killed (SIGTERM, then SIGKILL); token and cost
limits are checked once the final `result` event lands and flag the run
`over_budget`.

> **The token ceiling counts cache reads at full weight, so it is a runaway
> backstop rather than a real limit.** Codex reports `input_tokens` as the
> total WITH cached tokens in it, and `core/spawn.ts` adds that figure raw —
> so what the ceiling actually measures is context size times the number of
> model round-trips, not how much unique material the agent read. Measured: a
> 14-minute persona run reported 1,995,078 input tokens of which **1,906,560
> were cache reads**, crossed the original 2M ceiling by 2%, and blocked an
> issue whose outputs were already written and had passed their validator. The
> same run cost $1.1592 — 8% of the dollar ceiling, because cached tokens
> price at a tenth of fresh ones. The dollar limit is the one that means
> something; the token limit is set at 10M so it does not fire first.

**Reported cost is reported; estimated cost is labelled.** `runs.cost_usd` is
read straight off the CLI's own final `result` event and recorded verbatim, so
a figure in that column is always the CLI's arithmetic rather than ours. What
Codex changed is that there IS no such event — so `runs.est_cost_usd` holds our
own figure, computed by `priceRun()` from `model_prices`, in its own column,
never merged into the reported one. `runs.cost_source` says which applies.

The price table lives in the database rather than in code, so it can be
corrected without a deploy:

```bash
scyne models list                                      # catalogue, retirements flagged
scyne models set gpt-5.6-terra --input 2 --output 12   # correct one by hand
scyne models proposal                                  # a proposed table, as a DIFF
scyne models apply                                     # superadmin only
```

**A refresh is a proposal, never a write.** Rows may come from an agent that
read the vendor's pricing page, from a script, or from a person pasting a
table; they are validated (finite, non-negative, under a sanity ceiling, no
duplicates) and stored with the diff they would apply. A superadmin applies
them. A model that hallucinates a rate must not be able to change what every
run in the install is billed at, or trip every cost budget at once. An omitted
field means "leave it alone" rather than "clear it", so a refresh that forgets a
column cannot silently wipe every cached rate — and that rule holds for
`models set` too, which used to clear the cached rate of any model whose input
rate you corrected.

> **Rows are canonicalised at the HTTP boundary, and a row naming no rate is
> refused.** `input_per_mtok` and `inputPerMTok` both work. They did not: the
> proposal path stored rows verbatim and read snake_case only, so a refresh
> written the way every other write endpoint accepts was taken with 200,
> reported "it changes nothing", and applied as a no-op answering
> `applied: 1` — the whole feature, inert. The sanity ceiling was reading the
> same absent key, so it was not checking those rows either.

**Storage** is PGlite at `.orchestrator/pgdata`, with raw run logs as JSONL at
`.orchestrator/runs/<issueId>-<stepIndex>.jsonl`.

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

## The Skills

Eight registered company skills live under `./skills/<slug>/SKILL.md`. Each worker
invokes its skill **by name** (never by path). Claude Code discovers them from
`.claude/skills/`, so each one is symlinked there by **`npm run link-skills`** —
symlinks, not copies, because a copy silently drifts from the source (this had
already happened once: a stale 157-line copy of a 199-line skill). `.claude/` is
gitignored, so every fresh clone needs that command, and a clone that skips it
fails every run with `Unknown skill: <slug>`.

Editing a skill is editing its `SKILL.md` — there is nothing to re-register.
Do it on disk, or in the console's **Skills** tab, which also answers *which
agent invokes which skill*: that mapping is derived by walking every workflow's
agent steps (`step.agent` falling back to the workflow's `assignee` — the
engine's own resolution), so it can never disagree with what actually runs.

It reads in **both directions**, from one `/skills` fetch, so the inverse cannot
drift from the forward mapping:

| Where | Shows |
|---|---|
| **Skills** tab | each skill → the agents that invoke it, each linking to that agent |
| **agent page** | *Skills it invokes* → every skill, and the workflows it is invoked from, each linking to that skill |
| **org chart node** | the skill that agent invokes, under its key (`+N` when it owns more than one) |

An agent can own several skills and a skill can be invoked from several
workflows — `capArchitect` reaches `capability-process-map` through
`capabilities`, `revise-capabilities` **and** `baseline` — so both sides list
everything rather than collapsing to one name. An agent with assigned work but
no skill (the Developer, whose `app` workflow is a renderer) says so
differently from one with no work at all (the CEO, Delivery Lead and Business
Lead).

The tab flags the two states worth catching early:

- **`missing`** — a workflow invokes a skill with no `SKILL.md`. Every run of
  that stage spawns, reaches the invocation and dies with `Unknown skill:
  <slug>`, so it costs a run to discover. Saving in the editor creates the file.
- **`unused`** — a `SKILL.md` no workflow names. Either a stage lost its `skill`
  or the file is left over.

`skillsDir` in `orchestrator.config.ts` points at **`skills/`**, the source of
truth — not `.claude/skills/`, which is the directory of symlinks pointing here.
Saves are written through `realpath` and then temp-file-plus-rename, because
renaming *onto* a symlink replaces the link with a regular file and silently
severs it from the file the team maintains.

**Every skill has a `## Revision mode` section.** When the invocation supplies a
previous version plus a change instruction, the skill preserves everything the
instruction does not touch, applies the change and its genuine consequences, and
appends a `## Revision History` entry. The discipline is a small diff — a
regenerate-from-scratch defeats the approval gate that follows.

### PROJECT-level skills

**`capability-process-map`** (Capabilities Process Architect — `projects/<p>/solutions/Capabilities/`):
- Inputs: `documents/project/<category>/` (the project's own tree) and
  `documents/<feature>/<category>/` (every feature's discovery documents), plus an
  optional `capability-reference/` house taxonomy.
- Outputs: `capability-map.json` (L1–L4 hierarchy, current/target maturity,
  lifecycle stage), `process-model.json` (L1 phase / L2 step / L3 activity with
  actor, service tier, components, capability IDs), `capability-process.md`.
- No prerequisite. Publishes to its own wiki page
  (`/Scyne/<project>/Capability & Process Map`) on approval; a page only, never
  work items. Writes no HTML — the project's single page is
  rendered by `render-companion-app.mjs`.
- Deduplicate by what the organisation does: a capability exercised in three
  features is ONE capability citing all three.

**`persona-journey-map`** (Service Designer — `projects/<p>/solutions/Experience/`):
- Inputs: the same two-level `documents/` tree, plus `capabilities/` (**required** —
  journey stages align to the L1 lifecycle phases) and each feature's product
  summary (optional).
- Outputs: `personas-journeys.md`, plus `personas.json` and `journey-map.json` in
  the shape the companion app consumes.
- The discipline is evidence: every persona and pain point cites its source, and
  inferences are labelled. Three evidenced personas beat seven invented ones.
  Deduplicate by PERSON, not by feature.
- The two JSON files are a build contract, so the agent must pass
  `node scripts/validate-experience.mjs <project>` before raising its gate.

### FEATURE-level skills

**`requirement-generator`** (BA — `requirements/`):
- Inputs: `requirements/{SOP,Transcripts,Notes,UI}/` plus `requirements/project/`
  staged down from the project.
- Outputs: 5 files in the feature's `outputs/`.
- House style: `<process_number> As a <role>, I want <action>, So that <outcome>.`,
  Australian English, declarative AC bullets (not Gherkin), persona format
  `Full Name (ABBR)`.
- 11-section Product Summary, with placeholder text preserved verbatim in 3.3.1,
  7, 8, 9, 10, 11. (3.3.1 Data Model stays a manual placeholder — the Data Modeler
  publishes to a *separate* wiki page.)
- **It reuses the project's persona names verbatim.** Coining a new name for a
  persona the project has already evidenced is the most common way this pipeline
  produces documents that contradict each other.
- Reference files at `./examples/`; per-project overrides in
  `requirements/templates/` win per artefact.

**`ui-mockup-generator`** (UX Designer — `solutions/UI/`):
- Inputs: `documents/` and `productsummary/` (at least one required), plus
  `project/documents/`, `personas/`, `capabilities/`, `DataModel/`, `Architecture/`
  and `QA/`. Client-supplied designs in `requirements/UI/` are **authoritative**.
- Output: `solutions/UI/outputs/mockups.json` — screens, each with `realises`
  traceability and one or more `states`, from a fixed vocabulary of **13 block
  types**, plus `generatedFrom` recording which inputs were present.
- **The agent writes JSON only.** `render-mockups.mjs` owns every pixel, which is
  what keeps the screens matching the companion app's theme and identical
  run-to-run. A hand-written page is overwritten by the next render.
- **It now runs BEFORE the data model and test pack**, so those are usually
  absent on a first pass. Field labels come from the client's own words rather
  than an invented `Claim__c.Status__c`; states come from the acceptance criteria
  and the journey's pain points. The refresh once they exist is an ordinary
  revision.

**`salesforce-data-modeler`** (Data Modeler — `solutions/DataModel/`):
- Inputs: `productsummary/` + optional `datamodel-reference/` and `project/`. The
  Service Cloud catalogue, field-design rules and Mermaid ERD conventions are
  inlined as Appendices A–C.
- Output: `outputs/salesforce-data-model.md` — a 12-section Service Cloud design.
- Standard-object-first: `Ticket__c`/`Customer__c`/`Agent__c`-style inventions are
  ruled out against Case/Account/User before any custom object is proposed.
- **Replaced `datamodel-impact-analysis`**, retired. Features created before the
  change still carry `datamodel-impact.md`, so every downstream consumer reads
  *every* `.md` in `outputs/` rather than one fixed name.

**`salesforce-service-cloud-architecture`** (Solution Architect — `solutions/Architecture/`):
- Inputs: `productsummary/` (required) + `DataModel/`, `landscape/` and `project/`.
  Appendices A–E inline the capability catalogue, component-selection ladder,
  integration patterns, security/NFR guidance and Mermaid conventions.
- Output: `outputs/solution-architecture.md` — an 18-section SAD with several
  Mermaid diagrams, so Phase 2 renders **all** of them.
- Restraint about code is the core discipline: every Apex class and LWC carries a
  one-line justification for why Flow or standard configuration was insufficient.

**`requirements-test-case-generator`** (QA Architect — `solutions/QA/`):
- Inputs: `productsummary/` (required) + `DataModel/`, `Architecture/` and
  `project/`. Appendices A–D inline the test design techniques, coverage
  checklist, Salesforce-specific angles and export formats.
- Output: `outputs/test-cases.md`, plus optional `test-cases.csv` and
  `test-cases.feature`.
- Ambiguous or contradictory requirements are reported under **Requirement Quality
  Issues** with the interpretation used — never silently guessed.

**`solution-design-document`** (Architecture Lead — `solutions/Design/`, optional):
- Inputs: `productsummary/` + `DataModel/` + `project/`.
- Output: `outputs/solution-design.md` — declarative-first (OOB → low-code → code)
  component design and a Mermaid `flowchart`.

## The chatbot (`scyne-chatbot/`)

Local app: **React + Vite frontend on port 5173**, **Express backend on port 4000**. Vite proxies `/api/*` → backend.

### Setup

```
cp .env.example .env          # AT THE ROOT — there is no scyne-chatbot/.env
# edit .env: set GEMINI_API_KEY (Gemini 2.5 Flash, free key from aistudio.google.com/apikey)
cd scyne-chatbot
npm install
npm run dev                   # starts both vite + the api in one process via concurrently
open http://127.0.0.1:5173
```

> **One `.env`, at the workspace root.** Every process reads that file and no
> other — the orchestrator via `orchestrator.config.ts`, the chatbot via
> `scyne-chatbot/server/env.ts`, the scripts, and `.mcp.json`'s
> `${MCP_TOKEN_FOR_AZURE}`. The chatbot used to carry its own, because
> `import "dotenv/config"` resolves against `cwd` and `npm run chatbot` does
> `cd scyne-chatbot`: two copies of `ADO_ORG`, `GEMINI_API_KEY` and
> `WORKSPACE_PATH` that drifted, and one bug they hid — the PAT only ever
> lived in the ROOT file, so `adoVerify.ts` reported **`token present: false`
> on every approval** while the same token published fine from the agents.
> `env.ts` finds the root by walking up for `agent-instructions/` + `skills/`,
> so it is cwd-independent, and it is imported on line 1 of `index.ts` because
> ESM evaluates imports in order and `llm.ts` reads `process.env` at load time.
>
> **The chatbot's port is `CHATBOT_PORT`, not `PORT`.** One shared file feeds
> every process in the stack and `PORT` is a name half the Node world reads,
> so a value meant for the chatbot would be picked up by anything else started
> from it. `PORT` still works as a fallback — Docker and most PaaS hosts
> inject it, and neither is ours to change.
>
> Uncommented in `.env.example` = what an install actually needs (13 keys).
> Everything else is commented out with its code default named beside it.

### Backend endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/api/chat` | Proxies the conversation to Gemini, returns Anthropic-shaped blocks |
| **POST** | **`/api/projects`** | **Create a project**: folder tree, `description.md`, branding pulled from the client's website inline, **and the database row**. `409 exists` if the name is taken; `409 slug_collision` if the slugged name lands on a different, incomplete project |
| **POST** | **`/api/features`** | **Create a feature** under a project, on both sides. `400 reserved_name` for a name that would clash with a project folder or CLI stage keyword |
| **POST** | **`/api/upload/project`** | The wizard's untyped dropzone → `projects/<p>/documents/`, converted to markdown on arrival, original archived |
| **POST** | **`/api/project/bootstrap`** | `Set up project — <project>`: capability map, then personas, sequentially. `409 no_documents` |
| POST | `/api/capability-map/trigger` | `Generate capability map — <project>`. **PROJECT level, no feature.** `409 no_documents` only. Publishes to the ADO wiki |
| POST | `/api/personas/trigger` | `Generate personas — <project>`. **PROJECT level, no feature.** `409 no_capability_map` |
| POST | `/api/trigger` | `Generate requirements — …`. Feature level. `409 missing_inputs` if SOP/Transcripts/UI are empty |
| POST | `/api/ui-mockups/trigger` | `Generate UI mockups — …`. `409 no_documents` only. Publishes nothing |
| POST | `/api/data-model/trigger` | `Generate data model — …`. `409 no_product_summary` |
| POST | `/api/solution-architecture/trigger` | `Generate solution architecture — …`. `409 no_product_summary` only |
| POST | `/api/test-cases/trigger` | `Generate test cases — …`. `409 no_product_summary` only |
| POST | `/api/solution-design/trigger` | `Generate solution design — …` (optional side stage). `409 no_data_model` |
| POST | `/api/ui-agent/trigger` | `Build UI — <project>`. **PROJECT level.** `409 no_artefacts` — the page is progressive, so any single artefact is enough |
| **POST** | **`/api/revise`** | **Revise an existing artefact.** `{project, feature?, artefact, instruction}` → routes to the owner with the instruction verbatim. `409 not_generated`, `400 unknown_artefact` |
| **GET** | **`/api/documents?project=&feature=`** | **Every document at both levels**, with size, mtime, kind and the archived source each was converted from — plus the same staleness list, from one call. **`?excerpts=true`** attaches the opening of each markdown document; opt-in, because it is a file read per document and only the grid has anywhere to put it |
| **GET** | **`/api/documents/content?project=&feature=&path=`** | **One document's text**, for the preview. Refuses a binary file, a path outside `documents/`, and a climb out of the project — `400 bad_path` |
| **PUT** | **`/api/documents`** | **Replace one document** (multipart). Removes the old and its archived original FIRST, so the replacement keeps its own name instead of landing beside it as `handling (1).md` |
| **DELETE** | **`/api/documents`** | **Remove one document** and its archived original, on disk and in the database. `404 no_document`, `400 bad_path` for anything outside `documents/` |
| **GET** | **`/api/staleness/:project[/:feature]`** | Artefacts generated before one of their inputs last changed, by mtime against the shared pipeline graph |
| **GET** | **`/api/suggestions?project=&feature=`** | The composer's chips: 3–4 `{label, message}` computed from the graph and disk, so a chip can never 409 |
| POST | `/api/brand/extract` | Fetches a URL server-side, writes the **project's** `theme.json` + `brand-source.json`, re-renders the app if one exists |
| GET | `/api/companion-app/:project` | The project's page. **302s to the trailing-slash form** — the page links into `mockups/` relatively |
| GET | `/api/companion-app/:project/mockups/:feature/:file` | One rendered mockup page. `.html` only |
| GET | `/api/capability-map/:project[/:feature]` | Kept as an alias; redirects to the companion app |
| GET | `/api/preview/:project[/:feature]` | Registry entry for the iframe pane. Keyed by project; the feature form is an alias |
| POST | `/api/preview/:project/:feature/:action` | `start` re-renders the project's companion app; `stop` is a reported no-op |
| GET | `/api/status/:issueId` | Normalised view: tree + stage + activity + approvals + extracted links |
| POST | `/api/approve/:approvalId` | Resolves a gate; wakes the gate's own issue assignee. Atlassian auto-provisioning keys off the keys in the issue description |
| POST | `/api/reject/:approvalId` | Rejects a gate |
| POST | `/api/request-changes/:approvalId` | Reviewer feedback → comments it, re-fires the assignee to regenerate |
| **GET** | **`/api/issues`** | **Every issue in the company**, shaped like `scyne issues` — `5/6 gate`, target, control request, `needsHuman`. `?project=&feature=&status=&open=` |
| **GET** | **`/api/spend`** | **`?by=project\|feature\|user\|agent\|adapter\|model`.** Admin only upstream; the 403 is passed through, never collapsed to an empty table |
| **GET** | **`/api/actions`** | **The organisation's audit feed.** Admin only upstream, same 403 rule |
| GET | `/api/history` | All completed runs with their wiki + work item links |
| GET | `/api/runs/:issueId` | Compact agent run summaries for the run tree |
| GET | `/api/features` | `projects/<project>/<feature>/` on disk. Excludes the project's own folders (`solutions`, `documents`, `design`, …) |
| GET | `/api/project-description/:project` | Reads `projects/<project>/description.md` |
| POST | `/api/project-description` | Writes it. Rejects an unsafe name or a body under 40 chars |
| GET | `/api/artifacts` | The approval-card preview. `project` alone returns the project artefacts; `project`+`feature` adds that feature's |
| POST | `/api/upload` | Feature-level upload, routed into `requirements/<sub>/` via `fileRouter` |
| POST | `/api/ui-agent/comment` | Follow-up comment on the UI build issue |

> **The ROW is what a project IS. The tree is derived from it.**
>
> `POST /api/projects` writes the row **first**, and a failure to write it is
> **fatal** — `502 db_unavailable`, nothing created, no orphaned Azure DevOps
> project left in a client's organisation. Creating without a session is
> refused (`401`) instead of silently half-succeeding, which is what it used to
> do: `store.createProject` returned `skipped`, the tree was written anyway,
> and the caller got `ok: true` for a project no API could see.
>
> Everything below still WRITES to disk, and must: six skills read
> `projects/<p>/description.md` by that path, the renderer reads
> `design/style-guides/theme.json`, the publish scripts read `.published.json`.
> Those are DERIVED copies. Nothing DECIDES anything by reading disk any more —
> the existence check is `store.listProjects`, and the rule itself is
> `decideCreate` in `scyne-chatbot/server/names.ts`, extracted so it can be
> tested without booting a server.
>
> The history below is what that replaced, and is kept because the symptoms are
> the ones to recognise if any of it comes back.
>
> **Creation writes BOTH stores, and the web UI did not.** There are two
> records of what exists — the folder tree the agents read, and the database
> `scyne`, the console and every platform route read — and `cli/dual.ts` has
> written both since it was added, for the reason its own header gives:
> *"anything that CREATES something has to write to both, or the tool
> contradicts itself"*. The React wizard called only `/api/projects`, which
> wrote only the tree. So a project created in the browser existed for every
> agent and for no API, and every symptom surfaced somewhere else entirely:
>
> - the definition **silently failed to save** — `saveDescription` looks the
>   project up by name, does not find it, and returns
>   `{ok: false, reason: "no such project in the database"}` into a console
>   warning nobody reads, so the assistant goes on asking for a definition the
>   project visibly has;
> - **`/spend?by=project` filed every run under the anonymous row**, because
>   `repo.createIssue` resolves `params.project` into `issues.project_id` BY
>   NAME and there was no row to resolve to. The fix described above works; it
>   had nothing to find;
> - **`/projects/{id}/documents` was unreachable** — there is no id;
> - no membership or access control could attach to the project.
>
> `store.createProject` / `createFeature` / `createDocumentRow` /
> `deleteDocumentRow` are the chatbot's half, and all three upload paths — the
> project route, the feature route and the audio transcript — write a document
> row now as well. All of it is **best-effort and never fatal**, for the same
> reason `adoError` is: the tree, the definition and the branding are real and
> worth keeping. A failure is reported as `dbError` rather than logged, because
> everything that resolves a project by name stays empty until the row exists.
>
> **"What documents exist" is answered from DISK, by BOTH surfaces.** `scyne doc
> list` and the session's `/docs` read the same `/api/documents` the Docs tab
> does, so the two cannot disagree about what is there. They used to read the
> platform API's ROWS while the tab read the tree, which is precisely how one
> reported nothing for a project the other showed nine documents for. Each row
> carries `inDb`, and both surfaces name the count that is missing plus the
> command that fixes it — the difference is surfaced, never hidden.
>
> **`store.listDocuments` asks three questions, not two.** This feature's
> documents (`feature`), the project's OWN (neither flag), or every document at
> every level (`all`). Omitting a feature means `feature_id is null`, NOT "all"
> — and `available()`, which feeds the assistant's per-feature document counts,
> asked with no feature and then skipped every project-level row to count the
> feature ones. The loop always fell through, so the assistant was told every
> feature held zero documents while nine sat on disk under SAPN.
>
> **The SERVER writes the document row, and it is the only thing that may.**
> `cli/dual.ts` used to write its own, from the bytes read off the caller's
> machine, under a path computed before the upload — and both were wrong by the
> time it landed. The server converts on arrival and MOVES the source into
> `original-files/`, so the row held raw `.docx` bytes at a path naming a file
> that no longer existed: precisely the "`/docs` lists documents that are not on
> disk" state in the table below. With no `--as` it was wronger still — the CLI
> guessed `requirements/`, while the server's `routeFile()` infers `SOP/`,
> `Transcripts/`, `Notes/` or `UI/`.
>
> Only the server knows the converted name, so only the server can write the
> row; `uploadDocument` reports what the response says it did. Leaving both in
> place would have produced **two rows per CLI upload** — one correct, one
> naming a file the converter had already renamed. `cli/dual.test.ts` asserts
> exactly one write per upload and no `/documents` POST from the CLI.

### Conversation flow (Gemini, not Anthropic)

`server/llm.ts` uses **`@google/generative-ai` v0.21 with `gemini-2.5-flash`** (matches the compliance-app pattern). The system prompt is built fresh on each call — it scans `./projects/` for available projects + features and injects that list into the prompt, so the LLM always sees the current state of disk.

The bot follows this discovery pattern:

1. Greet briefly (no upfront listing).
2. When asked "what projects?" — list project names.
3. When asked about a project — list features under it.
4. When user picks a feature — confirm and ask to proceed.
5. When user confirms (any natural phrasing) — call `trigger_requirement_generation` with `{project, feature, ...}`.

The LLM's pipeline tools (plus `control_dev_server` / `comment_on_ui_build` for the live UI build):

- `set_target` — sets the chosen `{project, feature}` scope without firing anything. Lets the user pin a target before they're ready to run.
- `trigger_requirement_generation` — fires the requirements flow. Defaults from `.env` fill in everything except `project` and `feature`.
- `trigger_data_model` — fires the data model flow (`Generate data model — …`). Backend gates on `product-summary.md`; the bot offers to run requirements first if it's missing.
- `trigger_solution_design` — fires the OPTIONAL solution design side stage (`Generate solution design — …`). Backend gates on the data model; the bot offers to run it first if missing. Not part of the recommended order — offered only when asked for by name.
- `trigger_capability_map` — fires the capability map flow (`Generate capability map — …`). No prerequisite: it reads the same SOP/Transcripts/Notes as the BA. Backend only refuses with `no_documents` when the feature is empty.
- `trigger_solution_architecture` — fires the solution architecture flow (`Generate solution architecture — …`). Gated on the product summary only. **Distinct from `trigger_solution_design`** — if the user just says "do the architecture", the bot asks which one rather than guessing.
- `trigger_test_cases` — fires the test-case flow (`Generate test cases — …`). Gated on the product summary only; the data model and architecture enrich the pack when present.
- `trigger_personas` — fires the persona + journey flow (`Generate personas — …`). No prerequisite: it reads the same SOP/Transcripts/Notes as the BA. Its `personas.json` / `journey-map.json` feed the companion app.
- `trigger_ui_mockups` — fires the UI mockup flow (`Generate UI mockups — …`). No hard prerequisite: it needs the product summary *or* the discovery documents. **Distinct from `trigger_ui_build`** — mockups are wireframes of the client's future screens (UX Designer); the UI build renders the companion app page (Developer). If the user just says "do the UI", the bot asks which one.
- `list_documents` / `delete_document` — what a project holds, and removing one.
  Present in the chatbot AND in the `scyne` session, which dispatches the same
  `tool_use` blocks: an assistant that can list a project's documents in a
  browser and not in a terminal is two products. **Both surfaces confirm before
  deleting** — the model proposes, the person commits, because a sentence typed
  at a prompt is not consent to change what every later stage reads. There is
  deliberately no replace tool: a replacement needs a file from the user's own
  machine, so the prompt points at the Docs tab or `/replace <path> <file>`.
- `save_project_definition` — writes `projects/<project>/description.md` from the user's own words. The system prompt lists which projects have one and which do not, and tells the bot to ask once — never to block a run on it.
- `trigger_ui_build` — fires the UI flow (creates a `Build UI — …` issue assigned to the Delivery Lead). The Developer + UX Auditor chain runs from there.

The system prompt teaches the dependency chain (requirements → data model → solution design) so the bot proactively explains and offers the missing prerequisite rather than firing a stage that would just block.

### Frontend layout

- **Left panel**: chat with the LLM. Agent comments stream in as bubbles with the author label (e.g. `BA · SCY-2`). Approval gates render inline as a card with an expandable "Review what will be pushed" preview (Stories / Product Summary / Gaps tabs).
- **Right panel**: workflow status. Stage pill (queued → Delivery Lead triaging → BA generating → awaiting approval → pushing → complete), progress list of issues, autoscrolling activity timeline, links panel for the wiki page + work items.
- **Login gate**: the app shows a `Login.tsx` screen first, which authenticates against the **orchestrator's own user table** — the same accounts the CLI and console use. There are no demo credentials. The first account is created by `scyne init`, which claims the installation as its **superadmin**; everyone else is created with `scyne user create` or from the console. The session is an **httpOnly cookie** on the chatbot origin, never `localStorage` — a credential JavaScript cannot read is one an injected script cannot steal — and the chatbot forwards *that user's* token to the orchestrator, so a run started from chat records `issues.created_by`.
- **Session persistence**: `parentIssueId` is saved to `localStorage.scyne_parent_issue_id`. Refresh resumes the workflow.
- **Right-pane tabs**: `Activity` (live workflow status) and `UI` (iframes the generated app from `/api/preview/:project/:feature`). The UI tab unlocks the moment a generated app is registered.
- **Left rail**: `Chat` · `Docs` · `Issues` · `Spend` · `Actions` — the chatbot is a full
  client now, not only a launcher, so `/orch` is for installation admin (agents,
  skills, budgets, orgs) rather than for daily work. Selecting an issue in
  **Issues** sets the active issue and returns to Chat, where the Activity panel
  already renders one; `parentIssueId` therefore means *the issue being watched*
  rather than *the run this browser last started*. Spend and Actions are
  **hidden for a non-admin** — cosmetic only, because the orchestrator refuses
  `/spend` and `/actions` for them regardless, and that refusal is the boundary.
  A count badge on Issues tracks `in_review`/`blocked`/`paused` and polls every
  30s from whichever view is open, because its whole job is to interrupt.
- **Docs** is the document lifecycle: every document **grouped by the folder it
  lives in** — `Project › documents`, then `<feature> › SOP | Transcripts |
  Notes | UI` — each collapsible, each a **drop zone**, with **upload**,
  **replace** and **delete**, a **Table ⇄ Grid** toggle, filters (search,
  Folder, Type, Level), a **preview** of any document rendered as markdown, and
  — from the same fetch — the artefacts that now predate their inputs, as a
  checkbox list with one *Re-run selected* button. Nothing regenerates until it
  is clicked; a document change can invalidate five artefacts and an hour of
  agent time. Scoped to the pinned target, unlike Issues, and it carries its own
  `TargetPicker`: a drop zone for `SOP/` needs a feature, and sending someone
  back to Chat to choose one is how a working drop zone comes to look broken.

  **Grouped by folder rather than listed flat with a folder column**, because
  the folder is not a label — it is what the pipeline reads. The BA treats
  `Transcripts/` (the primary source of stories) differently from `SOP/`
  (context, explicitly NOT stories), the UX Designer treats `requirements/UI/`
  as authoritative, and a stage refusing with `no_documents` is nearly always
  one of these folders being empty. So an **empty folder is shown, not hidden**:
  its emptiness is the answer.

  **Dropping on a named folder cannot hit `ambiguous_kind`.** `routeFile`
  returns `ambiguous` only when no hint was supplied, and a folder IS a hint —
  so a `.docx` the chat attach button refuses uploads cleanly here.

  **The queue does not invent a phase boundary.** Upload and conversion happen
  in ONE request (the route converts on arrival, because every 409 gate counts
  `.md` and staging runs after that gate), so there is nothing to observe
  between them. Files upload SEQUENTIALLY — slower for a big drop, and what
  makes the queue truthful: one file in flight, the rest waiting, each ending
  as the name it converted to.

  **Disk is authoritative there and the row is reconciled alongside it**, in
  that order, because disk is what every stage reads. A delete takes the
  archived original in `original-files/` too — `convert-to-md.mjs` MOVES a
  source rather than deleting it, so removing only the markdown leaves the
  thing that produced it, and the next conversion pass puts the document
  straight back.
- **The preview iframe is same-origin.** `registry.json` stores an ABSOLUTE
  `devUrl` (`http://127.0.0.1:4000/…`) for the UX auditor's real browser, but
  every `/api/*` route needs the session cookie and **cookies are keyed by host
  with no regard for port** — Vite binds `[::1]:5173`, so the app is served from
  `localhost` and an iframe pointed at `127.0.0.1` carries no cookie and renders
  `{"error":"not_authenticated"}`. `PreviewPane` strips the origin so the iframe
  goes through the Vite proxy on whatever host is actually being viewed.
- **Comments render as markdown**: `MiniMarkdown` component handles headings, bullets, bold, inline code, fenced code blocks, and links (both `[label](url)` and bare URLs).

### Chatbot workflow defaults — there are none left

```
# DEFAULT_PROCESS_L3 / _L4 / _STARTING_STORY_NUMBER — parsed and then dropped
```

The block is empty, and both halves of that are deliberate.

**`DEFAULT_FEATURE_NAME` is deleted, not commented.** It was read by exactly
one route — `/api/trigger`, the requirements stage — and by nothing else, so
the feature display name in an issue title came from a global while every
other stage derived it from the feature FOLDER, at
`index.ts:468`, under a comment claiming *"same derivation as /api/trigger"*
that was not true. Set to the SADA-era label it shipped with, triggering
requirements for RTWSA/Appeals without an explicit name produced
`Generate requirements — Review & Verify Evidence (RTWSA/Appeals)` — a title
naming a **different client's feature**, on the one stage that publishes a
wiki page and creates the backlog. The LLM's tool schema described the field
as *"Override the default feature name"*, so omitting it was the normal case.
Both routes now derive it the same way, and the schema says what omitting it
does.

**The other three reach `issues.params` and stop.** They travel `.env` →
the issue description → `processL3` / `processL4` / `startingStoryNumber`, and
nothing reads them from there: no workflow step interpolates any of the three,
and the BA's generated prompt says only *"your inputs are staged, invoke the
skill"*. `requirement-generator/SKILL.md` does ask for them under `## Required
parameters`, but routes them via an `inputs/metadata.yaml` that nothing writes
— and then says the opposite anyway: *"The process model carries the real
L1/L2/L3 numbering; prefer it over inventing a process hierarchy."* Since the
capability map became a PROJECT stage, `process-model.json` is where story
numbering actually comes from.

They are commented out rather than deleted, and the two sites that rendered
them now handle absence: `llm.ts` lists only the defaults that are SET (an
unset one used to reach the model as the literal word `undefined`), and
`index.ts` writes `(not set)`, which `parseParams` already drops on shape — so
an unset default becomes an absent param, not the string `"undefined"` stored
in `issues.params`. Setting one still carries it through, unchanged.

The `DEFAULT_JIRA_*` / `DEFAULT_CONFLUENCE_*` / `DEFAULT_PARENT_EPIC_KEY` keys
that used to sit beside them were **Atlassian-era and read by nothing**; they
are gone, along with `CODEX_CLI` and the `PAPERCLIP_*` / `BETTER_AUTH_SECRET` /
`GEN_APP_PORT_*` block, which only `docker-compose.yml` still referenced.

**One Azure DevOps project per Scyne project.** ONE organisation (`ADO_ORG`)
holds everything; the PROJECT is created from the name the user enters, using
the **Agile** template, and recorded in **`projects.ado_target`** — org,
project, wiki, wiki id, process template and work item type.

> **That is a COLUMN, and it did not use to be.** It lived only in
> `projects/<project>/.published.json`, so a directory was the system of record
> for something the database owns — while `core/materialise.ts` says in as many
> words that "the store is the system of record now". `POST /api/projects`
> decided whether a project existed by calling `fs.access` on a folder and then
> reading that file, which is why pointing `DATABASE_URL` at a fresh Postgres
> produced a route that **refused to create projects the database had never
> heard of**, quoting an Azure DevOps target it could not see. Seven folders,
> zero rows, and the refusal named the folder.
>
> `.published.json` is still WRITTEN, and every publish still reads it by path
> — `ado-publish.mjs`, `ado-workitems.mjs --published-json` and
> `resolvePagePath` all take it from the materialised tree. It is derived from
> the column now rather than being the record.
>
> **Only the target moved.** The per-artefact page paths beside it
> (`ado.<artefact>.wikiPath` / `.url`) stay in the file, because an AGENT writes
> those mid-run and harvest brings them back — a column mirroring them would be
> stale from the first publish onwards. Set-up metadata and run output have
> different lifecycles, so they get different homes.
>
> Projects created before this carry their target on disk only:
> `npm run backfill:ado` prints a plan, `-- --apply` lifts it. A row that
> already has a target is never overwritten, even when the file disagrees — a
> stale `.published.json` from an old clone must not be able to redirect a
> client's publishing.
>
> `projects.theme` was the same bug with no symptom yet: a supported jsonb
> column since 002_platform that **nothing ever wrote**, so every project
> carried `{}` while its real palette sat in `design/style-guides/theme.json`.
> The create route patches it now.

There is deliberately **no `ADO_PROJECT`**. One target for the whole install is
exactly what this replaced, and a fallback to one would publish a client's
document into another client's project. A publish with no target STOPS and says
so.

The wiki path therefore loses its `/Scyne/<project>/` prefix, which only ever
existed to keep tenants apart inside a shared project:

| Level | Path |
|---|---|
| project | `/<artefact>` — e.g. `/Capability & Process Map` |
| feature | `/<feature>/<artefact>` — e.g. `/Appeals/Salesforce Data Model` |

> **A published page keeps its path.** `wikiPathTpl` decides a FIRST publish
> only; an artefact already recorded in `.published.json` republishes to its
> recorded `wikiPath` (`resolvePagePath` in `scripts/lib/ado.mjs`). This is
> what `.published.json` was always described as doing and did not do —
> `ado-publish.mjs` imported `readPublished` and then read `--path` alone,
> which was harmless only while the template never changed. It is also what
> lets SAPN keep its `/Scyne/SAPN/…` pages with no legacy flag anywhere: they
> are recorded, so they stay.

**Creation happens in the wizard, verification at the gate.** `POST
/api/projects` calls `server/services/adoProject.ts`, which resolves the Agile
template BY NAME (never a hardcoded GUID), creates the project, **polls the
operation to a terminal state**, creates the project wiki, and confirms the
work item type exists. Only then is `adoTarget` written.

The reasoning that used to make this "verify, never create" still holds — a
half-created project is worse to hand a client than a clear refusal — and is
why creation polls to completion and reports the operation's own failure text.
What changed is only WHERE: in the wizard, where the user is present and
nothing has been generated, rather than at an approval gate after a document
exists and a human has approved it.

A failure there is **not fatal**. The folder tree, definition and branding are
kept, the response carries `adoError`, and the project is left INCOMPLETE
rather than broken: re-posting `/api/projects` completes it instead of
answering `409 exists`. Nothing downstream may assume `adoTarget` exists.

**`/api/approve` still verifies and still never creates.** It reads the org and
project out of the parent issue description and calls
`server/services/adoVerify.ts`, which checks the project exists, the token has
the **wiki** scope, a wiki exists (and is unambiguous), and — for the
requirements flow — that there is a usable work item type. A failed check holds
the gate with `502 ado_target_unavailable` and says exactly what is wrong;
nothing is approved.

> The PAT needs `vso.project_manage` on top of `vso.wiki_write` and
> `vso.work_write`. The install's existing token already has it — measured: a
> create with a deliberately invalid name answers `400 TF50316`, not `401`.
> That same `TF50316` covers length, illegal characters and reserved names, so
> project names are validated BY ADO and its message is surfaced verbatim
> rather than re-implemented as a regex here. Note the wizard's own check is
> more permissive (it allows `&`), so a name can pass it and fail at creation —
> which is what the resumable path above is for.

## The Azure DevOps MCP

Project-scope, configured in `.mcp.json` at the workspace root:

```json
{
  "mcpServers": {
    "azure-devops": {
      "command": "npx",
      "args": ["-y", "@azure-devops/mcp", "Scyne-AI-Lab", "--authentication", "pat"],
      "env": { "PERSONAL_ACCESS_TOKEN": "${MCP_TOKEN_FOR_AZURE}" }
    }
  }
}
```

Organisation `Scyne-AI-Lab`, project `Scyne AI Project`. Microsoft's first-party
server in **PAT mode** — a configuration the client tested and published with,
rather than one researched here. It is also the only ADO MCP that has BOTH wiki
write tools and work item tools: the PAT-based third-party server
(`@tiberriver256/mcp-server-azure-devops`) exposes `get_wikis`, `get_wiki_page`
and `search_wiki` and no wiki writes at all.

**`${VAR}` is expanded by us on the Codex path.** Claude Code expands
`${VAR}` in `.mcp.json` itself. `readMcpServers` in `core/codex-runner.ts` does
not go through Claude Code — it parses the same file and re-encodes each value
as a `codex -c` TOML override — so without expansion a Codex run would hand the
MCP server the literal string `${MCP_TOKEN_FOR_AZURE}`, and every ADO call
would 401 with a credential that looks perfectly present in the config. Since
the whole org runs on Codex, that is not an edge case. A variable that resolves
to nothing is a hard error naming the variable and the file, because
substituting an empty string produces a 401 that reads like a permissions
problem.

The runner passes `--mcp-config <workspace>/.mcp.json --strict-mcp-config` for
any agent with `mcpEnabled: true`, and omits both for everyone else. Without
`--mcp-config`, a project-scope MCP needs interactive trust approval, which
cannot happen in `--print` mode. `--strict-mcp-config` keeps an agent from
inheriting whatever MCPs the developer happens to have configured at user scope.

## Common operations

### The three layers of instruction an agent receives

Worth knowing which file to open, because only two of the three are meant to be
edited:

| Layer | Lives in | Console |
|---|---|---|
| **Who it is** — scope, house rules, where its inputs are | `agent-instructions/<agent>.thin.md` | Org → agent → **Edit instructions**. Editable |
| **How it works** — method, output shape, `## Revision mode` | `skills/<slug>/SKILL.md` | **Skills** tab → the skill → **Edit**. Editable |
| **This task** — "your inputs are staged, invoke skill X, write to Y, do not call any API" | generated by `generatePrompt` / `revisePrompt` / `publishPrompt` in `orchestrator.workflows.ts` | **Config** → the workflow (or `#workflow/<key>`). **Read-only** |

The third layer is visible via **`GET /workflows/{key}`**, which is the only way
to recover it: the prompt reaches Claude Code on **stdin** rather than argv,
`GET /config` strips prompts from its summary, and `core/transcript.ts` has no
event kind for it — so after a run, what the agent was actually told is
otherwise unrecoverable.

It is deliberately **not** editable. These strings are compiled from
`scripts/pipeline.mjs`, which is what makes "add a stage, get a workflow for
free" true; an override would make one workflow hand-maintained while a later
pipeline change silently stopped reaching it. Domain instructions belong in the
skill, which is editable — the workflow page links straight to it.

### Edit an agent's instructions

Edit `agent-instructions/<agent>.thin.md`, **or edit it in the console** — Org →
pick the agent → *Edit instructions*. Either way the file is read from disk when
the agent is spawned, so the next run picks it up. Nothing to push, no bundle to
re-upload, no ids to look up.

The console writes through `PUT /agents/{key}/bundle`: temp file plus rename, so
an interrupted save leaves the previous instructions intact; a declared-but-
missing file is **created**, which is how the `System prompt file not found`
state is repaired without touching a terminal; and any path resolving outside
the workspace is refused (`bundlePath` is operator-typed free text, and this
endpoint writes to it). An edit cannot disturb a run already in flight — that
process was handed its prompt when it spawned.

`bundlePath` itself is editable on the agent's Runtime card. An agent with no
path runs on the bare workflow prompt and has nowhere for instructions to live,
so `PUT …/bundle` refuses it and says so.

Check what an agent will actually be handed:

```bash
curl -s http://127.0.0.1:3100/agents/dataModeler/bundle | python3 -m json.tool
```

or open the console's Org tab and click **instructions**.

The retired Paperclip-era JSON bundles are archived at
`agent-instructions/legacy/`. They are the only remaining record of the old Phase
2 publishing protocol, which the generated publish prompts were derived from —
which is why they were archived rather than deleted.

### Run a skill locally, without the orchestrator

The skills are ordinary Claude Code skills — you can invoke one directly in a
session at the workspace root, with no orchestrator, no chatbot and no agent. Two
things have to be true first:

**1. Discovery.** Claude Code reads `.claude/skills/<slug>/SKILL.md`, not
`./skills/`. Symlink them once per clone (`.claude/` is gitignored, so this does
not survive a fresh clone):

```bash
npm run link-skills        # symlinks every ./skills/<slug> into .claude/skills/
```

Symlinks, not copies — a copy silently drifts from the registered source. (This
had already happened once: `.claude/skills/requirement-generator` was a stale
157-line copy of a 199-line skill.)

**2. Staging.** Each skill reads from its working folder, which the agent
normally populates. `scripts/stage.mjs` does that step for EVERY stage,
replicating each agent's `agent-instructions/<agent>.json` Phase 1 step 2:

```bash
npm run stage                                  # every feature + which stages have run
npm run stage <project> <feature>              # status for one feature, and what's next
npm run stage <project> <feature> <stage>      # stage one stage, print its skill command
npm run stage <project> <feature> all          # stage every stage whose inputs are ready
```

### The pipeline, in order

The graph lives in **`scripts/pipeline.mjs`** — which stages exist, what level
each runs at, what each produces, hard-requires and opportunistically reads. The
CLI, the renderer and the chatbot server all import it, so a stage the CLI thinks
is ready is one the chatbot will run.

| # | Level | `<stage>` | Skill / script | Owner | Hard requirement |
|---|---|---|---|---|---|
| 0 | project | `extract` | `node scripts/extract-documents.mjs` (one `document-extract` agent per document) | Capabilities Process Architect | — |
| 1 | project | `capabilities` | `/capability-process-map` | Capabilities Process Architect | extracts |
| 2 | project | `personas` | `/persona-journey-map` | Service Designer | capability map |
| 3 | feature | `requirements` | `/requirement-generator` | BA | — |
| 4 | feature | `ui` | `/ui-mockup-generator` | UX Designer | product summary |
| 5 | feature | `datamodel` | `/salesforce-data-modeler` | Data Modeler | product summary |
| 6 | feature | `architecture` | `/salesforce-service-cloud-architecture` | Solution Architect | product summary |
| 7 | feature | `qa` | `/requirements-test-case-generator` | QA Architect | product summary |
| 8 | project | `app` | `node scripts/render-companion-app.mjs` | Developer | anything |
| — | feature | `design` | `/solution-design-document` | Architecture Lead | product summary |

`design` is an **optional side stage**, deliberately outside the numbered order:
a narrower, component-level deliverable that overlaps stage 6. Most features need
only the architecture. It is excluded from `all` for that reason — ask for it by
name when a client wants that level of detail.

**`ui` at position 4 is deliberate**, ahead of the data model. See *Why UI
mockups run at position 4* above.

### The `extract` stage — one agent per document, before the map reads any of them

`capabilities` used to read every `.md` a project has — client-wide documents
plus every feature's SOP/Transcripts/Notes/UI — into ONE agent's context. At
SAPN's real size that is ~986k tokens in a single call, which is expensive,
slow, and eventually simply will not fit. `extract` runs first (project level,
order 0) to fix that: one `document-extract` agent per document, each reading
**only its own document** and writing a small, structured `<hash>.extract.json`
to `projects/<project>/solutions/Extracts/` — eight lists (business functions,
process steps, actors, service tiers, components, maturity signals, lifecycle
phases, pain points), each item carrying `src` (the pages it came from) so a
later reduce can verify a claim without re-reading the whole document.
`capability-process-map` then reduces from these extracts instead of the raw
corpus — the method changed, the twelve-section document and both JSON output
shapes did not.

**There is no bypass.** Every project extracts at every size, including a
project with two documents. A size threshold ("only extract over N KB") was
considered and rejected: it would mean two code paths through the reduce that
must independently stay correct, a fixed cliff at which behaviour silently
changes, and a small project today that grows into the expensive path with no
warning. One path, always taken, is simpler to reason about and cannot bit-rot
on the branch nobody exercises.

**Extracts are keyed by the source document's content hash**, not by filename
— `scripts/extract-state.mjs`'s `extractPathFor` hashes the file and truncates
to 16 hex characters. Editing a document changes its hash, which means it now
asks for an extract nothing has written yet: it reads as `missing`, with no
separate invalidation step to keep in sync, and — critically — every OTHER
document's extract is untouched. A client replacing one SOP does not cost a
re-extraction of the other nineteen.

**Gates now refuse two different things.** `no_documents` (nothing uploaded)
and `documents_not_ready` (documents exist but have not finished extracting, or
one failed) are reported separately by `GET /api/extract-status/:project`,
because the fix is different: the first needs a document, the second needs
`node scripts/extract-documents.mjs <project>` to run or to be waited on.
Collapsing them into one `no_documents` would send someone to upload a file
that is already there.

**The spend gap.** The map phase (`extract`) is an `exec` step, not N `agent`
steps — the workflow engine has no fan-out primitive (`flow` exists but
parent-resume-on-child-completion is not implemented, and a workflow is
compiled at boot, before any document is known). So these ten, twenty or fifty
agent runs happen inside one `exec`, get no `runs` row each, **do not appear in
`/spend`**, and are not covered by the per-agent budget ceiling. Each extract
records its own `usage` (input/output tokens), so the spend is recoverable by
summing that field across a project's extracts — but it is not tracked the way
every other agent run is. Fixing this properly needs a fan-out primitive in the
engine; nothing here builds one.

**`src` is internal only.** It exists so a reduce can verify a claim against
the exact pages it came from — it must never reach `capability-process.md`,
`capability-map.json`, or anything a client sees. No footnotes, no
"(Workshop_Transcript.md, p.23)" in a delivered document.

**The `extract` workflow still raises a human approval gate.** Every stage the
compiler produces gets one — `gate` is baked into the generic
`exec → agent → exec → attach → gate` shape `orchestrator.workflows.ts` derives
from `scripts/pipeline.mjs`, and `extract` is compiled the same way as every
other stage. Extraction is mechanical (one document in, one small structured
file out) and fifty extracts are not something a human can meaningfully review
one by one — so this gate is friction with little value, not a safeguard. It is
flagged here as a known wart rather than special-cased away, because carving an
exception into the compiler for one stage is exactly the kind of divergence
that made hand-maintained workflows unreliable in the first place.

**`syncDown` does not recreate empty directories.** Blob storage has no concept
of a directory — it stores keyed objects, not folders — so a project restored
from blob after a fresh clone or a lost workspace comes back with every FILE in
place but without the empty scaffold folders nothing ever wrote to: an
untouched `requirements/UI/`, an empty `documents/` before the first upload,
and so on. Files themselves are unaffected; this was found live, restoring a
demo project onto a machine that had never held it. Something that expects a
directory to exist before it can write into it (a `readdir` with no
`{recursive: true}` mkdir first) is the failure mode to watch for.

**A `failed` document blocks its project, with no override.** A scanned PDF
with no text layer will never produce a usable extract — `document-extract`
has nothing to read — so it fails permanently, `extract-documents.mjs` exits
non-zero, and `capabilities` (which hard-requires every document ready) never
runs while that one file sits at `failed`. There is currently no "proceed
without it" escape hatch: the fix is to remove the document or replace it with
a text-bearing version. `solutions/Extracts/<hash>.extract.failed.json` names
the reason.

A full run, end to end:

```bash
# Project baseline — once per client. `baseline` runs both in ONE pass and
# prints the exact 6-step sequence; the two stages below remain for running
# either on its own.
npm run stage RTWSA baseline          # capability map + personas, one session

npm run stage RTWSA extract           # then node scripts/extract-documents.mjs RTWSA
npm run stage RTWSA capabilities      # then /capability-process-map in a Claude Code session
npm run stage RTWSA personas          # then /persona-journey-map

# Per feature
npm run stage RTWSA Demo requirements  # then /requirement-generator
npm run stage RTWSA Demo ui            # then /ui-mockup-generator
npm run stage RTWSA Demo datamodel     # then /salesforce-data-modeler
npm run stage RTWSA Demo architecture  # then /salesforce-service-cloud-architecture
npm run stage RTWSA Demo qa            # then /requirements-test-case-generator

# The deliverable — once per project, covering every feature
npm run app RTWSA
```

**A project stage takes no feature.** `npm run stage RTWSA capabilities` resolves
the LEVEL before the name, so the single trailing token is read as a stage rather
than a feature. The cost is that `capabilities`, `personas`, `app` and `all` are
not legal feature names — `POST /api/features` rejects them too.

Stage 4 (`ui`) needs two commands after the skill, both printed by the staging
output — the renderer, then the companion app so its **UI** tab picks the screens
up:

```bash
node scripts/render-mockups.mjs        RTWSA "Demo"   # validates the JSON, one page per screen
node scripts/render-companion-app.mjs  RTWSA          # UI tab now lists them
```

Two stages have a **validator that must pass** before the output is trusted; the
staging output prints them, and the agents treat a non-zero exit as a blocker:

```bash
node scripts/render-capability-map.mjs <project> --validate-only   # after `capabilities`
node scripts/validate-experience.mjs   <project>                   # after `personas`
```

`validate-experience.mjs` is the only guard between the Service Designer and a
companion-app build that may happen weeks later — `personas.json` and
`journey-map.json` are a build contract, not just a document.

### Clear the database and start again

```bash
npm run orch -- reset            # a PLAN — prints what would go, deletes nothing
npm run orch -- reset --yes      # do it: issues, comments, work products, gates,
                                 #   runs, budgets and the raw .jsonl logs
npm run orch -- reset --hard --yes   # also drop the agents and .orchestrator/overrides.json,
                                     #   then rebuild the org from orchestrator.config.ts
npm run orch -- reset --all --yes    # also users, projects, documents, installations
                                     #   and chats — the installation is then UNCLAIMED
```

The bare verb is a **dry run** — a half-remembered command cannot cost anyone
their history. Stop `npm run dev` first: the database is single-writer and the
CLI is refused while a server holds it.

> **It resets ONE organisation, not the database.** Every depth is scoped to
> the home company, so another organisation's projects, people and issues
> survive even `--all` — the plan lists the ones it will not touch, because
> "the installation is UNCLAIMED" reads like everything is gone. For a
> genuinely empty database, stop the server and `rm -rf .orchestrator/pgdata`.
>
> **`--hard` also detaches other organisations' issues from the agent rows.**
> The org chart lives in one company but every issue in the install is assigned
> out of it, so deleting those rows hits `issues_assignee_agent_id_fkey` the
> moment a second organisation exists. Measured before the fix: the reset
> aborted half-applied, having already deleted the superadmin, leaving an
> installation that could be neither used nor re-claimed. The whole reset is
> now one transaction, and the pointers are nulled rather than the issues
> deleted — they dangle either way, since the re-seeded agents get new ids.

**Skills need no reseeding — they are not in the database.** They are files
under `skillsDir`, and the agent-to-skill mapping is derived from the workflows
at read time, so a reset cannot lose them. (The schema does carry `skills` and
`agent_skills` tables from an earlier design; nothing in `src/` reads or writes
either one.)

Agents need no reseeding either: the org is reconciled from
`orchestrator.config.ts` on **every** boot, which is what makes `--hard` safe —
dropping the rows is how a hand-edited row or a stale overrides entry gets
discarded, not how an agent is permanently removed.

`rm -rf .orchestrator/pgdata` still works and additionally discards the
migration state, but it cannot run while a server holds the directory and it is
one mistyped path away from taking something else with it.

### Migrating a project created before the restructure

`personas`, `capabilities` and `design/` used to live under a feature.
`scripts/migrate-to-project-level.mjs` lifts them:

```bash
npm run migrate                    # dry run, every project
npm run migrate -- SAPN --apply    # do it, one project
```

It moves `<feature>/solutions/{Capabilities,Experience}/` and `<feature>/design/`
up to the project, archives a losing duplicate to
`original-files/superseded/<feature>/` rather than deleting it, clears the retired
per-feature `generated-apps/<project>-<feature>/` folders and their registry
entries, and lists any feature `Notes/` that read like client-wide policy so you
can move them to `documents/` by hand. It is idempotent and refuses to overwrite
an existing project-level artefact without `--force`.

### Conversion happens first

**Staging converts documents to markdown first.** The skills only read `.md`, so
a hand-placed `.pdf`/`.docx`/`.xlsx`/`.txt` under `requirements/` would otherwise
be silently invisible to the model. `scripts/convert-to-md.mjs` writes a sibling
`.md` for each (`Conceptual Data Model.pdf` → `Conceptual Data Model.md`). It
runs automatically as step 0 of every stage; `--no-convert` skips it, and it
also stands alone:

```bash
npm run convert <project> <feature>                        # convert only
npm run convert <project> <feature> -- --force             # re-convert
npm run convert <project> <feature> -- --keep-originals    # leave sources beside their .md
```

Same end state as the upload route: the markdown replaces the source in
`requirements/`, and the original is **moved** (never deleted) to
`original-files/requirements/<Sub>/`, so `requirements/` holds markdown only.

> **Both upload routes run it, and that is not a nicety.** Every stage's 409
> gate counts `.md` under `projects/<p>/`, and staging is step 0 of a workflow
> that the gate decides whether to start at all — so a `.docx` converted only
> at staging time is a `.docx` the gate refuses forever. `/api/upload/project`
> always ran the converter; `/api/upload` (the FEATURE route) did not, which is
> why three `.docx` uploaded to a feature produced `no_documents` on every
> retry while `/docs` listed all three. Both run it now.
>
> **The converter needs `markitdown-ts`, which is a declared dependency of
> `scyne-chatbot` and lives only in its `node_modules`** — `convert-to-md.mjs`
> resolves it from there, deliberately, so the root install stays lean and the
> two paths cannot use different versions. It was missing from that package for
> the whole of this repo's history, so conversion failed everywhere with
> `markitdown-ts is not installed` and every uploaded `.docx` stayed unreadable.
> A failure is now logged by the upload route rather than reported only in the
> `converted: false` field nothing reads.

It is idempotent (a second run reports `up-to-date`, and archives any source
still sitting beside its markdown), never clobbers a hand-written `.md` of the
same name (falls back to `<name>.<ext>.md`), and on a conversion failure leaves
the source untouched rather than writing a partial file or archiving something
that never converted. Images and audio are skipped by design — screens are read
as images, audio goes through Gemini transcription — and are never archived.

### Flags

| Flag | Effect |
|---|---|
| `--force` | re-seed reference catalogues that already hold curated files |
| `--no-convert` | skip the document → markdown pass |
| `--keep-originals` | leave converted sources beside their `.md` instead of archiving |
| `--from-requirements` | `datamodel` only — stage raw requirement `.md` instead of the product summary, for a feature that has not run the BA yet |

Outputs land at the same paths the agent would write, so the chatbot's approval
preview and every downstream stage still find them. What you skip by going direct
is the human approval gate and Azure DevOps publishing — those live in the
agents' Phase 2, not in the skills.

### Brand the companion app from a client's website

```bash
npm run brand -- <url> <project>            # writes design/style-guides/theme.json
npm run brand -- <url> <project> --dry      # print what it found, write nothing
```

Branding is **per project**: one project renders one companion app, so it carries
one palette. `scripts/extract-brand.mjs` fetches the page and its stylesheets and
extracts the brand colour (a CSS custom property literally named
`--brand`/`--primary` beats raw frequency, which in turn beats nothing), an accent
that is a genuinely different hue rather than a shade of the brand, the wordmark,
the font stack, and the logo — **inlined as a data URI**, because the rendered
page makes zero network requests and a linked logo would simply not load.

It writes two files: `theme.json` (what the renderer reads) and
`brand-source.json` (why each value was chosen, plus the runners-up). When a
colour is wrong, correct `theme.json` — do not re-run the extractor on the same
URL expecting a different answer.

It refuses to overwrite a hand-authored `theme.json` without `--force`. Sites that
build their CSS in the browser have nothing to read server-side; write the theme
by hand in that case.

The chatbot exposes the same thing two ways: the **New Project** wizard asks for
the website in step 1, and pasting a URL in chat ("brand it like acme.com") runs
`extract_brand` against the active project and re-renders the companion app if one
exists.

### Render the companion app by hand

```bash
node scripts/render-companion-app.mjs <project>                # full render
node scripts/render-companion-app.mjs <project> --no-diagrams  # skip mermaid (much faster)
open generated-apps/<project>/index.html                       # or just open the file
```

It takes a **project**, and renders every feature under it. It refuses only when
the project has produced nothing at all; a project with one capability map and
nothing else produces a valid page. Branding is data: drop a
`design/style-guides/theme.json` at the project and re-render.

```json
{ "brand": "#464e7e", "brandDeep": "#363c63", "accent": "#b4795a", "logoText": "Scyne" }
```

Never hand-edit the emitted `index.html` — the next render overwrites it.

### Create a project or a feature

From the chatbot, use the **New Project** wizard (header ✨) or just ask: "create a
new project", "add a feature to RTWSA". Both are also plain HTTP:

```bash
curl -sS -X POST http://127.0.0.1:4000/api/projects \
  -H 'Content-Type: application/json' \
  -d '{"project":"RTWSA","description":"Who the client is…","website":"https://rtwsa.com"}'

curl -sS -X POST http://127.0.0.1:4000/api/features \
  -H 'Content-Type: application/json' \
  -d '{"project":"RTWSA","feature":"Appeals & Reviews"}'
```

By hand on disk, if you prefer:

```bash
# Project
mkdir -p projects/<project>/{documents,design/{style-guides,example-screens}}
mkdir -p projects/<project>/solutions/{Capabilities,Experience}/outputs

# Feature
mkdir -p projects/<project>/<feature>/requirements/{SOP,Transcripts,Notes,UI,templates}
mkdir -p projects/<project>/<feature>/outputs
```

The `solutions/` working folders under a feature are created on demand by each
stage. No code change is needed — `/api/features` auto-discovers a new folder on
the next chat turn.

> **Project names take no spaces; feature names still do.** A feature is
> routinely "Interim Benefit" or "Appeals & Reviews" and always will be, so
> every generated command quotes BOTH `{project}` and `{feature}` — `swap()` in
> `orchestrator.workflows.ts` emits them already quoted, which is what keeps
> "add a stage to `pipeline.mjs`, get a workflow for free" true: a stage author
> cannot forget it. It was not always so, and an `exec` step runs through
> `child_process.exec`, i.e. `/bin/sh -c`, so an unquoted placeholder
> word-splits: a project called `SA Demo` reached `stage.mjs` as `SA` and it
> refused with `no such project: projects/SA`, while listing `SA Demo` as
> available two lines below.
>
> A NEW project name is **slugged rather than refused**: `SA Power Networks` is
> created as `SA-Power-Networks`, and the wizard says so live under the field
> before anything exists. The rule is unchanged — that name is also the Azure
> DevOps project, the wiki path segment and the `--project` argument on every
> verb, and it should not have to survive every future caller remembering — but
> nobody is asked to obey it.
>
> It used to be a refusal (`400 project_name_has_spaces`, carrying a
> hyphenated `suggestion` that the wizard threw away), and the wizard validated
> with the READ rule, which allows spaces. So the Next button lit up on a name
> the server was about to reject, one step later, with a fix it never applied.
>
> **`slugProjectName` / `isNewProjectName` in `scyne-chatbot/server/names.ts`
> are the authority.** The wizard imports them rather than carrying a fourth
> copy; `cli/dual.ts` keeps its own (it is dependency-free by design) and now
> APPLIES the slug too, because `scyne project create "SA Power Networks"` was
> refused outright while the web wizard created it happily.
>
> **A slug that lands on an existing INCOMPLETE project is refused**
> (`409 slug_collision`), naming both. `SA Demo` and `SA-Demo` are two
> different projects that already exist side by side in this repo, and
> "completing" a project rewrites its Azure DevOps target and its branding —
> so adopting one because a typed name happened to slug onto it would hand one
> client's tree another client's target, in a route that reports success.
>
> Reads are untouched: `SAFE_PROJECT` still admits spaces everywhere a project
> is READ, since projects with spaces already exist and refusing to open one
> would be worse than the bug this prevents.

**Reserved feature names:** `capabilities`, `personas`, `app`, `all`, `baseline`, plus the
project's own folder names (`solutions`, `documents`, `design`, `original-files`,
`outputs`). A feature by one of those names would be unreachable from the CLI and
would appear as a feature in the target picker.

### Start a run from the CLI

```bash
npm run orch -- run requirements --project SADA --feature interim-benefit \
  --adoOrg Scyne-AI-Lab --adoProject "Scyne AI Project"
```

Every `--key value` after the workflow name becomes a workflow param and reaches
the agent's prompt, so a stage needing extra context needs no code change. The
command starts the issue and advances it as far as it will go — which is to the
first gate — and prints the gate id and the command to approve it.

While `npm run dev` is running, use the HTTP API instead (PGlite is
single-writer):

```bash
curl -sS -X POST http://127.0.0.1:3100/issues -H 'Content-Type: application/json' \
  -d '{"workflow":"requirements","params":{"project":"SADA","feature":"interim-benefit","adoOrg":"Scyne-AI-Lab","adoProject":"Scyne AI Project"}}'
```

### Ship the `scyne` CLI to a user with no clone

```bash
npm run build:cli     # dist/cli/  — one file, no dependencies
npm run pack:cli      # …and dist/scyne-cli-<version>.tgz, ~21 KB
```

The user needs **Node 20+** and one of:

```bash
npm install -g ./scyne-cli-0.1.0.tgz                    # a tarball you hand over
npm install -g https://…/releases/…/scyne-cli-0.1.0.tgz # a GitHub release asset
npm install -g @scyne/cli                               # a registry, if you publish
cp dist/cli/scyne.mjs ~/bin/scyne                       # no npm at all
```

Then `scyne login --api-url https://…` and they are working. Nothing else is
installed — no engine, no PGlite, no workspace, no skills.

**Documents are managed from the CLI as well as the web UI**, through the same
routes, so neither can do something the other cannot:

```bash
scyne doc list [--all] [--category C]          # the rows, which now hold the CONVERTED markdown
scyne doc upload <file...> --as sop            # converts, archives the source, writes the row
scyne doc replace <path> <file>                # old and its archived original removed first
scyne doc delete <path...>                     # file, archived original, and row
```

and in the interactive session, `/docs`, `/upload`, `/replace` and `/rm`.

> **`doc delete` on a row whose file is not there retires the row anyway**, and
> says so. That is the exact state the old `doc upload` left behind — a
> pre-conversion path the converter had already renamed — so refusing would
> leave those rows undeletable by the only tool that lists them.

**It detaches cleanly because it was never coupled.** Every command goes over
HTTP to the same API the browser uses, and nothing in `cli/` has an npm
dependency — only `node:` builtins and global `fetch`. So "ship the CLI" is
bundling six files rather than extracting a subsystem, and the published
package declares **zero** dependencies: `npm i -g` on a locked-down machine
fetches nothing but the package.

**The stage list comes from the server, not from the package.**
`cli/stages.ts` reads `GET /config` — it used to `import … from
"../scripts/pipeline.mjs"`, the one line that required a checkout. Cutting it
is what makes the bundle standalone, but it is also the more correct answer:
"what can I run" is a fact about the server being asked. A CLI carrying its own
copy would answer for the version it was published at and **refuse a stage the
server had gained since** — the failure you least want in a tool distributed
separately from the engine it drives. Users do not have to upgrade in lockstep
with the server.

`level` is derived rather than declared: a workflow that interpolates
`{feature}` runs per feature. `params` comes from the engine's own scan of each
workflow's templates, so it cannot disagree with what the steps read — which is
also how `scyne run revise-<stage> --instruction "…"` now works at all, and how
a missing parameter is refused as a usage error instead of blocking mid-run on
`unknown placeholder`.

> **The build runs the artefact before packaging it.** Both failures it checks
> for have already happened here: esbuild HOISTS the entry's own shebang, so a
> `banner` adding a second one produced a package that installed perfectly and
> then failed every invocation with `SyntaxError` on line 2; and a bundle that
> is not `chmod +x` is not a command. Neither shows up until a user runs it, so
> `scripts/build-cli.mjs` asserts one shebang, sets the mode, and executes
> `scyne --help` — the one entirely offline command — before `npm pack` sees it.

> **A paste is one answer, not one answer per line.** Every prompt in the
> interactive session reads a single readline `line` event, which is right for
> a typed answer and wrong for a pasted one: a pasted paragraph is N events, so
> `/new` consumed one client description as its description, its website, its
> document paths and its first feature name — and the lines still left over
> fell through to the chat loop, where the assistant read each stray sentence
> as an instruction and created a feature for it. `cli/paste.ts` asks the
> terminal for **bracketed paste** (DECSET 2004) and strips the markers out of
> stdin BEFORE readline sees them, which is the only way to tell a pasted
> newline from a pressed Return — the bytes are otherwise identical, and Node's
> readline splits an insert on newlines and submits each piece. A multi-line
> block shows as `[Pasted text #1 +12 lines]` and expands back on Return; a
> paste never submits itself. Piped input is passed through untouched, so
> `printf '/use RTWSA\n/gates\n/exit\n' | scyne` still works. `npm run test:cli`
> covers the parser and the readline seam.

### Watch what an agent is doing

Open `http://127.0.0.1:3100/orch#runs` and click any run — the transcript
streams tool calls, skill invocations and assistant text, filtered and with
secrets scrubbed, polling every 3 seconds until the run finishes. The chatbot's
Live Transcript pane shows the same thing from the same endpoint.

From the terminal:

```bash
npm run orch -- runs SCY-7          # one line per run: agent, phase, duration, tokens, cost
npm run orch -- log <runId>         # filtered transcript
npm run orch -- log <runId> --raw   # the raw JSONL, byte for byte
```

## Helper scripts (`scripts/`)

- **`scripts/pipeline.mjs`** — **the pipeline, as data.** Which stages exist, what
  level each runs at, what each `produces`, `requires` and `enriches`, plus the
  artefact aliases the revision flow routes on. Imported by `stage.mjs`,
  `render-companion-app.mjs`, `migrate-to-project-level.mjs` and the chatbot
  server. Four consumers must agree on "what does this stage require"; writing it
  once is what stops them diverging. Paths carry an explicit `scope` —
  `project`, `feature`, or **`features`**, which spans every feature under the
  project because that is what `stageAllDocuments` reads.
  > **Documents are inputs, and were not.** Every entry came `from` another
  > STAGE, so the staleness walk could only ever answer "this artefact predates
  > another artefact" — a client replacing an SOP, the most common reason a pack
  > goes out of date, changed nothing it could see. The four
  > `requirements/{SOP,Transcripts,Notes,UI}` folders are now inputs
  > (`from: "discovery"`) to `requirements`, `ui` and `architecture`, and
  > feature-spanning inputs to `capabilities` and `personas`. Enumerated rather
  > than "requirements/ minus exclusions", because `templates/` is house style
  > and `project/` is staged DOWN on every run — treating that one as source
  > would report every feature artefact stale immediately after staging.
  >
  > `newestMtime` also followed exactly ONE level in, which was true enough for
  > the flat `projects/<p>/documents/` and useless for `requirements/<Sub>/`.
  > A walk that stops at the first directory returns null, and null means
  > "nothing changed" — so the deeper a document, the more certainly it was
  > ignored. It recurses now.
  >
  > `SOURCES` gives a non-stage origin a readable label: a refresh prompt used
  > to say an artefact was superseded by "documents", which is a key, not
  > something to show the person deciding whether to spend twenty-five minutes.
- `scripts/stage.mjs <project> [<feature>] <stage>` — the local, agent-free
  path, and the one the agents now call in Phase 1. Converts source documents to
  markdown first, stages the project's material down (or every feature's up, for a
  project stage), refuses a stage whose hard prerequisite is missing while naming
  the stage that would satisfy it, and prints the exact skill command to run next.
- `scripts/render-companion-app.mjs <project>` — used by the **Developer**. Emits
  ONE self-contained `generated-apps/<project>/index.html`: inline CSS + JS, data
  as a JSON island, Mermaid pre-rendered to inline SVG, a hand-drawn SVG
  satisfaction chart per journey. **Zero network requests.** Project tabs render
  the client artefacts; feature tabs open on a grid of feature cards and drill
  into one document, showing a muted "not generated" card for a feature that has
  not run that stage. Flags: `--no-diagrams` skips the mermaid pass.
  > Inlined Mermaid SVGs have their internal ids namespaced per diagram, and
  > markdown heading anchors are scoped per document. Both matter only at project
  > scale: mermaid-cli emits a fixed `id="my-svg"` and fixed filter/marker defs
  > for every diagram, so N diagrams on one page meant N duplicate ids AND every
  > `url(#…)` resolving to the first diagram's defs; and every feature's data
  > model opens with "1. Executive Summary".
- `scripts/render-mockups.mjs <project> <feature>` — used by the **UX Designer**.
  Reads `solutions/UI/outputs/mockups.json`, validates it (non-zero exit naming
  the offending screen and field), and emits
  `generated-apps/<project>/mockups/<feature>/` — one themed page per screen plus
  an index. Reads the project's `theme.json`, so a project branded once renders in
  the client's palette in both artefacts.
  > **Its theme tokens are duplicated from `render-companion-app.mjs`** rather
  > than imported, because the companion app builds its CSS inline inside a
  > template literal. Until that is extracted, a palette change has to be made in
  > both files.
- `scripts/migrate-to-project-level.mjs [<project>] [--apply] [--force]` — one-shot
  migration for a project created before the restructure. See above.
- `scripts/sync-bundles.mjs export|import <dir>` — **retired with Paperclip.** It
  round-tripped the agent bundles between their `{path, content}` JSON and one
  `.md` per agent, because editing a whole AGENTS.md crammed into a JSON string
  is how they got corrupted. The bundles are now plain `.thin.md` files, so there
  is nothing to round-trip. Kept only for reading `agent-instructions/legacy/`.
- `scripts/validate-experience.mjs <project>` — the contract guard for
  `personas.json` + `journey-map.json`: required fields, unique IDs, `avatarColor`
  in the app's palette, satisfaction scores as integers 1–5, no semicolons in
  persona bullets (the app's CSV loader splits on them), no `:`/`;` in journey step
  names (breaks the Mermaid `journey` parser), every journey's `personaId`
  resolving, every "moment that matters" resolving to a step, every persona having
  exactly one journey. Reports **every** problem in one run and exits non-zero.
- `scripts/render-capability-map.mjs <project> [--validate-only]` — the contract
  guard for `capability-map.json` + `process-model.json`, which is the part the
  agent cannot self-check. `--validate-only` is how the pipeline calls it. Its own
  page renderer is retained but no longer wired in: a project has ONE page,
  rendered by `render-companion-app.mjs`.
- **`scripts/ado-publish.mjs <file.md> --path "/Some/Page"`** — create or update
  a wiki page from a markdown file on disk, idempotent BY PATH so a revision
  can never leave the client with two documents. `--verify` checks the org,
  project, wiki and both token scopes and exits non-zero naming which failed —
  run it before a stage does, because a bad target is far cheaper to find now
  than after a document is built. `--attach` uploads an image and rewrites its
  markdown reference to `/.attachments/`; usually unnecessary, since the wiki
  renders ` ```mermaid ` itself.
  > The publish prompt reaches for this when a document exceeds about 40 KB.
  > Passing 110 KB through a tool call is measured to fail — run SCY-6 read the
  > document three times assembling the call, compacted thirteen minutes in and
  > published nothing, for $2.73.
- **`scripts/ado-workitems.mjs <stories.json> --summary-url <url> [--parent <id>]`**
  — creates or updates one work item per story. Three things it does that an
  instruction to a model could not be relied on to:
  > **Discovers the work item type.** "User Story" exists only in the Agile
  > process template; the current target runs **Basic** (Epic → Issue → Task,
  > no User Story), so a hard-coded `$User Story` would fail every story.
  > **Substitutes `{{PRODUCT_SUMMARY_URL}}`** — and REFUSES to write a
  > description that still contains it, because a re-run without
  > `--summary-url` would otherwise overwrite a correct link with the
  > placeholder.
  > **Writes the created ids back** into `stories.json`, so a re-run updates
  > rather than duplicating a client's backlog.
- **`scripts/sync-documents.mjs`** (`npm run sync:docs`) — **reconcile the folder
  tree into the database.** A PLAN by default; `--apply` writes; `--project P`
  narrows. Creates missing project, feature and document rows, and RETIRES a row
  whose file is gone (never a hard delete — bytes are shared by every path
  holding the same content). Idempotent: `put()` is content-addressed and
  answers `changed: false` for bytes it already holds.
  > **Disk wins, and only ever lifts one way.** It is what every stage reads —
  > the 409 gates count `.md` there, the skills read the folder tree — so this
  > records disk into the database and never the reverse.
  >
  > It exists because dual-write only governs what is created THROUGH those
  > paths. `npm run convert`, `stage.mjs`, an agent, or a person copying a file
  > into `documents/` all land on disk alone. Measured before it existed: **20
  > documents on disk against 2 rows, and three of four projects unknown to the
  > database entirely** — so `scyne doc list` printed nothing for a project the
  > browser listed nine documents for.
  >
  > **Count the two real shapes only** — `projects/<p>/documents/` and
  > `projects/<p>/<f>/requirements/{SOP,Transcripts,Notes,UI}/`. A glob like
  > `*/documents/*.md` also sweeps `solutions/<Stage>/documents/`, which is 41
  > staged working copies here: material `stage.mjs` writes before an agent run,
  > not documents anybody uploaded. Counting those is how "20" becomes a
  > confident, wrong "63".
- `scripts/extract-brand.mjs <url> <project>` — see *Brand the companion app*.
- **`scripts/build-cli.mjs`** (`npm run build:cli` / `npm run pack:cli`) — bundles
  `cli/` into `dist/cli/`: one readable, dependency-free `scyne.mjs` plus a
  GENERATED `package.json`, because the repo's own root package is
  `private: true` and carries the whole stack's scripts. Not minified on
  purpose — it is a file people are asked to install from an email and run
  against their own credentials. It executes `scyne --help` on the built
  artefact before packaging. See *Ship the `scyne` CLI to a user with no clone*.
- `scripts/convert-to-md.mjs <project> [<feature>]` — with a feature, converts that
  feature's `requirements/`; with none, the project's own `documents/`.
- `scripts/audit-a11y.mjs <project>` — used by the **UX Auditor**. Runs
  `@axe-core/cli` (WCAG 2.0 A + AA) and `pa11y` (WCAG2AA) against the registry's
  `devUrl` and writes `generated-apps/<project>/audit.json`. Exits 0 even when
  violations exist — the auditor reads the JSON to decide what to fix.
  > **Both tools test ONE theme state, not four.** Headless Chrome defaults to
  > `prefers-color-scheme: dark`, and neither tool exposes a flag to change it, so
  > a clean `audit.json` is evidence about the dark palette only. The page has four
  > states worth checking (system light, system dark, and the toggle forcing each),
  > and a per-project `theme.json` can pass one while failing another. When
  > branding changes, verify all four with a driver that calls
  > `page.emulateMediaFeatures([{name:"prefers-color-scheme",value:…}])`.
  > **Known environment issue:** `@axe-core/cli` drives Chrome through
  > ChromeDriver and fails with `session not created` when the installed Chrome is
  > newer than the bundled driver. `npx browser-driver-manager install chrome`
  > fixes it. `pa11y` uses its own bundled browser and is unaffected.
  > **What "0 violations" means here.** As of this restructure, pa11y reports 17
  > issues on the SAPN page, down from 176. The remainder are: mermaid emitting
  > duplicate ids *within* one sequence diagram (not fixable from outside
  > mermaid), two dialog headings filled by JS at open time, and the hash-router
  > nav links, which pa11y cannot resolve. Do not claim zero without saying which
  > tool and which theme state.

> The React path that `render-companion-app.mjs` replaced (`scaffold-app.mjs` /
> `stop-app.mjs`) is kept at `scripts/legacy-react-scaffold/` with a README on
> restoring it. It was retired because the deliverable is a document a consultant
> hands to a client, not a running program.

## Generated apps registry

`generated-apps/registry.json` is keyed by **project** — there is one companion
app per project, covering every feature:

```json
{
  "RTWSA": {
    "appPath": "generated-apps/RTWSA",
    "htmlPath": "generated-apps/RTWSA/index.html",
    "kind": "static-html",
    "devUrl": "http://127.0.0.1:4000/api/companion-app/RTWSA/",
    "branch": "ui/RTWSA",
    "repoUrl": "<git url or null>",
    "generatedAt": "2026-08-14T…",
    "features": {
      "interim-benefit": { "artefacts": ["Product Summary", "Data Model"], "screens": 6 }
    },
    "artefacts": ["6 personas", "88 capabilities", "product summary ×1"],
    "diagrams": 12,
    "bytes": 3057428
  }
}
```

The trailing slash on `devUrl` matters: the page links into the sibling
`mockups/` directory relatively so the pack also works from disk, and a relative
link on a URL without a trailing slash resolves one segment too high. The Developer
and UX Auditor both treat this file as authoritative — if a description disagrees
with the registry, the registry wins.

## Conventions

- **Australian English** in all generated content (Behaviour, Authorise, Organisation).
- **House style for story summary**: `<L4.N.M> As an <role>, I want <verb-phrase>, So that <outcome-phrase>.`
- **Personas**: full name + abbreviation (e.g. `Eligibility Officer (EO)`).
- **AC bullets**: declarative sentences, 2–4 per story, not Gherkin.
- **Section placeholders** in the Product Summary at 3.3.1, 7, 8, 9, 10, 11 are preserved verbatim ("Placeholder – Maintained manually. Do not populate via automation.").
- **One pass per agent wake**. Agents EXIT after their phase's work is done; they do not loop. Re-running is triggered by a status change, a new comment, or an explicit `/wakeup` call.
- **Issue status semantics**:
  - `todo` — fires the assignee
  - `in_progress` — agent has checked out the issue
  - `in_review` — work-products attached, approval gate raised
  - `done` — fully resolved
  - `blocked` — agent paused, needs human input
  - `paused` — a person stopped it; `resume` carries on from the same step
  - `cancelled` — a person ended it; it does not resume
- **Two levels.** Personas, capabilities and the process model describe the CLIENT
  and live at `projects/<project>/`. Everything else describes ONE slice of work and
  lives at `projects/<project>/<feature>/`. When in doubt: would a second feature
  for the same client want its own copy? If no, it is project-level.
- **Reserved feature names**: `capabilities`, `personas`, `app`, `all`, `baseline`, `solutions`,
  `documents`, `design`, `original-files`, `outputs`.
- **Source mapping** in `extraction.json` — every story / decision should map back to which input file it came from (`transcripts/foo.docx`, etc.) so traceability is auditable.

## When something feels off

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `<tool_use_error>Unknown skill: <slug></tool_use_error>` mid-run | `.claude/skills/` was never populated on this clone. Claude Code discovers skills there, not from `./skills/`, and `.claude/` is gitignored. | `npm run link-skills`, then confirm `ls -l .claude/skills` shows one symlink per skill. The console's **Skills** tab marks a skill `missing` before it costs you a run. |
| Agent run fails instantly with `System prompt file not found` | The agent's `bundlePath` in `orchestrator.config.ts` names a file that is not there. | `curl -s localhost:3100/agents/<key>/bundle` — it reports the missing path rather than 404ing. Create the bundle or clear the path. |
| A CLI verb fails on a database lock | PGlite is single-writer and `npm run dev` / `orch serve` holds it. | Use the HTTP API (`curl -s localhost:3100/issues`), or stop the server. The CLI says which. |
| An issue sits at `blocked` | A step failed. The blocking comment names it — a non-zero `exec`, a missing `produces` file, an unreadable `reads` file, or an agent that exited non-zero. | Fix the cause, then Resume from the console's Issues tab (or `POST /issues/:id/advance`). It restarts at the step that blocked, not from the beginning. |
| An issue sits at `todo` and nothing happens | The process died mid-run and orphan recovery returned it to `todo` at boot. | Resume it, as above. |
| Approving does nothing visible for a minute | Correct: the decision returns 202 and the publish step runs in the background. | Watch `#runs` in the console, or poll `GET /issues/{id}`. |
| Publishing fails with `401` on the wiki while everything else works | The PAT is valid and lacks the **wiki** scope. Azure DevOps answers a missing scope with 401, not 403, so it reads exactly like a bad token. | Add `vso.wiki_write` at `dev.azure.com/<org>/_usersSettings/tokens`. Confirm with `node scripts/ado-publish.mjs --verify`, which tests each scope separately and says which one failed. |
| Every story fails with "work item type does not exist" | The project's process template has no `User Story` — Basic has Epic → Issue → Task. | `ado-workitems.mjs` discovers the type; if something else hard-codes one, use `--type` or let the script choose. |
| An ADO call 401s only on Codex runs, and works on Claude | `.mcp.json` holds `${MCP_TOKEN_FOR_AZURE}` and something is not expanding it, so the server receives the literal string. | `readMcpServers` in `core/codex-runner.ts` does the expansion. Check the variable is set in the ROOT `.env` — an unset one now throws by name rather than substituting an empty string. |
| A published wiki page has the placeholder `{{PRODUCT_SUMMARY_URL}}` in its stories | `ado-workitems.mjs` was run without `--summary-url`. | It refuses this now. If you see it on an older item, re-run with `--summary-url`; the script updates in place. |
| A stage fails with `no such project: projects/<first-word>` | Something interpolated a project or feature into a shell command without quotes. An `exec` step is `/bin/sh -c`, so `SA Demo` word-splits. | `swap()` and `stageArgs()` in `orchestrator.workflows.ts` quote both placeholders; `sub()` in `stage.mjs` quotes the advice it prints. If a new command is added, quote it there rather than at the call site. |
| An upload's database half fails `Payload Too Large` while the folder tree succeeds | `express.json()` defaults to **100 KB** and a document travels base64-encoded in a JSON body, which adds about a third. A 275 KB PDF was over it. | `orch serve` sets `limit: "100mb"`, matching the chatbot's multer cap so both halves accept the same file, and returns a JSON 413 naming both sizes — Express's default is an HTML page the CLI refuses to print, which is why it only ever said `Payload Too Large`. Restart the orchestrator: it runs on plain `tsx`, not `tsx watch`. |
| A stage is refused `no documents` when the project holds `.docx`/`.pdf` | Fixed: the gates count `readable` = markdown **plus** every source `convert-to-md.mjs` can convert, because `stage.mjs` converts as its first step. If it still refuses, the files are images or audio (`other`), which are not discovery material. | `READABLE_AFTER_CONVERSION` in `scripts/convert-to-md.mjs` is the list, imported by the server rather than restated. |
| Documents upload fine but no stage can read them | The conversion failed. `stage.mjs` now prints `⚠ N document(s) could not be converted` and carries on with whatever else it staged. | Usually `markitdown-ts is not installed` — `cd scyne-chatbot && npm install`. It is a declared dependency, but only of `scyne-chatbot`, and it lives only in that `node_modules`. |
| A project created in the web UI is in no listing, its definition will not save, and its runs show no project in Spend | It was never written to the DATABASE. The wizard wrote the folder tree only; `cli/dual.ts` has always written both. | Fixed — `/api/projects` and `/api/features` now write the row too, and report `dbError` when they cannot. For a project created BEFORE the fix, re-post `/api/projects` with the same name: it completes rather than refusing. |
| `create_project` / the wizard refuses `exists`, but the `projects` table is empty | The existence check was reading DISK. Fixed — it reads `store.listProjects` now. If you still see it, the folders are being counted somewhere else. | The project folders survive a `DATABASE_URL` change; the rows do not. `npm run sync:docs -- --apply` creates the missing rows, then `npm run backfill:ado` lifts each `.published.json` target into `projects.ado_target`. |
| A project that IS fully set up is offered as "incomplete, finish setting it up" | Its target is on disk only — `projects.ado_target` is null because the project predates 009_project_ado_target.sql. | `npm run backfill:ado` (a plan; `-- --apply` writes). It refuses to overwrite a row that already has a target, so a stale `.published.json` cannot redirect a client's publishing. |
| Creating a project answers `502 db_unavailable` | Deliberate: the row is the record, so a create that cannot write one has created nothing. Nothing was left behind — no folder, no Azure DevOps project. | The message carries the underlying reason. Usually the orchestrator is not running, or `DATABASE_URL` points somewhere unreachable. |
| Creating a project answers `401 not_authenticated` | Also deliberate. It used to write the tree anyway and report `ok: true` for a project no API could see. | Sign in. The CLI sends `Authorization: Bearer`; the browser sends the `scyne_session` cookie. |
| A deleted document comes back | The archived source in `original-files/` was left behind, and the next conversion pass rebuilt the markdown from it. | Fixed — `deleteDocument` takes both. If one predates this, delete the file under `original-files/` by hand. |
| A stage still reports documents after its `requirements/` was emptied | `countFeatureDocs` walked `original-files/`, so every archived source counted as a live document — and each converted document counted twice. `countProjectDocs` skipped it explicitly and this did not. | Fixed — `original-files` is in `SKIP_DIRS`. |
| A stage is refused `no documents` while `/docs` lists documents | Those rows are in the DATABASE and the files are not on DISK, and every gate counts `.md` on disk. Either the upload was refused (`ambiguous_kind` — a `.docx`/`.pdf` whose name matches neither the SOP nor the transcript pattern needs `--as`) and a pre-`51dec6e` CLI recorded the row anyway, or the file landed but never converted. | `find projects/<p> -name '*.md'` is what the gate sees. Re-upload with `--as sop\|transcripts\|notes`, or with no feature pinned for client-wide material. `node scripts/convert-to-md.mjs <p> [<f>]` converts what is already there. |
| Every conversion fails with `markitdown-ts is not installed` | It resolves from `scyne-chatbot/node_modules` and was missing from that package's dependencies. | `cd scyne-chatbot && npm install`. Nothing under `requirements/` or `documents/` becomes readable until this works. |
| A stage runs as the wrong stage | The chatbot's title → workflow mapping broke — it parses a generated markdown description, which nothing type-checks. | `npm run check:routing`. It asserts every title and description shape the chatbot builds. |
| An env var is set but the chatbot doesn't see it | It was put in a `scyne-chatbot/.env`. That file is gone — `server/env.ts` loads the **workspace-root** `.env` only, by walking up for `agent-instructions/` + `skills/`. | Move the key to the root `.env` and restart; `tsx` does not watch it. The boot line `[workspace] root = …` names the directory it resolved. |
| Two servers fight over port 4000 | Something else read `PORT` out of the shared root `.env`. | The chatbot's key is `CHATBOT_PORT`; `PORT` is only a fallback for Docker/PaaS. Don't set a bare `PORT` in `.env`. |
| Chatbot shows "undefined" for a parameter | Frontend reading an old field name. | Search for the renamed field across `src/`. |
| `/api/features` returns `{}` | `projects/` missing, or `WORKSPACE_PATH` pointing elsewhere. | `mkdir projects/<project>/<feature>/...`, restart the dev server. |
| Refresh loses the workflow | `localStorage.scyne_parent_issue_id` cleared. | The workflow status panel's "New session" button starts over; otherwise it restores automatically. |
| `SCYNE_ADAPTER='codex' is not registered` at boot | The `codex` binary is not on PATH. | `npm i -g @openai/codex && codex login`, then restart. |
| A `/new` step's label is replaced by the session prompt as you type | Something wrote the label straight to stdout. readline in terminal mode redraws the whole line from ITS prompt on every edit, so the label survives until the first backspace — and the step then looks like the ordinary prompt, so the next thing typed is taken as a command. | `drawLabel()` in `cli/repl.ts` hands the label to `rl.setPrompt`. Any new prompt must go through it, not `process.stdout.write`. |
| A pasted paragraph in `scyne` is read as several answers | The terminal is not bracketing its pastes (DECSET 2004), so `cli/paste.ts` cannot tell a pasted newline from a pressed Return — tmux and screen can be configured to strip the markers. | Paste and look: a multi-line block should collapse to `[Pasted text #1 +N lines]` before you press Return. If it does not, `/new` refuses the step rather than spreading the block across the four that follow, and `project describe <p> "…"` takes the paragraph in one go. |
| A Codex run's transcript is empty in the console | The decoder did not recognise the event kinds — a Codex version bump. | `npm run orch -- log <runId> --raw` shows the real events; update `decodeCodexLine` in `core/transcript.ts`. Unrecognised events render as framing lines, so an empty transcript means the log itself is empty. |
| A stage refuses `documents_not_ready` | Documents are on disk but not extracted. | `curl /api/extract-status/<project>` names which and why. `node scripts/extract-documents.mjs <project>` runs the missing ones; it is idempotent. |
| A document sits at `failed` forever | Usually a scanned PDF with no text layer — nothing to extract. | The reason is in `solutions/Extracts/<hash>.extract.failed.json`. There is no override yet; remove the document or supply a text version. |
| `/spend` shows nothing for a big extraction run | Correct, and a known gap: map passes get no `runs` row. | Each extract's `usage` field carries its tokens. Sum them. |

---

If you're about to make a significant change, sketch the touched files first — most changes ripple through several:

- `scripts/pipeline.mjs` — the stage graph. Four consumers read it; a change here changes what every one of them believes a stage requires.
- `orchestrator.workflows.ts` — how a stage becomes steps, and the generate / revise / publish prompts.
- `orchestrator.config.ts` — the org chart, budgets, adapters.
- `agent-instructions/<agent>.thin.md` — that agent's domain instructions. No re-push needed; the file is read at spawn time.
- `skills/<slug>/SKILL.md` — the actual method. Symlinked into `.claude/skills/`, so an edit is live immediately.
- `scyne-chatbot/server/orchestrator.ts` — title → workflow mapping. Run `npm run check:routing` after touching it.
- `scyne-chatbot/server/llm.ts` (system prompt + tool schema), `scyne-chatbot/src/App.tsx` (state + rendering), `scyne-chatbot/.env` (defaults).
