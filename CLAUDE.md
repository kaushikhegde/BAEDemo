# Scyne Requirements Generator — CLAUDE.md

This file is the **orientation only**. It is loaded into every session, so it
stays short on purpose. The detail lives in `docs/` and is **not** loaded
automatically — open the one you need before changing anything it covers.

## Answer concisely

Keep replies short and on point. Lead with the answer, name the file and line,
skip the preamble and the recap. Explain the mechanism only when it changes what
the reader does next. Long, structured write-ups are for when they are asked
for — not the default.

## Where the detail lives

| Read before touching | File |
|---|---|
| The workflow engine, console auth, the HTTP API, stopping/retrying a run, the revision flow, staleness, PGlite gotchas | [`docs/engine.md`](docs/engine.md) |
| A `SKILL.md`, an `agent-instructions/*.thin.md`, or a generated prompt | [`docs/skills-reference.md`](docs/skills-reference.md) |
| What each of the nine deliverables is, what gates on what, the full folder tree, read-down / read-up staging | [`docs/deliverables.md`](docs/deliverables.md) |
| Anything that writes to a client's Confluence/Jira or Azure DevOps | [`docs/publishing.md`](docs/publishing.md) |
| Adapters, budgets, model pricing, cost attribution, blob storage, per-step scratch trees | [`docs/configuration.md`](docs/configuration.md) |
| `scyne-chatbot/` — every backend endpoint, the Gemini flow, the frontend | [`docs/chatbot.md`](docs/chatbot.md) |
| Running things by hand: staging, `extract`, reset, branding, shipping the CLI | [`docs/operations.md`](docs/operations.md) |
| What each script in `scripts/` does and why | [`docs/scripts.md`](docs/scripts.md) |
| A run failed, a stage refused, something reads as broken | [`docs/troubleshooting.md`](docs/troubleshooting.md) |

## What this project is

A local end-to-end workflow that turns a client's raw discovery artefacts
(transcripts, SOPs, policy docs, UI screens, notes) into a delivery pack.

It works at **two levels**, and getting this distinction right is the thing
everything else hangs off:

- **PROJECT level** describes the CLIENT ORGANISATION. Generated once; every
  feature reads it. Capability map + process model, personas + journeys, and
  the companion app.
- **FEATURE level** describes ONE slice of work. Repeated per feature. Product
  summary + stories, UI mockups, data model, solution architecture, test pack,
  and optionally a solution design.

> When in doubt: would a second feature for the same client want its own copy?
> If no, it is project-level.

Nine deliverables, in [`docs/deliverables.md`](docs/deliverables.md). The short
version of what gates on what: **stages 1 and 9 have no prerequisite; stage 2
needs stage 1; stage 3 needs nothing; stages 4–8 each need that feature's
Product Summary only.** They consume each other's output when it exists and say
so, but never block waiting for it.

The chatbot does two things: it **runs** stages, and it **revises** what they
produced ("add an SLA breach field", "the personas are too generic"). A revision
is a full round-trip to the specialist that owns the artefact, which revises
rather than regenerates, raises its own gate, and on approval updates the
existing wiki page rather than creating a second one.

## How it runs

The user drives everything from a Scyne-branded chatbot UI. The chatbot does not
do the work — it posts a **workflow** to **`@scyne/orchestrator`**
(`packages/orchestrator/`), which runs the agent org on the local machine via
Claude Code. A workflow names its own assignee, so there is no routing layer.

```bash
npm run dev          # orchestrator on :3100 (console at /orch), chatbot on :5173
```

| | |
|---|---|
| **Console** | `http://127.0.0.1:3100/orch` — sign in, then runs, issues, gates, org chart, skills, agent instructions, budgets, config, health, plus the admin tabs |
| **API docs** | `http://127.0.0.1:3100/docs` — generated from `openapi.yaml` |
| **Chatbot** | `http://127.0.0.1:5173` |

### The workflow engine, in one table

Everything is a **workflow**: an ordered list of steps against one issue. Five
step types, and they are the whole vocabulary:

| Step | Does |
|---|---|
| `exec` | runs a shell command. Non-zero exit blocks the issue with the stderr tail as a comment |
| `agent` | runs one Claude Code process with a system-prompt bundle and a prompt. `reads` pulls named files into the prompt as `{variables}` |
| `attach` | records outputs as work-products. A missing file blocks **before** any gate is raised |
| `gate` | raises the human approval gate and parks |
| `flow` | spawns a child workflow. Present but unused |

The engine owns every status transition (`todo → in_progress → in_review →
done/blocked`), parks at anything waiting on a human, and **narrates every step
as a comment on its issue** — that timeline is what the chatbot's Activity panel
shows. One issue, one workflow, one gate per artefact.

