---
name: scyne
description: The Scyne delivery pipeline and its large-document plane. Use when running or revising a pipeline stage (capability map, personas, requirements, UI mockups, data model, solution architecture, test cases, companion app), managing Scyne projects, features or documents, approving a gate, or reporting spend — AND whenever a document is too large to read directly, or you are asked to upload, process, search, summarise or extract text from a PDF, Word, PowerPoint, Excel, HTML or text file. Trigger on "/scyne", "scyne", "this PDF", "large file", "search this document", "what does the contract say", any file over a few hundred kilobytes, or any request to run/check/approve/revise something in the pipeline.
---

# /scyne

One skill over two MCP servers. They do different jobs and either runs without
the other.

| Server | Port | For |
|---|---|---|
| `scyne` | 8080 | **the file plane** — large documents in, page-cited passages out |
| `scyne-workspace` | 8081 | **the workspace plane** — projects, documents, pipeline stages, gates, spend |

Invoked as **`/scyne <verb>`**, via `commands/scyne.md`. Plain English works
just as well and reaches exactly the same tools — this skill also fires on its
own the moment somebody mentions a large PDF — so nothing below changes based on
which was used.

(The Codex build of this plugin used `$scyne`: Codex retired custom slash
commands in 0.117.0 in favour of skills. Claude Code has both, so this one has
both, and they load the same file.)

---

## The one rule that matters

**Never read a document yourself.** Do not open it, do not `cat` it, do not
pass it to another tool, do not summarise it from memory. A large document read
into the conversation is the exact failure this plugin exists to prevent: it
fills the context window, costs a fortune, and past a few tens of megabytes it
simply will not fit.

You will only ever see: counts and headings from `get_result`, short snippets
from `search_chunks`, and the handful of passages you explicitly ask
`fetch_chunks` for. Nothing else about a file's contents should reach you.

This holds no matter which verb you are serving. `upload`, `docs`, `read` and
every stage that consumes documents are all bound by it.

## Before anything works

The workspace plane is a front door to the Scyne stack, not a replacement for
it. For anything under *Stages*, *Gates* or *Projects*, both must be running:

```bash
npm run dev                     # repo root: orchestrator :3100, chatbot :4000
./scripts/stack.sh up           # this plugin: file plane :8080, workspace plane :8081
```

Every workspace tool needs **`SCYNE_ORCH_TOKEN`** in the workspace-root `.env` —
the same Bearer token the CLI uses. Without it every workspace call answers
`not_authenticated`. The file plane needs none of that; it only needs `:8080`:

```bash
curl -fsS http://127.0.0.1:8080/health
```

If tools are missing entirely, the stack is down **or this thread began before
it came up** — tools bind at thread start, so tell the user to start a new
thread rather than waiting.

There is deliberately no `/scyne login`. Credentials live in that one `.env`.

## Verbs

Dispatch on the first word. With no verb: report the pinned target if there is
one, then `stages` and `list_issues { open: true }`, and summarise what is
runnable and what is waiting on a person.

| Verb | Does |
|---|---|
| `use <project> [feature]` | Pin a target for this conversation. Validate against `list_projects` / `list_features`. |
| `stages` | Every workflow this server offers. Read live — never recite from memory. |
| `run <stage> [project] [feature]` | `start_stage`. Report the issue id and stop. |
| `status <issueId>` | `issue_status` — state, step, pending gate, recent activity. |
| `issues` | `list_issues { open: true }`. Lead with `needsHuman`. |
| `gate approve <gateId>` | `approve_gate`. **Never on the user's behalf.** |
| `gate reject <gateId> "<note>"` | `reject_gate`. The note is required. |
| `changes <approvalId> "<feedback>"` | `request_changes` — feedback onto the issue, agent re-fires. |
| `revise <artefact> "<instruction>"` | `revise_artefact`. A small diff, not a regeneration. |
| `republish <artefact>` | `republish_artefact` — same page, no new agent run. |
| `upload <path> [kind]` | `ingest_document`. **The default for any document.** |
| `docs` | `list_documents`. Report `inDb: false` rows. |
| `extracts` | `extract_status` — are the documents ready yet? Extraction is automatic; this asks if it has finished. |
| `retry extract [<path>]` | `retry_extraction` — for a document that FAILED, or one wedged at `extracting`. Not for one merely still running. |
| `read <path>` | `read_document`. Short notes only. |
| `rm <path>` | `delete_document`. **Confirm first.** |
| `stale` | `staleness`. Report; never trigger. |
| `spend [--by …]` | `spend`. Default `--by project`. |
| `runs <issueId>` \| `log <runId>` | `issue_runs` / `run_transcript`. |
| `actions` \| `history` | Audit feed; completed runs with their links. |
| `pause <issueId> [--force]` \| `resume` \| `cancel` | The three control verbs. |
| `new project <name>` \| `new feature <name>` | `create_project` / `create_feature`. |
| `describe <text>` | `save_project_definition`. Minimum 40 characters. |
| `brand <url>` | `extract_brand`. |

