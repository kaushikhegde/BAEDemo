# Scyne Requirements Generator — CLAUDE.md

This document is the orientation guide for anyone (Claude included) working on this repository. Read it before making changes.

## What this project is

A local end-to-end workflow that takes raw discovery artefacts for a single feature (meeting transcripts, SOP/policy docs, UI screens, optional notes) and produces:

1. A **Confluence-ready Product Summary** (11-section markdown).
2. A set of **Jira-ready user stories** (Atlassian Cloud REST v3 payloads).
3. A **Salesforce Data Model Impact analysis** (objects, custom fields, Mermaid ER diagram), published to its own Confluence page.
4. A **Salesforce Solution Design Document** (declarative-first component design, Mermaid flow diagram), published to its own Confluence page.
5. A **working Vite + React + shadcn/ui app** scaffolded from the Product Summary, with WCAG 2.0 AA auto-fixes applied.
6. A **Business Capability Map + L1/L2/L3 Process Model**, rendered as a self-contained interactive **HTML** page (local artefact — nothing is published).
7. A **Salesforce Service Cloud Solution Architecture Document** (capability-to-component map, Flow/LWC/Apex inventory with a justification per custom component, integration interface catalogue, ADRs, architecture diagrams), published to its own Confluence page.
8. A **test pack** (executable test cases, requirements traceability matrix, coverage gap analysis, optional CSV/Gherkin exports), published to its own Confluence page.

Deliverables 1→3→4 form a **sequential, human-gated pipeline** (requirements → data model → solution design); each stage needs the previous stage's approved output. Deliverable 5 (the UI app) is a parallel branch off the Product Summary. Deliverable 6 (the capability + process map) is **standalone and ungated** — the **Capabilities Process Architect** reads the same discovery documents the BA reads, so it can run before, after, or instead of the requirements flow. Deliverables 7 and 8 (**Solution Architect**, **QA Architect**) gate on the Product Summary **only**: they consume the data model and each other's output when those exist and say so in their own documents, but never block waiting for them.

> **Solution design (4) vs solution architecture (7)** are two different deliverables that may both exist for one feature. The Architecture Lead runs `solution-design-document` in `solutions/Design/`; the Solution Architect runs `salesforce-service-cloud-architecture` in `solutions/Architecture/`. Their issue title prefixes share their first two words, so the Delivery Lead must read as far as `design` / `architecture` before routing.

The user drives everything from a Scyne-branded chatbot UI. The chatbot doesn't do the work itself — it orchestrates through **Paperclip**, which runs the Scyne agent org on the local machine via Claude Code. The **Delivery Lead** is the single orchestrator: it routes each request by title prefix to the owning worker — **BA** (requirements), **Data Modeler** (data model), **Architecture Lead** (solution design), and **Developer** → **UX Auditor** (UI build). Every worker raises its own human approval gate; the data-model/solution-design/requirements stages then publish to Atlassian themselves. The Data Modeler reports to the Architecture Lead on the org chart; the Architecture Lead, BA, Developer and UX Auditor all sit under the Delivery Lead's dispatch.

> **Mermaid → PNG for Confluence:** all Mermaid diagrams (Product Summary flow, data model ER, solution-design flow) are rendered to **PNG** locally via `npx -y @mermaid-js/mermaid-cli` and embedded with `<ac:image>` before publishing. PNG (not SVG) is used deliberately — Confluence renders PNG inline reliably, whereas SVG attachments often show only as a download link.

## The agent flow

