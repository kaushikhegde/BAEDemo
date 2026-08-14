# Project-Level Restructure — Design

**Date:** 2026-08-14
**Status:** Approved for planning
**Scope:** Move personas/capabilities/process to project level, reorder the pipeline, make the companion app project-scoped, add a project-creation wizard, add chat suggestion chips, and add chat-driven artefact revision.

---

## 1. Why

Today every artefact is generated per feature. That is wrong for three of them: a client's personas, business capabilities and process model describe the **organisation**, not one slice of work. Generating them per feature produces near-duplicate sets that drift apart, and a consultant who has run five features has five slightly different persona lists for the same client.

Three consequences follow, and they are the substance of this design:

1. Personas, capabilities and the process model move up to the project. Feature stages read them down as inputs.
2. The companion app becomes **one page per project** rather than one per feature, because a project-level artefact has no single feature to live on.
3. A project now has a lifecycle of its own — it is created, given documents, and generates a baseline — which is what the creation wizard serves.

Two further changes are independent of that restructure but were requested alongside it:

4. UI mockups move to directly after the product summary, ahead of the data model.
5. The chat gains suggestion chips and the ability to **revise** an already-generated artefact, not only trigger new ones.

---

## 2. Decisions

Recorded here so the plan does not relitigate them.

| # | Decision | Rejected alternative |
|---|---|---|
| D1 | Project artefacts live at `projects/<project>/solutions/{Capabilities,Experience}/` | A `_project/` pseudo-feature; a flat `shared/` folder |
| D2 | Feature stages read down **both** the project's documents and its generated artefacts | Artefacts only; nothing automatic |
| D3 | One companion app per project, feature-level tabs drilling from a feature list into one feature's document | Per-feature pages; a header feature-switcher; one tab per feature |
| D4 | Revision goes through a full agent round-trip with its own approval gate | Direct file edit by the chat LLM; a hybrid router |
| D5 | Downstream artefacts are **flagged** stale, never auto-regenerated | Auto-cascade; track nothing |
| D6 | Suggestion chips are computed from pipeline state on the server | LLM-generated per turn |
| D7 | The wizard creates a **project only**, in three steps, with one untyped dropzone | Project + first feature; two wizards; a typed Requirements/Evidence split |
| D8 | Deploy fires capabilities, then personas **sequentially** | Parallel; capabilities only |
| D9 | Personas publish to one Confluence page per project; everything else stays per feature | Also publish capabilities; publish nothing project-level |
| D10 | UI mockups run early and are re-runnable to pick up the data model and test pack | Keep UI last; auto-flag; two deliberate passes |
| D11 | `theme.json` moves to project level | Keep per feature and pick one arbitrarily |
| D12 | Staleness is computed from file mtimes | A generated-from manifest per artefact |
| D13 | The per-feature companion app is dropped, not kept alongside | Render both |

---

## 3. Disk layout

```
projects/<project>/
├── description.md                       project definition — unchanged path
├── documents/                           NEW — project-wide discovery docs (.md only)
├── original-files/documents/            NEW — sources archived after conversion
├── design/
│   └── style-guides/theme.json          MOVED UP from the feature (D11)
├── .published.json                      NEW — Confluence page identity (§7.3)
├── solutions/
│   ├── Capabilities/
│   │   ├── documents/<category>/        staged input
│   │   ├── capability-reference/        optional house taxonomy
│   │   └── outputs/                     capability-map.json, process-model.json,
│   │                                    capability-process.md
│   └── Experience/
│       ├── documents/<category>/        staged input
│       ├── capabilities/                staged from Capabilities/outputs/
│       └── outputs/                     personas.json, journey-map.json,
│                                        personas-journeys.md
└── <feature>/
    ├── requirements/{SOP,Transcripts,Notes,UI,templates}/
    ├── outputs/                         product-summary.md, stories.{json,md}, gaps.md,
    │                                    extraction.json
    └── solutions/
        ├── UI/           documents/ · project/ · personas/ · capabilities/ ·
        │                 productsummary/ · DataModel/ · Architecture/ · QA/ · outputs/
        ├── DataModel/    productsummary/ · datamodel-reference/ · project/ · outputs/
        ├── Design/       productsummary/ · DataModel/ · outputs/        (optional stage)
        ├── Architecture/ productsummary/ · DataModel/ · landscape/ · project/ · outputs/
        └── QA/           productsummary/ · DataModel/ · Architecture/ · project/ · outputs/
```

