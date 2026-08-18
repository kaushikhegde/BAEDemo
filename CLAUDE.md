# Scyne Requirements Generator — CLAUDE.md

This document is the orientation guide for anyone (Claude included) working on this repository. Read it before making changes.

## What this project is

A local end-to-end workflow that turns a client's raw discovery artefacts
(meeting transcripts, SOP/policy docs, UI screens, notes) into a delivery pack.

It works at **two levels**, and getting this distinction right is the thing
everything else hangs off:

**PROJECT level — describes the CLIENT ORGANISATION. Generated once; every
feature reads it.**

1. A **Business Capability Map + L1/L2/L3 Process Model**, derived from every
   document the client has given us, across all their features. Published to its
   own Confluence page per project.
2. An **evidence-traced persona set + a journey map per persona**, published to
   one Confluence page per project — plus `personas.json` and `journey-map.json`,
   which are a **build contract for the companion app**. Needs (1): journey
   stages align to the capability model's L1 lifecycle phases.

**FEATURE level — describes ONE slice of work. Repeated per feature.**

3. A **Confluence-ready Product Summary** (11-section markdown) and a set of
   **Jira-ready user stories** (Atlassian Cloud REST v3 payloads).
4. A set of **UI mockups** (wireframes) — one screen specification rendered as
   self-contained themed HTML pages, one per screen, each carrying its error /
   empty / blocked states and tracing back to the stories and capabilities it
   realises. Local artefacts; they appear on the companion app's **UI** tab.
5. A **Salesforce Data Model** (objects, custom fields, Mermaid ER diagram),
   published to its own Confluence page.
6. A **Salesforce Service Cloud Solution Architecture Document**
   (capability-to-component map, Flow/LWC/Apex inventory with a justification per
   custom component, integration interface catalogue, ADRs, architecture
   diagrams), published to its own Confluence page.
7. A **test pack** (executable test cases, requirements traceability matrix,
   coverage gap analysis, optional CSV/Gherkin exports), published to its own
   Confluence page.
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
Confluence page rather than creating a second one.

The user drives everything from a Scyne-branded chatbot UI. The chatbot does not do the work itself — it posts a workflow to the orchestrator, which runs the agent org on the local machine via Claude Code. Every stage raises its own human approval gate, and the stages that publish do so after it. See **How it runs** below.

> **Mermaid → PNG for Confluence:** all Mermaid diagrams (Product Summary flow, data model ER, solution-design flow) are rendered to **PNG** locally via `npx -y @mermaid-js/mermaid-cli` and embedded with `<ac:image>` before publishing. PNG (not SVG) is used deliberately — Confluence renders PNG inline reliably, whereas SVG attachments often show only as a download link.
>
> **Attachments do NOT go through the MCP.** `<ac:image>` only resolves if the PNG
> is attached to the page, and the Atlassian MCP cannot attach anything: the
> OAuth grant `mcp-remote` obtains carries 20 scopes — 8 Confluence, none of them
> attachment scopes — so `POST .../child/attachment` returns
> `401 "scope does not match"`, and a raw curl reusing that token fails the same
> way (aimed at the site domain it 403s instead, because 3LO tokens are only
> valid against `api.atlassian.com`). Re-authorising will not add the scope —
> Atlassian's MCP app fixes the list. Every publishing agent therefore uploads
> with **`node scripts/confluence-attach.mjs <pageId> <files…>`**, which uses the
> `ATLASSIAN_API_TOKEN` from `scyne-chatbot/.env` (Basic auth, site domain).
> Symptom when this is skipped: the page publishes with its diagrams **silently
> missing** — not broken images, simply absent.

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
| **Console** | `http://127.0.0.1:3100/orch` — runs with live transcripts, issues, pending gates with approve/reject, org chart, spend, config, health |
| **API docs** | `http://127.0.0.1:3100/docs` — generated from `openapi.yaml`, which is diffed against the router in both directions by a test |
| **Chatbot** | `http://127.0.0.1:5173` |

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