```
chatbot UI
   │  POST /api/trigger            → "Generate requirements — …"
   │  POST /api/data-model/trigger → "Generate data model — …"
   │  POST /api/solution-design/trigger → "Generate solution design — …"
   │  POST /api/capability-map/trigger → "Generate capability map — …"
   │  POST /api/solution-architecture/trigger → "Generate solution architecture — …"
   │  POST /api/test-cases/trigger → "Generate test cases — …"
   │  POST /api/ui-agent/trigger   → "Build UI — …"
   │  (each creates a top-level Paperclip issue, status=todo, assigned to the Delivery Lead)
   ▼
Delivery Lead — routes by title prefix to the owning worker
   ├─ classifies issue intent by title prefix:
   │    "Generate requirements — …"     → REQUIREMENTS flow → BA
   │    "Generate data model — …"       → DATA MODEL flow → Data Modeler
   │    "Generate solution design — …"  → SOLUTION DESIGN flow → Architecture Lead
   │    "Generate capability map — …"   → CAPABILITY MAP flow → Capabilities Process Architect
   │    "Generate solution architecture — …" → SOLUTION ARCHITECTURE flow → Solution Architect
   │    "Generate test cases — …"       → TEST CASES flow → QA Architect
   │    "Build UI — …"                  → UI flow → Delivery Lead drives Developer, then UX Auditor
   │
   ├─ REQUIREMENTS flow: creates a child issue assigned to the BA (status=todo)
   │     ▼
   │   BA — runs in two phases
   │      ├─ PHASE 1: reads inputs from projects/<project>/<feature>/requirements/
   │      │          runs the `requirement-generator` skill → outputs/* (5 files)
   │      │          attaches them as work-products, raises an approval gate
   │      └─ PHASE 2 (after human approves): uses the `atlassian` MCP to
   │                 create the Confluence page + Jira stories
   │
   ├─ DATA MODEL flow (needs product-summary.md): child issue assigned to the Data Modeler (status=todo)
   │     ▼
   │   Data Modeler — works in solutions/DataModel/, two phases
   │      ├─ PHASE 1: stages inputs (copies outputs/product-summary.md → productsummary/;
   │      │          seeds datamodel-reference/ from the global catalogue if empty),
   │      │          runs the `datamodel-impact-analysis` skill
   │      │          → solutions/DataModel/outputs/datamodel-impact.md
   │      │          attaches it, raises an approval gate
   │      └─ PHASE 2 (after human approves): renders the Mermaid ER diagram → PNG,
   │                 creates a STANDALONE Confluence page "<feature> — Data Model Impact"
   │
   ├─ SOLUTION DESIGN flow (needs solutions/DataModel/outputs/datamodel-impact.md):
   │  child issue assigned to the Architecture Lead (status=todo)
   │     ▼
   │   Architecture Lead — works in solutions/Design/, two phases
   │      ├─ PHASE 1: stages inputs (copies the product summary → productsummary/;
   │      │          copies the Data Modeler's output → DataModel/),
   │      │          runs the `solution-design-document` skill
   │      │          → solutions/Design/outputs/solution-design.md
   │      │          attaches it, raises an approval gate
   │      └─ PHASE 2 (after human approves): renders the Mermaid flow diagram → PNG,
   │                 creates a STANDALONE Confluence page "<feature> — Solution Design"
   │
   ├─ CAPABILITY MAP flow (NO prerequisite): child issue assigned to the
   │  Capabilities Process Architect (status=todo)
   │     ▼
   │   Capabilities Process Architect — works in solutions/Capabilities/, two phases
   │      ├─ PHASE 1: stages every .md under the feature (requirements/{SOP,Transcripts,
   │      │          Notes} plus any reference doc tree) into documents/<category>/,
   │      │          runs the `capability-process-map` skill
   │      │          → outputs/{capability-map.json, process-model.json, capability-process.md},
   │      │          renders outputs/capability-process.html via
   │      │          `node scripts/render-capability-map.mjs <project> <feature>`,
   │      │          attaches all four, raises an approval gate
   │      └─ PHASE 2 (after human approves): verifies the artefacts, posts the summary
   │                 + the interactive-view URL, closes. NOTHING is published.
   │
   ├─ SOLUTION ARCHITECTURE flow (needs outputs/product-summary.md ONLY):
   │  child issue assigned to the Solution Architect (status=todo)
   │     ▼
   │   Solution Architect — works in solutions/Architecture/, two phases
   │      ├─ PHASE 1: stages inputs (product summary → productsummary/; any
   │      │          solutions/DataModel/outputs/*.md → DataModel/ if present;
   │      │          landscape docs from requirements/Notes/ → landscape/),
   │      │          runs the `salesforce-service-cloud-architecture` skill
   │      │          → solutions/Architecture/outputs/solution-architecture.md
   │      │          attaches it, raises an approval gate
   │      └─ PHASE 2 (after human approves): renders EVERY Mermaid diagram → PNG,
   │                 creates a STANDALONE Confluence page "<feature> — Solution Architecture"
   │
   ├─ TEST CASES flow (needs outputs/product-summary.md ONLY):
   │  child issue assigned to the QA Architect (status=todo)
   │     ▼
   │   QA Architect — works in solutions/QA/, two phases
   │      ├─ PHASE 1: stages inputs (product summary + stories → productsummary/;
   │      │          data model → DataModel/; solutions/Architecture/outputs/ and
   │      │          solutions/Design/outputs/ → Architecture/ — all optional),
   │      │          runs the `requirements-test-case-generator` skill
   │      │          → solutions/QA/outputs/test-cases.md (+ optional .csv / .feature)
   │      │          attaches them, raises an approval gate
   │      └─ PHASE 2 (after human approves): creates a STANDALONE Confluence page
   │                 "<feature> — Test Cases", attaching the CSV if one was produced
   │
   └─ UI flow: Delivery Lead dispatches the Developer and UX Auditor directly, as
              SIBLINGS under the Build UI issue (not a chain). The Delivery Lead is re-woken
              automatically (issue_children_completed) after each child finishes.

      Sub-phase A → child issue assigned to Developer (status=todo)
         ▼
       Developer
          ├─ reads design references + BA outputs
          ├─ scaffolds a Vite + React + shadcn/ui app into generated-apps/<project>-<feature>/
          ├─ on "push to github <url>": pushes to branch ui/<project>-<feature>, records branch/repoUrl in the registry
          ├─ on "approve": leaves branch/repoUrl null in the registry (audit-only)
          └─ marks its issue done → Delivery Lead auto-woken

      Sub-phase B → Delivery Lead reads generated-apps/registry.json, dispatches UX Auditor (status=todo)
         ▼
       UX Auditor
          ├─ runs WCAG 2.0 AA checks against the generated app
          ├─ auto-fixes safe violations (contrast, alt-text, focus rings, etc.)
          ├─ commits a11y: fixes onto the branch (or audit-only if branch is null)
          └─ marks its issue done → Delivery Lead auto-woken

      Sub-phase C → Delivery Lead posts the summary and marks the Build UI issue done
```

