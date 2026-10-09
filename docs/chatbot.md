# The chatbot (`scyne-chatbot/`)

Split out of `CLAUDE.md`. The `scyne-chatbot/` app — setup, every backend endpoint, the Gemini conversation flow, the frontend layout and the workflow defaults. See also `scyne-chatbot/CLAUDE.md`.

Local app: **React + Vite frontend on port 5173**, **Express backend on port 4000**. Vite proxies `/api/*` → backend.

### Setup

```
cp .env.example .env          # AT THE ROOT — there is no scyne-chatbot/.env
# edit .env: set GEMINI_API_KEY (Gemini 2.5 Flash, free key from aistudio.google.com/apikey)
cd scyne-chatbot
npm install
npm run dev                   # starts both vite + the api in one process via concurrently
open http://127.0.0.1:5173
```

> **One `.env`, at the workspace root.** Every process reads that file and no
> other — the orchestrator via `orchestrator.config.ts`, the chatbot via
> `scyne-chatbot/server/env.ts`, the scripts, and `.mcp.json`'s
> `${MCP_TOKEN_FOR_AZURE}`. The chatbot used to carry its own, because
> `import "dotenv/config"` resolves against `cwd` and `npm run chatbot` does
> `cd scyne-chatbot`: two copies of `ADO_ORG`, `GEMINI_API_KEY` and
> `WORKSPACE_PATH` that drifted, and one bug they hid — the PAT only ever
> lived in the ROOT file, so `adoVerify.ts` reported **`token present: false`
> on every approval** while the same token published fine from the agents.
> `env.ts` finds the root by walking up for `agent-instructions/` + `skills/`,
> so it is cwd-independent, and it is imported on line 1 of `index.ts` because
> ESM evaluates imports in order and `llm.ts` reads `process.env` at load time.
>
> **The chatbot's port is `CHATBOT_PORT`, not `PORT`.** One shared file feeds
> every process in the stack and `PORT` is a name half the Node world reads,
> so a value meant for the chatbot would be picked up by anything else started
> from it. `PORT` still works as a fallback — Docker and most PaaS hosts
> inject it, and neither is ours to change.
>
> Uncommented in `.env.example` = what an install actually needs (13 keys).
> Everything else is commented out with its code default named beside it.

