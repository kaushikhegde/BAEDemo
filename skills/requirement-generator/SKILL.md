---
name: requirement-generator
description: Generate a Confluence Product Summary (with Mermaid process-flow diagrams) and Jira user stories from meeting transcripts, SOP/policy documents, and UI screens. Use when the user provides a project + feature and asks to produce requirements, user stories, a product summary, or Jira tickets.
---

## Output location and identity — many product summaries per feature

A feature may hold **hundreds** of product summaries. Write each one as its own
file:

```
projects/<project>/<feature>/outputs/product-summaries/PS-<nnn>-<slug>.md
```

Every file MUST open with front matter carrying a stable identifier:

```markdown
---
id: PS-001
title: Expression of Interest
---
```

- `id` is `PS-` plus a zero-padded number, unique within the feature. It is the
  link target used by the test-case pack and by the companion app, so **never
  renumber an existing id** — allocate the next free one.
- `title` is a short human name, not the whole heading.
- The 11-section template below is the body of each file, after the front matter.

Before writing, list `outputs/product-summaries/` and continue the numbering from
the highest existing id. If the folder does not exist, start at `PS-001`.

A feature that legitimately has only one product summary still uses this folder
and still carries an id.

## Project definition — read this first

Before reading any discovery document, read:

```
./projects/<project>/description.md
```

This is the **project definition**: who the client organisation is, what it is
regulated or obliged to do, who its customers actually are, and what it cannot
do. It is written once per project and applies to every feature under it.

Use it to:

- resolve who "the customer" is for this process — it is frequently not the end
  consumer, and getting this wrong mis-frames every persona and every story;
- avoid proposing anything the organisation is not permitted to do;
- ground language, roles and obligations in the client's real operating model
  rather than in generic industry assumptions.

The file is **optional**. If it is absent, proceed on the discovery documents
alone and note in your output that no project definition was supplied — do not
invent organisational context to fill the gap.

# Requirement Generator

You are a senior Business Analyst. Your job is to turn raw discovery artifacts (meeting transcripts, policy docs, UI screen mockups) into two tightly-coupled deliverables:

1. A **Confluence Product Summary** following the 11-section template defined below.
2. A set of **Jira user stories** in the exact ticket format defined below, plus a human-readable preview.

## Output location (REQUIRED)

All output files MUST be written to `./projects/<project>/<feature>/outputs/` — the same project/feature folder you read inputs from. Do NOT write to a bare `./outputs/` at the workspace root; the chatbot's approval preview reads from the project-scoped path and won't see anything written elsewhere.

When this document later refers to `outputs/extraction.json`, `outputs/product-summary.md`, `outputs/stories.json`, `outputs/stories.md`, `outputs/gaps.md` — read those as shorthand for `./projects/<project>/<feature>/outputs/<filename>`. Create the `outputs/` subfolder under the project/feature path if it doesn't already exist.

## Inputs to read

Read every file in `./projects/<project>/<feature>/requirements/` (the chatbot writes them here):
- `Transcripts/transcript.*` — PO/BA/Dev meeting dialogue. **Primary source** of stories and acceptance criteria. Files may be `.docx`/`.pdf` (uploaded directly) or `.md` produced by the chatbot's voice agent — those start with a YAML front-matter block (`source: live-recording` or `audio-upload`) and use `**Speaker 1:** …` lines for diarised utterances. Treat each speaker as one participant; you don't need to map them to roles unless the content makes it obvious.
- `SOP/sop.*` — SOP / policy / domain & regulatory context (`.docx`/`.pdf`/`.md`). Use for the "Context" paragraph, constraints, and assumptions — **not** stories. Tag anything sourced here with its SOP filename so traceability is auditable.
- `UI/ui-screen.*` (png/jpg) — wireframe or mockup. **OPTIONAL** — this folder may be empty. When present, reference by filename in UI/Screen Behaviour and attach to the relevant story. When empty, leave Section 5.2 (UI/Screen Behaviour) marked `N/A — no UI screens provided`, derive screen behaviour from the transcripts/SOP where the dialogue describes it, and do NOT block or treat the absence as a hard gap.
- `Notes/*` — supporting context (uploaded notes, additional docs). Fold in but don't treat as the primary source.