**Workflows are compiled, not hand-written.** `orchestrator.workflows.ts` turns
each stage in `scripts/pipeline.mjs` into:

```
exec  stage.mjs   →  agent  generate  →  exec  validator  →  attach  →  gate
                                                    →  agent  publish  →  exec  render app
```

so adding a stage to the pipeline graph adds its workflow for free. Eighteen
exist: nine `<stage>`, eight `revise-<stage>`, and `baseline`.

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

The publish prompt is generated per stage and always says: check the space
exists (never create it), render Mermaid to PNG locally, upload with
`scripts/confluence-attach.mjs`, then record the page id in
`projects/<project>/.published.json` so a later revision updates that page
instead of creating a second one.

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
approval the publish step **updates** the existing Confluence page, using
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
card, and shows Confluence + Jira links the moment they appear.

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
│   ├── .published.json           Confluence page identity per artefact, so a REVISION
│   │                             updates the page instead of creating a second one
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

**Budgets** are a ceiling, not a target: 2M tokens / $15 / 45 minutes per agent
run. The one measured requirements run took 25 minutes and $3.19. A run that
breaches the duration limit is killed (SIGTERM, then SIGKILL); token and cost
limits are checked once the final `result` event lands and flag the run
`over_budget`.

**Storage** is PGlite at `.orchestrator/pgdata`, with raw run logs as JSONL at
`.orchestrator/runs/<issueId>-<stepIndex>.jsonl`.

## The orchestrator (`packages/orchestrator/`)

A standalone library — this repo is its first consumer, which is the discipline
that keeps it generic: nothing under `packages/orchestrator/` may import
`scripts/pipeline.mjs`, `orchestrator.config.ts`, or anything under `projects/`.

```
src/core/    db · repo · engine · runner · usage · transcript · interpolate
src/http/    router · console · docs · theme
src/cli.ts   seed · run · status · gate · runs · log · serve
```

### CLI

```bash
npm run orch -- seed                                     # reconcile the org chart
npm run orch -- run <workflow> --project P [--feature F] # start and advance
npm run orch -- status <SCY-7|uuid>                      # comments, work products, gates
npm run orch -- gate list | approve <id> | reject <id> --note "…"
npm run orch -- runs <SCY-7>                             # agent, phase, duration, tokens, cost
npm run orch -- log <runId> [--raw]                      # the transcript
npm run serve                                            # HTTP + console on :3100
```

Any `--key value` after the workflow name becomes a workflow param, so
`--confluenceSpace SADA` reaches the publish prompt without a code change.

### HTTP API

`GET /health` · `/agents` · `/agents/{key}` (PATCH) · `/agents/{key}/runs` ·
`/agents/{key}/bundle` · `/runners` · `POST /issues` · `GET /issues` ·
`/issues/{id}` (PATCH) · **`POST /issues/{id}/advance`** · `/issues/{id}/comments`
(POST) · `/issues/{id}/work-products` · `/issues/{id}/gates` ·
`POST /gates/{id}/approve|reject` · `/issues/{id}/runs` · `/runs/{id}` ·
`/runs/{id}/log` · `/runs/{id}/transcript` · `/usage` · `/config` · `/orch` ·
`/openapi.json` · `/docs`.

`openapi.yaml` is diffed against the router's `ROUTES` table **in both
directions** by `test/openapi.test.ts`: every route must be documented and every
documented route must exist. Adding a route means editing both.

### Gotchas

- **PGlite is single-writer.** One process owns `.orchestrator/pgdata`. While
  `npm run dev` or `orch serve` is up, CLI verbs fail on the lock — the CLI says
  so and points at the HTTP API. This is by design, not a bug to work around.
- **Gate decisions and `POST /issues` return 202 and resume in the background.**
  A resumed workflow runs an agent step for tens of minutes; a response that
  waited for it would time out on a click that actually worked. Poll
  `GET /issues/{id}`.
