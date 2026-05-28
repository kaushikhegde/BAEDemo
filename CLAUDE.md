# Scyne Requirements Generator — CLAUDE.md

This document is the orientation guide for anyone (Claude included) working on this repository. Read it before making changes.

## What this project is

A local end-to-end workflow that takes raw discovery artefacts for a single feature (meeting transcripts, policy docs, UI screens, optional notes) and produces:

1. A **Confluence-ready Product Summary** (11-section markdown).
2. A set of **Jira-ready user stories** (Atlassian Cloud REST v3 payloads).
3. A **working Vite + React + shadcn/ui app** scaffolded from the Product Summary, with WCAG 2.0 AA auto-fixes applied.

The user drives everything from a Scyne-branded chatbot UI. The chatbot doesn't do the work itself — it orchestrates through **Paperclip**, which runs four agents on the local machine via Claude Code. The **PM** is the single orchestrator: it delegates requirements to the **BA**, and drives the **UI Engineer** then the **UX Auditor** directly (all three report to the PM).

## The four-agent flow

```
chatbot UI
   │  POST /api/trigger   (creates a Paperclip issue, status=todo)
   ▼
Project Manager (PM) — orchestrates all three reports
   ├─ classifies issue intent by title prefix:
   │    "Generate requirements — …"  → REQUIREMENTS flow → BA
   │    "Build UI — …"               → UI flow → PM drives UI Engineer, then UX Auditor
   │
   ├─ REQUIREMENTS flow: creates a child issue assigned to the BA (status=todo)
   │     ▼
   │   Business Analyst (BA) — runs in two phases
   │      ├─ PHASE 1: reads inputs from projects/<project>/<feature>/requirements/
   │      │          runs the `requirement-generator` skill → outputs/* (5 files)
   │      │          attaches them as work-products, raises an approval gate
   │      └─ PHASE 2 (after human approves): uses the `atlassian` MCP to
   │                 create the Confluence page + Jira stories
   │
   └─ UI flow: PM dispatches the UI Engineer and UX Auditor directly, as
              SIBLINGS under the Build UI issue (not a chain). PM is re-woken
              automatically (issue_children_completed) after each child finishes.

      Sub-phase A → child issue assigned to UI Engineer (status=todo)
         ▼
       UI Engineer
          ├─ reads design references + BA outputs
          ├─ scaffolds a Vite + React + shadcn/ui app into generated-apps/<project>-<feature>/
          ├─ on "push to github <url>": pushes to branch ui/<project>-<feature>, records branch/repoUrl in the registry
          ├─ on "approve": leaves branch/repoUrl null in the registry (audit-only)
          └─ marks its issue done → PM auto-woken

      Sub-phase B → PM reads generated-apps/registry.json, dispatches UX Auditor (status=todo)
         ▼
       UX Auditor
          ├─ runs WCAG 2.0 AA checks against the generated app
          ├─ auto-fixes safe violations (contrast, alt-text, focus rings, etc.)
          ├─ commits a11y: fixes onto the branch (or audit-only if branch is null)
          └─ marks its issue done → PM auto-woken

      Sub-phase C → PM posts the summary and marks the Build UI issue done
```

The chatbot polls `/api/status/:issueId` every 3 seconds, surfaces comments as a live activity timeline, renders approval gates inline with an Approve / Reject card, and shows Confluence + Jira links the moment they appear in BA's comments.

## Folder layout