An unrecognised verb: say so and list these. Never guess at the nearest one —
`run` and `revise` both cost real money and are not interchangeable.

`use` writes no config file; hold the target in the conversation and apply it to
later verbs. An explicit project or feature on a call overrides it for that call.

---

## Getting a document in

**`upload` means `ingest_document`.** It streams the bytes to S3 as an 8 MiB
multipart upload, has a worker convert them to markdown *there*, and files only
the markdown into the project. A 2 GB PDF goes in without a byte of it entering the
conversation. Accepts PDF, Word, PowerPoint, Excel, HTML, CSV, RTF, EPUB, ODF
and plain text. Images and audio are refused deliberately — a markdown rendering
of a screenshot loses the point of the screenshot, and audio has a better path.

It blocks while the worker runs — seconds for a small document, minutes for a
very large one, so say that rather than going quiet. It returns counts, an
engine name and a path. **Never text.**

`attach_document` does the same job by reading the whole file into memory. Use
it only for something small with a reason to skip the worker; it fails on a
large file, which is the ceiling this plugin exists to remove.

Both convert on arrival and archive the source, so the filename reported back is
often not the one you passed — use the reported one. `ingest_document` archives
the original **in S3**, not in `original-files/`; `delete_job` disposes of it.

For a feature-level document pass `kind`: `sop`, `transcripts`, `notes` or `ui`.
The folder is what the pipeline reads — the BA treats `Transcripts/` as the
source of stories and `SOP/` as context that is explicitly *not* stories — so
it is a real decision, not filing. Ask if it is not obvious.

`list_documents` marks each row `inDb`. A row with `inDb: false` is on disk and
absent from the database: real, and fixed by `npm run sync:docs -- --apply`.
Report it rather than passing over it.

`replace_document` removes the old markdown AND its archived original first,
which is what stops the replacement landing beside it as `handling (1).md`.

**`delete_document` needs the person's word first.** It takes the file, its
archived original and its database row. A sentence typed at a prompt is not
consent to change what every later stage reads: say what you are about to
delete, and wait. Taking the archived original too is deliberate — leave it and
the next conversion pass puts the document straight back.

`read_document` returns one document's full text. Short notes only. Anything
substantial belongs on the file plane below, or you have just spent the context
window this whole plugin exists to protect.

## Reading a document without paying for it

The file plane, in order: `upload_file` → `job_status` → `get_result` →
`search_chunks` → `fetch_chunks` → `delete_job`. Search and fetch may repeat.

**1 · Upload.** One call, absolute path. The server opens the file, streams it
in blocks, records the SHA-256 of the bytes it actually sent, and queues it.

```
upload_file({ path: "/Users/you/Downloads/contract.pdf" })
→ { jobId, state: "queued", filename, bytes, sha256, started: true }
```

**Do not** run `shasum`, **do not** run `upload.mjs`, and **do not** read one
byte to "check" it first. The checksum is computed for you and verified on
download. If the user names a file without a path, resolve it with `ls`/`find`
— never by reading it. `start: false` uploads without queueing.

**2 · Poll.** `job_status({ jobId })`. `state` moves `queued → running →
succeeded`/`failed`; `phase` narrows `running` to `downloading` / `extracting` /
`converting` / `chunking` / `uploading`. Say what stage it is at rather than
going quiet for minutes.

**3 · Facts.** `get_result({ jobId })` — pages, words, chunks, language, up to
50 short headings, tables, and which engine rendered the markdown. Never passage
text. Headings are orientation, **not evidence**; use them to decide what to
search for, never to answer.

Every finished job also carries a **`document.md`** artifact: the whole document
as structured markdown. It is listed, not returned. Do not download it to read —
it exists so `ingest_document` can file it into a project, and so a format with
no page text (a deck, a spreadsheet) is still searchable.

**4 · Read only what you need.**

```
search_chunks({ jobId, query: "termination", topK: 5 })
→ hits: [{ chunkId, pageStart, pageEnd, snippet, score }]

fetch_chunks({ jobId, chunkIds: ["c-000412"] })
→ chunks: [{ chunkId, pageStart, pageEnd, text }]
```

Search first, fetch second — never fetch a chunk id you have not seen in a
search result. Ten ids per call, 32 KB of text per call.