The chatbot polls `/api/status/:issueId` every 3 seconds, surfaces comments as a live activity timeline, renders approval gates inline with an Approve / Reject card, and shows Confluence + Jira links the moment they appear in BA's comments.

## Folder layout

```
requirement-generator/                         workspace root (cwd for all agents)
├── CLAUDE.md                                  this file
├── .mcp.json                                  project-scope MCP config (atlassian)
├── projects/<project>/<feature>/
│   ├── requirements/
│   │   ├── SOP/            (one or more .docx/.txt — SOP / policy docs)
│   │   ├── Transcripts/    (one or more .docx/.txt/.md)
│   │   ├── Notes/          (optional — additional notes)
│   │   ├── UI/             (one or more .png/.jpg mockups)
│   │   └── templates/      (optional — per-project house-style templates; override examples/)
│   ├── design/             (consumed by the Developer, NOT the BA)
│   │   ├── style-guides/   (palette, typography, tokens, brand voice)
│   │   └── example-screens/(visual reference)
│   ├── outputs/            (BA writes here; downstream stages read product-summary.md from here)
│   │   ├── extraction.json
│   │   ├── product-summary.md       (BA)
│   │   ├── stories.json
│   │   ├── stories.md
│   │   └── gaps.md
│   └── solutions/          (downstream pipeline working folders — each stage stages its own inputs)
│       ├── DataModel/                       (the Data Modeler's working folder)
│       │   ├── productsummary/              (input — copied from outputs/product-summary.md)
│       │   ├── datamodel-reference/         (input — PSS catalogue; seeded from the global ./datamodel-reference/ if empty, curated copies win)
│       │   └── outputs/datamodel-impact.md  (output — fixed name, ER diagram inline)
│       ├── Design/                          (the Architecture Lead's working folder)
│       │   ├── productsummary/              (input — copied from outputs/product-summary.md)
│       │   ├── DataModel/                   (input — copied from solutions/DataModel/outputs/)
│       │   └── outputs/solution-design.md   (output — fixed name, flow diagram inline)
│       ├── Architecture/                    (the Solution Architect's working folder)
│       │   ├── productsummary/              (input — copied from outputs/product-summary.md)
│       │   ├── DataModel/                   (input, optional — copied from solutions/DataModel/outputs/)
│       │   ├── landscape/                   (input, optional — current-state / integration docs)
│       │   └── outputs/solution-architecture.md  (output — fixed name, several Mermaid diagrams)
│       ├── QA/                              (the QA Architect's working folder)
│       │   ├── productsummary/              (input — product summary + stories)
│       │   ├── DataModel/                   (input, optional)
│       │   ├── Architecture/                (input, optional — from solutions/Architecture/ and/or solutions/Design/)
│       │   └── outputs/test-cases.md        (output — fixed name, + optional .csv / .feature)
│       └── Capabilities/                    (the Capabilities Process Architect's working folder)
│           ├── documents/<category>/        (input — every .md under the feature, staged by category)
│           ├── capability-reference/        (optional input — house capability taxonomy)
│           └── outputs/                     (capability-map.json, process-model.json,
│                                             capability-process.md, capability-process.html)
├── datamodel-reference/    (STATIC global Salesforce PSS / Social-Insurance object catalogue — seeds each feature's solutions/DataModel/datamodel-reference/)
├── skills/                 (registered company skills — source of truth, registered with Paperclip by the bootstrap)
│   ├── requirement-generator/SKILL.md
│   ├── datamodel-impact-analysis/SKILL.md
│   ├── solution-design-document/SKILL.md
│   ├── capability-process-map/SKILL.md
│   ├── salesforce-data-modeler/SKILL.md
│   ├── salesforce-service-cloud-architecture/SKILL.md
│   └── requirements-test-case-generator/SKILL.md
├── generated-apps/<project>-<feature>/        Developer writes the scaffolded React app here
├── examples/               (gold-standard reference docs — house style for the BA; the FALLBACK when a project has no requirements/templates/)
│   ├── gold-product-summary.pdf
│   └── gold-story.doc
├── agent-instructions/     (per-agent AGENTS.md JSON payloads, pushed to Paperclip via API)
│   ├── pm.json             (Delivery Lead)
│   ├── ba.json
│   ├── data-modeler.json
│   ├── architect-lead.json
│   ├── capabilities-process-architect.json
│   ├── solution-architect.json
│   ├── qa-architect.json
│   ├── ui.json
│   └── ux-auditor.json
├── scyne-chatbot/          (the React + Vite + Express chatbot — see its own README.md)
│   ├── server/             (Express backend)
│   │   ├── index.ts        (routes)
│   │   ├── llm.ts          (Gemini client + system prompt + tool schema)
│   │   ├── paperclip.ts    (Paperclip API client)
│   │   ├── types.ts
│   │   └── services/       (file router, gemini files, gemini live, transcript writer)
│   ├── src/                (React frontend; shadcn/ui in src/components/ui/)
│   ├── .env                (live config — do not commit)
│   ├── .env.example
│   └── package.json
└── (Paperclip is installed separately on the host, outside this repo — location varies per machine)
```

## IDs and configuration

**The live agent IDs are written to `.bootstrap/ids.json` by `npm run bootstrap`** (the chatbot reads `companyId` + `deliveryLeadAgentId` from there; the full `org` map exposes every role by spec key). The values below are the *placeholder* IDs baked into `agent-instructions/pm.json` — the bootstrap string-replaces them with the freshly-hired IDs before pushing the Delivery Lead's bundle, so they never need to be the real IDs by hand:

| Field                 | Placeholder in pm.json (swapped at bootstrap)                  |
| --------------------- | -------------------------------------------------------------- |
| Company               | `2131f183-3822-4eee-9370-4b5cafae7e29` (`Scyne`)                |
| Delivery Lead  | resolved at bootstrap (`org.pm` in `.bootstrap/ids.json`)             |
| BA | `7561c779-5c3f-4e3a-9dc2-0f13eb1851ec`                          |
| Data Modeler | `ddddddd1-dddd-4ddd-8ddd-dddddddddddd` (reports to the Architecture Lead) |
| Capabilities Process Architect | `ccccccc1-cccc-4ccc-8ccc-cccccccccccc` (reports to the Architecture Lead) |
| Solution Architect | `bbbbbbb1-bbbb-4bbb-8bbb-bbbbbbbbbbbb` (reports to the Architecture Lead) |
| QA Architect | `eeeeeee1-eeee-4eee-8eee-eeeeeeeeeeee` (reports to the Business Lead) |
| Architecture Lead | `aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaaa` (reports to the Delivery Lead) |
| Developer           | `f19feb64-3ccd-42b2-b0b7-f9dfe7273a94` (dispatched by the Delivery Lead)          |
| UX Auditor            | `43a9e518-99c5-4916-8b91-3ff89e0c00ba` (dispatched by the Delivery Lead)          |

The Delivery Lead dispatches all six workers (one child issue each, routed by title prefix). Org-chart reporting: BA → Business Lead; Data Modeler, Capabilities Process Architect → Architecture Lead; Architecture Lead, Developer, UX Auditor, UX Designer → Architecture Lead/Delivery Lead per `scripts/bootstrap.mjs`. The human approval gate between stages is what QAs each output — not the leads. The placeholder IDs (`ddddddd1-…`, `aaaaaaa1-…`, `ccccccc1-…`) are added to `OLD_IDS` in `scripts/bootstrap.mjs` and swapped exactly like the BA/Developer/UX placeholders.

In normal operation you don't hand-edit IDs — `npm run bootstrap` hires everything, swaps the placeholder IDs in `pm.json`, and writes `.bootstrap/ids.json`. If you change the placeholder UUIDs themselves (the values in `OLD_IDS` in `scripts/bootstrap.mjs` must match the ones written in `agent-instructions/pm.json`), keep both in sync. The Delivery Lead dispatches the BA, Data Modeler, Architecture Lead, Capabilities Process Architect, Developer, and UX Auditor — all six placeholder IDs are baked into `pm.json` and swapped at bootstrap.

## Paperclip (the orchestrator)

- Paperclip is cloned/installed separately on the host (location varies per machine — e.g. a sibling directory). It is **not** part of this repo; don't assume any absolute path to it.
- Runs locally at `http://127.0.0.1:3100` in `local_trusted (private)` deployment mode.
- API base: `http://127.0.0.1:3100/api`.
- **No authentication is required for any local API call.** Every request from localhost is automatically treated as the `local-board` user with admin rights. Do NOT add `Authorization` headers. Do NOT look for `PAPERCLIP_API_KEY`. This is the most common source of confusion — agent instructions all start with a reminder about this.
- The `requirement-generator` skill is a **registered company skill** — reference it by name (`requirement-generator`), never by filesystem path. Its source ships in this repo at `./skills/requirement-generator/SKILL.md` (project-relative); the bootstrap registers it with Paperclip, which materialises it into each agent's skills home automatically. Do NOT go looking for it under any Paperclip clone path.
- Start Paperclip per its own README (commonly `pnpm dev` in the Paperclip clone). Embedded PostgreSQL boots automatically.

### Key Paperclip endpoints used by the chatbot

| Method | Path                                              | Purpose                                           |
| ------ | ------------------------------------------------- | ------------------------------------------------- |
| POST   | `/api/companies/:companyId/issues`                | Create the parent issue, assigned to the Delivery Lead           |
| GET    | `/api/issues/:id`                                 | Read parent issue state                           |
| GET    | `/api/companies/:companyId/issues?parentId=…`     | List child issues (no `/issues/:id/children` GET) |
| GET    | `/api/issues/:id/approvals`                       | Read approval gates                                |
| GET    | `/api/issues/:id/comments`                        | Read comments (the activity feed)                  |
| GET    | `/api/issues/:id/work-products`                   | Read attached artefacts                            |
| POST   | `/api/approvals/:id/approve`                      | Resolve an approval gate                           |
| POST   | `/api/approvals/:id/reject`                       | Reject an approval gate                            |
| POST   | `/api/agents/:id/wakeup`                          | Force-wake an agent (rarely needed; `status=todo` auto-wakes) |
| PUT    | `/api/agents/:id/instructions-bundle/file`        | Upload AGENTS.md for an agent                      |

### Gotchas