### Backend endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/api/chat` | Proxies the conversation to Gemini, returns Anthropic-shaped blocks |
| **POST** | **`/api/projects`** | **Create a project**: folder tree, `description.md`, branding pulled from the client's website inline, **and the database row**. `409 exists` if the name is taken; `409 slug_collision` if the slugged name lands on a different, incomplete project |
| **POST** | **`/api/features`** | **Create a feature** under a project, on both sides. `400 reserved_name` for a name that would clash with a project folder or CLI stage keyword |
| **POST** | **`/api/upload/project`** | The wizard's untyped dropzone → `projects/<p>/documents/`, converted to markdown on arrival, original archived |
| **POST** | **`/api/project/bootstrap`** | `Set up project — <project>`: capability map, then personas, sequentially. `409 no_documents` |
| POST | `/api/capability-map/trigger` | `Generate capability map — <project>`. **PROJECT level, no feature.** `409 no_documents` only. Publishes to the ADO wiki |
| POST | `/api/personas/trigger` | `Generate personas — <project>`. **PROJECT level, no feature.** `409 no_capability_map` |
| POST | `/api/trigger` | `Generate requirements — …`. Feature level. `409 missing_inputs` if SOP/Transcripts/UI are empty |
| POST | `/api/ui-mockups/trigger` | `Generate UI mockups — …`. `409 no_documents` only. Publishes nothing |
| POST | `/api/data-model/trigger` | `Generate data model — …`. `409 no_product_summary` |
| POST | `/api/solution-architecture/trigger` | `Generate solution architecture — …`. `409 no_product_summary` only |
| POST | `/api/test-cases/trigger` | `Generate test cases — …`. `409 no_product_summary` only |
| POST | `/api/solution-design/trigger` | `Generate solution design — …` (optional side stage). `409 no_data_model` |
| POST | `/api/ui-agent/trigger` | `Build UI — <project>`. **PROJECT level.** `409 no_artefacts` — the page is progressive, so any single artefact is enough |
| **POST** | **`/api/revise`** | **Revise an existing artefact.** `{project, feature?, artefact, instruction}` → routes to the owner with the instruction verbatim. `409 not_generated`, `400 unknown_artefact` |
| **GET** | **`/api/documents?project=&feature=`** | **Every document at both levels**, with size, mtime, kind and the archived source each was converted from — plus the same staleness list, from one call. **`?excerpts=true`** attaches the opening of each markdown document; opt-in, because it is a file read per document and only the grid has anywhere to put it |
| **GET** | **`/api/documents/content?project=&feature=&path=`** | **One document's text**, for the preview. Refuses a binary file, a path outside `documents/`, and a climb out of the project — `400 bad_path` |
| **PUT** | **`/api/documents`** | **Replace one document** (multipart). Removes the old and its archived original FIRST, so the replacement keeps its own name instead of landing beside it as `handling (1).md` |
| **DELETE** | **`/api/documents`** | **Remove one document** and its archived original, on disk and in the database. `404 no_document`, `400 bad_path` for anything outside `documents/` |
| **GET** | **`/api/extract-status/:project`** | Every document's extraction state — `ready` / `missing` / `extracting` / `failed`, and for a failure its `reason`, `attempts`, `firstFailedAt` and `lastFailedAt` |
| **POST** | **`/api/extract-retry/:project`** | **Retry a failed extraction.** `{doc?, force?}` → answers with what it is retrying and why each one failed, then runs detached. `409 no_documents` / `nothing_to_retry` / `already_ready`, `400 no_such_document` (which lists what it does know) |
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
| **GET** | **`/api/issues`** | **Every issue in the company**, shaped like `scyne issues` — `5/6 gate`, target, control request, `needsHuman`. `?project=&feature=&status=&open=` |
| **GET** | **`/api/spend`** | **`?by=project\|feature\|user\|agent\|adapter\|model`.** Admin only upstream; the 403 is passed through, never collapsed to an empty table |
| **GET** | **`/api/actions`** | **The organisation's audit feed.** Admin only upstream, same 403 rule |
| GET | `/api/history` | All completed runs with their wiki + work item links |
| GET | `/api/runs/:issueId` | Compact agent run summaries for the run tree |
| GET | `/api/features` | `projects/<project>/<feature>/` on disk. Excludes the project's own folders (`solutions`, `documents`, `design`, …) |
| GET | `/api/project-description/:project` | Reads `projects/<project>/description.md` |
| POST | `/api/project-description` | Writes it. Rejects an unsafe name or a body under 40 chars |
| GET | `/api/artifacts` | The approval-card preview. `project` alone returns the project artefacts; `project`+`feature` adds that feature's |
| POST | `/api/upload` | Feature-level upload, routed into `requirements/<sub>/` via `fileRouter` |
| POST | `/api/ui-agent/comment` | Follow-up comment on the UI build issue |

