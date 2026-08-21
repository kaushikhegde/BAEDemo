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
- **Login gate**: `src/components/Login.tsx` posts to `POST /api/auth/login`, which forwards to the orchestrator's `/auth/login` and stores the returned token in an **httpOnly cookie**. The session object is the orchestrator's flat `whoami` payload (`{id, email, name, role, company, isSuperadmin}`). Expiry is the orchestrator's (12h); a 401 from any call is announced once by `api.ts` and returns the user to the login screen without discarding their chat history.
- **WebSockets**: optional path for live audio. `wss.on("connection",...)` is mounted on the same HTTP server. Browser → `recordingSocketUrl()` → backend → Gemini Live → live transcription back over the same socket. The main workflow uses HTTP polling (every 3 s).

## Project structure

```
scyne-chatbot/
├── .env / .env.example     (config — see below)
├── package.json            (scripts: dev | dev:vite | dev:api | build | preview | typecheck | test)
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
        ├── SuggestionChips.tsx (server-computed next-step chips above the composer)
        ├── NewProjectWizard.tsx(3-step project creation; takes over the whole view)
        ├── AttachmentButton.tsx(upload .docx / .pdf / .png to a chosen scope)
        ├── RecordMeetingPanel.tsx (browser audio capture → Gemini Live transcription)
        ├── PreviewPane.tsx     (iframes the generated app from /api/preview/:project; polls the registry and AUTO-RELOADS the iframe when `generatedAt` changes. The iframe src is made RELATIVE — see Gotchas)
        ├── Rail.tsx            (left rail: Chat · Issues · Spend · Actions; hides the admin two by role, badges Issues with what is waiting)
        ├── IssuesView.tsx      (every issue in the company; selecting one sets the active issue and returns to Chat)
        ├── SpendView.tsx       (GROUP BY chips + Period/Project/Feature/User filters; reported and estimated in SEPARATE columns, unpriced runs called out)
        ├── ActionsView.tsx     (the organisation's audit feed — who did what)
        └── OpsState.tsx        (shared by the ops views: the three not-a-table states — refused, unreachable, empty — plus FilterSelect, ClearFilters, ago(), money())
```

## Backend endpoints

All defined in `server/index.ts`; the frontend calls them through `src/api.ts`.
**The authoritative table is in `../CLAUDE.md`** — it is one list and duplicating
it here is how the two drift. What matters on this side:

- **Two levels.** `/api/capability-map/trigger`, `/api/personas/trigger`,
  `/api/project/bootstrap` and `/api/ui-agent/trigger` take a **project** and no
  feature. Everything else in the pipeline takes both. `stageTrigger({level:
  "project", …})` is what makes the difference: it skips the feature, gates on the
  project's documents (its own plus every feature's), and titles the issue
  `<prefix> — <project>`.
- **`/api/revise`** is the other half of the chat's job. It resolves the artefact
  through `pipeline.stageFor()`, refuses `409 not_generated` for a stage that has
  not run, and passes the reviewer's `instruction` through **verbatim** into the
  issue description.
- **`/api/suggestions`** and **`/api/staleness`** both compute from
  `scripts/pipeline.mjs`, imported directly. That is deliberate: the chips must
  never offer a stage the CLI would refuse, and the only way to guarantee that is
  to read the same graph.
- **`/api/upload/project`** converts to markdown *on arrival* rather than at
  staging time, because `/api/project/bootstrap` gates on the project having at
  least one `.md` — a client who uploaded only PDFs would otherwise be told they
  have no documents.
- **`/api/features`** excludes the project's own folders (`solutions`,
  `documents`, `design`, `original-files`, `outputs`). Without that filter they
  appear in the target picker as selectable features the moment a project
  generates anything. `server/llm.ts` applies the same filter for the same reason;
  `PROJECT_OWN_DIRS` is declared in three places and they must stay in step.
