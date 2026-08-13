# scyne-chatbot — CLAUDE.md

This document is a focused guide to the chatbot codebase. For the bigger picture (agents, skill, Paperclip orchestration), read `../CLAUDE.md` first.

## What this is

The Scyne-branded conversational front-end for the requirements-generation workflow. The user chats with it; it orchestrates through Paperclip; agents do the work.

Two-process local app:

- **Frontend**: React + Vite + Tailwind + shadcn/ui on `http://127.0.0.1:5173`
- **Backend**: Express (TypeScript via tsx) on `http://127.0.0.1:4000`. Vite proxies `/api/*` to the backend.

Both are launched together with `npm run dev` (concurrently).

## Stack notes

- **LLM**: Gemini 2.5 Flash via `@google/generative-ai` (the legacy SDK — matches the compliance-app pattern). Function calling enabled for the trigger tool.
- **Auth**: none. Paperclip is in `local_trusted` mode; localhost calls are auto-authenticated as the board user.
- **Persistence**: `localStorage` only — `scyne_session` (login), `scyne_parent_issue_id` (active workflow), and the chat transcript: `scyne_chat_messages` (rendered bubbles) + `scyne_chat_history` (LLM history). On refresh the chat is restored from those keys and the right-hand workflow panel rehydrates from `/api/status`. "New session" and logout clear the chat keys (`clearChatPersistence`).
- **Login gate**: hardcoded demo creds (`admin` / `scyne2026`) in `src/components/Login.tsx`. Session is `{user, ts}`; expiry is a separate concern, not enforced. Replace with real auth when wiring SSO.
- **WebSockets**: optional path for live audio. `wss.on("connection",...)` is mounted on the same HTTP server. Browser → `recordingSocketUrl()` → backend → Gemini Live → live transcription back over the same socket. The main workflow uses HTTP polling (every 3 s).

## Project structure

```
scyne-chatbot/
├── .env / .env.example     (config — see below)
├── package.json            (scripts: dev | dev:vite | dev:api | build | preview)
├── vite.config.ts          (proxy /api → :4000)
├── tailwind.config.js      (Scyne palette under `theme.extend.colors.scyne`)
├── components.json         (shadcn/ui aliases)
├── index.html
├── public/
│   ├── image.png            (login background candidate)
│   ├── login-bg.svg        (fallback login background)
│   └── pcm-worklet.js      (Web Audio worklet — captures 16 kHz PCM for live transcription)
├── server/                 (Express backend, tsx-watched)
│   ├── index.ts            (all HTTP routes)
│   ├── llm.ts              (Gemini client, system prompt builder, tool schema)
│   ├── paperclip.ts        (Paperclip API client; no-auth, normalised methods)
│   ├── types.ts
│   └── services/
│       ├── fileRouter.ts       (decides which projects/<p>/<f>/requirements/X folder an upload belongs in)
│       ├── geminiFiles.ts      (uploads audio/video to Gemini Files API for transcription)
│       ├── geminiLive.ts       (Gemini Live WebSocket — real-time transcription)
│       └── transcriptWriter.ts (writes incremental transcript lines to disk)
└── src/                    (React frontend)
    ├── main.tsx            (entry)
    ├── App.tsx             (the only stateful component)
    ├── api.ts              (typed fetch wrappers + recordingSocketUrl() for WS; upload helpers with hint types sop/transcripts/notes/ui)
    ├── types.ts            (UIMessage, StatusSnapshot, ArtifactStory, etc.)
    ├── index.css           (Tailwind base + shadcn theme tokens)
    ├── lib/utils.ts        (cn() helper for shadcn)
    └── components/
        ├── ui/             (shadcn/ui primitives — generated, don't hand-edit)
        ├── Login.tsx            (login gate; reads/writes localStorage.scyne_session; image candidates in /public)
        ├── Header.tsx          (branded top bar, accepts `right` slot)
        ├── MessageBubble.tsx   (user/assistant/agent variants; uses MiniMarkdown)
        ├── MiniMarkdown.tsx    (headings, bullets, bold, code spans/blocks, links)
        ├── StagePill.tsx       (queued → pm_triaging → ba_generating → awaiting_approval → pushing → done)
        ├── ProgressPanel.tsx   (flat list of issues + statuses)
        ├── ActivityTimeline.tsx(comments, autoscrolling, markdown-rendered)
        ├── ApprovalCard.tsx    (inline approve/reject with collapsible artefact preview)
        ├── ArtifactsPreview.tsx(tabs: Stories | Product Summary | Gaps | Data Model | Solution Design | Solution Architecture | Test Cases | Personas & Journeys | Capability Map — reads /api/artifacts; the Capability Map tab also links to the interactive HTML)
        ├── LinksPanel.tsx      (Confluence + Jira links extracted from comments)
        ├── TargetPicker.tsx    (chip-style project + feature selector at top of chat)
        ├── AttachmentButton.tsx(upload .docx / .pdf / .png to a chosen scope)
        ├── RecordMeetingPanel.tsx (browser audio capture → Gemini Live transcription)
        └── PreviewPane.tsx     (iframes the generated app from /api/preview/:project/:feature)
```