> **The ROW is what a project IS. The tree is derived from it.**
>
> `POST /api/projects` writes the row **first**, and a failure to write it is
> **fatal** — `502 db_unavailable`, nothing created, no orphaned Azure DevOps
> project left in a client's organisation. Creating without a session is
> refused (`401`) instead of silently half-succeeding, which is what it used to
> do: `store.createProject` returned `skipped`, the tree was written anyway,
> and the caller got `ok: true` for a project no API could see.
>
> Everything below still WRITES to disk, and must: six skills read
> `projects/<p>/description.md` by that path, the renderer reads
> `design/style-guides/theme.json`, the publish scripts read `.published.json`.
> Those are DERIVED copies. Nothing DECIDES anything by reading disk any more —
> the existence check is `store.listProjects`, and the rule itself is
> `decideCreate` in `scyne-chatbot/server/names.ts`, extracted so it can be
> tested without booting a server.
>
> The history below is what that replaced, and is kept because the symptoms are
> the ones to recognise if any of it comes back.
>
> **Creation writes BOTH stores, and the web UI did not.** There are two
> records of what exists — the folder tree the agents read, and the database
> `scyne`, the console and every platform route read — and `cli/dual.ts` has
> written both since it was added, for the reason its own header gives:
> *"anything that CREATES something has to write to both, or the tool
> contradicts itself"*. The React wizard called only `/api/projects`, which
> wrote only the tree. So a project created in the browser existed for every
> agent and for no API, and every symptom surfaced somewhere else entirely:
>
> - the definition **silently failed to save** — `saveDescription` looks the
>   project up by name, does not find it, and returns
>   `{ok: false, reason: "no such project in the database"}` into a console
>   warning nobody reads, so the assistant goes on asking for a definition the
>   project visibly has;
> - **`/spend?by=project` filed every run under the anonymous row**, because
>   `repo.createIssue` resolves `params.project` into `issues.project_id` BY
>   NAME and there was no row to resolve to. The fix described above works; it
>   had nothing to find;
> - **`/projects/{id}/documents` was unreachable** — there is no id;
> - no membership or access control could attach to the project.
>
> `store.createProject` / `createFeature` / `createDocumentRow` /
> `deleteDocumentRow` are the chatbot's half, and all three upload paths — the
> project route, the feature route and the audio transcript — write a document
> row now as well. All of it is **best-effort and never fatal**, for the same
> reason `adoError` is: the tree, the definition and the branding are real and
> worth keeping. A failure is reported as `dbError` rather than logged, because
> everything that resolves a project by name stays empty until the row exists.
>
> **"What documents exist" is answered from DISK, by BOTH surfaces.** `scyne doc
> list` and the session's `/docs` read the same `/api/documents` the Docs tab
> does, so the two cannot disagree about what is there. They used to read the
> platform API's ROWS while the tab read the tree, which is precisely how one
> reported nothing for a project the other showed nine documents for. Each row
> carries `inDb`, and both surfaces name the count that is missing plus the
> command that fixes it — the difference is surfaced, never hidden.
>
> **`store.listDocuments` asks three questions, not two.** This feature's
> documents (`feature`), the project's OWN (neither flag), or every document at
> every level (`all`). Omitting a feature means `feature_id is null`, NOT "all"
> — and `available()`, which feeds the assistant's per-feature document counts,
> asked with no feature and then skipped every project-level row to count the
> feature ones. The loop always fell through, so the assistant was told every
> feature held zero documents while nine sat on disk under SAPN.
>
> **The SERVER writes the document row, and it is the only thing that may.**
> `cli/dual.ts` used to write its own, from the bytes read off the caller's
> machine, under a path computed before the upload — and both were wrong by the
> time it landed. The server converts on arrival and MOVES the source into
> `original-files/`, so the row held raw `.docx` bytes at a path naming a file
> that no longer existed: precisely the "`/docs` lists documents that are not on
> disk" state in [`troubleshooting.md`](troubleshooting.md). With no `--as` it was wronger still — the CLI
> guessed `requirements/`, while the server's `routeFile()` infers `SOP/`,
> `Transcripts/`, `Notes/` or `UI/`.
>
> Only the server knows the converted name, so only the server can write the
> row; `uploadDocument` reports what the response says it did. Leaving both in
> place would have produced **two rows per CLI upload** — one correct, one
> naming a file the converter had already renamed. `cli/dual.test.ts` asserts
> exactly one write per upload and no `/documents` POST from the CLI.

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
- `list_documents` / `delete_document` — what a project holds, and removing one.
  Present in the chatbot AND in the `scyne` session, which dispatches the same
  `tool_use` blocks: an assistant that can list a project's documents in a
  browser and not in a terminal is two products. **Both surfaces confirm before
  deleting** — the model proposes, the person commits, because a sentence typed
  at a prompt is not consent to change what every later stage reads. There is
  deliberately no replace tool: a replacement needs a file from the user's own
  machine, so the prompt points at the Docs tab or `/replace <path> <file>`.
- `read_artefact` — reads an artefact that already exists, so the bot can answer
  a question about it. See below; it is the one tool the server runs.
- `revise_artefact` — a change to an artefact that already exists. It no longer
  starts a run: the browser shows a card with the artefact, the instruction in
  quotes, and **Start change** / **Cancel** (`src/lib/proposal.ts`,
  `MessageBubble.tsx`). Only a `pending` card can be started, so a double click
  or a reload never starts the same revision twice.
- `save_project_definition` — writes `projects/<project>/description.md` from the user's own words. The system prompt lists which projects have one and which do not, and tells the bot to ask once — never to block a run on it.
- `trigger_ui_build` — fires the UI flow (creates a `Build UI — …` issue assigned to the Delivery Lead). The Developer + UX Auditor chain runs from there.

The system prompt teaches the dependency chain (requirements → data model → solution design) so the bot proactively explains and offers the missing prerequisite rather than firing a stage that would just block.

#### Questions about generated artefacts — `read_artefact`

