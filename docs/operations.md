# Common operations

Split out of `CLAUDE.md`. How to actually run things: editing agent instructions, running a skill by hand, the pipeline in order, the `extract` stage, resetting, branding, creating projects and features, shipping the CLI.

### The three layers of instruction an agent receives

→ the table is in `CLAUDE.md` § Common operations. Only two of the three
are meant to be edited; the generated workflow prompt is read-only.

### Edit an agent's instructions

Edit `agent-instructions/<agent>.thin.md`, **or edit it in the console** — Org →
pick the agent → *Edit instructions*. Either way the file is read from disk when
the agent is spawned, so the next run picks it up. Nothing to push, no bundle to
re-upload, no ids to look up.

The console writes through `PUT /agents/{key}/bundle`: temp file plus rename, so
an interrupted save leaves the previous instructions intact; a declared-but-
missing file is **created**, which is how the `System prompt file not found`
state is repaired without touching a terminal; and any path resolving outside
the workspace is refused (`bundlePath` is operator-typed free text, and this
endpoint writes to it). An edit cannot disturb a run already in flight — that
process was handed its prompt when it spawned.

`bundlePath` itself is editable on the agent's Runtime card. An agent with no
path runs on the bare workflow prompt and has nowhere for instructions to live,
so `PUT …/bundle` refuses it and says so.

Check what an agent will actually be handed:

```bash
curl -s http://127.0.0.1:3100/agents/dataModeler/bundle | python3 -m json.tool
```

or open the console's Org tab and click **instructions**.

The retired Paperclip-era JSON bundles are archived at
`agent-instructions/legacy/`. They are the only remaining record of the old Phase
2 publishing protocol, which the generated publish prompts were derived from —
which is why they were archived rather than deleted.

### Run a skill locally, without the orchestrator

The skills are ordinary Claude Code skills — you can invoke one directly in a
session at the workspace root, with no orchestrator, no chatbot and no agent. Two
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
normally populates. `scripts/stage.mjs` does that step for EVERY stage,
replicating each agent's `agent-instructions/<agent>.json` Phase 1 step 2:

```bash
npm run stage                                  # every feature + which stages have run
npm run stage <project> <feature>              # status for one feature, and what's next
npm run stage <project> <feature> <stage>      # stage one stage, print its skill command
npm run stage <project> <feature> all          # stage every stage whose inputs are ready
```

### The pipeline, in order

→ the stage table, the `design` side-stage note and why `ui` runs at
position 4 are in `CLAUDE.md` § The pipeline, in order.

### The `extract` stage — one agent per document, before the map reads any of them

`capabilities` used to read every `.md` a project has — client-wide documents
plus every feature's SOP/Transcripts/Notes/UI — into ONE agent's context. At
SAPN's real size that is ~986k tokens in a single call, which is expensive,
slow, and eventually simply will not fit. `extract` runs first (project level,
order 0) to fix that: one `document-extract` agent per document, each reading
**only its own document** and writing a small, structured `<hash>.extract.json`
to `projects/<project>/solutions/Extracts/` — eight lists (business functions,
process steps, actors, service tiers, components, maturity signals, lifecycle
phases, pain points), each item carrying `src` (the pages it came from) so a
later reduce can verify a claim without re-reading the whole document.
`capability-process-map` then reduces from these extracts instead of the raw
corpus — the method changed, the twelve-section document and both JSON output
shapes did not.

**There is no bypass.** Every project extracts at every size, including a
project with two documents. A size threshold ("only extract over N KB") was
considered and rejected: it would mean two code paths through the reduce that
must independently stay correct, a fixed cliff at which behaviour silently
changes, and a small project today that grows into the expensive path with no
warning. One path, always taken, is simpler to reason about and cannot bit-rot
on the branch nobody exercises.

**Extracts are keyed by the source document's content hash**, not by filename
— `scripts/extract-state.mjs`'s `extractPathFor` hashes the file and truncates
to 16 hex characters. Editing a document changes its hash, which means it now
asks for an extract nothing has written yet: it reads as `missing`, with no
separate invalidation step to keep in sync, and — critically — every OTHER
document's extract is untouched. A client replacing one SOP does not cost a
re-extraction of the other nineteen.

