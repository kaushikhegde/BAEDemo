# Running the Scyne pipeline from Codex

Everything below is driven from **Codex**, through this plugin. For the server
itself — installing, claiming the installation, users, budgets — see
[`SETUP.md`](../../SETUP.md) and [`SETUP-RUN.md`](../../SETUP-RUN.md) at the
repo root. This file assumes those are done and picks up at getting the plugin
into Codex.

Paths are relative to the repo root unless stated.

---

## 1 · Install the plugin into Codex

Once per machine, from the **repo root** — `.agents/plugins/marketplace.json`
registers this repo as a marketplace named `scyne`, and the plugin is installed
out of it:

```bash
codex plugin marketplace add .                 # registers the marketplace `scyne`
codex plugin add azure-file-processing@scyne   # installs the plugin from it
codex plugin list | grep scyne                 # → installed, enabled  0.6.0
```

A clone somewhere else takes the same two steps with a Git source instead of
`.`:

```bash
codex plugin marketplace add <git-url> --ref main
codex plugin add azure-file-processing@scyne
```

> **`add` COPIES the plugin** into
> `~/.codex/plugins/cache/scyne/azure-file-processing/<version>/`, and that copy
> is what Codex loads — not the working tree. So an edit to
> `skills/scyne/SKILL.md` or to `.mcp.json` does nothing until you re-run
> `codex plugin add azure-file-processing@scyne`, which overwrites the cache in
> place. The two MCP servers are a different matter: they run from the REPO
> (§2), so a change under `src/` needs only a restart of `stack.sh`.

Then install the plugin's own dependencies — `stack.sh` starts both servers with
`./node_modules/.bin/tsx` and will not run without them:

```bash
cd plugins/azure-file-processing && npm install
```

### Removing it

```bash
codex plugin remove azure-file-processing@scyne   # config entry + the cached copy
codex plugin marketplace remove scyne             # deregister the marketplace
```

Neither touches anything in the repo.

---

## 2 · Start everything

Four processes, in two commands, in this order.

```bash
# Terminal 1 — repo root. Orchestrator :3100 and chatbot :4000.
npm run dev

# Terminal 2 — this plugin. Azurite + workers in Docker,
# file plane :8080 and workspace plane :8081 natively.
cd plugins/azure-file-processing && ./scripts/stack.sh up
```

`stack.sh up` waits for `/health` itself and prints the MCP URLs when ready.

**Check all four before doing anything else:**

```bash
for p in 3100 4000 8080 8081; do
  printf ":%s " $p; curl -s -m3 -o /dev/null -w '%{http_code}\n' http://127.0.0.1:$p/health
done
# want: 200 200 200 200
```

| Port | Is | Needed for |
|---|---|---|
| 3100 | Scyne orchestrator | every stage, gate, issue, spend |
| 4000 | chatbot API | every document operation |
| 8080 | file plane MCP | uploading and searching large documents |
| 8081 | workspace plane MCP | everything `$scyne` does |

**Then start a NEW Codex thread.** Tools and skills bind when a thread begins —
an already-open thread will not see the plugin even after the stack comes up.
This is the single most common reason `$scyne` "doesn't work".

`SCYNE_ORCH_TOKEN` must be set in the **workspace-root `.env`**. Without it every
workspace call answers `not_authenticated`. The file plane does not need it.

### Stopping

```bash
cd plugins/azure-file-processing && ./scripts/stack.sh down   # ⚠ see below
```

> **`down` runs `docker compose down -v` and DESTROYS the Azurite volume** — every
> uploaded document and every processed artifact in blob. Local `projects/` on
> disk is untouched. To stop without losing blob, stop the containers instead:
> `docker compose stop`.

---

## 3 · The whole flow

In Codex, type `$scyne <verb>` — `$`, not `/`. Plain English works identically
("run the capability map for SAPN"); the verbs are just the precise form.

### 3.1 Create the project

```
$scyne new project "SA Power Networks"
```

Writes the folder tree, the database row, the Azure DevOps project and the
branding in one call.

Two fields in the response always worth reading:

- **`slugged`** — project names cannot contain spaces, so this becomes
  `SA-Power-Networks`. **Use that name from here on.**
- **`dbError` / `adoError`** — either can fail while the project is still
  usable. A `dbError` means anything resolving the project by name stays empty
  until it is fixed. Re-posting the same name completes an incomplete project
  rather than refusing.

Then pin it so later verbs don't need repeating:

```
$scyne use SA-Power-Networks
```

Give it a definition — every skill reads this before any discovery document:

```
$scyne describe "SA Power Networks distributes electricity across South Australia,
regulated by the AER, serving 900,000 homes and businesses…"
```

Minimum 40 characters. Ask once; never block a run on it.

### 3.2 Upload the project's client-wide documents

Client-wide policy, legislation, standards, current-state architecture:

```
$scyne upload /Users/you/docs/network-safety-policy.pdf
$scyne upload /Users/you/docs/aer-determination.docx
```