Every other tool is one-way: the model names it, the browser runs it, and the
result never returns to the model. A question about an artefact needs the result
back, so `chat()` runs `read_artefact` itself (`server/read-loop.ts`), sends the
file back as a function response, and returns only the final turn. At most three
rounds; at the limit the pending calls are answered with `state: "limit"`,
because Gemini rejects plain text after an unanswered function call.

`server/artefact-reader.ts` maps each artefact to a fixed list of files (the
`.md` rendering where one exists), refuses any project not in
`store.available(token)` and any feature that project does not have, and caps
the content at 200 KB. The model never supplies a path.

The turns go through `generateContent` over a list `chat()` keeps, not a
`ChatSession`: a session whose `sendMessage` once threw keeps that rejection
and rethrows it on every later send, so a retried 503 on the second round
would never succeed.

File contents are not kept in the chat history, so a follow-up question reads
the file again. That keeps every later turn small, which matters: long prompts
are what cause Gemini's empty turns (see `llm.ts`).

### Frontend layout

- **Left panel**: chat with the LLM. Agent comments stream in as bubbles with the author label (e.g. `BA · SCY-2`). Approval gates render inline as a card with an expandable "Review what will be pushed" preview (Stories / Product Summary / Gaps tabs).
- **Right panel**: workflow status. Stage pill (queued → Delivery Lead triaging → BA generating → awaiting approval → pushing → complete), progress list of issues, autoscrolling activity timeline, links panel for the wiki page + work items.
- **Login gate**: the app shows a `Login.tsx` screen first, which authenticates against the **orchestrator's own user table** — the same accounts the CLI and console use. There are no demo credentials. The first account is created by `scyne init`, which claims the installation as its **superadmin**; everyone else is created with `scyne user create` or from the console. The session is an **httpOnly cookie** on the chatbot origin, never `localStorage` — a credential JavaScript cannot read is one an injected script cannot steal — and the chatbot forwards *that user's* token to the orchestrator, so a run started from chat records `issues.created_by`.
- **Session persistence**: `parentIssueId` is saved to `localStorage.scyne_parent_issue_id`. Refresh resumes the workflow.
- **Right-pane tabs**: `Activity` (live workflow status) and `UI` (iframes the generated app from `/api/preview/:project/:feature`). The UI tab unlocks the moment a generated app is registered.
- **Left rail**: `Chat` · `Docs` · `Issues` · `Spend` · `Actions` — the chatbot is a full
  client now, not only a launcher, so `/orch` is for installation admin (agents,
  skills, budgets, orgs) rather than for daily work. Selecting an issue in
  **Issues** sets the active issue and returns to Chat, where the Activity panel
  already renders one; `parentIssueId` therefore means *the issue being watched*
  rather than *the run this browser last started*. Spend and Actions are
  **hidden for a non-admin** — cosmetic only, because the orchestrator refuses
  `/spend` and `/actions` for them regardless, and that refusal is the boundary.
  A count badge on Issues tracks `in_review`/`blocked`/`paused` and polls every
  30s from whichever view is open, because its whole job is to interrupt.
- **Docs** is the document lifecycle: every document **grouped by the folder it
  lives in** — `Project › documents`, then `<feature> › SOP | Transcripts |
  Notes | UI` — each collapsible, each a **drop zone**, with **upload**,
  **replace** and **delete**, a **Table ⇄ Grid** toggle, filters (search,
  Folder, Type, Level), a **preview** of any document rendered as markdown, and
  — from the same fetch — the artefacts that now predate their inputs, as a
  checkbox list with one *Re-run selected* button. Nothing regenerates until it
  is clicked; a document change can invalidate five artefacts and an hour of
  agent time. Scoped to the pinned target, unlike Issues, and it carries its own
  `TargetPicker`: a drop zone for `SOP/` needs a feature, and sending someone
  back to Chat to choose one is how a working drop zone comes to look broken.

  **Grouped by folder rather than listed flat with a folder column**, because
  the folder is not a label — it is what the pipeline reads. The BA treats
  `Transcripts/` (the primary source of stories) differently from `SOP/`
  (context, explicitly NOT stories), the UX Designer treats `requirements/UI/`
  as authoritative, and a stage refusing with `no_documents` is nearly always
  one of these folders being empty. So an **empty folder is shown, not hidden**:
  its emptiness is the answer.

  **Dropping on a named folder cannot hit `ambiguous_kind`.** `routeFile`
  returns `ambiguous` only when no hint was supplied, and a folder IS a hint —
  so a `.docx` the chat attach button refuses uploads cleanly here.

  **The queue does not invent a phase boundary.** Upload and conversion happen
  in ONE request (the route converts on arrival, because every 409 gate counts
  `.md` and staging runs after that gate), so there is nothing to observe
  between them. Files upload SEQUENTIALLY — slower for a big drop, and what
  makes the queue truthful: one file in flight, the rest waiting, each ending
  as the name it converted to.

  **Disk is authoritative there and the row is reconciled alongside it**, in
  that order, because disk is what every stage reads. A delete takes the
  archived original in `original-files/` too — `convert-to-md.mjs` MOVES a
  source rather than deleting it, so removing only the markdown leaves the
  thing that produced it, and the next conversion pass puts the document
  straight back.