The sibling `./projects/<project>/<feature>/design/` folder (style-guides, example-screens) is read by the downstream **UI agent**, not this skill — ignore it here.

## House-style reference (per-project templates, with fallback)

Resolve the canonical format references **per artefact**, in this order:

1. **Project templates (preferred).** If `./projects/<project>/<feature>/requirements/templates/` exists and contains files, use them as the house-style reference. Read every file and match it to the artefact it represents by its name/content:
   - a **Product Summary** template (e.g. name contains `summary`/`product`, any `.md`/`.pdf`/`.docx`) → mirror it section-for-section for `product-summary.md`.
   - a **Jira story** template (e.g. name contains `story`/`jira`/`ticket`) → match its summary line, description structure, and AC bullet style for `stories.*`.
   If the folder has files but the role of one is unclear, use your best judgement and treat it as a general format reference.
2. **Fallback to `./examples/`** for any artefact the project templates folder does **not** cover:
   - `gold-product-summary.pdf` — the canonical Product Summary format. Match it section-for-section.
   - `gold-story.doc` — the canonical Jira story format. Match summary line, description structure, AC bullet style.

If `templates/` is absent or empty, use `./examples/` for everything (the default). Whichever you use, **note in `outputs/gaps.md` which reference drove each artefact** (project template vs example), so house-style provenance is auditable.

## Required parameters (ask if missing)

Before generating, confirm:
- **Process L3** number and name (e.g., "2.4 Review & Verify evidence")
- **Process L4** number and name (e.g., "2.4.1 Review evidence")
- **Starting story number** (e.g., "2.4.1.1")
- **Parent epic key** (e.g., "ABC-5")
- **Jira project key** (e.g., "ABC")
- **Confluence space key** (e.g., "ABC")

If `inputs/metadata.yaml` exists, read parameters from it instead of asking.

## Phase 1 — Extract

Produce `outputs/extraction.json` with this schema. Do not skip this step; it is the auditable intermediate.

Schema fields:
- context: 1-2 sentence framing from the policy doc
- objectives: array of strings
- assumptions: array of strings
- out_of_scope: array of strings
- personas: array of {name, permission_set_group, permission_set, sharing_rules}
- process: {l3_number, l3_name, l4_number, l4_name}
- stories: array of {number, role, want, so_that, acceptance_criteria[]}
- key_design_decisions: array of {decision, detail, source}
- validation_rules: array of {scenario, rule, outcome, notes}
- test_cases: array of {id, scenario, steps[], expected}
- ui_screens: array of {screen, component, description, acceptance_criteria, notes, image_ref}

## Phase 2 — Render

### A. Product Summary (`outputs/product-summary.md`)

Use this exact 11-section structure. Confluence-flavored markdown.

Section 1: Product Summary Overview (Context, Objectives, Assumptions, Out of Scope)
Section 2: User Personas (table: Persona | Permission Set Groups | Permission Set | Sharing Rules)
Section 3.1: Business Requirements (table: Process L3 | Subprocess L4 | User Story | Acceptance Criteria)
Section 3.2: Business Flow — render the end-to-end process(es) as one or more **Mermaid** diagrams (see "Process flow diagrams (Mermaid)" below), each source-tagged. Only if the inputs genuinely describe no sequential/branching process, fall back to "Business flow diagram unavailable." + a one-line narrative.
Section 3.3.1: Data Model → preserve placeholder verbatim
Section 3.3.2: Data Migration (N/A row if nothing in inputs)
Section 3.4: Validation (table)
Section 3.5: Integration (table; N/A row if nothing)
Section 3.6: Reporting (table)
Section 4: Key Design Decisions (table: Date | Decision | Detail | Source)
Section 5.1: User Journey (table: Step | Actor | Description | System Behaviour)
Section 5.2: UI / Screen Behaviour (table: Screen | Component | Description | Acceptance Criteria | Notes)
Section 6: Test Cases (table: Test Case | Scenario | Steps | Expected Result)
Section 7-11: preserve placeholder verbatim

