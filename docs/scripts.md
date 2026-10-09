# Helper scripts (`scripts/`)

Split out of `CLAUDE.md`. What every script in `scripts/` does and why. Read the entry before changing a script or adding one.

- **`scripts/pipeline.mjs`** — **the pipeline, as data.** Which stages exist, what
  level each runs at, what each `produces`, `requires` and `enriches`, plus the
  artefact aliases the revision flow routes on. Imported by `stage.mjs`,
  `render-companion-app.mjs`, `migrate-to-project-level.mjs` and the chatbot
  server. Four consumers must agree on "what does this stage require"; writing it
  once is what stops them diverging. Paths carry an explicit `scope` —
  `project`, `feature`, or **`features`**, which spans every feature under the
  project because that is what `stageAllDocuments` reads.
  > **Documents are inputs, and were not.** Every entry came `from` another
  > STAGE, so the staleness walk could only ever answer "this artefact predates
  > another artefact" — a client replacing an SOP, the most common reason a pack
  > goes out of date, changed nothing it could see. The four
  > `requirements/{SOP,Transcripts,Notes,UI}` folders are now inputs
  > (`from: "discovery"`) to `requirements`, `ui` and `architecture`, and
  > feature-spanning inputs to `capabilities` and `personas`. Enumerated rather
  > than "requirements/ minus exclusions", because `templates/` is house style
  > and `project/` is staged DOWN on every run — treating that one as source
  > would report every feature artefact stale immediately after staging.
  >
  > `newestMtime` also followed exactly ONE level in, which was true enough for
  > the flat `projects/<p>/documents/` and useless for `requirements/<Sub>/`.
  > A walk that stops at the first directory returns null, and null means
  > "nothing changed" — so the deeper a document, the more certainly it was
  > ignored. It recurses now.
  >
  > `SOURCES` gives a non-stage origin a readable label: a refresh prompt used
  > to say an artefact was superseded by "documents", which is a key, not
  > something to show the person deciding whether to spend twenty-five minutes.
- `scripts/stage.mjs <project> [<feature>] <stage>` — the local, agent-free
  path, and the one the agents now call in Phase 1. Converts source documents to
  markdown first, stages the project's material down (or every feature's up, for a
  project stage), refuses a stage whose hard prerequisite is missing while naming
  the stage that would satisfy it, and prints the exact skill command to run next.
- `scripts/render-companion-app.mjs <project>` — used by the **Developer**. Emits
  ONE self-contained `generated-apps/<project>/index.html`. **Zero network
  requests.** The file at this path is a shim kept for its callers; the renderer
  is `scripts/companion/`:
  - `render.mjs` — entry: load, render every view, write the page and the
    `registry.json` entry (printed LAST on stdout — the chatbot parses it).
  - `load.mjs` — inputs, theme, markdown, Mermaid (moved unchanged).
  - `views/*.mjs` — one per tab, data in, HTML out, through `html.mjs`'s
    auto-escaping `html` template. The page is rendered **statically**: every
    view is in the HTML, and `client.js` (~300 lines) only routes
    `#/<tab>/<view>/<item>`, opens dialogs and the capability slide-over,
    filters, searches and switches theme.
  - `swimlane.mjs` + `swimlane.css` — one BPMN-style swimlane per phase, drawn at
    build time from `flows` in `process-model.json` (contract:
    `scripts/lib/flows.mjs`). A phase with no flow shows its cards only; a
    malformed flow costs that swimlane, not the page.
  - `styles.css` — the one visual system. Brand colour marks what matters, text
    in the brand uses `--brand-fg` (computed to AA), never `--line`
    (`test/companion-contrast.test.mjs`).
  Project tabs render the client artefacts; feature tabs open on a grid of
  feature cards, showing a muted "not generated" card for a feature that has not
  run that stage. Flags: `--no-diagrams` skips the mermaid pass.
  `test/companion-render.test.mjs` renders a fixture through the real CLI.
  > Inlined Mermaid SVGs have their internal ids namespaced per diagram, and
  > markdown heading anchors are scoped per document. Both matter only at project
  > scale: mermaid-cli emits a fixed `id="my-svg"` and fixed filter/marker defs
  > for every diagram, so N diagrams on one page meant N duplicate ids AND every
  > `url(#…)` resolving to the first diagram's defs; and every feature's data
  > model opens with "1. Executive Summary".
- `scripts/render-mockups.mjs <project> <feature>` — used by the **UX Designer**.
  Reads `solutions/UI/outputs/mockups.json`, validates it (non-zero exit naming
  the offending screen and field), and emits
  `generated-apps/<project>/mockups/<feature>/` — one themed page per screen plus
  an index. Reads the project's `theme.json`, so a project branded once renders in
  the client's palette in both artefacts.
  > **Its theme tokens are duplicated from the companion app** rather than
  > shared. The companion app's CSS is now a real file
  > (`scripts/companion/styles.css`), so the two could share tokens; until they
  > do, a palette change has to be made in both.