No `kind` at project level — a project document always lands in `documents/`.

Each call streams the file to Azure in 8 MiB blocks, converts it to markdown in
a worker, and files only the markdown. It blocks while the worker runs — seconds
for a small document, minutes for a very large one.

Accepted: PDF, Word, PowerPoint, Excel, HTML, CSV, RTF, EPUB, ODF, text. Images
and audio are refused by design.

```
$scyne docs                 # what the project holds now
$scyne extracts             # …and whether it is ready to be read by a stage
```

### 3.3 Wait for extraction, then the capability map

**There is no extract step to run.** Uploading starts it: all three upload
routes spawn `extract-documents.mjs` the moment a document lands, detached, so
by the time `$scyne upload` returns the work is already under way. One agent
runs per document, which is what stops the capability map ever having to read
the whole corpus at once.

What you do is *wait for it*:

```
$scyne extracts             # → ready / still extracting / failed, per document
```

Then:

```
$scyne run capabilities
```

`capabilities` hard-requires every document to be ready. If it refuses with
`documents_not_ready`, **that almost always means wait**, not that you missed a
step — check `$scyne extracts` and try again.

Run the stage by hand only when a document reached the tree by some other route
(copied in, `npm run convert`) or a spawn failed:

```
$scyne run extract          # idempotent catch-up; raises its own gate
```

Produces the Business Capability Map and the L1/L2/L3 Process Model, and on
approval publishes to the project's Azure DevOps wiki.

### 3.4 Personas

```
$scyne run personas
```

Requires the capability map — journey stages align to its L1 lifecycle phases.

### 3.5 Create a feature

```
$scyne new feature "CRM Management"
$scyne use SA-Power-Networks "CRM Management"
```

Feature names MAY contain spaces. Reserved names (`capabilities`, `personas`,
`app`, `all`, `baseline`, `solutions`, `documents`, `design`, `original-files`,
`outputs`) are refused with the reason.

### 3.6 Upload the feature's discovery documents

**`kind` is a real decision, not filing.** The folder is what the pipeline
reads: the BA treats `Transcripts/` as the source of stories and `SOP/` as
context that is explicitly *not* stories.

```
$scyne upload /Users/you/docs/complaints-sop.docx sop
$scyne upload /Users/you/docs/workshop-2026-08-12.docx transcripts
$scyne upload /Users/you/docs/analyst-notes.md notes
$scyne upload /Users/you/screens/current-case-view.png ui
```

| `kind` | Holds |
|---|---|
| `sop` | SOPs, policy, procedure — context, not stories |
| `transcripts` | Workshop and interview transcripts — the primary source of stories |
| `notes` | Anything else written down |
| `ui` | Client-supplied screens. **Authoritative** for the UX Designer |

Omitting `kind` on a feature document risks `ambiguous_kind` — the router only
infers from the filename.

### 3.7 Requirements, then the rest

```
$scyne run requirements
```

Produces the 11-section Product Summary, `stories.json`, `stories.md`, `gaps.md`.
On approval it publishes the wiki page **and** creates one work item per story.

Everything after it needs that product summary:

```
$scyne run ui              # wireframes — deliberately before the data model
$scyne run datamodel       # Salesforce Service Cloud objects + Mermaid ERD
$scyne run architecture    # 18-section solution architecture
$scyne run qa              # test cases + traceability matrix
```

Each raises its own gate and publishes on approval.

### 3.8 The companion app

```
$scyne run app
```

One self-contained HTML page per project, assembling everything produced so far.
Project level — it covers every feature. Progressive: any single artefact is
enough.

### The order, in full

```
project   upload docs  →  (extraction runs itself)  →  capabilities → personas
feature   requirements → ui → datamodel → architecture → qa
project   app
```

`design` is an optional side stage overlapping `architecture`. Ask for it by
name; most features need only the architecture.

---

## 4 · Watching, approving, controlling

### What is waiting on me

```
$scyne issues
```

Every open issue, `needsHuman` first — true when parked at a gate, blocked, or
paused.

### Live status of one run

```
$scyne status SCY-41
```

State, current step, any pending gate with its id, and the recent activity
timeline. An agent run averages **twenty-five minutes**, so this is how you
watch it rather than waiting in silence.

For the transcript of what an agent actually did:

```
$scyne runs SCY-41          # agent, phase, duration, tokens, cost per run
$scyne log <runId>          # the tail of the transcript, capped
```

Or open the console at `http://127.0.0.1:3100/orch#runs`, which streams it live.

### Approving

```
$scyne status SCY-41        # read what the gate covers
$scyne gate approve g_8f21
```

**Approving publishes** — a wiki page a client will read, and a backlog in their
Azure DevOps project. The assistant will not approve on your behalf; it reports
what is waiting and waits for you.

Rejecting is **not** a decline — it rewinds to the generating step and
regenerates, costing another run:

```
$scyne gate reject g_8f21 "Personas 2 and 4 are the same person — merge them."
```

The note is all the agent is given. To leave feedback and re-fire without a
rewind:

```
$scyne changes <approvalId> "Section 7 should cite the AER determination."
```

### Stopping a run

| Verb | The agent in flight | Resumable |
|---|---|---|
| `$scyne pause SCY-41` | runs to completion, parks before the next step | yes |
| `$scyne pause SCY-41 --force` | killed now, that step's work is lost | yes — the step re-runs |
| `$scyne cancel SCY-41` | killed now | **no** |
| `$scyne resume SCY-41` | — | carries on from where it stopped |

None are instant: the engine honours the request at its next step boundary.

### Documents

```
$scyne docs                              # every document, both levels, with inDb
$scyne read documents/policy.md          # full text — SHORT notes only
$scyne replace documents/policy.md /Users/you/docs/policy-v2.pdf
$scyne rm documents/policy.md            # confirms first
```

A row with `inDb: false` is on disk and missing from the database — real, and
fixed with `npm run sync:docs -- --apply` at the repo root.

### Changing something already produced

```
$scyne revise datamodel "Add an SLA breach timestamp field to Case."
$scyne revise personas "Too generic — tie each one to evidence from the transcripts."
```

A **small diff**, not a regeneration: the agent gets its own previous output
plus your instruction verbatim, raises its own gate, and on approval updates the
existing wiki page rather than creating a second one.

```
$scyne republish datamodel   # re-publish an approved doc to the same page,
                             # for when publishing failed on a bad target
$scyne stale                 # artefacts that now predate their inputs
```

`stale` reports; it never triggers. A refresh is twenty-five minutes and real
money.

### Cost

```
$scyne spend --by project
$scyne spend --by feature       # also: user | agent | adapter | model
$scyne actions                  # who started, approved, paused or cancelled what
```

Both are admin-only upstream; a refusal is reported as a refusal, never as an
empty table.

---

## 5 · Reading a large document without running a stage

Separate from the pipeline. Ask a question of a 2 GB PDF without any of it
entering the conversation:

```
"Upload /Users/you/docs/contract.pdf and tell me what it says about termination."
```

Behind that: `upload_file` → `job_status` → `get_result` → `search_chunks` →
`fetch_chunks`. You get page-cited passages, never the whole document. Nothing
is filed into a project — use `$scyne upload` for that.

---

## 6 · When it goes wrong

| Symptom | Cause | Fix |
|---|---|---|
| `$scyne` not offered in Codex | Thread started before the stack came up, or the plugin is not installed | Start a new thread. `codex plugin list` should show `azure-file-processing@scyne  installed, enabled` — if it does not, or shows a stale version, §1 |
| `not_authenticated` | `SCYNE_ORCH_TOKEN` unset in the **workspace-root** `.env` | Set it, restart the workspace server |
| `cannot reach the orchestrator` / `the Scyne chatbot` | `npm run dev` is not running | Start it |
| `documents_not_ready` | Extraction is still running, or one document failed. It starts automatically on upload | `$scyne extracts`. Usually just wait. `$scyne run extract` only if a document arrived outside the upload routes |
| `no_documents` | Nothing uploaded, or only images/audio | `$scyne docs` to see what is actually there |
| `no_product_summary` | A feature stage before `requirements` | `$scyne run requirements` first |
| `ambiguous_kind` | Feature document whose filename matches no pattern | Pass `kind` |
| `unknown workflow <key>` | Not a stage this server offers | `$scyne stages` — the list is read live |
| `<stage> runs per feature` / `takes no feature` | Level mismatch | `$scyne stages` reports each one's level |
| Issue sits at `blocked` | A step failed; the blocking comment names it | Fix, then `$scyne resume <id>` |
| Issue sits at `todo`, nothing happens | Process died; orphan recovery returned it | `$scyne resume <id>` |
| Approving does nothing for a minute | Correct — the decision returns 202 and publishing runs in the background | `$scyne status <id>` |
| A `.docx` uploads but no stage reads it | Conversion failed | `cd scyne-chatbot && npm install` — `markitdown-ts` lives only there |
| Wiki publish 401 while everything else works | The PAT lacks the wiki scope. Azure DevOps answers a missing scope with 401, not 403 | `node scripts/ado-publish.mjs --verify` |

---

## What has and has not been proved

Verified end to end on this machine: the stack starting, a **2000-page / 6.5 MB
PDF** ingested through `$scyne upload` into a project (5.4 MB of markdown, filed,
DB row written, then searched back to page 1450), documents listed and deleted,
the stage catalogue read live from the server (26 stages), and every read-only
verb answering against live data.

**Not yet run end to end: a real agent stage.** Sections 3.3 through 3.8 are
written from the pipeline definition and the workflow compiler, not from a
completed run — each stage costs roughly twenty-five minutes and real money, and
that spend was deliberately left for you to authorise. Expect the shape to hold
and the timings to be approximate.