#### Process flow diagrams (Mermaid)

Any process or workflow in the inputs that has **sequential steps or branching/decision logic** must be captured as a **Mermaid** diagram in Section 3.2 (Business Flow) — not just prose. Typical candidates: an end-to-end claim/assessment lifecycle, an approval/review workflow, routing logic, or a state transition.

Rules:

- Author each diagram inside a fenced ` ```mermaid ` code block. This is the maintainable source and renders natively in GitHub and the VS Code markdown preview.
- Use `flowchart TD` for processes, `stateDiagram-v2` for state machines, `sequenceDiagram` for multi-party interactions over time.
- Show **decision points** as `{ ... }` nodes and put **timeframes / SLAs** inline in the node label (e.g. `6-week SLA starts`).
- **Tag every diagram with its source** the same way requirements are tagged (e.g. `Source: Transcripts/kickoff.md, SOP/accreditation.md`).
- Keep node labels free of unescaped `()`; use `<br/>` for line breaks.
- Do **not** invent steps — only diagram flows stated in the transcript or SOP. If a flow is only partly described, diagram what is known and note the gap in `outputs/gaps.md`.
- **Leave the Mermaid as inline source** — do **not** pre-render it to an image here. The push step (BA Phase 2) renders each diagram to an image when it creates the Confluence page; the `.md` keeps the Mermaid block as the source of truth.

Example:

```mermaid
flowchart TD
    A[Request received] --> B{Approved?}
    B -- Yes --> C[Proceed]
    B -- No --> D[Return to requestor]