## Backend endpoints

All defined in `server/index.ts`. The frontend calls them through `src/api.ts`.

| Method | Path                                | Purpose                                                                   |
| ------ | ----------------------------------- | ------------------------------------------------------------------------- |
| POST   | `/api/chat`                         | Proxies the conversation to Gemini. Returns Anthropic-shaped blocks (`{content:[{type:"text"|"tool_use",...}]}`) so the frontend doesn't care which model is behind. |
| POST   | `/api/trigger`                      | Creates a `Generate requirements — …` issue assigned to the Delivery Lead with `status:"todo"`. Body merges with `.env` defaults. **Pre-flight:** returns `409 {error:"missing_inputs", emptyFolders}` if SOP/Transcripts/UI are empty. |
| POST   | `/api/data-model/trigger`           | Creates a `Generate data model — …` issue. **Pre-flight:** `409 {error:"no_product_summary"}` if `outputs/product-summary.md` is missing. |
| POST   | `/api/solution-design/trigger`      | Creates a `Generate solution design — …` issue. **Pre-flight:** `409 {error:"no_data_model"}` if `solutions/DataModel/outputs/datamodel-impact.md` is missing. |
| POST   | `/api/capability-map/trigger`       | Creates a `Generate capability map — …` issue. **No pipeline prerequisite** — reads the same SOP/Transcripts/Notes as the BA. **Pre-flight:** `409 {error:"no_documents"}` only when the feature has no `.md` anywhere outside `outputs/`, `solutions/`, `design/`. Emits no Confluence key, so `/api/approve` skips provisioning. |
| POST   | `/api/solution-architecture/trigger` | Creates a `Generate solution architecture — …` issue (Solution Architect → SAD). **Pre-flight:** `409 {error:"no_product_summary"}` only. Deliberately NOT gated on the data model. |
| POST   | `/api/test-cases/trigger`           | Creates a `Generate test cases — …` issue (QA Architect → test pack). **Pre-flight:** `409 {error:"no_product_summary"}` only. |
| POST   | `/api/personas/trigger`             | Creates a `Generate personas — …` issue (Service Designer → persona set + journey maps). **No pipeline prerequisite** — reads the same discovery documents as the BA. **Pre-flight:** `409 {error:"no_documents"}` only. Unlike the capability map it DOES publish, so it carries the Confluence space key. |
| GET    | `/api/capability-map/:project/:feature` | Serves the architect's rendered `solutions/Capabilities/outputs/capability-process.html` as `text/html`. `404 {error:"not_generated"}` before the stage runs. Linked from the approval card, not iframed. |
| GET    | `/api/status/:issueId`              | The polling endpoint. Returns `{tree, stage, flatIssues, activity, approvals, links, workProducts}`. Walks the parent + all descendants. `stage.label` adapts to the flow's worker. |
| POST   | `/api/approve/:approvalId`          | Resolves an approval gate; explicitly wakes the gate's own issue assignee (BA / Data Modeler / Architecture Lead). Atlassian auto-provisioning runs only for the requirements flow. |
| POST   | `/api/reject/:approvalId`           | Rejects an approval gate.                                                  |
| POST   | `/api/request-changes/:approvalId`  | Reviewer feedback loop: rejects the gate with the feedback, comments it on the issue, flips the issue to `todo`, and wakes its assignee to regenerate — works for any worker, not just the BA. Body `{issueId, feedback}`. |
| GET    | `/api/history`                      | All completed pipeline runs (requirements, data model, solution design) across sessions, each with extracted Confluence + Jira links. Used by `HistoryView`. |
| GET    | `/api/runs/:issueId`                | Compact agent run summaries (agent · status · duration) for the parent + descendant issues. Used by `RunsPanel` in the Activity panel. No tool counts (claude_local tool calls live in the run log, not run events). |
| GET    | `/api/features`                     | Scans `projects/` on disk and returns `{<project>: [{name, counts}]}`. Used by `TargetPicker`. |
| GET    | `/api/artifacts`                    | Reads the BA's `outputs/{product-summary.md,stories.json,stories.md,gaps.md}` plus `solutions/DataModel/outputs/datamodel-impact.md`, `solutions/Design/outputs/solution-design.md` and `solutions/Capabilities/outputs/capability-process.md`. Used by `ArtifactsPreview` inside the approval card. |
| POST   | `/api/upload`                       | Multer-handled upload. Routes the file into the correct `projects/<p>/<f>/requirements/<sub>/` folder via `fileRouter`. Supports passing audio to `geminiFiles` for transcription. |
| POST   | `/api/ui-agent/trigger`             | Creates a `Build UI — <project>/<feature>` issue assigned to the Delivery Lead. Delivery Lead detects the title prefix and dispatches the Developer directly, then the UX Auditor once the build completes. |
| GET    | `/api/companion-app/:project/:feature` | Serves the rendered `generated-apps/<project>-<feature>/index.html` as `text/html` with `Cache-Control: no-store`. `404 {error:"not_generated"}` before the Developer has rendered it. This is what the preview iframe points at. |
| GET    | `/api/preview/:project/:feature`    | Resolves the registry entry for the generated companion app. `devUrl` now points at `/api/companion-app/…` rather than a dev server, so `PreviewPane` and `scripts/audit-a11y.mjs` are unchanged. |
| POST   | `/api/preview/:project/:feature/:action` | `start` re-renders the companion app (`render-companion-app.mjs`); `stop` is a reported no-op, since a static page has no server. The React dev-server path lives in `scripts/legacy-react-scaffold/`. |
| POST   | `/api/ui-agent/comment`             | Adds a follow-up comment on the UI-build issue (e.g. iteration prompts).  |
| WS     | `ws://127.0.0.1:4000/recording`     | Browser ↔ backend audio stream. Client pushes PCM frames; backend pipes them into Gemini Live and pushes transcript chunks back. Used by `RecordMeetingPanel`. |