`solutions/Capabilities/` and `solutions/Experience/` are **removed** from the feature.

Every feature working folder gains a `project/` subfolder holding what was staged down from
the parent (D2). For most stages that is the project documents plus `personas.json`,
`journey-map.json`, `capability-map.json`, `process-model.json` and `capability-process.md`
when they exist.

`solutions/UI/` is the exception, and only partly: it already has `personas/` and
`capabilities/` folders that its skill reads by name, so the generated artefacts keep landing
there and only the project **documents** go to `UI/project/`. Changing the UI skill's input
folder names would be churn for no gain.

### 3.1 Conversion is unchanged

Uploads and staged documents are converted to markdown before any skill sees them, exactly
as today: `scripts/convert-to-md.mjs` runs as step 0 of every stage, the upload route uses
`scyne-chatbot/server/services/toMarkdown.ts`, and originals are **moved** (never deleted)
into an `original-files/` tree. `projects/<project>/documents/` therefore holds `.md` only,
with sources under `projects/<project>/original-files/documents/`. No skill reads a raw
`.pdf`, `.docx`, `.xlsx` or `.txt` at any level.

---

## 4. The pipeline

### 4.1 Stages

| Level | Key | Label | Skill / script | Owner | Hard requirement |
|---|---|---|---|---|---|
| project | `capabilities` | Capability & Process Map | `capability-process-map` | Capabilities Process Architect | — |
| project | `personas` | Personas & Journey Map | `persona-journey-map` | Service Designer | capabilities |
| feature | `requirements` | Requirements & Product Summary | `requirement-generator` | BA | — |
| feature | `ui` | UI Mockups | `ui-mockup-generator` | UX Designer | product summary |
| feature | `datamodel` | Salesforce Data Model | `salesforce-data-modeler` | Data Modeler | product summary |
| feature | `architecture` | Solution Architecture | `salesforce-service-cloud-architecture` | Solution Architect | product summary |
| feature | `qa` | Test Cases | `requirements-test-case-generator` | QA Architect | product summary |
| feature | `design` | Solution Design *(optional side stage)* | `solution-design-document` | Architecture Lead | data model |
| project | `app` | Companion App | `render-companion-app.mjs <project>` | Developer | anything |

Two changes to the ordering itself:

- **`personas` now hard-requires `capabilities`.** Today both are ungated. D8 makes the
  wizard run them in sequence specifically so journey stages can align to the capability
  model's L1 lifecycle phases; encoding that as a real prerequisite keeps the CLI and the
  chatbot consistent with the wizard.
- **`ui` moves from order 6.5 to order 4**, ahead of `datamodel`.

### 4.2 The cost of moving UI early, and the mitigation (D10)

`ui-mockup-generator` currently derives real field names, data types and picklist values
from the data model, and derives screen states from the test pack's failure, empty and
blocked paths. Running it before either exists means the first pass of mockups is built from
the product summary, stories, personas and capabilities alone.

The mitigation is not a workaround bolted on later — it is the revision flow from §7, used
for its ordinary purpose. Concretely:

1. `mockups.json` gains a `generatedFrom` array naming which inputs were present.
2. Each rendered screen page shows a small "designed without: data model, test cases" note
   when that array is short, so a reviewer knows why field names are generic.
3. Once the data model and test cases exist, `GET /api/staleness` reports the mockups as
   stale (§8.1) and the chat offers a **Refresh the UI mockups** chip, which fires an
   ordinary revision.

### 4.3 Read-down (D2)

Every feature stage stages the parent project's material into its working folder before
invoking its skill:

```
projects/<project>/documents/*.md                          → <work>/project/documents/
projects/<project>/solutions/Experience/outputs/*.json      → <work>/project/ (or personas/ for UI)
projects/<project>/solutions/Capabilities/outputs/*         → <work>/project/ (or capabilities/ for UI)
```

`description.md` is *not* copied — every skill already reads it in place from its stable
path, and duplicating it into eight working folders would only create drift.