- **Companion-app routes are project-keyed**, with the older `:project/:feature`
  forms kept as aliases so saved links and the current frontend resolve. The
  canonical URL carries a **trailing slash** — the page links into the sibling
  `mockups/` directory relatively so the pack works from disk too, and a relative
  link on a URL without a trailing slash resolves one segment too high, silently,
  in an iframe.

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
| `view`                 | `View`                          | What the left rail selects: `workspace` (chat + workflow) · `issues` · `spend` · `actions` · `history`. Persisted to `localStorage.scyne_view` — being returned to Chat after every refresh is the wrong default for somebody watching a run. |
| `needsAttention`       | `number`                        | Issues sitting `in_review`/`blocked`/`paused`. Drives the rail badge; polled every 30s regardless of the open view, because its job is to interrupt. |
| `previewAvailable`     | `boolean`                       | True once `/api/preview/:project/:feature` returns a URL.                |
| `pendingUiPrompt`      | `{project, feature} \| null`    | When the bot suggests a UI build, this stages a one-click trigger.       |
| `seenCommentIds`       | `useRef<Set<string>>`           | Dedupes agent comments so the same one doesn't appear twice in the chat. |
| `showWizard`           | `boolean`                       | When true the New Project wizard REPLACES the workspace — creating a project is its own task, not a side panel beside a streaming workflow. |
| `chipsKey`             | `number`                        | Bumped whenever the pipeline advances, so `SuggestionChips` re-asks the server what is possible. A stale chip row is worse than none: it offers work already done. |

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

| Tool | Level | When the bot calls it |
| --- | --- | --- |
| `create_project` | project | "Create a new project / client". Writes the tree, the definition, and the branding if a website was given. |
| `bootstrap_project` | project | Once the documents are uploaded. ONE call that runs the capability map then the personas — the bot must not also call the two triggers. |
| `create_feature` | project | "Add a feature". Scaffolds it; the personas and capability map are inherited, not re-run. |
| `trigger_capability_map` | project | Capability map / process model / operating model. No feature parameter. |
| `trigger_personas` | project | Personas / journeys / service blueprint. No feature parameter. `409 no_capability_map`. |
| `trigger_requirement_generation` | feature | Product Summary + Jira stories. |
| `trigger_ui_mockups` | feature | Wireframes. **Not `trigger_ui_build`** — the prompt tells the bot to ask which when ambiguous. |
| `trigger_data_model` | feature | Data model / ERD / objects. `409 no_product_summary`. |
| `trigger_solution_architecture` | feature | SAD / HLD / target architecture. **Not `trigger_solution_design`.** |
| `trigger_test_cases` | feature | Test pack / UAT / traceability matrix. |
| `trigger_solution_design` | feature | The optional SDD. `409 no_data_model`. Offered only when asked for by name. |
| `revise_artefact` | either | **Any change to something already generated.** The instruction goes through verbatim. |
| `trigger_ui_build` | project | The companion app page. |
| `set_target` | — | Keeps the target picker in sync when the user names a project/feature. |
| `save_project_definition` | project | When the user supplies "about the client" text for an existing project. |
| `extract_brand` | project | A pasted URL → the project's `theme.json`, then a re-render. |
| `control_dev_server` | project | `start` = re-render the companion app; `stop` = reported no-op. |
| `comment_on_ui_build` | — | Only while a UI preview is live: modify / approve / push. |

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

ORCHESTRATOR_API_URL=http://127.0.0.1:3100
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

Use the **New Project** wizard (the ✨ in the header) or just ask the bot. Both go
through `POST /api/projects` and `POST /api/features`, which scaffold the right
tree for the level. By hand:

```bash
# Project — client-wide
mkdir -p projects/<project>/{documents,design/{style-guides,example-screens}}
mkdir -p projects/<project>/solutions/{Capabilities,Experience}/outputs

# Feature — one slice of work
mkdir -p projects/<project>/<feature>/requirements/{SOP,Transcripts,Notes,UI,templates}
mkdir -p projects/<project>/<feature>/outputs
```