- **A declared-but-missing agent bundle** makes Claude Code fail fast with
  `System prompt file not found`, before any network call. The run is recorded
  `failed` with that stderr — but check `GET /agents/{key}/bundle`, which reports
  the missing path rather than 404ing.
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
- No prerequisite. Publishes to its own Confluence page (`<project> — Capability
  & Process Map`) on approval; Confluence only, never Jira. Writes no HTML — the project's single page is
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
  publishes to a *separate* Confluence page.)
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
cd scyne-chatbot
npm install
cp .env.example .env          # if not already present
# edit .env: set GEMINI_API_KEY (Gemini 2.5 Flash, free key from aistudio.google.com/apikey)
npm run dev                   # starts both vite + the api in one process via concurrently
open http://127.0.0.1:5173
```

### Backend endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/api/chat` | Proxies the conversation to Gemini, returns Anthropic-shaped blocks |
| **POST** | **`/api/projects`** | **Create a project**: folder tree, `description.md`, and branding pulled from the client's website inline. `409 exists` if the name is taken |
| **POST** | **`/api/features`** | **Create a feature** under a project. `400 reserved_name` for a name that would clash with a project folder or CLI stage keyword |
| **POST** | **`/api/upload/project`** | The wizard's untyped dropzone → `projects/<p>/documents/`, converted to markdown on arrival, original archived |
| **POST** | **`/api/project/bootstrap`** | `Set up project — <project>`: capability map, then personas, sequentially. `409 no_documents` |
| POST | `/api/capability-map/trigger` | `Generate capability map — <project>`. **PROJECT level, no feature.** `409 no_documents` only. Publishes to Confluence |
| POST | `/api/personas/trigger` | `Generate personas — <project>`. **PROJECT level, no feature.** `409 no_capability_map` |
| POST | `/api/trigger` | `Generate requirements — …`. Feature level. `409 missing_inputs` if SOP/Transcripts/UI are empty |
| POST | `/api/ui-mockups/trigger` | `Generate UI mockups — …`. `409 no_documents` only. Publishes nothing |
| POST | `/api/data-model/trigger` | `Generate data model — …`. `409 no_product_summary` |
| POST | `/api/solution-architecture/trigger` | `Generate solution architecture — …`. `409 no_product_summary` only |
| POST | `/api/test-cases/trigger` | `Generate test cases — …`. `409 no_product_summary` only |
| POST | `/api/solution-design/trigger` | `Generate solution design — …` (optional side stage). `409 no_data_model` |
| POST | `/api/ui-agent/trigger` | `Build UI — <project>`. **PROJECT level.** `409 no_artefacts` — the page is progressive, so any single artefact is enough |
| **POST** | **`/api/revise`** | **Revise an existing artefact.** `{project, feature?, artefact, instruction}` → routes to the owner with the instruction verbatim. `409 not_generated`, `400 unknown_artefact` |
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
| GET | `/api/history` | All completed runs with their Confluence + Jira links |
| GET | `/api/runs/:issueId` | Compact agent run summaries for the run tree |
| GET | `/api/features` | `projects/<project>/<feature>/` on disk. Excludes the project's own folders (`solutions`, `documents`, `design`, …) |
| GET | `/api/project-description/:project` | Reads `projects/<project>/description.md` |
| POST | `/api/project-description` | Writes it. Rejects an unsafe name or a body under 40 chars |
| GET | `/api/artifacts` | The approval-card preview. `project` alone returns the project artefacts; `project`+`feature` adds that feature's |
| POST | `/api/upload` | Feature-level upload, routed into `requirements/<sub>/` via `fileRouter` |
| POST | `/api/ui-agent/comment` | Follow-up comment on the UI build issue |

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
- `save_project_definition` — writes `projects/<project>/description.md` from the user's own words. The system prompt lists which projects have one and which do not, and tells the bot to ask once — never to block a run on it.
- `trigger_ui_build` — fires the UI flow (creates a `Build UI — …` issue assigned to the Delivery Lead). The Developer + UX Auditor chain runs from there.

The system prompt teaches the dependency chain (requirements → data model → solution design) so the bot proactively explains and offers the missing prerequisite rather than firing a stage that would just block.

### Frontend layout

