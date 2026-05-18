# Scyne Requirements Generator — CLAUDE.md

This document is the orientation guide for anyone (Claude included) working on this repository. Read it before making changes.

## What this project is

A local end-to-end workflow that takes raw discovery artefacts for a single feature (meeting transcripts, policy docs, UI screens, optional notes) and produces:

1. A **Confluence-ready Product Summary** (11-section markdown).
2. A set of **Jira-ready user stories** (Atlassian Cloud REST v3 payloads).
3. A **working Vite + React + shadcn/ui app** scaffolded from the Product Summary, with WCAG 2.0 AA auto-fixes applied.

The user drives everything from a Scyne-branded chatbot UI. The chatbot doesn't do the work itself — it orchestrates through **Paperclip**, which runs four agents (PM → BA → UI Engineer → UX Auditor) on the local machine via Claude Code.

## The four-agent flow

```
chatbot UI
   │  POST /api/trigger   (creates a Paperclip issue, status=todo)
   ▼
Project Manager (PM)
   ├─ classifies issue intent by title prefix:
   │    "Generate requirements — …"  → REQUIREMENTS flow
   │    "Build UI — …"               → UI flow
   └─ creates a child issue assigned to the BA (status=todo)
         ▼
Business Analyst (BA) — runs in three phases
   ├─ PHASE 1: reads inputs from projects/<project>/<feature>/requirements/
   │          runs the `requirement-generator` skill → outputs/* (5 files)
   │          attaches them as work-products, raises an approval gate
   │
   ├─ PHASE 2 (after human approves): uses the `atlassian` MCP to
   │          create the Confluence page + Jira stories
   │
   └─ PHASE 3 (when intent=build_ui or "build ui" comment received):
         creates child issue assigned to the UI Engineer
              ▼
        UI Engineer
           ├─ reads design references + BA outputs
           ├─ scaffolds a Vite + React + shadcn/ui app into generated-apps/<project>-<feature>/
           ├─ pushes to a user-supplied GitHub repo on branch ui/<project>-<feature>
           └─ creates child issue assigned to the UX Auditor
                 ▼
              UX Auditor
                ├─ runs WCAG 2.0 AA checks against the generated app
                ├─ auto-fixes safe violations (contrast, alt-text, focus rings, etc.)
                └─ commits a11y: fixes back onto the same branch
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
└── (paperclip clone lives at ~/Projects/buzzinga/paperclip — sibling, not nested)
```

## IDs and configuration

All IDs live in `scyne-chatbot/.env`. The two below are the source of truth for local dev:

| Field                 | Value                                                          |
| --------------------- | -------------------------------------------------------------- |
| Company               | `2131f183-3822-4eee-9370-4b5cafae7e29` (`Scyne`)                |
| Project Manager (PM)  | `212a6542-4e49-41dc-94f0-7d7acbc460ba`                          |
| Business Analyst (BA) | `7561c779-5c3f-4e3a-9dc2-0f13eb1851ec`                          |
| UI Engineer           | _hired separately_; insert into `ba.json` after creation       |
| UX Auditor            | _hired separately_; UI agent references it after creation     |

If you re-hire agents (new IDs), update:
1. `scyne-chatbot/.env` (`PAPERCLIP_COMPANY_ID`, `PAPERCLIP_PM_AGENT_ID`).
2. `agent-instructions/pm.json` (BA id baked into PM's instructions).
3. `agent-instructions/ba.json` (UI Engineer id baked into BA's instructions).
4. `agent-instructions/ui.json` (UX Auditor id baked into UI's instructions).
5. Push the updated JSON files via `PUT /api/agents/:id/instructions-bundle/file`.

## Paperclip (the orchestrator)

- Clone lives at `~/Projects/buzzinga/paperclip`.
- Runs locally at `http://127.0.0.1:3100` in `local_trusted (private)` deployment mode.
- API base: `http://127.0.0.1:3100/api`.
- **No authentication is required for any local API call.** Every request from localhost is automatically treated as the `local-board` user with admin rights. Do NOT add `Authorization` headers. Do NOT look for `PAPERCLIP_API_KEY`. This is the most common source of confusion — agent instructions all start with a reminder about this.
- The `requirement-generator` skill is installed at `~/Projects/buzzinga/paperclip/skills/requirement-generator/SKILL.md`. Paperclip auto-syncs all skills under `skills/` into every hired agent's `desiredSkills` list.
- Start Paperclip with `cd ~/Projects/buzzinga/paperclip && pnpm dev`. Embedded PostgreSQL boots automatically.

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

`~/Projects/buzzinga/paperclip/skills/requirement-generator/SKILL.md` — the BA loads this in Phase 1. It defines:

- Input layout: `./projects/<project>/<feature>/requirements/{Policy,Transcripts,Notes,UI}/`.
- Output schema: 5 files in `./outputs/`.
- House style: `<process_number> As a <role>, I want <action>, So that <outcome>.`, Australian English, declarative AC bullets (not Gherkin), persona format `Full Name (ABBR)`.
- 11-section Product Summary template, with placeholder text preserved verbatim in sections 3.3.1, 7, 8, 9, 10, 11.
- Reference files at `./examples/gold-product-summary.pdf` and `./examples/gold-story.doc` — the BA matches these for house style.

To edit the skill: change the file in the paperclip clone (no API push needed; Paperclip re-reads from disk on the next agent run).

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

The tool schema requires `project` and `scenario` … sorry, `project` and `feature`. Defaults from `.env` fill in everything else (`process_l3`, `parent_epic_key`, etc.).

### Frontend layout

- **Left panel**: chat with the LLM. Agent comments stream in as bubbles with the author label (e.g. `BA · SCY-2`). Approval gates render inline as a card with an expandable "Review what will be pushed" preview (Stories / Product Summary / Gaps tabs).
- **Right panel**: workflow status. Stage pill (queued → PM triaging → BA generating → awaiting approval → pushing → complete), progress list of issues, autoscrolling activity timeline, links panel for Confluence + Jira.
- **Session persistence**: `parentIssueId` is saved to `localStorage`. Refresh resumes the workflow.
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

The BA's adapter is configured with `extraArgs: ["--mcp-config", "/Users/.../requirement-generator/.mcp.json"]` so Claude Code in the BA's headless subprocess loads this MCP. (Without `--mcp-config`, project-scope MCPs require interactive trust approval which can't happen in `--print` mode.)

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
| Chatbot shows "undefined" for a parameter                | Frontend reading old field name                                                 | Search for the renamed field across `src/`; rebuild the tool schema response handler if needed.                                |
| `/api/features` returns `{}`                             | `projects/` folder missing, or `WORKSPACE_PATH` env var pointing elsewhere      | `mkdir projects/<project>/<feature>/...`, restart dev server.                                                                  |
| Atlassian MCP OAuth fails with "Supported sites required" | Logged-in Atlassian account has no Jira/Confluence site                         | Switch accounts, or create a free Atlassian Cloud trial site, then re-run `claude mcp add atlassian -- npx -y mcp-remote …`.    |
| Refresh loses the workflow                                | `localStorage.scyne_parent_issue_id` cleared                                    | Click the workflow status panel's "New session" button to start over; otherwise it should restore automatically.               |

---

If you're about to make a significant change, sketch the touched files first — most changes need to ripple through: `agent-instructions/<agent>.json` (re-pushed via curl), `paperclip/skills/requirement-generator/SKILL.md` (loaded from disk by BA), `scyne-chatbot/server/llm.ts` (system prompt + tool schema), `scyne-chatbot/src/App.tsx` (state + rendering), and `scyne-chatbot/.env` (defaults).