**`truncated: true` means different things, and neither means "nothing
matched":** on `search_chunks` the scan hit its byte ceiling before the end of
the document, so a late section may never have been scanned — narrow the query
or say plainly that search did not reach the whole file. On `fetch_chunks` you
asked for more text than 32 KB allows and some chunks were left out — ask for
fewer.

**5 · Clean up only when asked.** `delete_job` permanently removes the upload
and every artifact. Never on your own initiative.

**Answering from a document:** search for the terms the question actually uses,
fetch the two or three best chunks, answer from those. Cite a **page range**,
not a page — a chunk routinely spans a boundary, so "page 37" is wrong when the
answer is "pages 37–38". If the snippets do not answer it, search again with
different terms; never fetch more and more chunks hoping to stumble on it.

**If `upload_file` is not in your tool list** it is deliberate: it exists only
where the server and the file share a machine. Fall back to
`create_upload_url` → `node scripts/upload.mjs <path> "<uploadUrl>"` → `start_job`,
taking the checksum from the shell with `shasum -a 256`. The URL is a presigned
PUT: write-only, scoped to one object key, and it expires in fifteen minutes.

A 403 on that URL is almost always one of two things, and neither is guessable
from the status code. Either it expired — mint another — or it was signed
against a different endpoint than the one being used, because SigV4 signs the
Host header and a rewritten URL is cryptographically invalid however correct it
looks. Never edit the host of a presigned URL.

---

## Which stages exist

**Ask the server; never assume.** `stages` returns every workflow this
orchestrator offers, with its level, read live from `GET /config`. `start_stage`
validates against the same list and refuses an unknown key by naming what the
server actually has.

Do not carry a list from a previous conversation. This plugin shipped one for a
while and it was already wrong: ten keys against the server's twenty-six,
refusing `extract` — a stage the pipeline had gained — while the engine ran it
fine.

## Running a stage

`start_stage` creates a tracked issue — the same issue the chatbot creates, so
it appears in the console, in Spend and in Actions. It returns immediately; an
agent run averages **twenty-five minutes and real money**.

So: report the issue id and stop. Do not poll `issue_status` on a timer, and
confirm the target back before starting if the user has not been specific —
`requirements` against the wrong feature is a wasted run and a wiki page naming
another client's work.

Project-level stages take no feature (`capabilities`, `personas`, `app`,
`baseline`); feature-level stages require one (`requirements`, `ui`,
`datamodel`, `architecture`, `qa`, `design`).

The order that works:

```
project   (extraction is automatic on upload) → capabilities → personas
feature   requirements → ui → datamodel → architecture → qa
project   app
```

**`extract` is not a step you run.** All three upload routes start it the moment
a document lands — detached, fire-and-forget — so by the time `upload` returns
the extraction is already under way. One agent runs per document, which is what
stops the capability map ever reading the whole corpus at once.

`capabilities` hard-requires every document to be ready and refuses with
`documents_not_ready` until they are. **That refusal usually means wait, not
re-run** — check with `extract_status`, and only `run extract` when a document
arrived by some route other than an upload (copied into the tree,
`npm run convert`) or a spawn genuinely failed. It is idempotent, so a re-run
costs nothing but the gate it raises. `no_documents` is the separate refusal
that really does mean "upload something".

**Two of those states never resolve on their own, and `retry_extraction` is the
way out of both.** A document at `failed` has nothing working on it — telling
somebody to wait is telling them to wait forever. One at `extracting` is
normally a live pass and worth waiting for, but it looks identical to a claim
whose owner was killed. So: `extract_status` first, and read the fields. It
names the document, the reason, and — on a failure — `attempts`, which is the
one that matters: a document that has failed four times with the same reason is
a scanned PDF with no text layer, and the answer is to replace or remove it
rather than pay for a fifth run. `retry_extraction` takes a single `doc` so one
bad document does not cost a re-run of the other nineteen.

`personas` then requires the capability map.

At feature level everything except `requirements` needs that feature's product
summary, so `requirements` comes first. `design` is an optional side stage that
overlaps `architecture`; run it only when asked for by name.

## Gates

Each stage parks at a human approval gate, and the stages that publish do so
after it. `issue_status` reports the pending gate.

**Never approve on the person's behalf.** Approving publishes — a wiki page a
client will read, a backlog in their Azure DevOps project. Report what is
waiting and what it would publish; the decision is theirs. `/scyne gate approve
<id>` typed by the user IS that decision; "looks good" in passing is not.

`reject_gate` is not a decline: it REWINDS to the generating step and
regenerates, costing another run. Say so first. A note is required — it is all
the agent gets. `request_changes` sits between the two and leaves a record of
why.

## Changing what a stage produced