- **The preview iframe is same-origin.** `registry.json` stores an ABSOLUTE
  `devUrl` (`http://127.0.0.1:4000/…`) for the UX auditor's real browser, but
  every `/api/*` route needs the session cookie and **cookies are keyed by host
  with no regard for port** — Vite binds `[::1]:5173`, so the app is served from
  `localhost` and an iframe pointed at `127.0.0.1` carries no cookie and renders
  `{"error":"not_authenticated"}`. `PreviewPane` strips the origin so the iframe
  goes through the Vite proxy on whatever host is actually being viewed.
- **Comments render as markdown**: `MiniMarkdown` component handles headings, bullets, bold, inline code, fenced code blocks, and links (both `[label](url)` and bare URLs).

### Chatbot workflow defaults — there are none left

```
# DEFAULT_PROCESS_L3 / _L4 / _STARTING_STORY_NUMBER — parsed and then dropped
```

The block is empty, and both halves of that are deliberate.

**`DEFAULT_FEATURE_NAME` is deleted, not commented.** It was read by exactly
one route — `/api/trigger`, the requirements stage — and by nothing else, so
the feature display name in an issue title came from a global while every
other stage derived it from the feature FOLDER, at
`index.ts:468`, under a comment claiming *"same derivation as /api/trigger"*
that was not true. Set to the SADA-era label it shipped with, triggering
requirements for RTWSA/Appeals without an explicit name produced
`Generate requirements — Review & Verify Evidence (RTWSA/Appeals)` — a title
naming a **different client's feature**, on the one stage that publishes a
wiki page and creates the backlog. The LLM's tool schema described the field
as *"Override the default feature name"*, so omitting it was the normal case.
Both routes now derive it the same way, and the schema says what omitting it
does.

