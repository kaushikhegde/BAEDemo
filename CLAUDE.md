# Scyne Requirements Generator — CLAUDE.md

This document is the orientation guide for anyone (Claude included) working on this repository. Read it before making changes.

## Answer concisely

Keep replies short and on point. Lead with the answer, name the file and line,
skip the preamble and the recap. Explain the mechanism only when it changes what
the reader does next. Long, structured write-ups are for when they are asked
for — not the default.

## Where the detail lives

This file is the orientation: the two levels, the folder layout, the workflow
engine, the org, the skills, and the conventions. The reference material lives
beside it in `docs/`, and **is not loaded automatically — open the one you need
before changing anything it covers**:

| Read before touching | File |
|---|---|
| Anything that writes to a client's Confluence/Jira or Azure DevOps — pages, attachments, backlog, targets, scopes | [`docs/publishing.md`](docs/publishing.md) |
| Adapters, budgets, model pricing, cost attribution, blob storage and the per-step scratch tree | [`docs/configuration.md`](docs/configuration.md) |
| `scyne-chatbot/` — every backend endpoint, the Gemini flow, the frontend, project/feature creation rules | [`docs/chatbot.md`](docs/chatbot.md) |
| Running things by hand: staging, the `extract` stage, reset, branding, creating projects, shipping the CLI | [`docs/operations.md`](docs/operations.md) |
| What each script in `scripts/` does and why | [`docs/scripts.md`](docs/scripts.md) |
| A run failed, a stage refused, something reads as broken | [`docs/troubleshooting.md`](docs/troubleshooting.md) |

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