The read-down is opportunistic, never a gate: a project with no documents and no generated
artefacts stages nothing extra and every feature stage still runs.

---

## 5. Shared pipeline graph — `scripts/pipeline.mjs` (new)

The stage graph is currently a 110-line `STAGES` object inside
[`scripts/stage.mjs`](../../../scripts/stage.mjs) (lines 56–165). This design adds three more
consumers of the same knowledge: `/api/staleness`, `/api/suggestions`, and the trigger
endpoints' pre-flight checks. Writing the prerequisite rules a fourth time guarantees they
diverge.

`scripts/pipeline.mjs` therefore exports the graph as data, and nothing else:

```js
export const LEVEL = { PROJECT: "project", FEATURE: "feature" };

export const STAGES = {
  capabilities: {
    level: LEVEL.PROJECT,
    order: 1,
    label: "Capability & Process Map",
    agent: "Capabilities Process Architect",
    skill: "capability-process-map",
    work: "solutions/Capabilities",
    produces: [...],          // paths relative to the PROJECT root
    requires: [],
    enriches: [],
    titlePrefix: "Generate capability map",
    publishes: false,
  },
  // …
};

export const ordered = (level) => /* stages of that level, by order */;
export const stageFor = (artefactKey) => /* revision routing, §7.2 */;
```

`produces`, `requires` and `enriches` are all paths relative to the stage's own level root —
the project directory for a project stage, the feature directory for a feature stage. This is
the one subtlety worth calling out, because the existing code has a comment warning that a
path relative to the *working* folder silently reports "never run"; the same trap now exists
one level up.

Consumers:

- `scripts/stage.mjs` — imports the graph, keeps its staging functions
- `scyne-chatbot/server/index.ts` — pre-flight checks, staleness, suggestions
- `scripts/render-companion-app.mjs` — which tabs to render and which features have what

### 5.1 A CLI parsing trap the plan must handle

`stage.mjs` currently parses `<project> <feature…> [stage]`, treating the last token as a stage
only when `rest.length > 1` — because a feature name may contain spaces. A project-level
invocation is `npm run stage SAPN capabilities`, where `rest` is a single token, so the existing
rule would read `capabilities` as a *feature name* and fail with "no such feature".

The fix is to resolve the level before the name: if the sole remaining token names a
project-level stage, it is a stage. That makes `capabilities` and `personas` unusable as feature
folder names, which is an acceptable trade and must be documented in `CLAUDE.md` and rejected by
`POST /api/features`.

The server is TypeScript and the scripts are ESM `.mjs`. `pipeline.mjs` stays plain ESM with
JSDoc types and is imported directly by the server via `tsx`, which already resolves `.mjs`.
No build step, no duplicated type declaration file.

---

## 6. Companion app — one page per project (D3)

### 6.1 Output paths

```
generated-apps/<project>/index.html                    the single page
generated-apps/<project>/mockups/<feature>/*.html      one page per screen, per feature
generated-apps/<project>/mockups/<feature>/index.html  that feature's mockup index
generated-apps/registry.json                           keyed by <project>, not <project>-<feature>
```

Registry entries become:

```json
{
  "RTWSA": {
    "appPath": "generated-apps/RTWSA",
    "htmlPath": "generated-apps/RTWSA/index.html",
    "kind": "static-html",
    "devUrl": "http://127.0.0.1:4000/api/companion-app/RTWSA",
    "generatedAt": "2026-08-14T...",
    "features": {
      "interim-benefit": { "artefacts": ["product summary", "data model"], "screens": 6 }
    },
    "diagrams": 12,
    "bytes": 412000
  }
}
```

### 6.2 Navigation

Eleven tabs in two groups:

| Group | Tabs | Source |
|---|---|---|
| Project | Overview · Personas · Journeys · Capabilities · Process | `projects/<project>/` |
| Feature | Product Summary · Stories · UI · Data Model · Architecture · Test Cases | each `<feature>/` |

Project tabs render as they do today, unchanged in content.

Feature tabs open on a **feature list**: a responsive grid of cards, one per feature, each
carrying the feature name and a one-line stat drawn from that artefact (`6 objects · 24
fields`, `18 stories`, `9 screens`, `41 test cases`). A feature that has not run the stage
renders a muted "not generated" card that is not clickable. Clicking a live card replaces the
grid with that feature's document, preceded by a breadcrumb (`‹ Data Model / interim-benefit`)
and a Back control.