- `scripts/migrate-blobs-to-local.mjs [--apply]` (`npm run migrate:blobs:local`) —
  copies every document's bytes out of S3/LocalStack or Azure into the local
  folder store and rewrites its `blob_path` to `local:…`, so the install no
  longer needs Docker. A plan without `--apply`. Each row is rewritten only
  after its bytes read back with the right hash, so a run killed halfway is
  safe to re-run; the originals are left in place. The source store must be up
  while it runs.
- `scripts/migrate-to-project-level.mjs [<project>] [--apply] [--force]` — one-shot
  migration for a project created before the restructure. See
  [`operations.md`](operations.md) § Migrating a project created before the restructure.
- `scripts/sync-bundles.mjs export|import <dir>` — **retired with Paperclip.** It
  round-tripped the agent bundles between their `{path, content}` JSON and one
  `.md` per agent, because editing a whole AGENTS.md crammed into a JSON string
  is how they got corrupted. The bundles are now plain `.thin.md` files, so there
  is nothing to round-trip. Kept only for reading `agent-instructions/legacy/`.
- `scripts/validate-experience.mjs <project>` — the contract guard for
  `personas.json` + `journey-map.json`: required fields, unique IDs, `avatarColor`
  in the app's palette, satisfaction scores as integers 1–5, no semicolons in
  persona bullets (the app's CSV loader splits on them), no `:`/`;` in journey step
  names (breaks the Mermaid `journey` parser), every journey's `personaId`
  resolving, every "moment that matters" resolving to a step, every persona having
  exactly one journey. Reports **every** problem in one run and exits non-zero.
- `scripts/render-capability-map.mjs <project> [--validate-only]` — the contract
  guard for `capability-map.json` + `process-model.json`, which is the part the
  agent cannot self-check. `--validate-only` is how the pipeline calls it. Its own
  page renderer is retained but no longer wired in: a project has ONE page,
  rendered by `render-companion-app.mjs`.
- `scripts/mermaid-to-flows.mjs <project> [--dry-run]` — used by the
  **Capabilities Process Architect**. Generates `process-model.json`'s `flows`
  (the swimlanes) from `capability-process.md` §5: one `### <phase>` heading and
  Mermaid flowchart per phase, the role prefix on each task label (`SOO: …`)
  picking the lane, `{…}` nodes as decisions. Adds start/end events, links tasks
  to activities, keeps any `pain` the agent added, validates, writes.
  > **Why a script.** Asked to hand-write `flows` for BAE's six phases, the agent
  > spent its whole output budget (128k thinking tokens, four "output token limit
  > hit" restarts, $2.34) and saved nothing. The translation is deterministic, so
  > it lives in code; the agent only adds `pain`, as small edits.
- `scripts/lib/flows.mjs` — `validateFlows(flows, activities)` → `{ flows,
  errors }`, the rules for `process-model.json`'s optional `flows` (one swimlane
  per L1 phase). Pure, so the guard above refuses exactly what the companion app
  cannot draw: it dies on any error, while `flows` holds only the flows that
  passed. Absent `flows` is valid — projects mapped before swimlanes still pass.
  Tests: `test/flows-validate.test.mjs`.
- **`scripts/confluence-publish.mjs <file.md> --title "Title"`** — create or
  update a Confluence page from a markdown file on disk, idempotent by the
  RECORDED PAGE ID (falling back to a title match) so a revision can never leave
  the client with two documents. That is a sharper rule than the Azure path's,
  not a softer one: a Confluence title can be edited in the UI by anybody, so
  title lookup alone would eventually publish a duplicate beside a page somebody
  had simply renamed. `--render-mermaid` renders every ` ```mermaid ` fence to
  PNG and attaches it in the same pass — without it the page goes up with its
  diagrams silently missing.
- **`scripts/confluence-attach.mjs <pageId> <file>...`** — uploads attachments.
  The **only** supported way: the MCP has no attachment scope. Idempotent — a
  filename already attached is versioned in place rather than duplicated.
- **`scripts/jira-issues.mjs <stories.json>`** — creates or updates one Jira
  issue per story. The counterpart of `ado-workitems.mjs`, with the same three
  guarantees: it discovers the issue type, refuses to write a description still
  containing `{{PRODUCT_SUMMARY_URL}}`, and writes `jiraKey` back so a re-run
  cannot duplicate a backlog. Uses REST **v2**, because v2 takes a wiki-markup
  string and `requirement-generator` already writes exactly that — v3 would mean
  an ADF conversion layer whose only job is to undo the skill's own output.
- **`scripts/ensure-confluence-space.mjs <project>`** — the pre-publish guard.
  Confirms the space exists and that the project's recorded target matches this
  installation's, and creates NOTHING: a space conjured into a client's site at
  approval time is a decision about where their documents live being made by a
  gate handler.
- **`scripts/ado-publish.mjs <file.md> --path "/Some/Page"`** — create or update
  a wiki page from a markdown file on disk, idempotent BY PATH so a revision
  can never leave the client with two documents. `--verify` checks the org,
  project, wiki and both token scopes and exits non-zero naming which failed —
  run it before a stage does, because a bad target is far cheaper to find now
  than after a document is built. `--attach` uploads an image and rewrites its
  markdown reference to `/.attachments/`; usually unnecessary, since the wiki
  renders ` ```mermaid ` itself.
  > The publish prompt reaches for this when a document exceeds about 40 KB.
  > Passing 110 KB through a tool call is measured to fail — run SCY-6 read the
  > document three times assembling the call, compacted thirteen minutes in and
  > published nothing, for $2.73.
- **`scripts/ado-workitems.mjs <stories.json> --summary-url <url> [--parent <id>]`**
  — creates or updates one work item per story. Three things it does that an
  instruction to a model could not be relied on to:
  > **Discovers the work item type.** "User Story" exists only in the Agile
  > process template; the current target runs **Basic** (Epic → Issue → Task,
  > no User Story), so a hard-coded `$User Story` would fail every story.
  > **Substitutes `{{PRODUCT_SUMMARY_URL}}`** — and REFUSES to write a
  > description that still contains it, because a re-run without
  > `--summary-url` would otherwise overwrite a correct link with the
  > placeholder.
  > **Writes the created ids back** into `stories.json`, so a re-run updates
  > rather than duplicating a client's backlog.
- **`scripts/sync-documents.mjs`** (`npm run sync:docs`) — **reconcile the folder
  tree into the database.** A PLAN by default; `--apply` writes; `--project P`
  narrows. Creates missing project, feature and document rows, and RETIRES a row
  whose file is gone (never a hard delete — bytes are shared by every path
  holding the same content). Idempotent: `put()` is content-addressed and
  answers `changed: false` for bytes it already holds.
  > **Disk wins, and only ever lifts one way.** It is what every stage reads —
  > the 409 gates count `.md` there, the skills read the folder tree — so this
  > records disk into the database and never the reverse.
  >
  > It exists because dual-write only governs what is created THROUGH those
  > paths. `npm run convert`, `stage.mjs`, an agent, or a person copying a file
  > into `documents/` all land on disk alone. Measured before it existed: **20
  > documents on disk against 2 rows, and three of four projects unknown to the
  > database entirely** — so `scyne doc list` printed nothing for a project the
  > browser listed nine documents for.
  >
  > **Count the two real shapes only** — `projects/<p>/documents/` and
  > `projects/<p>/<f>/requirements/{SOP,Transcripts,Notes,UI}/`. A glob like
  > `*/documents/*.md` also sweeps `solutions/<Stage>/documents/`, which is 41
  > staged working copies here: material `stage.mjs` writes before an agent run,
  > not documents anybody uploaded. Counting those is how "20" becomes a
  > confident, wrong "63".
- `scripts/extract-brand.mjs <url> <project>` — see [`operations.md`](operations.md)
  § Brand the companion app from a client's website.
- **`scripts/build-cli.mjs`** (`npm run build:cli` / `npm run pack:cli`) — bundles
  `cli/` into `dist/cli/`: one readable, dependency-free `scyne.mjs` plus a
  GENERATED `package.json`, because the repo's own root package is
  `private: true` and carries the whole stack's scripts. Not minified on
  purpose — it is a file people are asked to install from an email and run
  against their own credentials. It executes `scyne --help` on the built
  artefact before packaging. See [`operations.md`](operations.md) § Ship the
  `scyne` CLI to a user with no clone.
- `scripts/convert-to-md.mjs <project> [<feature>]` — with a feature, converts that
  feature's `requirements/`; with none, the project's own `documents/`.
- `scripts/audit-a11y.mjs <project>` — used by the **UX Auditor**. Runs
  `@axe-core/cli` (WCAG 2.0 A + AA) and `pa11y` (WCAG2AA) against the registry's
  `devUrl` and writes `generated-apps/<project>/audit.json`. Exits 0 even when
  violations exist — the auditor reads the JSON to decide what to fix.
  > **Both tools test ONE theme state, not four.** Headless Chrome defaults to
  > `prefers-color-scheme: dark`, and neither tool exposes a flag to change it, so
  > a clean `audit.json` is evidence about the dark palette only. The page has four
  > states worth checking (system light, system dark, and the toggle forcing each),
  > and a per-project `theme.json` can pass one while failing another. When
  > branding changes, verify all four with a driver that calls
  > `page.emulateMediaFeatures([{name:"prefers-color-scheme",value:…}])`.
  > **Known environment issue:** `@axe-core/cli` drives Chrome through
  > ChromeDriver and fails with `session not created` when the installed Chrome is
  > newer than the bundled driver. `npx browser-driver-manager install chrome`
  > fixes it. `pa11y` uses its own bundled browser and is unaffected.
  > **What "0 violations" means here.** As of this restructure, pa11y reports 17
  > issues on the SAPN page, down from 176. The remainder are: mermaid emitting
  > duplicate ids *within* one sequence diagram (not fixable from outside
  > mermaid), two dialog headings filled by JS at open time, and the hash-router
  > nav links, which pa11y cannot resolve. Do not claim zero without saying which
  > tool and which theme state.

> The React path that `render-companion-app.mjs` replaced (`scaffold-app.mjs` /
> `stop-app.mjs`) is kept at `scripts/legacy-react-scaffold/` with a README on
> restoring it. It was retired because the deliverable is a document a consultant
> hands to a client, not a running program.

