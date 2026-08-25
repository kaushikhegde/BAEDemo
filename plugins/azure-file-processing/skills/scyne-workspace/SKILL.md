---
name: scyne-workspace
description: Use when running Scyne pipeline stages (capability map, personas, requirements, UI mockups, data model, architecture, test cases, companion app) or managing Scyne projects, features and documents from Codex.
---

# Scyne workspace

Two MCP servers ship in this plugin and they do different jobs.

| Server | Port | For |
|---|---|---|
| `scyne` | 8080 | large files: upload, extract, chunk, search — the FILE plane |
| `scyne-workspace` | 8081 | projects, features, documents, and running pipeline stages |

This skill is the second one.

## Before anything works

The workspace server is a front door to the Scyne stack, not a replacement for
it. Both must be running:

```bash
npm run dev                                   # repo root: orchestrator :3100, chatbot :4000
./scripts/stack.sh up                         # this plugin: workspace server :8081
```

Every workspace tool needs **`SCYNE_ORCH_TOKEN`** in the root `.env` — the same
Bearer token the CLI uses. Without it every call answers `not_authenticated`.
Nothing in the file plane needs it.

## Running a stage

`start_stage` creates a tracked issue — the same issue the chatbot creates, so
it appears in the console, in Spend and in Actions. It returns immediately with
an id; an agent run averages twenty-five minutes.

```
start_stage { workflow: "capabilities", project: "SAPN" }
→ { issueId: "SCY-12", state: "todo" }

issue_status { issueId: "SCY-12" }
→ { status: "in_review", gate: { id: "…" }, comments: [ … ] }
```

Project-level stages take no feature: `capabilities`, `personas`, `app`,
`baseline`. Feature-level stages require one: `requirements`, `ui`, `datamodel`,
`architecture`, `qa`, `design`.

The order that works: `capabilities` → `personas` (project), then per feature
`requirements` → `ui` → `datamodel` → `architecture` → `qa`, then `app` to
assemble the companion page. Every stage except `capabilities`, `personas` and
`app` needs that feature's product summary, so `requirements` comes first.

## Approving

Each stage parks at a human approval gate, and the stages that publish do so
after it. `issue_status` reports the pending gate; `approve_gate` releases it and
`reject_gate` rewinds to the generating step and regenerates — **a note is
required**, because that note is what the agent is given to fix.

Never approve on the person's behalf. Report what is waiting and what the gate
covers; the decision is theirs.

## Tracking and controlling a run

`list_issues` is the roster — narrow it with `project`, `feature`, `status` or
`open` (todo/in_progress/in_review/blocked/paused). Every row carries
`needsHuman`, true when it is parked at a gate, blocked, or paused. `spend`
groups token and dollar cost by `project | feature | user | agent | adapter |
model` — it is admin-only upstream, and a refusal is reported as a refusal,
never quietly shown as "no spend".

`pause_issue` lets the step in flight finish first (`force: true` stops the
agent NOW, losing that step's work); `resume_issue` carries on from wherever it
stopped. Neither is instant — the engine honours the request at its next step
boundary.

## Creating things

`create_project` writes the folder tree, the database row, the Azure DevOps
project and the branding in one call. Two results always worth repeating back:

- **`slugged`** — a project name cannot contain spaces, so `SA Power Networks`
  becomes `SA-Power-Networks`. Say which name was actually used.
- **`dbError` / `adoError`** — either can fail while the project is still
  usable. A `dbError` means everything that resolves the project by name stays
  empty until it is fixed; do not report a clean creation when one is present.

`create_feature` takes a name that MAY contain spaces. Reserved names are
refused with the reason.

## Documents

**`ingest_document` is the one to reach for.** It takes a local path, streams the
bytes to Azure in 8 MiB blocks, has a worker convert them to markdown *there*,
and files only the markdown into the project. A 2 GB PDF goes in without a byte
of it entering the conversation. It accepts PDF, Word, PowerPoint, Excel, HTML,
CSV, RTF, EPUB and plain text.

It blocks while the worker runs — seconds for a small document, minutes for a
very large one — and returns counts, an engine name and a path. **Never text.**
If you want to know what the document SAYS, that is `search_chunks` on the file
plane, not this.

`attach_document` does the same job by reading the whole file into memory and
posting it. Use it only for something small when you have a reason to skip the
worker; it will fail on a large file, which is the ceiling this plugin exists to
remove.

Both convert on arrival and archive the source, so the filename reported back is
frequently not the one you passed — use the reported one. `ingest_document`
archives the original **in Azure**, not in `original-files/`; `delete_job`
disposes of it.

For a feature-level document pass `kind`: `sop`, `transcripts`, `notes` or `ui`.
The folder is what the pipeline reads — the BA treats `Transcripts/` as the
source of stories and `SOP/` as context that is explicitly not stories — so
choosing it is a real decision, not a filing convenience.

`list_projects` and `list_features` are the live tree, read from the chatbot —
use them before guessing a name. `list_documents` marks each row `inDb`. A row
with `inDb: false` is on disk and absent from the database: real, and fixed by
`npm run sync:docs -- --apply`. Report it rather than passing over it.

`replace_document` swaps one for a new local file — it removes the old markdown
AND its archived original first, which is what stops the replacement landing
beside it as `handling (1).md`.

**`delete_document` needs the person's word first.** It takes the file, its
archived original and its database row. A sentence typed at a prompt is not
consent to change what every later stage reads: say what you are about to
delete, and wait. Taking the archived original too is deliberate — leave it and
the next conversion pass puts the document straight back.

`read_document` returns one document's full text. For short notes only. Anything
substantial belongs on the file plane, or you have just spent the context window
this plugin exists to protect.

## Changing what a stage produced

`revise_artefact` is the one that makes this more than a launcher. "Add an SLA
breach field to the data model", "reword story 2.4.1.3", "the personas are too
generic" — it hands the owning agent its own previous output plus your
instruction verbatim and asks for a **small diff**, not a regeneration. It
raises its own gate, and on approval it UPDATES the existing wiki page instead
of creating a second one.

Keep the instruction specific. The agent is given nothing else to work from, and
a regenerate-from-scratch produces a diff too large for a reviewer to check —
which defeats the gate that follows it.

`republish_artefact` re-publishes an approved document to the same page, for
when a publish failed on a bad target and the document itself is fine. Far
cheaper than re-running the stage.

`staleness` reports artefacts generated before one of their inputs last changed.
Nothing regenerates on its own — say what is stale and let the person decide. A
refresh is twenty-five minutes and real money, and it over-reports deliberately.

## What this does not do

It does not reduce what a stage costs. The agent still reads every staged
document, so a capability-map run over 92 documents is roughly the same number
of tokens whether it was started from Codex, the chatbot or the CLI. What this
buys is one durable home for the workspace and one place every run is tracked.

For reading a large file WITHOUT paying for it in context, that is the other
server: `search_chunks` and `fetch_chunks` under `scyne`.