**Gates now refuse two different things.** `no_documents` (nothing uploaded)
and `documents_not_ready` (documents exist but have not finished extracting, or
one failed) are reported separately by `GET /api/extract-status/:project`,
because the fix is different: the first needs a document, the second needs
`node scripts/extract-documents.mjs <project>` to run or to be waited on.
Collapsing them into one `no_documents` would send someone to upload a file
that is already there.

**The spend gap.** The map phase (`extract`) is an `exec` step, not N `agent`
steps — the workflow engine has no fan-out primitive (`flow` exists but
parent-resume-on-child-completion is not implemented, and a workflow is
compiled at boot, before any document is known). So these ten, twenty or fifty
agent runs happen inside one `exec`, get no `runs` row each, **do not appear in
`/spend`**, and are not covered by the per-agent budget ceiling. Each extract
records its own `usage` (input/output tokens), so the spend is recoverable by
summing that field across a project's extracts — but it is not tracked the way
every other agent run is. Fixing this properly needs a fan-out primitive in the
engine; nothing here builds one.

**`src` is internal only.** It exists so a reduce can verify a claim against
the exact pages it came from — it must never reach `capability-process.md`,
`capability-map.json`, or anything a client sees. No footnotes, no
"(Workshop_Transcript.md, p.23)" in a delivered document.

**The `extract` workflow raises no approval gate.** It used to, because `gate`
is part of the generic `exec → agent → exec → attach → gate` shape
`orchestrator.workflows.ts` derives from `scripts/pipeline.mjs`. Extraction is
mechanical — one document in, one small structured file out — and fifty
extracts are not something a human can meaningfully review one by one, so that
gate was friction at order 0, before any of the work worth reviewing had
happened.

It is turned off by **`gates: false` on the stage itself**, the same opt-out
`ui` already used, rather than by an exception in the compiler. That
distinction is the whole reason this was left alone for a while: carving a
per-stage special case into the compiler is what makes "add a stage to
pipeline.mjs and get a workflow for free" stop being true. A DECLARED property
the compiler reads costs nothing. The gate is still the default — a stage
author gets one and has to opt out deliberately.

What actually guards the stage is `validate-extracts.mjs` in its `then`, which
is a check a machine can make and a person cannot.

**It does not re-render the companion app either** (`renders: false`, the same
declared shape). Every other stage appends a render step so the chatbot's UI
tab does not go stale for hours — but `extract` runs at order 0, so on a new
project the renderer has nothing to show and refuses, correctly, with `nothing
to render — no artefacts found`. As a workflow step that refusal blocked the
FIRST stage of every new project. Extracts are internal anyway: `src` must
never reach a client-facing page, so they are not something the app would show
even later.

That rule used to read `if (key !== "app")` inside `buildWorkflows`, which was
right about `app` (that stage IS the render) and silently wrong about
`extract`. Both are declared on the stage now — a growing list of key
comparisons inside the compiler is how "add a stage, get a workflow for free"
quietly stops being true.

**`syncDown` does not recreate empty directories.** Blob storage has no concept
of a directory — it stores keyed objects, not folders — so a project restored
from blob after a fresh clone or a lost workspace comes back with every FILE in
place but without the empty scaffold folders nothing ever wrote to: an
untouched `requirements/UI/`, an empty `documents/` before the first upload,
and so on. Files themselves are unaffected; this was found live, restoring a
demo project onto a machine that had never held it. Something that expects a
directory to exist before it can write into it (a `readdir` with no
`{recursive: true}` mkdir first) is the failure mode to watch for.

**A `failed` document blocks its project.** `capabilities` hard-requires every
document ready, so it never runs while one file sits at `failed`. There is
still no "proceed without it" escape hatch — a capability map with a silent
hole in it is worse than a refusal — but there are now two ways to act on one:

**Retry it.** `POST /api/extract-retry/:project` takes an optional `doc` and
re-runs extraction for that document alone, or for every document that is not
ready. `retry_extraction` in the workspace MCP plane is the same thing, and
`node scripts/extract-documents.mjs <project> --doc "<scope>/<docId>"` is the
same thing again from a terminal. It is fire-and-forget — poll
`/api/extract-status/:project` — because a fifty-document project is not
something to hold a request open for.