The Paperclip client (`server/paperclip.ts`) wraps just the calls the chatbot needs. Notable methods:

- `createIssue(title, description)` — always `status: "todo"`, always `assigneeAgentId: deliveryLead`.
- `listChildren(parentId)` — uses `GET /companies/:companyId/issues?parentId=…` (there is **no** `/issues/:id/children`).
- `getIssueTree(rootId)` — recursive; folds in comments, approvals, work-products at each node.
- `approveGate(id, note)` / `rejectGate(id, note)`.

`/api/status` then walks the tree, flattens, extracts URLs (Confluence + Jira regex), and computes a coarse `stage` label.

## Frontend state model

The only stateful React component is `src/App.tsx`. All other components are presentational. State lives here:

| State                  | Type                            | Purpose                                                                 |
| ---------------------- | ------------------------------- | ----------------------------------------------------------------------- |
| `session`              | `LoginSession \| null`         | From `loadSession()`. If null, the app renders `<Login>` instead of the main UI.        |
| `messages`             | `UIMessage[]`                   | What the chat panel renders. Three kinds: user, assistant (LLM), agent (Delivery Lead/BA comments). |
| `apiHistory`           | `ApiMsg[]`                      | Anthropic-shaped conversation history sent to `/api/chat`.              |
| `draft`                | `string`                        | Composer textarea contents.                                              |
| `busy`                 | `boolean`                       | Composer disabled while a chat round-trip is in flight.                  |
| `parentIssueId`        | `string \| null`                | Persisted to `localStorage.scyne_parent_issue_id`. Drives the polling effect. |
| `status`               | `StatusSnapshot \| null`        | Latest `/api/status` response. Refreshed every 3 s.                      |
| `targetProject`/`targetFeature` | `string \| null`        | What the user has selected in `TargetPicker`. Sent with the trigger.     |
| `featuresRefreshKey`   | `number`                        | Bumped after an upload to force `TargetPicker` to re-fetch `/api/features`. |
| `rightTab`             | `"activity" \| "ui"`            | Toggle on the right pane: workflow status vs UI preview.                 |
| `previewAvailable`     | `boolean`                       | True once `/api/preview/:project/:feature` returns a URL.                |
| `pendingUiPrompt`      | `{project, feature} \| null`    | When the bot suggests a UI build, this stages a one-click trigger.       |
| `seenCommentIds`       | `useRef<Set<string>>`           | Dedupes agent comments so the same one doesn't appear twice in the chat. |