- **Left panel**: chat with the LLM. Agent comments stream in as bubbles with the author label (e.g. `BA · SCY-2`). Approval gates render inline as a card with an expandable "Review what will be pushed" preview (Stories / Product Summary / Gaps tabs).
- **Right panel**: workflow status. Stage pill (queued → Delivery Lead triaging → BA generating → awaiting approval → pushing → complete), progress list of issues, autoscrolling activity timeline, links panel for Confluence + Jira.
- **Login gate**: the app shows a `Login.tsx` screen first (hardcoded demo creds `admin` / `scyne2026`; session stored in `localStorage.scyne_session`). Replace with real auth when wiring SSO.
- **Session persistence**: `parentIssueId` is saved to `localStorage.scyne_parent_issue_id`. Refresh resumes the workflow.
- **Right-pane tabs**: `Activity` (live workflow status) and `UI` (iframes the generated app from `/api/preview/:project/:feature`). The UI tab unlocks the moment a generated app is registered.
- **Comments render as markdown**: `MiniMarkdown` component handles headings, bullets, bold, inline code, fenced code blocks, and links (both `[label](url)` and bare URLs).

### Defaults baked into `.env`

```
DEFAULT_FEATURE_NAME=Review & Verify Evidence
DEFAULT_PROCESS_L3=2.4 Review & Verify evidence
DEFAULT_PROCESS_L4=2.4.1 Review evidence
DEFAULT_STARTING_STORY_NUMBER=2.4.1.1
DEFAULT_PARENT_EPIC_KEY=SADA-1
DEFAULT_JIRA_PROJECT_KEY=SADA
DEFAULT_CONFLUENCE_SPACE_KEY=SADA
DEFAULT_CONFLUENCE_PAGE_TITLE=Review & Verify Evidence
```

These mean a user can simply say "process SADA / interim-benefit" without specifying any parameters.

**Per-project push targets (not fixed to SADA):** `/api/trigger` defaults the **Jira project key** and **Confluence space key** to the *project name* (e.g. project `RTWSA` → keys `RTWSA`), not the `.env` SADA values. The `.env` `DEFAULT_JIRA_PROJECT_KEY` / `DEFAULT_PARENT_EPIC_KEY` / `DEFAULT_CONFLUENCE_PAGE_TITLE` only apply when the chosen project equals `DEFAULT_JIRA_PROJECT_KEY` (the SADA demo); for any other project the parent epic is omitted and the page title defaults to the feature name. The BA's Phase 2 **verifies the Jira project + Confluence space exist** (`getVisibleJiraProjects` / `getConfluenceSpaces`) and blocks with a clear message if not — it cannot create projects/spaces (the Atlassian MCP has no such tool). The Delivery Lead keeps the parent `Generate requirements` issue `in_progress` while the BA runs (it does **not** mark it `blocked`).

**Auto-provisioning (no client setup by default):** at the **approval** step, `/api/approve` reads the Jira/Confluence keys from the parent issue description and calls `server/services/atlassianProvision.ts` (`ensureAtlassianTargets`) to create the missing targets via the Atlassian **REST** API (not the MCP) before resolving the gate — both Jira project + Confluence space for the requirements flow, just the space for the Confluence-only data-model/solution-design flows (whose descriptions carry no Jira key). Auth reuses the **OAuth login the client already did for the MCP** (token cached in `~/.mcp-auth/`, used as a Bearer against `api.atlassian.com` 3LO) — no API token needed. An explicit API token (`ATLASSIAN_SITE_URL`+`ATLASSIAN_EMAIL`+`ATLASSIAN_API_TOKEN`) takes priority if set (Basic auth), useful when the MCP grant lacks create scope. **Soft-fail policy:** auth/lookup problems → skip provisioning and let the BA verify-and-block (so a stale token never blocks an approval where the target already exists); only a definitive *missing-target + create-rejected* throws `502 provision_failed` and holds the gate. Jira projects are created team-managed Kanban by default (`ATLASSIAN_JIRA_TEMPLATE_KEY`/`ATLASSIAN_JIRA_PROJECT_TYPE` override).