This reuses the drill-down already built for the Process perspective — same 0.22s level
change, same slide-in-from-right for the deeper level, same 0.04s per-card stagger, all
disabled under `prefers-reduced-motion`. No new interaction vocabulary is introduced.

A tab whose stage has run for **no** feature is hidden entirely, matching today's rule that a
perspective appears only if its stage has run.

### 6.3 Renderer changes

[`scripts/render-companion-app.mjs`](../../../scripts/render-companion-app.mjs) is 2530 lines
and takes `<project> <feature>`. It becomes `<project>` only. The functions that change shape:

| Today | Becomes |
|---|---|
| `loadTheme(featureRoot)` | `loadTheme(projectRoot)` |
| `loadArtefacts(featureRoot)` | `loadProjectArtefacts(projectRoot)` + `loadFeatureArtefacts(featureRoot)` per feature |
| `loadCollections(featureRoot)` | `loadCollections(projectRoot)` — personas/journeys are project-level now |
| `loadImages(featureRoot, personas)` | `loadImages(projectRoot, personas)` |
| `page({ project, feature, a, docHtml, theme })` | `page({ project, features, projectData, theme })` |

Everything below that — markdown→HTML, Mermaid→inline SVG, the satisfaction chart, the theme
and contrast maths, the search index, the light/dark toggle — is untouched. The diagram pass
now runs across every feature's documents in one go rather than one feature's, so
`--no-diagrams` matters more for iteration speed.

The **0 WCAG 2.0 A/AA violations** bar holds. The new drill-down needs the same treatment the
existing one has: feature cards are `<button>`s in a list, the breadcrumb is a nav landmark,
and focus moves to the detail heading on drill-in and back to the originating card on Back.

`scripts/render-mockups.mjs` changes only its output root, from
`generated-apps/<project>-<feature>/mockups/` to `generated-apps/<project>/mockups/<feature>/`,
and reads `theme.json` from the project. Its "back to the companion app" link becomes
`../../index.html`.

### 6.4 Known duplication, unresolved

`render-mockups.mjs` duplicates its theme tokens from `render-companion-app.mjs` because the
companion app builds its CSS inline inside a template literal. This design does **not** fix
that — it is orthogonal, and both files are being changed enough already. The existing comment
warning that a palette change must be made in both places stays true and stays accurate.

---

## 7. Revision flow (D4)

### 7.1 Shape

```
User: "add an SLA breach field to the data model"
  ↓
LLM calls revise_artefact({project, feature, artefact:"datamodel", instruction:"…"})
  ↓
POST /api/revise
  → issue "Revise data model — RTWSA/interim-benefit", status=todo, → Delivery Lead
     description carries: project, feature, artefact key, the instruction verbatim
  ↓
Delivery Lead routes on the "Revise " prefix + artefact name → owning worker
  ↓
Worker, PHASE 1
  ├─ re-stages its inputs exactly as for a fresh run (including project read-down)
  ├─ reads its OWN previous output from outputs/
  ├─ invokes its skill in revision mode: previous output + instruction + inputs
  ├─ writes the output back to the same fixed filename
  ├─ runs its validator if it has one (render-mockups, validate-experience, …)
  └─ attaches, raises an approval gate
  ↓
Human approves
  ↓
Worker, PHASE 2
  ├─ re-renders diagrams → PNG
  └─ UPDATES the existing Confluence page (not a new one) — §7.3
```

Revision is available for **every** generated artefact, project-level and feature-level alike:
personas, capabilities, product summary, stories, UI mockups, data model, architecture, test
cases, solution design.

### 7.2 Routing

`pipeline.mjs` exports `stageFor(artefactKey)`, and the Delivery Lead's routing table gains one
`### REVISION intent` section listing the artefact names it may see. The existing hazard is
worse here than for generation: `Revise solution design` and `Revise solution architecture`
still share their first two words after the artefact name begins, so the instruction repeats
the "read as far as `design` / `architecture`" rule verbatim.

### 7.3 Confluence page identity

Nothing today records which Confluence page an artefact produced — each worker's Phase 2
creates a page and comments the URL. A revision that re-created the page would leave the client
with two pages and a stale link.