> **Publishing has TWO back ends and the rules are unforgiving — read
> [`docs/publishing.md`](docs/publishing.md) before touching any of it.** The
> short version:
>
> - `PUBLISH_TARGET` picks the default (`atlassian`; `ado` is the other), but a
>   project **keeps the system it has already published into** — resolved from
>   `projects.atlassian_target` / `projects.ado_target` and
>   `projects/<p>/.published.json` by `resolvePublishTarget`
>   (`scripts/lib/publish-shared.mjs`), never from the environment variable.
> - **Confluence cannot take a diagram from the MCP.** Its OAuth grant carries
>   no attachment scope, so a page publishes cleanly with its diagrams
>   **silently missing**. `scripts/confluence-publish.mjs --render-mermaid`
>   does the conversion, the PNG pass and the upload, over an API token with
>   Basic auth against the SITE domain. An Azure DevOps wiki renders
>   ` ```mermaid ` itself and needs none of this.
> - **The PAGE goes through the MCP; the BACKLOG never does.** The publishing
>   agent writes the page and stops; the step after it runs
>   `scripts/jira-issues.mjs` or `scripts/ado-workitems.mjs`. Both are
>   idempotent by `jiraKey` / `adoId`. 45 stories in one agent turn is where a
>   run reports `succeeded` having created zero work items.
> - An optional param reaches an `exec` step as **`SCYNE_PARAM_<NAME>`**, never
>   as a `{placeholder}` — `interpolate` throws on one the issue does not carry.
> - The ADO work item type is **per project** (`projects.ado_target`), because
>   no MCP tool can enumerate them and `User Story` exists only under Agile.
> - A document over ~40 KB publishes via `scripts/ado-publish.mjs`, not a tool
>   call.

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
`azure_foundry`. `SCYNE_ADAPTER` picks the org-wide default;
`scyne adapter set <name> --project <p>` overrides it per project, and an agent
or a step can pin its own.

**Budgets** are a ceiling, not a target: 10M tokens / $15 / 45 minutes per agent
run. The dollar limit is the one that means something — the token ceiling counts
cache reads at full weight, so it is a runaway backstop rather than a real
limit.

**Cost has two columns and they are never merged.** `runs.cost_usd` is what the
CLI reported; `runs.est_cost_usd` is ours, from the `model_prices` table;
`runs.cost_source` says which a reader is looking at. Codex emits no dollar
figure, so **`CODEX_MODEL` must be set or every Codex run shows `—` for cost and
no cost budget can fire on it.**

**Storage** is Postgres for metadata and **Azure Blob Storage for every byte of
document content**, addressed by SHA-256. Disk is a scratch surface, one tree
per step, deleted after it.

→ **[`docs/configuration.md`](docs/configuration.md)** for the whole of it:
Codex model retirements, the price-table proposal/apply flow and why a refresh
is never a write, per-project run attribution (`issues.project_id`), the blob
backend contract, and what `materialise` refuses to copy.

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

Local app: **React + Vite frontend on port 5173**, **Express backend on port
4000**. Vite proxies `/api/*` → backend. `npm run dev` at the root starts the
orchestrator and both halves of the chatbot.

Three rules that are load-bearing everywhere else:

- **One `.env`, at the workspace root.** Every process reads that file and no
  other; `scyne-chatbot/server/env.ts` finds the root by walking up for
  `agent-instructions/` + `skills/`, so it is cwd-independent. The chatbot's
  port is **`CHATBOT_PORT`**, not `PORT` — one shared file feeds every process
  in the stack.
- **The ROW is what a project IS; the tree is derived from it.** `POST
  /api/projects` writes the database row FIRST and a failure to write it is
  fatal (`502 db_unavailable`). Everything still lands on disk, because six
  skills read `projects/<p>/description.md` by path — but nothing DECIDES
  anything by reading disk. The one exception is documents: "what documents
  exist" is answered from disk by every surface, because disk is what the
  stages read.
- **The title → workflow mapping parses a generated markdown description, which
  nothing type-checks.** Run **`npm run check:routing`** after touching
  `server/orchestrator.ts` or `server/llm.ts`.

→ **[`docs/chatbot.md`](docs/chatbot.md)** for every backend endpoint and its
409 codes, the Gemini conversation flow and its tool schema, the frontend
layout and left rail, the Docs tab's upload/replace/delete lifecycle, and why
the workflow defaults were deleted rather than commented.

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

### Everything else — [`docs/operations.md`](docs/operations.md)

Editing an agent's instructions · running a skill locally without the
orchestrator (`npm run link-skills`, `npm run stage`) · **the `extract` stage**,
one agent per document, its content-hash keying, its failure markers and its
spend gap · clearing the database (`orch reset`, and what each depth takes) ·
migrating a pre-restructure project · document → markdown conversion and why
both upload routes run it · branding from a client's website · rendering the
companion app · creating a project or a feature, and the naming rules
(`slugProjectName`, reserved feature names, why `SA Demo` word-splits) ·
starting a run from the CLI · shipping the `scyne` CLI to a user with no clone ·
watching what an agent is doing.

## Helper scripts (`scripts/`)

→ **[`docs/scripts.md`](docs/scripts.md)** — what each one does, and the
reasoning it encodes. Read the entry before changing a script or adding one.

| Script | |
|---|---|
| `pipeline.mjs` | **the pipeline, as data** — stages, levels, `produces` / `requires` / `enriches`, and documents as inputs. Four consumers import it |
| `stage.mjs` | converts, stages down (or up), refuses a stage whose prerequisite is missing, prints the skill command |
| `extract-documents.mjs` · `extract-state.mjs` | one `document-extract` agent per document → `solutions/Extracts/<hash>.extract.json` |
| `render-companion-app.mjs` | ONE self-contained page per project. Never hand-edit the emitted HTML |
| `render-mockups.mjs` | `mockups.json` → one themed page per screen. Owns every pixel |
| `validate-experience.mjs` · `render-capability-map.mjs --validate-only` | the two contract guards. Non-zero exit is a blocker |
| `confluence-publish.mjs` · `confluence-attach.mjs` · `jira-issues.mjs` · `ensure-confluence-space.mjs` | the Atlassian path — see [`docs/publishing.md`](docs/publishing.md) |
| `ado-publish.mjs` · `ado-workitems.mjs` | the Azure DevOps path, same |
| `sync-documents.mjs` (`npm run sync:docs`) | reconcile the folder tree into the database. Disk wins; a plan by default |
| `convert-to-md.mjs` | `.docx`/`.pdf`/`.xlsx` → `.md`, source **moved** to `original-files/` |
| `extract-brand.mjs` | a client's site → `design/style-guides/theme.json` |
| `audit-a11y.mjs` | axe + pa11y against the registry's `devUrl`. Tests ONE theme state |
| `build-cli.mjs` | bundles `cli/` into a dependency-free `dist/cli/scyne.mjs`, and runs it before packaging |
| `migrate-to-project-level.mjs` | one-shot lift of pre-restructure projects |

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

→ **[`docs/troubleshooting.md`](docs/troubleshooting.md)** — a symptom → cause →
fix table covering every failure this repo has actually produced. Check it
first; most of what looks like a new bug is in there.

The five that come up most:

| Symptom | Fix |
| --- | --- |
| `Unknown skill: <slug>` mid-run | `npm run link-skills` — `.claude/` is gitignored, so every fresh clone needs it |
| An issue sits at `blocked` | The blocking comment names the step. Fix the cause, then Resume — it restarts at that step, not from the beginning |
| A CLI verb fails on a database lock | PGlite is single-writer and the server holds it. Use the HTTP API, or stop the server |
| A stage refuses `no documents` while `/docs` lists some | The rows are in the database and the files are not on disk. `find projects/<p> -name '*.md'` is what the gate sees |
| A stage refuses `documents_not_ready` | `curl /api/extract-status/<project>` names which document and why |

---

If you're about to make a significant change, sketch the touched files first — most changes ripple through several:

- `scripts/pipeline.mjs` — the stage graph. Four consumers read it; a change here changes what every one of them believes a stage requires.
- `orchestrator.workflows.ts` — how a stage becomes steps, and the generate / revise / publish prompts.
- `orchestrator.config.ts` — the org chart, budgets, adapters.
- `agent-instructions/<agent>.thin.md` — that agent's domain instructions. No re-push needed; the file is read at spawn time.
- `skills/<slug>/SKILL.md` — the actual method. Symlinked into `.claude/skills/`, so an edit is live immediately.
- `scyne-chatbot/server/orchestrator.ts` — title → workflow mapping. Run `npm run check:routing` after touching it.
- `scyne-chatbot/server/llm.ts` (system prompt + tool schema), `scyne-chatbot/src/App.tsx` (state + rendering), `scyne-chatbot/.env` (defaults).