## The Atlassian MCP

Project-scope, configured in `.mcp.json` at the workspace root:

```json
{
  "mcpServers": {
    "atlassian": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://mcp.atlassian.com/v1/mcp/authv2"]
    }
  }
}
```

The runner passes `--mcp-config <workspace>/.mcp.json --strict-mcp-config` for any agent with `mcpEnabled: true`, and omits both for everyone else. Without `--mcp-config`, a project-scope MCP needs interactive trust approval, which cannot happen in `--print` mode. `--strict-mcp-config` keeps an agent from inheriting whatever MCPs the developer happens to have configured at user scope.

OAuth tokens for `mcp-remote` are cached in `~/.mcp-auth/` at user scope. The same user runs Claude Code interactively and inside the BA's subprocess, so tokens are shared.

## Common operations

### Edit an agent's instructions

Edit `agent-instructions/<agent>.thin.md`. That is the whole procedure — the file
is read from disk when the agent is spawned, so the next run picks it up. Nothing
to push, no bundle to re-upload, no ids to look up.

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
| 1 | project | `capabilities` | `/capability-process-map` | Capabilities Process Architect | — |
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

A full run, end to end:

```bash
# Project baseline — once per client. `baseline` runs both in ONE pass and
# prints the exact 6-step sequence; the two stages below remain for running
# either on its own.
npm run stage RTWSA baseline          # capability map + personas, one session

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
`.md` for each (`Conceptual Data Model.pdf` → `Conceptual Data Model.md`), using
the same `markitdown-ts` conversion the chatbot's upload route uses
(`scyne-chatbot/server/services/toMarkdown.ts`). It runs automatically as step 0
of every stage; `--no-convert` skips it, and it also stands alone:

```bash
npm run convert <project> <feature>                        # convert only
npm run convert <project> <feature> -- --force             # re-convert
npm run convert <project> <feature> -- --keep-originals    # leave sources beside their .md
```

Same end state as the upload route: the markdown replaces the source in
`requirements/`, and the original is **moved** (never deleted) to
`original-files/requirements/<Sub>/`, so `requirements/` holds markdown only.

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
is the human approval gate and Confluence/Jira publishing — those live in the
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

**Reserved feature names:** `capabilities`, `personas`, `app`, `all`, `baseline`, plus the
project's own folder names (`solutions`, `documents`, `design`, `original-files`,
`outputs`). A feature by one of those names would be unreachable from the CLI and
would appear as a feature in the target picker.

### Start a run from the CLI

```bash
npm run orch -- run requirements --project SADA --feature interim-benefit \
  --confluenceSpace SADA --jiraProjectKey SADA
```

Every `--key value` after the workflow name becomes a workflow param and reaches
the agent's prompt, so a stage needing extra context needs no code change. The
command starts the issue and advances it as far as it will go — which is to the
first gate — and prints the gate id and the command to approve it.

While `npm run dev` is running, use the HTTP API instead (PGlite is
single-writer):

```bash
curl -sS -X POST http://127.0.0.1:3100/issues -H 'Content-Type: application/json' \
  -d '{"workflow":"requirements","params":{"project":"SADA","feature":"interim-benefit","confluenceSpace":"SADA"}}'