`projects/<project>/.published.json`:

```json
{
  "personas":                       { "pageId": "123456", "url": "https://…", "title": "RTWSA — Personas & Journey Map" },
  "interim-benefit/requirements":   { "pageId": "123457", "url": "https://…", "title": "Interim Benefit" },
  "interim-benefit/datamodel":      { "pageId": "123458", "url": "https://…", "title": "Interim Benefit — Data Model" }
}
```

Written by each publishing worker's Phase 2 after a successful create or update; read at the
start of Phase 2 to decide `createConfluencePage` vs `updateConfluencePage`. A missing entry
means create — so a feature published before this change simply gets one new page and is
tracked from then on.

Keys are `<stage key>` for project-level artefacts and `<feature>/<stage key>` for feature-level
ones, matching the staleness keys in §8.1.

### 7.4 Skill changes

Each skill gains a short **Revision mode** section with the same contract:

> When the invocation supplies a previous version of this document plus a change instruction,
> you are revising, not regenerating. Preserve every section, decision and identifier the
> instruction does not touch. Apply the change and its genuine consequences — a new field
> belongs in the field dictionary, the ER diagram and the traceability matrix, not only the
> first of those. Record what changed in a `## Revision History` entry at the end. Do not
> renumber, reword or restructure anything the instruction did not ask about.

That last sentence is the important one: a regenerate-from-scratch would produce a diff too
large for a reviewer to check, which defeats the approval gate.

---

## 8. Staleness and suggestions

### 8.1 Staleness (D5, D12)

`GET /api/staleness/:project` and `GET /api/staleness/:project/:feature` return:

```json
{ "stale": [ { "key": "interim-benefit/architecture",
               "label": "Solution Architecture",
               "generatedAt": "2026-08-14T10:22:00Z",
               "supersededBy": [ { "key": "interim-benefit/datamodel",
                                   "label": "Salesforce Data Model",
                                   "generatedAt": "2026-08-14T11:05:00Z" } ] } ] }
```

An artefact is stale when any file it declares in `requires` or `enriches` has an mtime later
than its own. Nothing is stored; it is a walk of the graph in `pipeline.mjs` plus `fs.stat`.

The limitation is honest and worth stating: mtime cannot tell a substantive revision from a
re-run that changed nothing, so this over-reports rather than under-reports. Over-reporting is
the safe direction — the user is offered a refresh they may decline, never silently handed a
contradictory pack.

After any approval resolves, `/api/approve` includes the fresh staleness result in its
response; `App.tsx` surfaces it as one assistant line plus refresh chips. Nothing regenerates
without a click.

### 8.2 Suggestion chips (D6)

`GET /api/suggestions?project=&feature=` returns 3–4 `{ label, message }`. `label` is what the
chip shows; `message` is sent as an ordinary chat turn on click, so a chip is indistinguishable
from typing and needs no special LLM handling.

Computed from: whether a project is selected, whether a feature is selected, which stages have
produced output, which hard requirements are unmet, and what is stale. Ordering is
next-action-first.

| State | Chips |
|---|---|
| No project | `Create a new project` · `Show me my projects` |
| Project, no baseline | `Generate capabilities & personas` · `Brand it from their website` |
| Baseline done, no feature | `Add a feature` · `Show me the companion app` |
| Feature, no product summary | `Generate the product summary` · `Add documents` |
| Product summary exists | `Generate UI mockups` · `Generate the data model` · `Change something in the product summary` |
| Anything stale | `Refresh the solution architecture` · `Leave it` |

A chip is never offered for a stage whose hard requirement is unmet, so clicking one cannot
produce a 409.

Rendered as a horizontal wrapping row directly above the composer in `App.tsx`, refreshed on
target change and after each poll that changes stage state.

---

## 9. The wizard (D7, D8)

A new route in the chatbot, reached from a **New Project** control in the header and from the
`Create a new project` chip. Three steps, matching the supplied reference design's stepper,
card and button treatment.

**Step 1 — Details.** Project name (validated against the existing `[A-Za-z0-9._ &-]` rule).
About the client — free text, becomes `description.md`, subject to the existing 40-character
minimum. Their website, optional.