Three effects drive the UX:

1. **Auto-scroll**: scrolls the chat container to the bottom whenever `messages` changes.
2. **Status polling**: starts when `parentIssueId` is set; polls `/api/status/:id` every 3 s; fans new comments into the chat as `agent` messages.
3. **UI preview check**: polls `/api/preview/:project/:feature` once the BA reports a UI build is underway; flips `previewAvailable` so the right tab unlocks.

Persistence rule: `parentIssueId`, the chat transcript (`messages` → `scyne_chat_messages`, `apiHistory` → `scyne_chat_history`), and the target are saved to `localStorage`. On refresh the chat bubbles + LLM history are restored from those keys (see `loadMessages`/`loadHistory`) and the polling effect re-runs to rehydrate the right-hand workflow panel from `/api/status`. If a poll fails, `statusError` drives an error/retry card instead of leaving the panel on skeletons forever.

## The Gemini conversation (`server/llm.ts`)

The system prompt is **built fresh on every `/api/chat` call** by `buildSystemPrompt(scenariosBlock)`, where `scenariosBlock` comes from scanning `projects/` on disk. So the LLM always sees the current truth: which projects, which features, how many files in each subfolder.

The prompt instructs a discovery flow:

1. Greet briefly (no upfront listing).
2. List projects when asked.
3. Drill into a project when named — list its features.
4. Confirm the chosen `<project> / <feature>` and ask if ready.
5. On any confirmation phrasing, call the appropriate tool.

**Tools exposed to the LLM** (all defined in `server/llm.ts`):