**The other three reach `issues.params` and stop.** They travel `.env` →
the issue description → `processL3` / `processL4` / `startingStoryNumber`, and
nothing reads them from there: no workflow step interpolates any of the three,
and the BA's generated prompt says only *"your inputs are staged, invoke the
skill"*. `requirement-generator/SKILL.md` does ask for them under `## Required
parameters`, but routes them via an `inputs/metadata.yaml` that nothing writes
— and then says the opposite anyway: *"The process model carries the real
L1/L2/L3 numbering; prefer it over inventing a process hierarchy."* Since the
capability map became a PROJECT stage, `process-model.json` is where story
numbering actually comes from.

They are commented out rather than deleted, and the two sites that rendered
them now handle absence: `llm.ts` lists only the defaults that are SET (an
unset one used to reach the model as the literal word `undefined`), and
`index.ts` writes `(not set)`, which `parseParams` already drops on shape — so
an unset default becomes an absent param, not the string `"undefined"` stored
in `issues.params`. Setting one still carries it through, unchanged.

The `DEFAULT_JIRA_*` / `DEFAULT_CONFLUENCE_*` / `DEFAULT_PARENT_EPIC_KEY` keys
that used to sit beside them were **Atlassian-era and read by nothing**; they
are gone, along with `CODEX_CLI` and the `PAPERCLIP_*` / `BETTER_AUTH_SECRET` /
`GEN_APP_PORT_*` block, which only `docker-compose.yml` still referenced.

**One Azure DevOps project per Scyne project.** ONE organisation (`ADO_ORG`)
holds everything; the PROJECT is created from the name the user enters, using
the **Agile** template, and recorded in **`projects.ado_target`** — org,
project, wiki, wiki id, process template and work item type.

> **That is a COLUMN, and it did not use to be.** It lived only in
> `projects/<project>/.published.json`, so a directory was the system of record
> for something the database owns — while `core/materialise.ts` says in as many
> words that "the store is the system of record now". `POST /api/projects`
> decided whether a project existed by calling `fs.access` on a folder and then
> reading that file, which is why pointing `DATABASE_URL` at a fresh Postgres
> produced a route that **refused to create projects the database had never
> heard of**, quoting an Azure DevOps target it could not see. Seven folders,
> zero rows, and the refusal named the folder.
>
> `.published.json` is still WRITTEN, and every publish still reads it by path
> — `ado-publish.mjs`, `ado-workitems.mjs --published-json` and
> `resolvePagePath` all take it from the materialised tree. It is derived from
> the column now rather than being the record.
>
> **Only the target moved.** The per-artefact page paths beside it
> (`ado.<artefact>.wikiPath` / `.url`) stay in the file, because an AGENT writes
> those mid-run and harvest brings them back — a column mirroring them would be
> stale from the first publish onwards. Set-up metadata and run output have
> different lifecycles, so they get different homes.
>
> Projects created before this carry their target on disk only:
> `npm run backfill:ado` prints a plan, `-- --apply` lifts it. A row that
> already has a target is never overwritten, even when the file disagrees — a
> stale `.published.json` from an old clone must not be able to redirect a
> client's publishing.
>
> `projects.theme` was the same bug with no symptom yet: a supported jsonb
> column since 002_platform that **nothing ever wrote**, so every project
> carried `{}` while its real palette sat in `design/style-guides/theme.json`.
> The create route patches it now.

There is deliberately **no `ADO_PROJECT`**. One target for the whole install is
exactly what this replaced, and a fallback to one would publish a client's
document into another client's project. A publish with no target STOPS and says
so.

The wiki path therefore loses its `/Scyne/<project>/` prefix, which only ever
existed to keep tenants apart inside a shared project:

| Level | Path |
|---|---|
| project | `/<artefact>` — e.g. `/Capability & Process Map` |
| feature | `/<feature>/<artefact>` — e.g. `/Appeals/Salesforce Data Model` |

> **A published page keeps its path.** `wikiPathTpl` decides a FIRST publish
> only; an artefact already recorded in `.published.json` republishes to its
> recorded `wikiPath` (`resolvePagePath` in `scripts/lib/ado.mjs`). This is
> what `.published.json` was always described as doing and did not do —
> `ado-publish.mjs` imported `readPublished` and then read `--path` alone,
> which was harmless only while the template never changed. It is also what
> lets SAPN keep its `/Scyne/SAPN/…` pages with no legacy flag anywhere: they
> are recorded, so they stay.

**Creation happens in the wizard, verification at the gate.** `POST
/api/projects` calls `server/services/adoProject.ts`, which resolves the Agile
template BY NAME (never a hardcoded GUID), creates the project, **polls the
operation to a terminal state**, creates the project wiki, and confirms the
work item type exists. Only then is `adoTarget` written.

The reasoning that used to make this "verify, never create" still holds — a
half-created project is worse to hand a client than a clear refusal — and is
why creation polls to completion and reports the operation's own failure text.
What changed is only WHERE: in the wizard, where the user is present and
nothing has been generated, rather than at an approval gate after a document
exists and a human has approved it.

A failure there is **not fatal**. The folder tree, definition and branding are
kept, the response carries `adoError`, and the project is left INCOMPLETE
rather than broken: re-posting `/api/projects` completes it instead of
answering `409 exists`. Nothing downstream may assume `adoTarget` exists.

**`/api/approve` still verifies and still never creates.** It reads the org and
project out of the parent issue description and calls
`server/services/adoVerify.ts`, which checks the project exists, the token has
the **wiki** scope, a wiki exists (and is unambiguous), and — for the
requirements flow — that there is a usable work item type. A failed check holds
the gate with `502 ado_target_unavailable` and says exactly what is wrong;
nothing is approved.

> The PAT needs `vso.project_manage` on top of `vso.wiki_write` and
> `vso.work_write`. The install's existing token already has it — measured: a
> create with a deliberately invalid name answers `400 TF50316`, not `401`.
> That same `TF50316` covers length, illegal characters and reserved names, so
> project names are validated BY ADO and its message is surfaced verbatim
> rather than re-implemented as a regex here. Note the wizard's own check is
> more permissive (it allows `&`), so a name can pass it and fail at creation —
> which is what the resumable path above is for.