**Or read why, and stop retrying.** `solutions/Extracts/<hash>.extract.failed.json`
carries `reason`, `doc`, `attempts`, `firstFailedAt` and `lastFailedAt`, and
`/api/extract-status` reports all of them per document. **`attempts` is the
field that decides.** A scanned PDF with no text layer gives `document-extract`
nothing to read and fails identically every time; four attempts with one reason
is not bad luck, and the fix is to remove the document or replace it with a
text-bearing version. `attempts` said `1` on every failure until it was read
from the previous marker before being overwritten, so nothing could tell those
two cases apart.

> **The reason used to be thrown away one layer up.** `extract-documents.mjs`
> printed its failure summary to STDOUT and exited 1, and the engine builds an
> `exec` step's blocking comment from STDERR — so a run blocked with *"the
> extraction script exited with code 1 and returned no error details"* while the
> reason sat in a file on a machine the person reading that comment could not
> open. The script writes the failures to stderr now, and `engine.ts` falls back
> to stdout when stderr is empty. Both halves, because either one alone leaves
> the next script that reports on stdout in the same place.

> **The `.partial` is a CLAIM, not scratch.** It is taken with `wx`, so a second
> pass over the same document finds it held rather than truncating it. Two
> passes overlap routinely — the chatbot fires `startExtraction` detached on
> every upload while the workflow's own `extract` step runs the same script, and
> two documents with identical bytes hash to one extract path. Before this, the
> loser read a `.partial` the winner had already renamed away and recorded
> `ENOENT: … <hash>.extract.json.partial` as that document's permanent failure
> reason: a complete, valid extract on disk and a marker beside it saying the
> document could not be read. A claim older than `SCYNE_EXTRACT_CLAIM_TTL_MS`
> (25 minutes) is abandoned and taken over, because a SIGKILLed pass cannot
> release its own; `--force` breaks one outright.

A full run, end to end:

```bash
# Project baseline — once per client. `baseline` runs both in ONE pass and
# prints the exact 6-step sequence; the two stages below remain for running
# either on its own.
npm run stage RTWSA baseline          # capability map + personas, one session

npm run stage RTWSA extract           # then node scripts/extract-documents.mjs RTWSA
npm run stage RTWSA capabilities      # then /capability-process-map in a Claude Code session
npm run stage RTWSA personas          # then /persona-journey-map

# Per feature
npm run stage RTWSA Demo requirements  # then /requirement-generator
npm run stage RTWSA Demo ui            # then /ui-mockup-generator
npm run stage RTWSA Demo datamodel     # then /salesforce-data-modeler
npm run stage RTWSA Demo architecture  # then /salesforce-service-cloud-architecture
npm run stage RTWSA Demo qa            # then /requirements-test-case-generator

# The deliverable — once per project, covering every feature
npm run app RTWSA
```

**A project stage takes no feature.** `npm run stage RTWSA capabilities` resolves
the LEVEL before the name, so the single trailing token is read as a stage rather
than a feature. The cost is that `capabilities`, `personas`, `app` and `all` are
not legal feature names — `POST /api/features` rejects them too.

Stage 4 (`ui`) needs two commands after the skill, both printed by the staging
output — the renderer, then the companion app so its **UI** tab picks the screens
up:

```bash
node scripts/render-mockups.mjs        RTWSA "Demo"   # validates the JSON, one page per screen
node scripts/render-companion-app.mjs  RTWSA          # UI tab now lists them
```

Two stages have a **validator that must pass** before the output is trusted; the
staging output prints them, and the agents treat a non-zero exit as a blocker:

```bash
node scripts/render-capability-map.mjs <project> --validate-only   # after `capabilities`
node scripts/validate-experience.mjs   <project>                   # after `personas`
```

`validate-experience.mjs` is the only guard between the Service Designer and a
companion-app build that may happen weeks later — `personas.json` and
`journey-map.json` are a build contract, not just a document.

### Clear the database and start again