- **Issue status must be `todo` to auto-fire** the assignee agent. `backlog` (the default if you don't pass `status`) is invisible to agent inboxes. Always set `status: "todo"` when creating issues for agents.
- **Children listing** has no dedicated endpoint; query `?parentId=…` on the company-level issue list.
- **Approval titles + descriptions live in `payload.title` / `payload.summary`**, not on the approval object. The Paperclip approval entity is `{id, type, status, payload, decisionNote, decidedByUserId, decidedAt, ...}` — `payload` is the human-facing content.
- **Heartbeats stay disabled per agent** (`runtimeConfig.heartbeat.enabled = false`). We wake agents via status transitions and `POST /agents/:id/wakeup` — not via a background polling loop. The server-side heartbeat service picks up queued runs within ~30s.
- **Force a fresh Claude session** with `{"forceFreshSession": true}` in the wakeup body if an agent is stuck on a stale conclusion from a previous run.

## The Skills

Seven registered company skills live under `./skills/<slug>/SKILL.md`. Each worker invokes its skill **by name** (never by path); the bootstrap's `ensureCompanySkills` registers them with Paperclip from these files (any agent listing the slug in `desiredSkills` triggers registration). To edit a skill, change its `SKILL.md` here and re-run the bootstrap so Paperclip re-registers the updated content.

**`requirement-generator`** (the BA, Phase 1):
- Input layout: `./projects/<project>/<feature>/requirements/{SOP,Transcripts,Notes,UI}/`.
- Output schema: 5 files in the project-scoped `outputs/`.
- House style: `<process_number> As a <role>, I want <action>, So that <outcome>.`, Australian English, declarative AC bullets (not Gherkin), persona format `Full Name (ABBR)`.
- 11-section Product Summary template, with placeholder text preserved verbatim in sections 3.3.1, 7, 8, 9, 10, 11. (Section 3.3.1 Data Model stays a manual placeholder — the Data Modeler publishes its analysis to a *separate* Confluence page, it does not fill 3.3.1.)
- Reference files at `./examples/gold-product-summary.pdf` and `./examples/gold-story.doc`. **Per-project override:** files in `./projects/<project>/<feature>/requirements/templates/` take precedence per artefact; `./examples/` is the fallback.

**`datamodel-impact-analysis`** (the Data Modeler, Phase 1 — working folder `solutions/DataModel/`):
- Inputs (staged by the agent): `productsummary/` (copied from the approved `outputs/product-summary.md`) + `datamodel-reference/` (seeded from the global catalogue if empty).
- Output: `solutions/DataModel/outputs/datamodel-impact.md` (fixed name) — impact table, custom-field detail, standard-first decision hierarchy, and a Mermaid `erDiagram`.

**`salesforce-data-modeler`** (the Data Modeler — working folder `solutions/DataModel/`, standalone; **not** currently wired to any chatbot trigger):
- Inputs (staged by the agent): `productsummary/` (product summary / BRD / user stories / transcript) + optional `datamodel-reference/`. The Service Cloud standard-object catalogue, field-design rules and Mermaid ERD conventions are inlined as Appendices A–C — the skill needs no sidecar reference files.
- Output: `solutions/DataModel/outputs/salesforce-data-model.md` (fixed name, deliberately distinct from `datamodel-impact.md` so the two skills never collide) — a 12-section Service Cloud design: object inventory, field dictionary, relationship matrix, Mermaid `erDiagram`, traceability matrix, and rejected alternatives.
- Standard-object-first: `Ticket__c`/`Customer__c`/`Agent__c`-style inventions are ruled out against Case/Account/User before any custom object is proposed.

**`capability-process-map`** (the Capabilities Process Architect, Phase 1 — working folder `solutions/Capabilities/`):
- Inputs (staged by the agent): `documents/<category>/` — every `.md` under the feature except `outputs/`, `solutions/` and `design/`, i.e. the same `requirements/{SOP,Transcripts,Notes}` the BA reads, plus any reference document tree the feature carries. Optional `capability-reference/`.
- Outputs: `solutions/Capabilities/outputs/` — `capability-map.json` (L1–L4 hierarchy, current/target maturity, lifecycle stage), `process-model.json` (L1 phase / L2 step / L3 activity with actor, service tier, components, capability IDs), `capability-process.md` (tables + Mermaid + coverage), and `capability-process.html` (rendered by `scripts/render-capability-map.mjs` — never hand-written).
- No prerequisite stage, and no Confluence/Jira publishing.

**`salesforce-service-cloud-architecture`** (the Solution Architect — working folder `solutions/Architecture/`):
- Inputs (staged by the agent): `productsummary/` (required) + `DataModel/` and `landscape/` (both optional). The Service Cloud capability catalogue, component-selection ladder, integration patterns, security/NFR guidance and Mermaid conventions are inlined as Appendices A–E — the skill needs no sidecar reference files.
- Output: `solutions/Architecture/outputs/solution-architecture.md` (fixed name) — an 18-section SAD. Several Mermaid diagrams, so Phase 2 renders **all** of them, not just the first.
- Restraint about code is the core discipline: every Apex class and LWC in the inventory must carry a one-line justification for why Flow or standard configuration was insufficient.

**`requirements-test-case-generator`** (the QA Architect — working folder `solutions/QA/`):
- Inputs (staged by the agent): `productsummary/` (required — product summary + stories) + `DataModel/` and `Architecture/` (both optional; the latter picks up either the Solution Architect's or the Architecture Lead's output, or both). Test design techniques, the coverage checklist, Salesforce-specific test angles and the tool export formats are inlined as Appendices A–D.
- Output: `solutions/QA/outputs/test-cases.md` (fixed name), plus optional `test-cases.csv` (Jira/Xray/Zephyr/TestRail/ADO import) and `test-cases.feature` (Gherkin).
- Ambiguous or contradictory requirements are reported under **Requirement Quality Issues** with the interpretation used — never silently guessed.

**`solution-design-document`** (the Architecture Lead, Phase 1 — working folder `solutions/Design/`):
- Inputs (staged by the agent): `productsummary/` (copied from the approved product summary) + `DataModel/` (copied from `solutions/DataModel/outputs/`).
- Output: `solutions/Design/outputs/solution-design.md` (fixed name) — declarative-first (OOB → low-code → code) component design and a Mermaid `flowchart`.

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

| Method | Path                              | Purpose                                                                   |
| ------ | --------------------------------- | ------------------------------------------------------------------------- |
| POST   | `/api/chat`                       | Proxies the chat conversation to Gemini, returns Anthropic-shaped blocks  |
| POST   | `/api/trigger`                    | Creates the requirements issue (`Generate requirements — …`, status=todo, assigned to the Delivery Lead) |
| POST   | `/api/data-model/trigger`         | Creates a `Generate data model — …` issue. Gated: `409 no_product_summary` if `outputs/product-summary.md` is missing |
| POST   | `/api/solution-design/trigger`    | Creates a `Generate solution design — …` issue. Gated: `409 no_data_model` if `solutions/DataModel/outputs/datamodel-impact.md` is missing |
| POST   | `/api/capability-map/trigger`     | Creates a `Generate capability map — …` issue. No pipeline prerequisite; `409 no_documents` only when the feature has no `.md` at all. Carries no Atlassian keys, so approval skips provisioning |
| POST   | `/api/solution-architecture/trigger` | Creates a `Generate solution architecture — …` issue. Gated: `409 no_product_summary` only — the data model is optional enrichment |
| POST   | `/api/test-cases/trigger`         | Creates a `Generate test cases — …` issue. Gated: `409 no_product_summary` only — the data model and architecture are optional enrichment |
| GET    | `/api/capability-map/:project/:feature` | Serves the rendered `capability-process.html` (self-contained page); `404 not_generated` before the stage has run |
| GET    | `/api/status/:issueId`            | Normalised view: tree + stage + activity + approvals + extracted links. Stage labels adapt to the flow (BA / Data Modeler / Architecture Lead / Developer) |
| POST   | `/api/approve/:approvalId`        | Resolves an approval gate; wakes the gate's own issue assignee. Atlassian auto-provisioning is keyed on the keys in the issue description: requirements ensures Jira project + Confluence space; data-model/solution-design ensure just the space; Build UI carries no keys → skipped |
| POST   | `/api/reject/:approvalId`         | Rejects an approval gate                                                  |
| POST   | `/api/request-changes/:approvalId`| Reviewer feedback → comments it, re-fires the gate's assignee (issue → `todo`) to regenerate — works for any worker, not just the BA |
| GET    | `/api/history`                    | All completed pipeline runs (requirements, data model, solution design) with their Confluence + Jira links (History view) |
| GET    | `/api/runs/:issueId`              | Compact agent run summaries (agent · status · duration) for the run tree (Activity panel) |
| GET    | `/api/features`                   | Lists `projects/<project>/<feature>/` available on disk                   |
| GET    | `/api/artifacts`                  | Reads the BA's `outputs/*` plus `solutions/DataModel/outputs/{datamodel-impact,salesforce-data-model}.md`, `solutions/Design/outputs/solution-design.md`, `solutions/Architecture/outputs/solution-architecture.md`, `solutions/QA/outputs/test-cases.md` and `solutions/Capabilities/outputs/capability-process.md` for the approval-card preview |
| POST   | `/api/upload`                     | File upload (audio recordings, attachments) — wired to multer + Gemini Files |
| POST   | `/api/ui-agent/trigger`           | Triggers the UI flow (creates a `Build UI — …` issue assigned to the Delivery Lead)     |
| GET    | `/api/preview/:project/:feature`  | Returns preview URL for the scaffolded app                                |
| POST   | `/api/ui-agent/comment`           | Adds a follow-up comment to the UI build issue                            |

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
- `trigger_solution_design` — fires the solution design flow (`Generate solution design — …`). Backend gates on `datamodel-impact.md`; the bot offers to run the data model first if it's missing.
- `trigger_capability_map` — fires the capability map flow (`Generate capability map — …`). No prerequisite: it reads the same SOP/Transcripts/Notes as the BA. Backend only refuses with `no_documents` when the feature is empty.
- `trigger_solution_architecture` — fires the solution architecture flow (`Generate solution architecture — …`). Gated on the product summary only. **Distinct from `trigger_solution_design`** — if the user just says "do the architecture", the bot asks which one rather than guessing.
- `trigger_test_cases` — fires the test-case flow (`Generate test cases — …`). Gated on the product summary only; the data model and architecture enrich the pack when present.
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

The BA's adapter is configured with `extraArgs: ["--mcp-config", "<AGENT_CWD>/.mcp.json"]` where `<AGENT_CWD>` is the agent's working directory (this repo's root on the host). The bootstrap sets this automatically from `AGENT_CWD`, so it's never a fixed absolute path. This lets Claude Code in the BA's headless subprocess load this MCP. (Without `--mcp-config`, project-scope MCPs require interactive trust approval which can't happen in `--print` mode.)

OAuth tokens for `mcp-remote` are cached in `~/.mcp-auth/` at user scope. The same user runs Claude Code interactively and inside the BA's subprocess, so tokens are shared.

## Common operations

### Re-apply agent instructions after editing them

The simplest path is to **re-run `npm run bootstrap`** — it re-pushes every bundle (and swaps the pm.json placeholder IDs). For a single agent, PUT its bundle directly using the **live** id from `.bootstrap/ids.json` (`org.<key>`):

```bash
# Look up live ids first
cat .bootstrap/ids.json | jq '.org'

# Then push one bundle (substitute the live id for the agent's org key)
curl -sS -X PUT \
  http://127.0.0.1:3100/api/agents/<live-id>/instructions-bundle/file \
  -H "Content-Type: application/json" \
  -d @agent-instructions/pm.json
```

Bundles: `pm.json` (org.pm / Delivery Lead), `ba.json` (org.ba), `data-modeler.json` (org.dataModeler), `architect-lead.json` (org.archLead), `capabilities-process-architect.json` (org.capArchitect), `solution-architect.json` (org.solutionArchitect), `qa-architect.json` (org.qaArchitect), `ui.json` (org.ui), `ux-auditor.json` (org.ux). Note `pm.json` must have its placeholder IDs swapped for the real report IDs before pushing — the bootstrap does this automatically, so prefer re-running it when pm.json changes.

### Run a skill locally, without Paperclip

The skills are ordinary Claude Code skills — you can invoke one directly in a
session at the workspace root, with no Paperclip, no chatbot and no agent. Two
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
normally populates. `scripts/stage-datamodel.mjs` does that step for the two
Data Modeler skills, replicating `agent-instructions/data-modeler.json` exactly:

```bash
npm run stage <project> <feature>              # e.g. npm run stage SADA interim-benefit
npm run stage <project> <feature> -- --from-requirements   # no product summary yet
```

**Staging converts documents to markdown first.** The skills only read `.md`, so
a hand-placed `.pdf`/`.docx`/`.xlsx`/`.txt` under `requirements/` would otherwise
be silently invisible to the model. `scripts/convert-to-md.mjs` writes a sibling
`.md` for each (`Conceptual Data Model.pdf` → `Conceptual Data Model.md`), using
the same `markitdown-ts` conversion the chatbot's upload route uses
(`scyne-chatbot/server/services/toMarkdown.ts`). It runs automatically as step 0
of a stage; `--no-convert` skips it, and it also stands alone:

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

It copies `outputs/product-summary.md` → `solutions/DataModel/productsummary/`,
seeds `datamodel-reference/` from the global catalogue when empty (a curated
per-feature copy wins; `--force` overrides), creates `outputs/`, and prints the
exact skill invocation. Run with no arguments to list every feature and flag
which ones lack a product summary. `--from-requirements` stages
`requirements/**.md` instead (skipping `templates/`) — suitable for
`salesforce-data-modeler`, which accepts a BRD / user stories / transcript, but
only a fallback for `datamodel-impact-analysis`, which expects an approved
summary.

Then, in a Claude Code session at the workspace root:

```
/salesforce-data-modeler     project: SADA, feature: interim-benefit
/datamodel-impact-analysis   project: SADA, feature: interim-benefit
```

Outputs land at the same paths the agent would write, so the chatbot's approval
preview and the downstream Architecture Lead stage still find them. What you skip
by going direct is the human approval gate and Confluence/Jira publishing — those
live in the agents' Phase 2, not in the skills.

### Add a new feature to a project

```bash
mkdir -p projects/<project>/<feature>/requirements/{SOP,Transcripts,Notes,UI,templates}
mkdir -p projects/<project>/<feature>/design/{style-guides,example-screens}
mkdir -p projects/<project>/<feature>/outputs
mkdir -p projects/<project>/<feature>/solutions/DataModel/{productsummary,datamodel-reference,outputs}
mkdir -p projects/<project>/<feature>/solutions/Design/{productsummary,DataModel,outputs}
mkdir -p projects/<project>/<feature>/solutions/Architecture/{productsummary,DataModel,landscape,outputs}
mkdir -p projects/<project>/<feature>/solutions/QA/{productsummary,DataModel,Architecture,outputs}
mkdir -p projects/<project>/<feature>/solutions/Capabilities/{documents,outputs}
# Drop files into the four requirements subfolders
# (the solutions/ working folders are also created on demand by the agents)
```

No code change needed — `/api/features` auto-discovers it on the next chat turn.

### Create a fresh test run from CLI

```bash
curl -sS -X POST http://127.0.0.1:3100/api/companies/2131f183-3822-4eee-9370-4b5cafae7e29/issues \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Generate requirements — Review & Verify Evidence",
    "description": "project: SADA\nfeature: interim-benefit\n…(parameters as plain text block)…",
    "assigneeAgentId": "212a6542-4e49-41dc-94f0-7d7acbc460ba",
    "status": "todo",
    "priority": "medium"
  }'
```

### Tail what an agent is doing

Open `http://127.0.0.1:3100/SCY/agents/business-analyst/runs` (or `…/project-manager/runs`) in the browser — Paperclip's UI shows live transcripts of every run, with each tool call and result.

## Helper scripts (`scripts/`)

Three Node scripts power the UI / a11y / capability agents:

- `scripts/scaffold-app.mjs <project> <feature>` — used by the **Developer**. Creates `generated-apps/<project>-<feature>/` from the Vite react-ts template, installs deps, adds Tailwind + shadcn/ui, allocates a free port (`PAPERCLIP_PORT_BASE` or 5174), launches `npm run dev` detached, and waits until the dev URL responds. Writes the entry into `generated-apps/registry.json`. Idempotent — if the app and its PID are alive, it just re-prints the registry entry.
- `scripts/audit-a11y.mjs <project-feature-key>` — used by the **UX Auditor**. Reads the registry entry, runs `@axe-core/cli` (WCAG 2.0 A + AA) and `pa11y` (WCAG2AA standard) against the dev URL, then writes consolidated violations to `generated-apps/<key>/audit.json`. Exits 0 even when violations exist — the auditor reads the JSON to decide what to fix.

- `scripts/render-capability-map.mjs <project> <feature>` — used by the **Capabilities Process Architect**. Reads `solutions/Capabilities/outputs/{capability-map.json,process-model.json}`, validates them (non-zero exit naming the offending file/field), and writes `capability-process.html` — one self-contained page (inline CSS/JS, data as a JSON island, no network requests) with the capability tree, the L1/L2/L3 process explorer, actor/tier/capability filters, a coverage table and a source index. The agent never hand-writes the HTML, so every run looks the same.

The chatbot doesn't call these directly; the agents do (via the `Bash` tool in their Claude Code sessions). The one exception is `scaffold-app.mjs` / `stop-app.mjs`, which `/api/preview/:project/:feature/:action` shells out to.

## Generated apps registry

`generated-apps/registry.json` is the authoritative source for every running scaffolded app:

```json
{
  "SADA-interim-benefit": {
    "appPath": "generated-apps/SADA-interim-benefit",
    "port": 5174,
    "devUrl": "http://127.0.0.1:5174",
    "branch": "ui/SADA-interim-benefit",
    "repoUrl": "<git url or null>",
    "pid": 12345,
    "startedAt": "2026-05-18T14:09:00Z"
  }
}
```

The chatbot's `/api/preview/:project/:feature` looks up the entry and returns the dev URL. The Developer and UX Auditor both treat this file as authoritative — if a description disagrees with the registry, the registry wins.

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
- **Source mapping** in `extraction.json` — every story / decision should map back to which input file it came from (`transcripts/foo.docx`, etc.) so traceability is auditable.

## When something feels off

| Symptom                                                  | Likely cause                                                                    | Fix                                                                                                                            |
| -------------------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Agent says "PAPERCLIP_API_KEY not set"                   | Claude misread Paperclip auth — local_trusted needs no key                      | Re-emphasise in the agent's AGENTS.md that no auth is required; force fresh session via `{"forceFreshSession": true}` on wake. |
| Agent loops searching for an MCP / tool                  | Stale session, or `--mcp-config` not set on adapter                             | Add `extraArgs: ["--mcp-config", "<abs path to .mcp.json>"]` on the agent's `adapterConfig`. Force fresh session.                |
| Agent doesn't pick up a new issue                        | Issue created with `status=backlog` (the default)                               | Always pass `status: "todo"` when creating issues assigned to agents.                                                          |
| Delivery Lead does the work itself instead of delegating to the BA  | Stale Delivery Lead Claude session carrying a prior "do it myself" conclusion, or agents never (re)bootstrapped after a code/instructions change. Verified May 2026: on a clean `npm run bootstrap` the Delivery Lead correctly creates a BA child and the BA raises the approval gate — the delegation path is sound. | Re-run `npm run bootstrap` (re-pushes instructions, sets `cwd`), then force a fresh Delivery Lead session on the next wake with `{"forceFreshSession": true}`. Confirm the Delivery Lead's `adapterConfig.cwd` points at this repo and `instructionsFilePath` is set (`GET /api/agents/<delivery-lead-id>`). |
| Chatbot shows "undefined" for a parameter                | Frontend reading old field name                                                 | Search for the renamed field across `src/`; rebuild the tool schema response handler if needed.                                |
| `/api/features` returns `{}`                             | `projects/` folder missing, or `WORKSPACE_PATH` env var pointing elsewhere      | `mkdir projects/<project>/<feature>/...`, restart dev server.                                                                  |
| Atlassian MCP OAuth fails with "Supported sites required" | Logged-in Atlassian account has no Jira/Confluence site                         | Switch accounts, or create a free Atlassian Cloud trial site, then re-run `claude mcp add atlassian -- npx -y mcp-remote …`.    |
| Refresh loses the workflow                                | `localStorage.scyne_parent_issue_id` cleared                                    | Click the workflow status panel's "New session" button to start over; otherwise it should restore automatically.               |

---

If you're about to make a significant change, sketch the touched files first — most changes need to ripple through: `agent-instructions/<agent>.json` (re-pushed via curl), `paperclip/skills/requirement-generator/SKILL.md` (loaded from disk by BA), `scyne-chatbot/server/llm.ts` (system prompt + tool schema), `scyne-chatbot/src/App.tsx` (state + rendering), and `scyne-chatbot/.env` (defaults).