**Workflows are compiled, not hand-written.** `orchestrator.workflows.ts` turns
each stage in `scripts/pipeline.mjs` into:

```
exec  stage.mjs  →  agent generate  →  exec validator  →  attach  →  gate
                                              →  agent publish  →  exec render app
```

so adding a stage to the pipeline graph adds its workflow for free. Eighteen
exist: nine `<stage>`, eight `revise-<stage>`, and `baseline`. A `revise-` is
the same stage in another mode (`variantOf` + `variant` on the `WorkflowDef`),
with its own separate budget.

### What the chatbot posts

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

That mapping happens in `scyne-chatbot/server/orchestrator.ts` and parses a
generated markdown description, which nothing type-checks.
**`npm run check:routing` after touching either file.**

Staging is shared with the CLI: every workflow's first step is
`node scripts/stage.mjs <project> ["<feature>"] <stage>`, the same code path
`npm run stage` uses.

## The pipeline, in order

The graph lives in **`scripts/pipeline.mjs`** — which stages exist, what level
each runs at, what each produces, hard-requires and opportunistically reads.
The CLI, the renderer and the chatbot server all import it.

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

**`ui` at position 4 is deliberate**, ahead of the data model: a client wants to
see screens before committing to a schema. The cost is real, so `mockups.json`
records which inputs it had in `generatedFrom` and the staleness check offers a
refresh once the data model and test pack exist.

`design` is an **optional side stage** outside the numbered order — a narrower,
component-level deliverable overlapping stage 6, excluded from `all`.

## Agents

Twelve, addressed **by key**. The org chart in `orchestrator.config.ts` is the
source of truth and is reconciled into the database on every boot. Each worker's
system prompt is `agent-instructions/<agent>.thin.md` — domain only; the engine
does status transitions, API calls and idempotency.

| Key | Agent | Bundle | MCP |
|---|---|---|---|
| `ceo` / `pm` / `businessLead` | CEO, Delivery Lead, Business Lead — org chart only | — | — |
| `archLead` | Architecture Lead | `architect-lead.thin.md` | yes |
| `ba` | BA | `ba.thin.md` | yes |
| `qaArchitect` | QA Architect | `qa-architect.thin.md` | yes |
| `capArchitect` | Capabilities Process Architect | `capabilities-process-architect.thin.md` | yes |
| `serviceDesigner` | Service Designer | `service-designer.thin.md` | yes |
| `dataModeler` | Data Modeler | `data-modeler.thin.md` | yes |
| `solutionArchitect` | Solution Architect | `solution-architect.thin.md` | yes |
| `uxDesigner` | UX Designer | `ux-designer.thin.md` | no |
| `ui` | Developer | `ui.thin.md` | no |

## The skills

Eight company skills under `./skills/<slug>/SKILL.md`, invoked **by name**.
Claude Code discovers them from `.claude/skills/`, symlinked by
**`npm run link-skills`**. `.claude/` is gitignored, so **every fresh clone
needs that command** or every run dies with `Unknown skill: <slug>`.

Editing a skill is editing its `SKILL.md` — on disk, or in the console's Skills
tab. Every skill has a `## Revision mode` section; the discipline is a small
diff, because a regenerate-from-scratch defeats the gate that follows.

| Skill | Owner | Level | Writes |
|---|---|---|---|
| `capability-process-map` | Capabilities Process Architect | project | `capability-map.json`, `process-model.json`, `capability-process.md` |
| `persona-journey-map` | Service Designer | project | `personas-journeys.md`, `personas.json`, `journey-map.json` |
| `requirement-generator` | BA | feature | 5 files in the feature's `outputs/` |
| `ui-mockup-generator` | UX Designer | feature | `solutions/UI/outputs/mockups.json` — **JSON only, never HTML** |
| `salesforce-data-modeler` | Data Modeler | feature | `outputs/salesforce-data-model.md` |
| `salesforce-service-cloud-architecture` | Solution Architect | feature | `outputs/solution-architecture.md` |
| `requirements-test-case-generator` | QA Architect | feature | `outputs/test-cases.md` (+ optional `.csv` / `.feature`) |
| `solution-design-document` | Architecture Lead | feature | `outputs/solution-design.md` (optional) |

Inputs, disciplines and the three layers of instruction an agent receives:
[`docs/skills-reference.md`](docs/skills-reference.md).

## Folder layout