```bash
npm run orch -- reset            # a PLAN — prints what would go, deletes nothing
npm run orch -- reset --yes      # do it: issues, comments, work products, gates,
                                 #   runs, budgets and the raw .jsonl logs
npm run orch -- reset --hard --yes   # also drop the agents and .orchestrator/overrides.json,
                                     #   then rebuild the org from orchestrator.config.ts
npm run orch -- reset --all --yes    # also users, projects, documents, installations
                                     #   and chats — the installation is then UNCLAIMED
```

The bare verb is a **dry run** — a half-remembered command cannot cost anyone
their history. Stop `npm run dev` first: the database is single-writer and the
CLI is refused while a server holds it.

> **It resets ONE organisation, not the database.** Every depth is scoped to
> the home company, so another organisation's projects, people and issues
> survive even `--all` — the plan lists the ones it will not touch, because
> "the installation is UNCLAIMED" reads like everything is gone. For a
> genuinely empty database, stop the server and `rm -rf .orchestrator/pgdata`.
>
> **`--hard` also detaches other organisations' issues from the agent rows.**
> The org chart lives in one company but every issue in the install is assigned
> out of it, so deleting those rows hits `issues_assignee_agent_id_fkey` the
> moment a second organisation exists. Measured before the fix: the reset
> aborted half-applied, having already deleted the superadmin, leaving an
> installation that could be neither used nor re-claimed. The whole reset is
> now one transaction, and the pointers are nulled rather than the issues
> deleted — they dangle either way, since the re-seeded agents get new ids.

**Skills need no reseeding — they are not in the database.** They are files
under `skillsDir`, and the agent-to-skill mapping is derived from the workflows
at read time, so a reset cannot lose them. (The schema does carry `skills` and
`agent_skills` tables from an earlier design; nothing in `src/` reads or writes
either one.)

Agents need no reseeding either: the org is reconciled from
`orchestrator.config.ts` on **every** boot, which is what makes `--hard` safe —
dropping the rows is how a hand-edited row or a stale overrides entry gets
discarded, not how an agent is permanently removed.

`rm -rf .orchestrator/pgdata` still works and additionally discards the
migration state, but it cannot run while a server holds the directory and it is
one mistyped path away from taking something else with it.

### Migrating a project created before the restructure

`personas`, `capabilities` and `design/` used to live under a feature.
`scripts/migrate-to-project-level.mjs` lifts them:

```bash
npm run migrate                    # dry run, every project
npm run migrate -- SAPN --apply    # do it, one project
```

It moves `<feature>/solutions/{Capabilities,Experience}/` and `<feature>/design/`
up to the project, archives a losing duplicate to
`original-files/superseded/<feature>/` rather than deleting it, clears the retired
per-feature `generated-apps/<project>-<feature>/` folders and their registry
entries, and lists any feature `Notes/` that read like client-wide policy so you
can move them to `documents/` by hand. It is idempotent and refuses to overwrite
an existing project-level artefact without `--force`.

### Conversion happens first

**Staging converts documents to markdown first.** The skills only read `.md`, so
a hand-placed `.pdf`/`.docx`/`.xlsx`/`.txt` under `requirements/` would otherwise
be silently invisible to the model. `scripts/convert-to-md.mjs` writes a sibling
`.md` for each (`Conceptual Data Model.pdf` → `Conceptual Data Model.md`). It
runs automatically as step 0 of every stage; `--no-convert` skips it, and it
also stands alone:

```bash
npm run convert <project> <feature>                        # convert only
npm run convert <project> <feature> -- --force             # re-convert
npm run convert <project> <feature> -- --keep-originals    # leave sources beside their .md
```

Same end state as the upload route: the markdown replaces the source in
`requirements/`, and the original is **moved** (never deleted) to
`original-files/requirements/<Sub>/`, so `requirements/` holds markdown only.

> **Both upload routes run it, and that is not a nicety.** Every stage's 409
> gate counts `.md` under `projects/<p>/`, and staging is step 0 of a workflow
> that the gate decides whether to start at all — so a `.docx` converted only
> at staging time is a `.docx` the gate refuses forever. `/api/upload/project`
> always ran the converter; `/api/upload` (the FEATURE route) did not, which is
> why three `.docx` uploaded to a feature produced `no_documents` on every
> retry while `/docs` listed all three. Both run it now.
>
> **The converter needs `markitdown-ts`, which is a declared dependency of
> `scyne-chatbot` and lives only in its `node_modules`** — `convert-to-md.mjs`
> resolves it from there, deliberately, so the root install stays lean and the
> two paths cannot use different versions. It was missing from that package for
> the whole of this repo's history, so conversion failed everywhere with
> `markitdown-ts is not installed` and every uploaded `.docx` stayed unreadable.
> A failure is now logged by the upload route rather than reported only in the
> `converted: false` field nothing reads.