| Tool                            | When the bot calls it                                                                           |
| ------------------------------- | ----------------------------------------------------------------------------------------------- |
| `set_target`                    | When the user picks a project + feature but isn't ready to fire yet. Pins the scope so the right-pane TargetPicker reflects it. No Paperclip side effect. |
| `trigger_requirement_generation`| When the user is ready to generate Product Summary + Jira stories. Creates a `Generate requirements — …` issue assigned to the Delivery Lead. |
| `trigger_data_model`            | When the user asks for the data model / object impact / ER diagram. Creates a `Generate data model — …` issue. Backend 409s `no_product_summary` if requirements aren't done — the bot then offers to run them first. |
| `trigger_solution_design`       | When the user asks for the solution design / SDD / architecture. Creates a `Generate solution design — …` issue. Backend 409s `no_data_model` if the data model isn't done — the bot then offers to run it first. |
| `trigger_capability_map`        | When the user asks for a capability map, capability model, business capabilities, process model, L1/L2/L3 processes or operating model. Creates a `Generate capability map — …` issue. **No prerequisite** — never offer to run requirements first for this one; the only 409 is `no_documents`. |
| `trigger_solution_architecture` | When the user asks for a solution architecture, SAD, HLD/LLD, target architecture, component design or integration architecture. Creates a `Generate solution architecture — …` issue. Only 409 is `no_product_summary`. **Not the same as `trigger_solution_design`** — the prompt tells the bot to ask which one when the request is ambiguous. |
| `trigger_test_cases`            | When the user asks for test cases, a test plan/pack, QA or UAT scripts, acceptance tests, BDD scenarios or a traceability matrix. Creates a `Generate test cases — …` issue. Only 409 is `no_product_summary`. |
| `trigger_personas`              | When the user asks who the users are, to identify personas, to map a customer/user journey, for a journey or experience map, a service blueprint, the as-is vs to-be experience, or moments that matter. Creates a `Generate personas — …` issue. **No prerequisite**; only 409 is `no_documents`. Its `personas.json` / `journey-map.json` are a build contract for the companion app. |
| `trigger_ui_build`              | When the user (after requirements are done) asks the bot to build the UI. Creates a `Build UI — …` issue assigned to the Delivery Lead, which dispatches the Developer then the UX Auditor directly. |
| `comment_on_ui_build`           | Only when a UI preview is live (the chat sends `uiContext.active`): the LLM classifies each message and calls this with `kind=modify\|approve\|push` for change/approve/push requests, while answering plain questions in text. |

The pipeline is gated **requirements → data model → solution design**; the system prompt teaches the bot to offer the missing prerequisite instead of firing a stage that would just block. The **capability map** sits outside that chain — it has no prerequisite and publishes nothing, so the bot fires it whenever asked.

The tool schemas are in the same file. The frontend reads `args.project` + `args.feature` directly and POSTs them to `/api/trigger`. Backend merges with `.env` defaults.

### Adding a new tool

If you want the bot to invoke a new server action (say, `cancel_workflow`), the pattern is:

1. Add the `FunctionDeclaration` in `server/llm.ts` next to `trigger_requirement_generation`, `set_target`, and `trigger_ui_build`.
2. Update the system prompt's "Conversation flow" so the LLM knows when to call it.
3. Add a handler in `App.tsx` (inside the `if (toolUse?.name === ...)` branch) that POSTs to the matching new endpoint.
4. Add the endpoint in `server/index.ts`.

Don't try to inline the tool's result into the same chat turn — the LLM doesn't get a second pass currently. Surface the result as a visible assistant message in the UI thread.

## Live audio (RecordMeetingPanel)

Optional path. When the user opens the recorder modal:

1. Browser registers `public/pcm-worklet.js` as an `AudioWorklet` and starts capturing 16 kHz mono PCM from the mic.
2. Frontend opens a WebSocket via `recordingSocketUrl()` (`ws://127.0.0.1:4000/recording`) and streams PCM frames.
3. Backend (`server/services/geminiLive.ts`) holds the upstream WebSocket to Gemini Live and pipes audio through.
4. Gemini returns transcript chunks; backend writes them to disk via `transcriptWriter.ts` AND echoes them back to the browser over the same WebSocket.
5. When the user stops, the final transcript file lands at `projects/<project>/<feature>/requirements/Transcripts/<timestamp>.md` (location chosen by `fileRouter.ts`).