**Step 2 — Documents.** One untyped dropzone: "Drag and drop project documents". No SOP /
Transcript / Notes split in the UI — `fileRouter.ts` continues to sort behind the scenes, and
everything is converted to markdown on arrival.

**Step 3 — Review.** Project entity, document count, branding found or not, then **Deploy**.

`POST /api/projects` creates the folder tree, writes `description.md`, and — if a URL was given
— runs `scripts/extract-brand.mjs <url> <project>` synchronously, since it is a fetch and not
an agent. A branding failure is reported, never fatal; the Scyne palette is the fallback.

Deploy creates a **`Set up project — <project>`** issue assigned to the Delivery Lead. The
Delivery Lead dispatches the Capabilities Process Architect; on the `issue_children_completed`
wake it dispatches the Service Designer; when that completes it posts the summary and closes.
This is the sibling-dispatch pattern already proven by the Build UI flow, not a new mechanism.
Two approval gates result, in order.

### 9.1 Adding a feature

An **Add a feature** chip appears once a project is selected. Clicking it sends a chat message;
the LLM calls a new `create_feature({project, feature})` tool → `POST /api/features`, which
scaffolds the feature tree. The bot then tells the user to attach the feature's documents with
the existing 📎 button, and the chip row offers `Generate the product summary`.

No new UI component. The wizard stays project-only.

---

## 10. Files touched

### New

| Path | Purpose |
|---|---|
| `scripts/pipeline.mjs` | The stage graph, shared by CLI, server and renderer |
| `scripts/migrate-to-project-level.mjs` | One-shot migration (§11) |
| `scyne-chatbot/src/components/NewProjectWizard.tsx` | The three-step wizard |
| `scyne-chatbot/src/components/SuggestionChips.tsx` | The chip row |

### Changed

**Scripts** — `stage.mjs` (project stages, read-down, import the graph),
`render-companion-app.mjs` (project-scoped, drill-down), `render-mockups.mjs` (output root,
project theme), `render-capability-map.mjs` (project paths), `validate-experience.mjs`
(project paths), `extract-brand.mjs` (`<url> <project>`), `audit-a11y.mjs` (registry key).

**Skills** — `capability-process-map` and `persona-journey-map` take project inputs;
`requirement-generator`, `ui-mockup-generator`, `salesforce-data-modeler`,
`salesforce-service-cloud-architecture`, `requirements-test-case-generator` and
`solution-design-document` gain the `project/` input folder. All eight gain the Revision mode
section from §7.4.

**Agent bundles** (`{path, content}` JSON, re-pushed by `npm run bootstrap`) —
`capabilities-process-architect.json` and `service-designer.json` become project-scoped;
`ba.json`, `ux-designer.json`, `data-modeler.json`, `solution-architect.json`,
`qa-architect.json`, `architect-lead.json` gain read-down staging and revision handling;
`ui.json` renders one project page; `pm.json` gains `Set up project — ` and `Revise … — `
routing, and its capability-map and personas routes become project-scoped (they still exist —
a consultant can re-run either on its own — they just carry a project and no feature).

**Chatbot server** — `index.ts` (project-scoped trigger routes, `POST /api/projects`,
`POST /api/features`, `POST /api/revise`, `GET /api/suggestions`, `GET /api/staleness`,
project-scoped companion-app and preview routes, `scope=project` uploads); `llm.ts` (the new
order, project vs feature tools, `revise_artefact`, `create_feature`); `workspace.ts`
unchanged.

**Chatbot frontend** — `App.tsx` (wizard route, chips, revision handling, project-scoped
preview), `PreviewPane.tsx`, `TargetPicker.tsx`, `ArtifactsPreview.tsx`, `api.ts`, `types.ts`.

**Docs** — `CLAUDE.md` and `scyne-chatbot/CLAUDE.md`, both substantially.

---

## 11. Migration

Only `projects/SAPN/interiam-benifits` has capabilities and personas outputs today, so this is
a single feature to lift, not a migration project. `scripts/migrate-to-project-level.mjs`
performs it and is safe to run on any project:

1. Move `<feature>/solutions/Capabilities/` and `<feature>/solutions/Experience/` up to
   `projects/<project>/solutions/`. If two features under one project both have them, the most
   recently modified wins and the other is moved to
   `projects/<project>/original-files/superseded/<feature>/` — never deleted, and reported.