It is idempotent (a second run reports `up-to-date`, and archives any source
still sitting beside its markdown), never clobbers a hand-written `.md` of the
same name (falls back to `<name>.<ext>.md`), and on a conversion failure leaves
the source untouched rather than writing a partial file or archiving something
that never converted. Images and audio are skipped by design — screens are read
as images, audio goes through Gemini transcription — and are never archived.

### Flags

| Flag | Effect |
|---|---|
| `--force` | re-seed reference catalogues that already hold curated files |
| `--no-convert` | skip the document → markdown pass |
| `--keep-originals` | leave converted sources beside their `.md` instead of archiving |
| `--from-requirements` | `datamodel` only — stage raw requirement `.md` instead of the product summary, for a feature that has not run the BA yet |

Outputs land at the same paths the agent would write, so the chatbot's approval
preview and every downstream stage still find them. What you skip by going direct
is the human approval gate and Azure DevOps publishing — those live in the
agents' Phase 2, not in the skills.

### Brand the companion app from a client's website

```bash
npm run brand -- <url> <project>            # writes design/style-guides/theme.json
npm run brand -- <url> <project> --dry      # print what it found, write nothing
```

Branding is **per project**: one project renders one companion app, so it carries
one palette. `scripts/extract-brand.mjs` fetches the page and its stylesheets and
extracts the brand colour (a CSS custom property literally named
`--brand`/`--primary` beats raw frequency, which in turn beats nothing), an accent
that is a genuinely different hue rather than a shade of the brand, the wordmark,
the font stack, and the logo — **inlined as a data URI**, because the rendered
page makes zero network requests and a linked logo would simply not load.

It writes two files: `theme.json` (what the renderer reads) and
`brand-source.json` (why each value was chosen, plus the runners-up). When a
colour is wrong, correct `theme.json` — do not re-run the extractor on the same
URL expecting a different answer.

It refuses to overwrite a hand-authored `theme.json` without `--force`. Sites that
build their CSS in the browser have nothing to read server-side; write the theme
by hand in that case.

The chatbot exposes the same thing two ways: the **New Project** wizard asks for
the website in step 1, and pasting a URL in chat ("brand it like acme.com") runs
`extract_brand` against the active project and re-renders the companion app if one
exists.

### Render the companion app by hand

```bash
node scripts/render-companion-app.mjs <project>                # full render
node scripts/render-companion-app.mjs <project> --no-diagrams  # skip mermaid (much faster)
open generated-apps/<project>/index.html                       # or just open the file
```

It takes a **project**, and renders every feature under it. It refuses only when
the project has produced nothing at all; a project with one capability map and
nothing else produces a valid page. Branding is data: drop a
`design/style-guides/theme.json` at the project and re-render.

```json
{ "brand": "#464e7e", "brandDeep": "#363c63", "accent": "#b4795a", "logoText": "Scyne" }
```

Never hand-edit the emitted `index.html` — the next render overwrites it.

### Create a project or a feature

From the chatbot, use the **New Project** wizard (header ✨) or just ask: "create a
new project", "add a feature to RTWSA". Both are also plain HTTP:

```bash
curl -sS -X POST http://127.0.0.1:4000/api/projects \
  -H 'Content-Type: application/json' \
  -d '{"project":"RTWSA","description":"Who the client is…","website":"https://rtwsa.com"}'

curl -sS -X POST http://127.0.0.1:4000/api/features \
  -H 'Content-Type: application/json' \
  -d '{"project":"RTWSA","feature":"Appeals & Reviews"}'
```

By hand on disk, if you prefer:

```bash
# Project
mkdir -p projects/<project>/{documents,design/{style-guides,example-screens}}
mkdir -p projects/<project>/solutions/{Capabilities,Experience}/outputs

# Feature
mkdir -p projects/<project>/<feature>/requirements/{SOP,Transcripts,Notes,UI,templates}
mkdir -p projects/<project>/<feature>/outputs
```