If you remove this feature: delete `RecordMeetingPanel.tsx`, `services/geminiLive.ts`, `services/transcriptWriter.ts`, `public/pcm-worklet.js`, and the `wss.on("connection", ...)` block at the bottom of `server/index.ts`. Drop `ws` and `@types/ws` from `package.json`.

## Defaults baked into `.env`

```
GEMINI_API_KEY=AIza...
GEMINI_MODEL=gemini-2.5-flash
GEMINI_TRANSCRIBE_MODEL=gemini-2.5-flash       # optional
GEMINI_LIVE_MODEL=models/gemini-2.5-flash-native-audio-latest  # optional

PAPERCLIP_API_URL=http://127.0.0.1:3100/api
# Company + agent IDs are NOT in .env — the server reads them from
# <workspace>/.bootstrap/ids.json, written by `npm run bootstrap`.

# WORKSPACE_PATH=  # leave unset locally — derived from the install location

DEFAULT_FEATURE_NAME=Review & Verify Evidence
DEFAULT_PROCESS_L3=2.4 Review & Verify evidence
DEFAULT_PROCESS_L4=2.4.1 Review evidence
DEFAULT_STARTING_STORY_NUMBER=2.4.1.1
DEFAULT_PARENT_EPIC_KEY=SADA-1
DEFAULT_JIRA_PROJECT_KEY=SADA
DEFAULT_CONFLUENCE_SPACE_KEY=SADA
DEFAULT_CONFLUENCE_PAGE_TITLE=Review & Verify Evidence

PORT=4000
```

**Workspace root resolution** (`server/workspace.ts`) — the one place that decides where `projects/`, `outputs/`, `generated-apps/` and `.bootstrap/ids.json` live. Never hardcode an absolute path anywhere else; every other module imports `WORKSPACE_PATH` from there. It resolves in this order:

1. `WORKSPACE_PATH` env var, **if that directory exists and is writable on this machine** (Docker sets `/workspace`). A stale value copied from someone else's `.env` is logged and ignored rather than failing every write with `EACCES`.
2. Otherwise the repo root found by walking up from `server/` for the `agent-instructions/` + `skills/` markers — so a fresh clone on any machine just works with no config.

The resolved root is printed at boot: `[workspace] root = … (from WORKSPACE_PATH | derived from install location)`.

Agent IDs never live in `.env`: `npm run bootstrap` hires/converges the org, swaps the placeholder IDs inside `../agent-instructions/pm.json`, and writes the live IDs to `<workspace>/.bootstrap/ids.json`, which `server/paperclip.ts` reads at startup.

## Branding

All colors are Tailwind tokens under `theme.extend.colors.scyne` in `tailwind.config.js`:

```
scyne.ink     = #464e7e   (primary navy — header, buttons, primary text accents)
scyne.deep    = #363c63   (hover state)
scyne.line    = #e7e9f0   (subtle borders & dividers)
scyne.sand / forest / ocean  (accent palette pulled from scyne.com.au imagery)
```

Font stack: `Arial, "Helvetica Neue", Helvetica, sans-serif` (no Google Fonts dependency).

Logo: served from Scyne's CDN at `https://cdn.prod.website-files.com/650aedb6397a7021a593e810/672ac5664163926064db6bd7_scyne-logo.svg`, embedded in `Header.tsx` as `<img>`.

## Common dev tasks

### Hot-reload behaviour
- **Frontend changes** (anything under `src/`) — Vite HMR. No restart needed.
- **Backend changes** (anything under `server/`) — `tsx watch` reloads automatically. The browser will refetch on the next request.
- **`.env` changes** — restart `npm run dev`; tsx doesn't watch `.env`.

### Test an endpoint without the UI
```bash
curl -sS http://127.0.0.1:4000/api/features | jq
curl -sS http://127.0.0.1:4000/api/status/<issueId> | jq '.stage, .flatIssues, .approvals'
```

### Change the chatbot's persona / phrasing
Edit `buildSystemPrompt` in `server/llm.ts`. Restart `dev:api` (or wait for tsx to reload).