The bot picks it up on the next `/api/features` poll — no code change. Note
`design/` is at PROJECT level: one project renders one companion app, so it
carries one palette.

### Re-hire / re-wire agents
Run `npm run bootstrap` at the workspace root — it hires anything missing, converges names/titles/reportsTo, swaps the placeholder IDs in `../agent-instructions/pm.json` for the live ones, re-pushes every AGENTS.md bundle, and rewrites `.bootstrap/ids.json`. Then restart the chatbot so `server/paperclip.ts` re-reads the IDs. Never hand-edit IDs in `.env` or the bundles (the bundles intentionally carry placeholders).

### Reset a stuck conversation
Click "New session" in the right-pane header. This clears `localStorage`, drops `status`, resets `seenCommentIds`, and shows the fresh greeting. The Paperclip-side issue is **not** cancelled — it just becomes invisible to this UI.

## Gotchas

- **An absolute URL into `/api/*` loses the session cookie.** Cookies are keyed
  by HOST and ignore the port, and Vite binds `[::1]:5173` — so the app is served
  from `localhost` while `registry.json` holds `http://127.0.0.1:4000/…`. Same
  machine, same site by every intuition, different cookie jar: the companion-app
  iframe rendered `{"error":"not_authenticated"}`. Anything the browser loads
  from this API must be RELATIVE so it goes through the Vite proxy. The registry
  keeps its absolute URL for the UX auditor, which drives a real browser at it.
- **The ops reads live in `server/store.ts`, NOT `server/orchestrator.ts`.**
  That module falls back to `SCYNE_API_TOKEN` when there is no caller token,
  which is right for the unattended staleness sweep and exactly wrong for a
  browser read — a request arriving without a session would be served the whole
  organisation's spend under a service credential. `store.ts` returns nothing.
- **Nothing is filtered by default, and grouping is not filtering.** Issues
  opened scoped to the pinned project AND to open-only, so a page headed
  "Issues" could show one row out of forty with nothing saying so. Both views
  now open unfiltered and show `3 of 41` whenever a filter is on. In Spend, the
  chips choose how rows are GROUPED and the dropdowns choose which runs count
  at all — they are rendered deliberately unalike, because "group by project"
  and "only project SAPN" sit inches apart.
- **Filter options come from the data.** Issues derives them from the rows it
  already holds; Spend reads the unfiltered grouping on each filterable
  dimension once. Neither can offer an option that returns nothing, and neither
  re-derives them as filters change — an option list that shrinks while you use
  it is one you cannot get back out of.
- **A 403 must not become an empty table.** `/spend` and `/actions` are
  admin-only upstream. An empty table shown to a member says "nothing has been
  spent" — a confident wrong answer where "you are not allowed to see this" is
  the true one. `sendOps` preserves the status; `OpsState` renders the three
  cases apart.
- **`server/` is typechecked now** (`npm run typecheck`, `tsconfig.server.json`),
  and `pipeline.mjs` is typed by the ambient `server/pipeline.d.ts`. That
  declaration must stay COMPLETE — a partial one silences the implicit-any and
  then reports every export it forgot as a missing property.
- **`status: "backlog"`** — Paperclip's default. Agents won't pick it up. Always create issues with `status: "todo"`.
- **Project vs feature.** Half the pipeline takes a project only. Passing a feature to `trigger_capability_map` or `trigger_personas` is ignored server-side, but it makes the chat say the wrong thing — the prompt tells the LLM not to.
- **`PROJECT_OWN_DIRS` lives in three files** (`scripts/pipeline.mjs`, `server/index.ts`, `server/llm.ts`). They must agree, or `solutions/` and `documents/` show up as selectable features.
- **The system prompt is a template literal.** Backticks and `${` in prompt text must be escaped, or the file stops parsing with errors hundreds of lines from the edit.
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