```
requirement-generator/                         workspace root (cwd for all agents)
├── CLAUDE.md                                  this file
├── .mcp.json                                  project-scope MCP config (atlassian)
├── projects/<project>/<feature>/
│   ├── requirements/
│   │   ├── Policy/         (one or more .docx/.txt)
│   │   ├── Transcripts/    (one or more .docx/.txt/.md)
│   │   ├── Notes/          (optional — additional notes)
│   │   └── UI/             (one or more .png/.jpg mockups)
│   ├── design/             (consumed by the UI Engineer, NOT the BA)
│   │   ├── style-guides/   (palette, typography, tokens, brand voice)
│   │   └── example-screens/(visual reference)
│   └── outputs/            (BA writes here; UI Engineer reads from here)
│       ├── extraction.json
│       ├── product-summary.md
│       ├── stories.json
│       ├── stories.md
│       └── gaps.md
├── generated-apps/<project>-<feature>/        UI Engineer writes the scaffolded React app here
├── examples/               (gold-standard reference docs — house style for the BA)
│   ├── gold-product-summary.pdf
│   └── gold-story.doc
├── agent-instructions/     (per-agent AGENTS.md JSON payloads, pushed to Paperclip via API)
│   ├── pm.json
│   ├── ba.json
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

All IDs live in `scyne-chatbot/.env`. The two below are the source of truth for local dev:

| Field                 | Value                                                          |
| --------------------- | -------------------------------------------------------------- |
| Company               | `2131f183-3822-4eee-9370-4b5cafae7e29` (`Scyne`)                |
| Project Manager (PM)  | `212a6542-4e49-41dc-94f0-7d7acbc460ba`                          |
| Business Analyst (BA) | `7561c779-5c3f-4e3a-9dc2-0f13eb1851ec`                          |
| UI Engineer           | `f19feb64-3ccd-42b2-b0b7-f9dfe7273a94` (reports to PM)          |
| UX Auditor            | `43a9e518-99c5-4916-8b91-3ff89e0c00ba` (reports to PM)          |

All four agents report to the PM (the UI Engineer and UX Auditor were moved off the BA). The PM dispatches the UI Engineer and UX Auditor directly as siblings under the Build UI issue; the BA owns requirements only.

If you re-hire agents (new IDs), update:
1. `scyne-chatbot/.env` (`PAPERCLIP_COMPANY_ID`, `PAPERCLIP_PM_AGENT_ID`).
2. `agent-instructions/pm.json` (BA, UI Engineer, and UX Auditor ids are all baked into PM's instructions — it dispatches all three).
3. Set each new agent's `reportsTo` to the PM id via `PATCH /api/agents/:id` (body `{"reportsTo":"<PM id>"}`).
4. Push the updated JSON files via `PUT /api/agents/:id/instructions-bundle/file`.

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
| POST   | `/api/companies/:companyId/issues`                | Create the parent issue, assigned to PM           |
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

## The Skill

The `requirement-generator` skill (source: `./skills/requirement-generator/SKILL.md` in this repo, registered with Paperclip by the bootstrap) — the BA invokes it **by name** in Phase 1. It defines:

- Input layout: `./projects/<project>/<feature>/requirements/{Policy,Transcripts,Notes,UI}/`.
- Output schema: 5 files in `./outputs/`.
- House style: `<process_number> As a <role>, I want <action>, So that <outcome>.`, Australian English, declarative AC bullets (not Gherkin), persona format `Full Name (ABBR)`.
- 11-section Product Summary template, with placeholder text preserved verbatim in sections 3.3.1, 7, 8, 9, 10, 11.
- Reference files at `./examples/gold-product-summary.pdf` and `./examples/gold-story.doc` — the BA matches these for house style.

To edit the skill: change `./skills/requirement-generator/SKILL.md` in this repo, then re-run the bootstrap so Paperclip re-registers the updated content.

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
| POST   | `/api/trigger`                    | Creates the Paperclip parent issue (status=todo, assigned to PM)          |
| GET    | `/api/status/:issueId`            | Normalised view: tree + stage + activity + approvals + extracted links    |
| POST   | `/api/approve/:approvalId`        | Resolves an approval gate as approved                                     |
| POST   | `/api/reject/:approvalId`         | Rejects an approval gate                                                  |
| POST   | `/api/request-changes/:approvalId`| Reviewer feedback → marks the gate `revision_requested`, comments the feedback, re-fires the BA (issue → `todo`) to regenerate |
| GET    | `/api/history`                    | All completed requirements runs with their Confluence + Jira links (History view) |
| GET    | `/api/runs/:issueId`              | Compact agent run summaries (agent · status · duration) for the run tree (Activity panel) |
| GET    | `/api/features`                   | Lists `projects/<project>/<feature>/` available on disk                   |
| GET    | `/api/artifacts`                  | Reads `outputs/*` from disk for the approval-card preview                 |
| POST   | `/api/upload`                     | File upload (audio recordings, attachments) — wired to multer + Gemini Files |
| POST   | `/api/ui-agent/trigger`           | Triggers the UI flow (creates a `Build UI — …` issue assigned to PM)     |
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

The LLM has three tools available:

- `set_target` — sets the chosen `{project, feature}` scope without firing anything. Lets the user pin a target before they're ready to run.
- `trigger_requirement_generation` — fires the requirements flow. Defaults from `.env` fill in everything except `project` and `feature`.
- `trigger_ui_build` — fires the UI flow (creates a `Build UI — …` issue assigned to PM). The UI Engineer + UX Auditor chain runs from there.

### Frontend layout

- **Left panel**: chat with the LLM. Agent comments stream in as bubbles with the author label (e.g. `BA · SCY-2`). Approval gates render inline as a card with an expandable "Review what will be pushed" preview (Stories / Product Summary / Gaps tabs).
- **Right panel**: workflow status. Stage pill (queued → PM triaging → BA generating → awaiting approval → pushing → complete), progress list of issues, autoscrolling activity timeline, links panel for Confluence + Jira.
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

**Per-project push targets (not fixed to SADA):** `/api/trigger` defaults the **Jira project key** and **Confluence space key** to the *project name* (e.g. project `RTWSA` → keys `RTWSA`), not the `.env` SADA values. The `.env` `DEFAULT_JIRA_PROJECT_KEY` / `DEFAULT_PARENT_EPIC_KEY` / `DEFAULT_CONFLUENCE_PAGE_TITLE` only apply when the chosen project equals `DEFAULT_JIRA_PROJECT_KEY` (the SADA demo); for any other project the parent epic is omitted and the page title defaults to the feature name. The BA's Phase 2 **verifies the Jira project + Confluence space exist** (`getVisibleJiraProjects` / `getConfluenceSpaces`) and blocks with a clear message if not — it cannot create projects/spaces (the Atlassian MCP has no such tool). The PM keeps the parent `Generate requirements` issue `in_progress` while the BA runs (it does **not** mark it `blocked`).

**Auto-provisioning (no client setup by default):** at the **approval** step, `/api/approve` reads the Jira/Confluence keys from the parent issue description and calls `server/services/atlassianProvision.ts` (`ensureAtlassianTargets`) to create the missing Jira project + Confluence space via the Atlassian **REST** API (not the MCP) before resolving the gate. Auth reuses the **OAuth login the client already did for the MCP** (token cached in `~/.mcp-auth/`, used as a Bearer against `api.atlassian.com` 3LO) — no API token needed. An explicit API token (`ATLASSIAN_SITE_URL`+`ATLASSIAN_EMAIL`+`ATLASSIAN_API_TOKEN`) takes priority if set (Basic auth), useful when the MCP grant lacks create scope. **Soft-fail policy:** auth/lookup problems → skip provisioning and let the BA verify-and-block (so a stale token never blocks an approval where the target already exists); only a definitive *missing-target + create-rejected* throws `502 provision_failed` and holds the gate. Jira projects are created team-managed Kanban by default (`ATLASSIAN_JIRA_TEMPLATE_KEY`/`ATLASSIAN_JIRA_PROJECT_TYPE` override).

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

```bash
curl -sS -X PUT \
  http://127.0.0.1:3100/api/agents/212a6542-4e49-41dc-94f0-7d7acbc460ba/instructions-bundle/file \
  -H "Content-Type: application/json" \
  -d @agent-instructions/pm.json

curl -sS -X PUT \
  http://127.0.0.1:3100/api/agents/7561c779-5c3f-4e3a-9dc2-0f13eb1851ec/instructions-bundle/file \
  -H "Content-Type: application/json" \
  -d @agent-instructions/ba.json
```

(Repeat for `ui.json` and `ux-auditor.json` with their respective agent IDs.)

### Add a new feature to a project

```bash
mkdir -p projects/<project>/<feature>/requirements/{Policy,Transcripts,Notes,UI}
mkdir -p projects/<project>/<feature>/design/{style-guides,example-screens}
mkdir -p projects/<project>/<feature>/outputs
# Drop files into the four requirements subfolders
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

Two Node scripts power the UI / a11y agents:

- `scripts/scaffold-app.mjs <project> <feature>` — used by the **UI Engineer**. Creates `generated-apps/<project>-<feature>/` from the Vite react-ts template, installs deps, adds Tailwind + shadcn/ui, allocates a free port (`PAPERCLIP_PORT_BASE` or 5174), launches `npm run dev` detached, and waits until the dev URL responds. Writes the entry into `generated-apps/registry.json`. Idempotent — if the app and its PID are alive, it just re-prints the registry entry.
- `scripts/audit-a11y.mjs <project-feature-key>` — used by the **UX Auditor**. Reads the registry entry, runs `@axe-core/cli` (WCAG 2.0 A + AA) and `pa11y` (WCAG2AA standard) against the dev URL, then writes consolidated violations to `generated-apps/<key>/audit.json`. Exits 0 even when violations exist — the auditor reads the JSON to decide what to fix.

The chatbot doesn't call these directly; the agents do (via the `Bash` tool in their Claude Code sessions).

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

The chatbot's `/api/preview/:project/:feature` looks up the entry and returns the dev URL. The UI Engineer and UX Auditor both treat this file as authoritative — if a description disagrees with the registry, the registry wins.

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
| PM does the work itself instead of delegating to the BA  | Stale PM Claude session carrying a prior "do it myself" conclusion, or agents never (re)bootstrapped after a code/instructions change. Verified May 2026: on a clean `npm run bootstrap` the PM correctly creates a BA child and the BA raises the approval gate — the delegation path is sound. | Re-run `npm run bootstrap` (re-pushes instructions, sets `cwd`), then force a fresh PM session on the next wake with `{"forceFreshSession": true}`. Confirm the PM's `adapterConfig.cwd` points at this repo and `instructionsFilePath` is set (`GET /api/agents/<pm-id>`). |
| Chatbot shows "undefined" for a parameter                | Frontend reading old field name                                                 | Search for the renamed field across `src/`; rebuild the tool schema response handler if needed.                                |
| `/api/features` returns `{}`                             | `projects/` folder missing, or `WORKSPACE_PATH` env var pointing elsewhere      | `mkdir projects/<project>/<feature>/...`, restart dev server.                                                                  |
| Atlassian MCP OAuth fails with "Supported sites required" | Logged-in Atlassian account has no Jira/Confluence site                         | Switch accounts, or create a free Atlassian Cloud trial site, then re-run `claude mcp add atlassian -- npx -y mcp-remote …`.    |
| Refresh loses the workflow                                | `localStorage.scyne_parent_issue_id` cleared                                    | Click the workflow status panel's "New session" button to start over; otherwise it should restore automatically.               |

---

If you're about to make a significant change, sketch the touched files first — most changes need to ripple through: `agent-instructions/<agent>.json` (re-pushed via curl), `paperclip/skills/requirement-generator/SKILL.md` (loaded from disk by BA), `scyne-chatbot/server/llm.ts` (system prompt + tool schema), `scyne-chatbot/src/App.tsx` (state + rendering), and `scyne-chatbot/.env` (defaults).