```
requirement-generator/                         workspace root (cwd for all agents)
├── CLAUDE.md · .mcp.json · orchestrator.config.ts · orchestrator.workflows.ts
│
├── projects/<project>/                        ===== PROJECT LEVEL =====
│   ├── description.md          PROJECT DEFINITION — read by EVERY skill first
│   ├── documents/              client-wide docs. .md ONLY (uploads convert on arrival)
│   ├── original-files/         archived upload sources — moved, never deleted
│   ├── design/                 theme.json, persona/journey artwork, example screens
│   ├── .published.json         wiki page identity per artefact (DERIVED)
│   └── solutions/
│       ├── Extracts/           <hash>.extract.json, one per document
│       ├── Capabilities/       capability-map.json, process-model.json, capability-process.md
│       └── Experience/         personas-journeys.md, personas.json, journey-map.json
│
└── projects/<project>/<feature>/               ===== FEATURE LEVEL =====
    ├── requirements/           SOP/ · Transcripts/ · Notes/ · UI/ · templates/ · project/
    ├── outputs/                extraction.json, product-summary.md, stories.json,
    │                           stories.md, gaps.md
    └── solutions/              UI/ · DataModel/ · Architecture/ · QA/ · Design/
                                each with its own staged inputs and outputs/

├── skills/                 the company's skills — symlinked into .claude/skills/
├── agent-instructions/     one <agent>.thin.md per worker
├── generated-apps/<project>/   ONE page per project + mockups/<feature>/
├── examples/               gold-standard reference docs (house style fallback)
├── datamodel-reference/    STATIC Salesforce PSS object catalogue
├── docs/                   the reference material this file points at
├── scyne-chatbot/          React + Vite frontend, Express backend
└── packages/orchestrator/  @scyne/orchestrator — engine, HTTP API, console
```

The full tree, and the read-down / read-up staging rules, are in
[`docs/deliverables.md`](docs/deliverables.md). The short version: every feature
stage stages the parent project's material into its working folder first, and
every project stage reads the project's own `documents/` **and every feature's**
discovery documents, tagged by scope.

## The chatbot (`scyne-chatbot/`)

React + Vite on **5173**, Express on **4000**, Vite proxies `/api/*`.
Three rules that are load-bearing everywhere else:

- **One `.env`, at the workspace root.** Every process reads that file and no
  other. The chatbot's port is **`CHATBOT_PORT`**, not `PORT`.
- **The ROW is what a project IS; the tree is derived from it.** `POST
  /api/projects` writes the database row FIRST and a failure is fatal. The one
  exception is documents: "what documents exist" is answered from disk.
- **The title → workflow mapping parses generated markdown.** Run
  `npm run check:routing` after touching `server/orchestrator.ts` or
  `server/llm.ts`.

Every endpoint, its 409 codes and the Gemini flow: [`docs/chatbot.md`](docs/chatbot.md).

## Configuration

`orchestrator.config.ts` is the whole of it — org chart, adapter registry,
defaults, and the workflows compiled from `scripts/pipeline.mjs`. Reconciled
into the database on **every** boot, so the file cannot drift from what runs.

- **Adapters**: `claude_local`, `codex`, `gemini`, `azure_foundry`.
  `SCYNE_ADAPTER` is the org default; `scyne adapter set <name> --project <p>`
  overrides per project.
- **Budgets** are a ceiling, not a target: 10M tokens / $15 / 45 min per run.
- **Cost has two columns and they are never merged**: `runs.cost_usd` (what the
  CLI reported) and `runs.est_cost_usd` (ours). **`CODEX_MODEL` must be set** or
  every Codex run shows `—`.
- **Storage** is Postgres for metadata, Azure Blob for document bytes. Disk is a
  scratch surface, one tree per step, deleted after it.

→ [`docs/configuration.md`](docs/configuration.md).

## Gotchas that cost money

Each of these has been a real failure. The full list is in
[`docs/troubleshooting.md`](docs/troubleshooting.md).