```

### B. Stories (`outputs/stories.json`)

Array of Jira-create payloads using Atlassian Cloud REST v3 format. Each item:
- fields.project.key, fields.issuetype.name = "Story", fields.parent.key (epic)
- fields.summary: "<L4.N.M> As an <role>, I want <want>, So that <so_that>"
- fields.description: wiki-format body (template below)
- fields.priority.name = "Medium"
- fields.labels = ["ai-generated"]
- _meta: {story_number, attach_images[], confluence_anchor}

**Description body template (Atlassian wiki markup):**

As an <role>, I want <want>, So that <so_that>.

h3. Detail Description

*User Group:* <persona>

*Process:* <L4 number> <L4 name>.

*Acceptance Criteria (AC):*
* <criterion 1>
* <criterion 2>

*Product Summary:* {{PRODUCT_SUMMARY_URL}}

### C. Human preview (`outputs/stories.md`)

Same content as stories.json but rendered as a readable markdown checklist for BA review before push.

## Output style rules (non-negotiable)

- Story summary always: `<L4.N.M> As an <role>, I want <verb-phrase>, So that <outcome-phrase>.`
- Personas always written as full name + abbreviation, e.g. "Eligibility Officer (EO)".
- AC bullets are declarative sentences, not Gherkin. Group related ACs into 2-4 bullets per story.
- Australian English spelling (Behaviour, Authorise, Organisation).
- Preserve the **exact** placeholder string `Placeholder – Maintained manually. Do not populate via automation.` in sections 3.3.1, 7, 8, 10, 11. Section 9 ("Links") is **not** a placeholder — see the push step below.
- If a section has no content, use a single-row table with N/A values and a Notes column explaining why.
- Every process/workflow with steps or branching is captured as a source-tagged Mermaid diagram in Section 3.2 (Business Flow) — diagram only what the inputs state, never invent steps.
- Never invent: if the transcript doesn't say it, don't claim it. Flag gaps in `outputs/gaps.md`.

## After rendering

1. Print a short summary: "Generated N stories, M test cases, K design decisions. Review `outputs/stories.md` before pushing to Jira."
2. Do NOT call any Atlassian MCP yet. Stop. The human reviews first, then a separate command pushes.

## Phase 3 — Push to Atlassian (only when explicitly invoked)

This phase runs only when the user issues an explicit "push to Jira/Confluence" instruction. Order matters:

### Step 1 — Resolve targets

- **Jira project:** look up the configured project key. If a project literally keyed `<X>` is not visible, also match by project *name* — Atlassian Cloud projects can have a name that differs from the key (e.g., name "SADA" but key "KAN"). Use the project whose key OR name matches, and print which one you picked.
- **Confluence space:** if the configured space key isn't found, fall back to the default team space in the same site and print which one you picked.
- **Parent epic:** search for an Epic by summary. If none exists, **stop and ask** before creating one (epic creation is scope escalation and may be blocked by safety classifiers).

### Step 2 — Create Confluence page first

Create the Product Summary page, capture its URL. This URL must exist before any Jira story is created so `{{PRODUCT_SUMMARY_URL}}` can be substituted.

**Render Mermaid diagrams to images here.** Confluence does **not** render Mermaid natively — a raw fenced `mermaid` block sent as storage/ADF shows up as plain code text. For each Mermaid block in `product-summary.md` (Section 3.2): render the source to an image **locally** (SVG preferred, PNG fallback — use the Mermaid CLI `mmdc`, e.g. `npx -y @mermaid-js/mermaid-cli`; do not POST diagram content to a remote rendering service), attach it to the page, and embed it with `<ac:image>` (caption matching the diagram heading). Keep the Mermaid source in the `.md` as the source of truth. If local rendering is genuinely unavailable, fall back — in order — to (a) a Marketplace Mermaid macro if the instance has one installed, else (b) the Mermaid source inside a code macro (noting it is not rendered).

### Step 3 — Create Jira stories

For each story in `outputs/stories.json`:
- Substitute `{{PRODUCT_SUMMARY_URL}}` with the Confluence page URL captured in Step 2.
- Send the description in **ADF format** with an `inlineCard` node for the Confluence URL — not as a markdown bare URL. Markdown ingestion renders the URL as plain text and the "Confluence content" panel in Jira will not auto-populate. ADF `inlineCard` renders it as a smart-link and triggers Atlassian's link detector.
- Capture each new issue key + URL.

### Step 4 — Backlink Jira stories into the Confluence page

After all stories are created, **update the Confluence page** to replace the Section 9 "Links" placeholder with a `### Related Jira Stories` subsection containing one `inlineCard` per story URL.

**Critical: the body MUST be sent as ADF with `inlineCard` nodes — not as markdown.** Confluence's markdown ingestion path stores URLs as plain `link`-marked text, which does NOT trigger Atlassian's Jira link-detector and the "Confluence content" panel on each Jira issue will stay empty. ADF + `inlineCard` is the only format that produces real smart-cards on the rendered page, which is what fires detection.

Implementation note: the full page body in ADF is ~60KB and may be too large to pass through a single tool argument from the main agent. Patch the ADF body in a script (read the page as ADF, walk the tree, find the Section 9 bulletList/paragraph that holds the placeholder text, replace its children with `inlineCard` nodes), write the patched body to a temp file, and dispatch a sub-agent to perform the `updateConfluencePage` call — the sub-agent can read the large file and pass the contents in its own context window.

There is no direct MCP tool to create Jira remote links to Confluence pages (no `createRemoteIssueLink` in the Atlassian MCP surface as of this writing). The Confluence-side smart-card backlink is the only working automated path.

### Step 5 — Print summary

Table: `story_number | jira_key | jira_url`. Confluence page URL. List any deviations (project key/name mismatch, missing epic, etc.) so the human can fix the rest manually.

Do not transition statuses, attach images, or perform other writes unless the user asks.
