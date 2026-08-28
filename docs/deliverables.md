# The deliverables, and the folder tree in full

Moved out of `CLAUDE.md`. The two levels, the nine outputs, what gates on
what, and how material is staged down to a feature and up to a project.

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