```

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
  once is what stops them diverging. Paths carry an explicit `scope`
  (`project`/`feature`), because a feature stage routinely depends on a project
  artefact.
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
- `scripts/confluence-attach.mjs <pageId> <file…>` — the ONLY supported way to put
  a file on a Confluence page. Used by every publishing agent's Phase 2 to upload
  its Mermaid PNGs (and `personas.json`, `capability-map.json`, `test-cases.csv`).
  Reads `ATLASSIAN_SITE_URL`/`EMAIL`/`API_TOKEN` from the environment or
  `scyne-chatbot/.env`, authenticates with Basic auth against the **site domain**,
  and is idempotent — re-uploading a filename replaces that attachment in place
  rather than duplicating it, which is what a revision needs. Prints the
  `<ac:image>` snippet for each image so the agent can paste it into the body.
  > It exists because the Atlassian MCP **has no attachment scope** and never
  > will (see the Mermaid → PNG note above). Any agent hand-rolling a curl with
  > the `~/.mcp-auth` token gets a 401/403 and, historically, published the page
  > with its diagrams missing and said nothing.
- `scripts/extract-brand.mjs <url> <project>` — see *Brand the companion app*.
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
| `<tool_use_error>Unknown skill: <slug></tool_use_error>` mid-run | `.claude/skills/` was never populated on this clone. Claude Code discovers skills there, not from `./skills/`, and `.claude/` is gitignored. | `npm run link-skills`, then confirm `ls -l .claude/skills` shows one symlink per skill. |
| Agent run fails instantly with `System prompt file not found` | The agent's `bundlePath` in `orchestrator.config.ts` names a file that is not there. | `curl -s localhost:3100/agents/<key>/bundle` — it reports the missing path rather than 404ing. Create the bundle or clear the path. |
| A CLI verb fails on a database lock | PGlite is single-writer and `npm run dev` / `orch serve` holds it. | Use the HTTP API (`curl -s localhost:3100/issues`), or stop the server. The CLI says which. |
| An issue sits at `blocked` | A step failed. The blocking comment names it — a non-zero `exec`, a missing `produces` file, an unreadable `reads` file, or an agent that exited non-zero. | Fix the cause, then Resume from the console's Issues tab (or `POST /issues/:id/advance`). It restarts at the step that blocked, not from the beginning. |
| An issue sits at `todo` and nothing happens | The process died mid-run and orphan recovery returned it to `todo` at boot. | Resume it, as above. |
| Approving does nothing visible for a minute | Correct: the decision returns 202 and the publish step runs in the background. | Watch `#runs` in the console, or poll `GET /issues/{id}`. |
| Published Confluence page has no diagrams (or `401 scope does not match` on upload) | Something tried to attach PNGs through the Atlassian MCP, which has **no attachment scope** and never will. | Attachments go through `node scripts/confluence-attach.mjs <pageId> <files…>`, which uses `ATLASSIAN_API_TOKEN` from `scyne-chatbot/.env`. Re-authorising the MCP does not add the scope. |
| Atlassian MCP OAuth fails with "Supported sites required" | The logged-in Atlassian account has no Jira/Confluence site. | Switch accounts, or create a free Atlassian Cloud trial site, then re-run `npm run oauth`. |
| A stage runs as the wrong stage | The chatbot's title → workflow mapping broke — it parses a generated markdown description, which nothing type-checks. | `npm run check:routing`. It asserts every title and description shape the chatbot builds. |
| Chatbot shows "undefined" for a parameter | Frontend reading an old field name. | Search for the renamed field across `src/`. |
| `/api/features` returns `{}` | `projects/` missing, or `WORKSPACE_PATH` pointing elsewhere. | `mkdir projects/<project>/<feature>/...`, restart the dev server. |
| Refresh loses the workflow | `localStorage.scyne_parent_issue_id` cleared. | The workflow status panel's "New session" button starts over; otherwise it restores automatically. |

---

If you're about to make a significant change, sketch the touched files first — most changes ripple through several:

- `scripts/pipeline.mjs` — the stage graph. Four consumers read it; a change here changes what every one of them believes a stage requires.
- `orchestrator.workflows.ts` — how a stage becomes steps, and the generate / revise / publish prompts.
- `orchestrator.config.ts` — the org chart, budgets, adapters.
- `agent-instructions/<agent>.thin.md` — that agent's domain instructions. No re-push needed; the file is read at spawn time.
- `skills/<slug>/SKILL.md` — the actual method. Symlinked into `.claude/skills/`, so an edit is live immediately.
- `scyne-chatbot/server/orchestrator.ts` — title → workflow mapping. Run `npm run check:routing` after touching it.
- `scyne-chatbot/server/llm.ts` (system prompt + tool schema), `scyne-chatbot/src/App.tsx` (state + rendering), `scyne-chatbot/.env` (defaults).