2. Move `<feature>/design/style-guides/theme.json` up to `projects/<project>/design/style-guides/`,
   same tie-break.
3. Move any `<feature>/requirements/Notes/*.md` that the capability stage had been reading as
   project-wide context — **not automated**; the script lists candidates and takes no action,
   because only the consultant knows which notes are project-wide.
4. Delete `generated-apps/<project>-<feature>/` and its registry entries (D13), then re-render
   `generated-apps/<project>/`.

The script is idempotent, prints a dry-run plan under `--dry`, and refuses to overwrite an
existing project-level artefact without `--force`.

---

## 12. Testing

The repo has no test harness today, and this design does not introduce one — that is a separate
decision. Verification is therefore the existing validators plus explicit manual gates, and the
plan must treat these as blocking:

| What | How |
|---|---|
| Pipeline graph | `npm run stage` with no arguments renders the full grid, project and feature rows, for all five existing features |
| Staging | `npm run stage SAPN capabilities` and `npm run stage SAPN interiam-benifits ui` produce the documented working folders, `project/` included |
| Contract validators | `node scripts/render-capability-map.mjs SAPN --validate-only` and `node scripts/validate-experience.mjs SAPN` exit 0 against migrated artefacts |
| Mockups | `node scripts/render-mockups.mjs SAPN` writes `generated-apps/SAPN/mockups/interiam-benifits/` |
| Companion app | `node scripts/render-companion-app.mjs SAPN` produces one page; every tab reachable; drill-in and Back work; zero network requests |
| Accessibility | `node scripts/audit-a11y.mjs SAPN` clean — **and** the four theme states checked manually per the standing caveat that axe and pa11y only test one |
| Endpoints | `curl` each new route; `/api/suggestions` returns no chip whose stage would 409 |
| Wizard | Create a throwaway project end to end, confirm both gates fire in order |
| Revision | Revise the SAPN data model with a one-line instruction; confirm the diff is small, the gate fires, and the Confluence page is updated rather than duplicated |

---

## 13. Phasing

Each phase leaves the repo working.

**Phase 1 — Foundation.** `pipeline.mjs`; project-level layout; `stage.mjs` project stages and
read-down; the migration script; skills and agent bundles. Ends with the full pipeline runnable
from the CLI against the new layout.

**Phase 2 — Companion app.** Project-scoped renderer with feature drill-down; `render-mockups`
output move; registry reshape; server preview routes; `PreviewPane`. Ends with one page per
project.

**Phase 3 — Wizard.** `POST /api/projects`, `POST /api/features`, the `Set up project —` flow,
`NewProjectWizard.tsx`, the Delivery Lead's sequential dispatch.

**Phase 4 — Chips and staleness.** `/api/suggestions`, `/api/staleness`, `SuggestionChips.tsx`,
the post-approval stale line.

**Phase 5 — Revision.** `/api/revise`, `revise_artefact`, `.published.json`, Delivery Lead
revision routing, Revision mode in all eight skills.

Phases 1 and 2 are the restructure and must land together for the app to render. Phases 3–5 are
independently shippable.

---

## 14. Risks

| Risk | Mitigation |
|---|---|
| `render-companion-app.mjs` is 2530 lines and its data loading is being reshaped | Change the load layer and the nav shell only; leave markdown, Mermaid, theme, chart and search untouched. Verify against SAPN, the one feature with a full artefact set |
| The a11y bar is evidence about one theme state only | Phase 2 verification checks all four states by hand, per the standing caveat in `CLAUDE.md` |
| First-pass mockups are weaker without the data model | `generatedFrom` on the JSON, a visible note on the screen page, and a staleness-driven refresh chip (§4.2) |
| Revision produces a diff too large to review | The Revision mode contract forbids restructuring untouched sections; the approval gate is the check |
| Placeholder agent IDs in `pm.json` must stay in sync with `OLD_IDS` in `bootstrap.mjs` | No new agents are hired, so no new placeholders. If that changes, the bootstrap already throws on an unswapped placeholder |
| `mockups.json` and the Experience JSON files are build contracts consumed weeks later | Their validators already exist and stay blocking; both are extended to the project paths in Phase 1 |