| | |
|---|---|
| `Unknown skill: <slug>` mid-run | `npm run link-skills` — `.claude/` is gitignored |
| An issue sits at `blocked` | The blocking comment names the step. Fix, then Resume — it restarts at that step |
| A CLI verb fails on a database lock | PGlite is single-writer and the server holds it. Use the HTTP API |
| A stage refuses `no documents` while `/docs` lists some | Rows in the database, files not on disk. `find projects/<p> -name '*.md'` is what the gate sees |
| A stage refuses `documents_not_ready` | `curl /api/extract-status/<project>` names which document and why |
| One document will not extract | Its reason, `attempts` and first/last failure times are in `<hash>.extract.failed.json` beside the extract. Retry just that one with `retry_extraction` (or `--doc <id>`); a document that fails the same way twice will not extract — replace it |
| An extraction ran but no budget stopped it | The map pass records one run row per document (so `/spend` and the transcripts are right), but the engine's **per-agent budget ceiling does not apply** — it cannot cap a process it did not spawn |
| `unknown placeholder {X}` after a gate | A doubled brace is a literal: `interpolate` substitutes `{name}` and leaves `{{NAME}}` alone |
| A publish "succeeded" with zero work items | The PAGE goes through the MCP; the **BACKLOG never does** — `scripts/jira-issues.mjs` / `ado-workitems.mjs` run as a separate step |
| A Confluence page renders with diagrams missing | Its OAuth grant carries no attachment scope. `scripts/confluence-publish.mjs --render-mermaid` |
| `attach` blocks on a file the agent definitely wrote | `produces[]` is relative to the stage's OWN level root, not the workspace root |
| An `exec` step leaked a path to a client | An `exec` narrates its `label`, never its command. No label means "running" |
| A document over ~40 KB fails to publish | Use `scripts/ado-publish.mjs`, not a tool call |

**Publishing has TWO back ends and the rules are unforgiving.** `PUBLISH_TARGET`
picks the default, but a project **keeps the system it has already published
into**, resolved by `resolvePublishTarget` (`scripts/lib/publish-shared.mjs`),
never from the environment variable. Read
[`docs/publishing.md`](docs/publishing.md) before touching any of it.

## Helper scripts (`scripts/`)

→ [`docs/scripts.md`](docs/scripts.md) — what each one does, and the reasoning it
encodes. Read the entry before changing a script or adding one.

| Script | |
|---|---|
| `pipeline.mjs` | **the pipeline, as data**. Four consumers import it |
| `stage.mjs` | converts, stages down (or up), refuses a stage whose prerequisite is missing |
| `extract-documents.mjs` · `extract-state.mjs` · `validate-extracts.mjs` | one extract per document, keyed by content hash |
| `render-companion-app.mjs` · `render-mockups.mjs` | own every pixel. Never hand-edit the emitted HTML |
| `validate-experience.mjs` · `render-capability-map.mjs --validate-only` | the contract guards. Non-zero exit is a blocker |
| `confluence-publish.mjs` · `jira-issues.mjs` · `ado-publish.mjs` · `ado-workitems.mjs` | the two publishing paths |
| `sync-documents.mjs` · `convert-to-md.mjs` · `extract-brand.mjs` · `audit-a11y.mjs` · `build-cli.mjs` | |

## Conventions

- **Australian English** in all generated content (Behaviour, Authorise, Organisation).
- **Story summary**: `<L4.N.M> As an <role>, I want <verb-phrase>, So that <outcome-phrase>.`
- **Personas**: full name + abbreviation, e.g. `Eligibility Officer (EO)` — and a
  feature **reuses the project's persona names verbatim**. Coining a new name for
  a persona the project has already evidenced is the most common way this
  pipeline produces documents that contradict each other.
- **AC bullets**: declarative sentences, 2–4 per story, not Gherkin.
- **Product Summary placeholders** at 3.3.1, 7, 8, 9, 10, 11 are preserved
  verbatim ("Placeholder – Maintained manually. Do not populate via automation.").
- **One pass per agent wake.** Agents EXIT after their phase's work is done.
- **Reserved feature names**: `capabilities`, `personas`, `app`, `all`,
  `baseline`, `solutions`, `documents`, `design`, `original-files`, `outputs`.
- **Source mapping** in `extraction.json` — every story maps back to its input file.
- **Issue statuses**: `todo` fires the assignee · `in_progress` checked out ·
  `in_review` gate raised · `done` · `blocked` needs a human · `paused` resumes
  from the same step · `cancelled` does not resume.

## Before a significant change

Sketch the touched files first — most changes ripple through several:

- `scripts/pipeline.mjs` — the stage graph. Four consumers read it.
- `orchestrator.workflows.ts` — how a stage becomes steps, and the prompts.
- `orchestrator.config.ts` — org chart, budgets, adapters.
- `agent-instructions/<agent>.thin.md` — read at spawn time, no re-push needed.
- `skills/<slug>/SKILL.md` — symlinked, so an edit is live immediately.
- `scyne-chatbot/server/orchestrator.ts` — title → workflow. `npm run check:routing`.
- `scyne-chatbot/server/llm.ts`, `src/App.tsx` — system prompt, tool schema, UI state.
- `packages/orchestrator/` — must never import `scripts/pipeline.mjs`,
  `orchestrator.config.ts`, or anything under `projects/`. That is the
  discipline that keeps it a generic library.