The `solutions/` working folders under a feature are created on demand by each
stage. No code change is needed — `/api/features` auto-discovers a new folder on
the next chat turn.

> **Project names take no spaces; feature names still do.** A feature is
> routinely "Interim Benefit" or "Appeals & Reviews" and always will be, so
> every generated command quotes BOTH `{project}` and `{feature}` — `swap()` in
> `orchestrator.workflows.ts` emits them already quoted, which is what keeps
> "add a stage to `pipeline.mjs`, get a workflow for free" true: a stage author
> cannot forget it. It was not always so, and an `exec` step runs through
> `child_process.exec`, i.e. `/bin/sh -c`, so an unquoted placeholder
> word-splits: a project called `SA Demo` reached `stage.mjs` as `SA` and it
> refused with `no such project: projects/SA`, while listing `SA Demo` as
> available two lines below.
>
> A NEW project name is **slugged rather than refused**: `SA Power Networks` is
> created as `SA-Power-Networks`, and the wizard says so live under the field
> before anything exists. The rule is unchanged — that name is also the Azure
> DevOps project, the wiki path segment and the `--project` argument on every
> verb, and it should not have to survive every future caller remembering — but
> nobody is asked to obey it.
>
> It used to be a refusal (`400 project_name_has_spaces`, carrying a
> hyphenated `suggestion` that the wizard threw away), and the wizard validated
> with the READ rule, which allows spaces. So the Next button lit up on a name
> the server was about to reject, one step later, with a fix it never applied.
>
> **`slugProjectName` / `isNewProjectName` in `scyne-chatbot/server/names.ts`
> are the authority.** The wizard imports them rather than carrying a fourth
> copy; `cli/dual.ts` keeps its own (it is dependency-free by design) and now
> APPLIES the slug too, because `scyne project create "SA Power Networks"` was
> refused outright while the web wizard created it happily.
>
> **A slug that lands on an existing INCOMPLETE project is refused**
> (`409 slug_collision`), naming both. `SA Demo` and `SA-Demo` are two
> different projects that already exist side by side in this repo, and
> "completing" a project rewrites its Azure DevOps target and its branding —
> so adopting one because a typed name happened to slug onto it would hand one
> client's tree another client's target, in a route that reports success.
>
> Reads are untouched: `SAFE_PROJECT` still admits spaces everywhere a project
> is READ, since projects with spaces already exist and refusing to open one
> would be worse than the bug this prevents.

**Reserved feature names:** `capabilities`, `personas`, `app`, `all`, `baseline`, plus the
project's own folder names (`solutions`, `documents`, `design`, `original-files`,
`outputs`). A feature by one of those names would be unreachable from the CLI and
would appear as a feature in the target picker.

### Start a run from the CLI

```bash
npm run orch -- run requirements --project SADA --feature interim-benefit \
  --adoOrg Scyne-AI-Lab --adoProject "Scyne AI Project"
```

Every `--key value` after the workflow name becomes a workflow param and reaches
the agent's prompt, so a stage needing extra context needs no code change. The
command starts the issue and advances it as far as it will go — which is to the
first gate — and prints the gate id and the command to approve it.

While `npm run dev` is running, use the HTTP API instead (PGlite is
single-writer):

```bash
curl -sS -X POST http://127.0.0.1:3100/issues -H 'Content-Type: application/json' \
  -d '{"workflow":"requirements","params":{"project":"SADA","feature":"interim-benefit","adoOrg":"Scyne-AI-Lab","adoProject":"Scyne AI Project"}}'
```

### Ship the `scyne` CLI to a user with no clone

```bash
npm run build:cli     # dist/cli/  — one file, no dependencies
npm run pack:cli      # …and dist/scyne-cli-<version>.tgz, ~21 KB
```

The user needs **Node 20+** and one of:

```bash
npm install -g ./scyne-cli-0.1.0.tgz                    # a tarball you hand over
npm install -g https://…/releases/…/scyne-cli-0.1.0.tgz # a GitHub release asset
npm install -g @scyne/cli                               # a registry, if you publish
cp dist/cli/scyne.mjs ~/bin/scyne                       # no npm at all
```