`revise_artefact` is what makes this more than a launcher. "Add an SLA breach
field to the data model", "reword story 2.4.1.3", "the personas are too
generic" — it hands the owning agent its own previous output plus the
instruction verbatim and asks for a **small diff**. It raises its own gate, and
on approval UPDATES the existing wiki page rather than creating a second one.

Keep the instruction specific: it is all the agent has, and a
regenerate-from-scratch produces a diff too large for a reviewer to check, which
defeats the gate that follows.

`republish_artefact` re-publishes an approved document to the same page — for
when a publish failed on a bad target and the document itself is fine. Far
cheaper than re-running the stage.

`staleness` reports artefacts generated before one of their inputs last changed.
Nothing regenerates on its own: say what is stale and let the person decide. A
refresh is twenty-five minutes and real money, and it over-reports deliberately.

## Tracking and control

`list_issues` is the roster — narrow by `project`, `feature`, `status` or `open`.
Every row carries `needsHuman`, true when parked at a gate, blocked or paused.
`issue_runs` gives agent, duration, tokens and cost per run; two rows a second
apart mean an automatic retry, not two mysterious runs. `run_transcript` returns
the TAIL of what an agent did, capped — a twenty-five-minute run produces
megabytes of events.

`spend` groups cost by `project | feature | user | agent | adapter | model`. It
is admin-only upstream, and a refusal is reported as a refusal, never quietly
shown as "no spend". Same for `actions`.

`pause_issue` lets the step in flight finish (`force: true` stops the agent NOW,
losing that step's work); `resume_issue` carries on from where it stopped;
`cancel_issue` ends it for good — it does not resume and is never retried, and
any pending gate is cancelled with it. None are instant: the engine honours the
request at its next step boundary.

## Creating things

`create_project` writes the folder tree, the database row, the Azure DevOps
project and the branding in one call. Two results always worth repeating back:

- **`slugged`** — a project name cannot contain spaces, so `SA Power Networks`
  becomes `SA-Power-Networks`. Say which name was actually used.
- **`dbError` / `adoError`** — either can fail while the project is still
  usable. A `dbError` means everything that resolves the project by name stays
  empty until it is fixed; never report a clean creation when one is present.

`create_feature` takes a name that MAY contain spaces. Reserved names are
refused with the reason.

## Reporting back

Terse. The issue id, the state, and the one thing the user has to do next. The
timeline is in the console and in `status` — do not paste it back wholesale.

## What this does not do

It does not reduce what a stage costs. The agent still reads every staged
document, so a capability-map run over 92 documents costs roughly the same
whether it started from Claude Code, the chatbot or the CLI. What this buys is one
durable home for the workspace and one place every run is tracked.

## When it goes wrong

| What you see | What it means |
|---|---|
| `not_authenticated` | `SCYNE_ORCH_TOKEN` is unset in the workspace-root `.env`. File-plane tools are unaffected. |
| `cannot reach the orchestrator` / `the Scyne chatbot` | The stack is down. `npm run dev` at the repo root. |
| No tools at all | Stack down, or this thread began before it came up. Tools bind at thread start — start a new thread. |
| `unknown workflow <key>` | The server does not offer it. The message names what it does; do not argue from memory. |
| `<stage> runs per feature` / `takes no feature` | Level mismatch. `stages` reports each one's level. |
| `path must be absolute` | A relative path would resolve against the SERVER's cwd, not the user's. Resolve it first. |
| `no such file` / `not a regular file` / `file is empty` | Check with `ls`. An empty file would process into a document that appears to say nothing — say it is empty instead. |
| `ambiguous_kind` | The name matches neither the SOP nor the transcript pattern. Pass `kind`. |
| `unsupported extension` | Not a convertible format. A scanned PDF with no text layer uploads and processes but yields almost no text — say so rather than guessing what it "must" say. |
| `file too large` | Over `MAX_UPLOAD_BYTES` (5 GiB default, which is also S3's own single-object PUT ceiling). |
| `upload failed after N of M bytes` | The stream broke part-way; the job is `failed` with the reason. Call `upload_file` again. |
| `checksum_mismatch` / `size mismatch` | The upload was incomplete or the file changed mid-read. Upload again. |
| `job <id> is not ready: state is <state>` | Called before `succeeded`. Poll `job_status`. |
| `job <id> produced no document.md` | Processed by a worker predating markdown rendering. Re-upload. |
| `unknown job <id>` | Wrong id, or the stack was reset. Start from `upload_file`. |
| `state: "failed"` with `error` | Read it verbatim and report it. A file that keeps failing is dead-lettered rather than retried forever. |
| Presigned URL 403 | Fallback path only. It expired (fifteen minutes), or its host was edited — SigV4 signs the Host header, so a rewritten URL cannot verify. Mint another; never edit one. |