### Add a new project + feature
On disk, in the workspace root:
```bash
mkdir -p projects/<project>/<feature>/requirements/{SOP,Transcripts,Notes,UI,templates}
mkdir -p projects/<project>/<feature>/design/{style-guides,example-screens}
mkdir -p projects/<project>/<feature>/outputs
```
Drop input files in the four `requirements/*` subfolders. The bot picks it up on the next `/api/features` poll — no code change.

### Re-hire / re-wire agents
Run `npm run bootstrap` at the workspace root — it hires anything missing, converges names/titles/reportsTo, swaps the placeholder IDs in `../agent-instructions/pm.json` for the live ones, re-pushes every AGENTS.md bundle, and rewrites `.bootstrap/ids.json`. Then restart the chatbot so `server/paperclip.ts` re-reads the IDs. Never hand-edit IDs in `.env` or the bundles (the bundles intentionally carry placeholders).

### Reset a stuck conversation
Click "New session" in the right-pane header. This clears `localStorage`, drops `status`, resets `seenCommentIds`, and shows the fresh greeting. The Paperclip-side issue is **not** cancelled — it just becomes invisible to this UI.

## Gotchas

- **`status: "backlog"`** — Paperclip's default. Agents won't pick it up. Always create issues with `status: "todo"`.
- **No `/issues/:id/children` GET** — use the company-level list with `?parentId=…`.
- **Approval payload** — `payload.title` / `payload.summary`, not `title` / `description` at the top level.
- **Comment author resolution** — Paperclip returns `authorAgentId` or `authorUserId`, not always a friendly name. `/api/status` falls back to the ID if no name field is present.
- **MiniMarkdown** is intentionally minimal. It handles 95% of agent-comment formatting but is not a full CommonMark renderer. Add to it if a new BA output style breaks rendering — don't bring in a heavy markdown lib unless we need GFM tables.
- **Gemini system prompt rebuilds every turn** — that's intentional (the projects tree may have changed) but it does cost ~1 K tokens per request. Acceptable for a local dev tool; would matter at scale.
- **Voice/audio path** (`RecordMeetingPanel` + `geminiLive.ts` + `transcriptWriter.ts`) is wired but treated as optional. If you remove it, also remove the `ws` dep, `@radix-ui/react-dialog` (used for the recorder modal), and the recorder button from the composer area in `App.tsx`.

## When something feels off

| Symptom                                       | Likely cause                                                                | Where to look                                       |
| --------------------------------------------- | --------------------------------------------------------------------------- | --------------------------------------------------- |
| Chatbot shows "undefined" for a tool arg      | Renamed a tool field; frontend still reading the old name                   | `App.tsx` (inside the `tool_use` branch)            |
| Right panel empty after firing a workflow      | `parentIssueId` not set, or `/api/status` returning empty `tree`            | DevTools Network → `/api/status/:id` response       |
| Approval card never appears                    | BA hasn't raised an approval yet, OR `payload.title` is missing             | `/api/status/:id` → `approvals[]`                   |
| Activity timeline doesn't update                | Polling interval canceled (e.g. by an effect dep change)                    | Check `useEffect` deps near `setInterval(tick, 3000)` |
| `Firing the workflow now for SADA / undefined` | Tool schema field name mismatch (`scenario` vs `feature`)                   | `server/llm.ts` tool params + `src/App.tsx`         |
| `npm run dev` exits immediately                | Port 4000 or 5173 already bound                                              | `lsof -i:4000 -i:5173` and kill the offender        |
| Browser shows CORS error                       | Backend not running, or Vite proxy misconfigured                            | `vite.config.ts` `server.proxy['/api']` target      |

---

If you're about to make a non-trivial change, sketch the touched files first. The chatbot has only one stateful component (`App.tsx`) — most changes either land there, in `server/llm.ts` (system prompt + tools), or in `server/index.ts` (endpoints). Components under `src/components/` are intentionally dumb.