Then `scyne login --api-url https://…` and they are working. Nothing else is
installed — no engine, no PGlite, no workspace, no skills.

**Documents are managed from the CLI as well as the web UI**, through the same
routes, so neither can do something the other cannot:

```bash
scyne doc list [--all] [--category C]          # the rows, which now hold the CONVERTED markdown
scyne doc upload <file...> --as sop            # converts, archives the source, writes the row
scyne doc replace <path> <file>                # old and its archived original removed first
scyne doc delete <path...>                     # file, archived original, and row
```

and in the interactive session, `/docs`, `/upload`, `/replace` and `/rm`.

> **`doc delete` on a row whose file is not there retires the row anyway**, and
> says so. That is the exact state the old `doc upload` left behind — a
> pre-conversion path the converter had already renamed — so refusing would
> leave those rows undeletable by the only tool that lists them.

**It detaches cleanly because it was never coupled.** Every command goes over
HTTP to the same API the browser uses, and nothing in `cli/` has an npm
dependency — only `node:` builtins and global `fetch`. So "ship the CLI" is
bundling six files rather than extracting a subsystem, and the published
package declares **zero** dependencies: `npm i -g` on a locked-down machine
fetches nothing but the package.

**The stage list comes from the server, not from the package.**
`cli/stages.ts` reads `GET /config` — it used to `import … from
"../scripts/pipeline.mjs"`, the one line that required a checkout. Cutting it
is what makes the bundle standalone, but it is also the more correct answer:
"what can I run" is a fact about the server being asked. A CLI carrying its own
copy would answer for the version it was published at and **refuse a stage the
server had gained since** — the failure you least want in a tool distributed
separately from the engine it drives. Users do not have to upgrade in lockstep
with the server.

`level` is derived rather than declared: a workflow that interpolates
`{feature}` runs per feature. `params` comes from the engine's own scan of each
workflow's templates, so it cannot disagree with what the steps read — which is
also how `scyne run revise-<stage> --instruction "…"` now works at all, and how
a missing parameter is refused as a usage error instead of blocking mid-run on
`unknown placeholder`.

> **The build runs the artefact before packaging it.** Both failures it checks
> for have already happened here: esbuild HOISTS the entry's own shebang, so a
> `banner` adding a second one produced a package that installed perfectly and
> then failed every invocation with `SyntaxError` on line 2; and a bundle that
> is not `chmod +x` is not a command. Neither shows up until a user runs it, so
> `scripts/build-cli.mjs` asserts one shebang, sets the mode, and executes
> `scyne --help` — the one entirely offline command — before `npm pack` sees it.

> **A paste is one answer, not one answer per line.** Every prompt in the
> interactive session reads a single readline `line` event, which is right for
> a typed answer and wrong for a pasted one: a pasted paragraph is N events, so
> `/new` consumed one client description as its description, its website, its
> document paths and its first feature name — and the lines still left over
> fell through to the chat loop, where the assistant read each stray sentence
> as an instruction and created a feature for it. `cli/paste.ts` asks the
> terminal for **bracketed paste** (DECSET 2004) and strips the markers out of
> stdin BEFORE readline sees them, which is the only way to tell a pasted
> newline from a pressed Return — the bytes are otherwise identical, and Node's
> readline splits an insert on newlines and submits each piece. A multi-line
> block shows as `[Pasted text #1 +12 lines]` and expands back on Return; a
> paste never submits itself. Piped input is passed through untouched, so
> `printf '/use RTWSA\n/gates\n/exit\n' | scyne` still works. `npm run test:cli`
> covers the parser and the readline seam.

### Watch what an agent is doing

Open `http://127.0.0.1:3100/orch#runs` and click any run — the transcript
streams tool calls, skill invocations and assistant text, filtered and with
secrets scrubbed, polling every 3 seconds until the run finishes. The chatbot's
Live Transcript pane shows the same thing from the same endpoint.

From the terminal:

```bash
npm run orch -- runs SCY-7          # one line per run: agent, phase, duration, tokens, cost
npm run orch -- log <runId>         # filtered transcript
npm run orch -- log <runId> --raw   # the raw JSONL, byte for byte
```

