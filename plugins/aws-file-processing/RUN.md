# Running the Scyne pipeline from Claude Code

The end-to-end path, in the order you would actually do it. Everything below is
typed into Claude Code; `/scyne <verb>` and plain English reach exactly the same
tools.

For what the plugin IS, its environment and its AWS mapping, see
[README.md](./README.md).

## 1 · Install the plugin

```
/plugin marketplace add .
/plugin install aws-file-processing@scyne
```

Then start a **new session**. MCP tools and skills bind at session start, so a
plugin installed mid-session provides nothing until you restart. If tools are
missing entirely, that — not a broken stack — is nearly always why.

### Removing it

```
/plugin uninstall aws-file-processing
```

The buckets, the queue and the table survive; `./scripts/stack.sh down` drops
the LocalStack volume with them.

## 2 · Start everything

```bash
# Terminal 1 — repo root. Orchestrator :3100 and chatbot :4000.
npm run dev

# Terminal 2 — this plugin. LocalStack + workers in Docker,
# file plane :8080 and workspace plane :8081 natively.
cd plugins/aws-file-processing && ./scripts/stack.sh up
```

Four health checks, and all four have to answer:

```bash
for u in http://127.0.0.1:8080/health \
         http://127.0.0.1:8081/health \
         http://127.0.0.1:3100/health \
         http://127.0.0.1:4000/api/features; do
  printf '%s ' "$(curl -s -o /dev/null -w '%{http_code}' "$u")"
done; echo
# want: 200 200 200 200
```

`SCYNE_ORCH_TOKEN` must be in the **workspace-root** `.env` — the same Bearer
token the `scyne` CLI uses. Without it every workspace tool answers
`not_authenticated` while the file plane goes on working perfectly, which is a
confusing pair of symptoms to see together.

### Stopping

```bash
./scripts/stack.sh down    # containers, volumes, both native servers
```

## 3 · The whole flow

`/scyne use <project> [feature]` pins a target for the conversation. It writes
no config file — the target is held in the conversation, and an explicit project
or feature on any later call overrides it for that call.

### 3.1 Create the project

```
/scyne new project SA Power Networks
```

Two things in the answer are always worth reading back:

- **`slugged`** — a project name cannot contain spaces, so `SA Power Networks`
  is created as `SA-Power-Networks`. That name is also the Azure DevOps project,
  the wiki path segment and the `--project` argument on every verb.
- **`publishingReady: false`** — the project is real and usable (documents,
  stages and gates all work) but has no Azure DevOps target, so nothing will be
  published. Calling `new project` again with the same exact name finishes
  setting it up rather than refusing.

Then, in the client's own words and at least 40 characters:

```
/scyne describe <who the client is, what they are regulated to do, who their customers are>
```

Every skill reads this before any discovery document. A project without one
produces documents written in nobody's terms.

### 3.2 Upload the project's client-wide documents

```
/scyne upload /Users/you/Downloads/Regulatory-Framework.pdf
```

`upload` means `ingest_document`: the bytes stream to S3 as an 8 MiB multipart
upload, a worker converts them to markdown **there**, and only the markdown is
filed into `projects/<project>/documents/`. A 2 GB PDF goes in without a byte of
it entering the conversation.

It blocks while the worker runs — seconds for a note, minutes for something very
large. The reported filename is often not the one you passed: the route converts
on arrival and archives the source, so use the name it gives back.

### 3.3 Wait for extraction, then the capability map

Extraction starts **by itself** the moment a document lands. There is no step to
run.

```
/scyne extracts
```

`capabilities` hard-requires every document to be ready and refuses with
`documents_not_ready` until they are. That usually means **wait**, not re-run.

Two states never resolve on their own, and `retry extract` is the way out of
both: a document at `failed` has nothing working on it, and one wedged at
`extracting` is normally a live pass but looks identical to a claim whose owner
was killed. Read `attempts` — four failures with one reason is a scanned PDF
with no text layer, and the answer is to replace or remove the document rather
than pay for a fifth run.

```
/scyne retry extract documents/Regulatory-Framework.md
/scyne run capabilities
```

### 3.4 Personas

```
/scyne run personas
```

Requires the capability map: journey stages align to its L1 lifecycle phases.

### 3.5 Create a feature

```
/scyne new feature CRM Management
```

Feature names MAY contain spaces. Reserved names (`capabilities`, `personas`,
`app`, `all`, `baseline`, `solutions`, `documents`, `design`, `original-files`,
`outputs`) are refused with the reason.

### 3.6 Upload the feature's discovery documents

```
/scyne use SA-Power-Networks "CRM Management"
/scyne upload /Users/you/Downloads/Workshop-Transcript.docx transcripts
```

The `kind` — `sop`, `transcripts`, `notes` or `ui` — is a real decision, not
filing. The BA treats `Transcripts/` as the source of stories and `SOP/` as
context that is explicitly *not* stories, and the UX Designer treats
`requirements/UI/` as authoritative. Ask if it is not obvious.

Omitting it on a name that matches neither the SOP nor the transcript pattern
gets you `ambiguous_kind`, which is the refusal telling you to pass one.

### 3.7 Requirements, then the rest

```
/scyne run requirements
```

Everything else at feature level needs that feature's product summary, so
`requirements` comes first. Then:

```
/scyne run ui
/scyne run datamodel
/scyne run architecture
/scyne run qa
```

`design` is an optional side stage overlapping `architecture`; run it only when
asked for by name.

### 3.8 The companion app

```
/scyne run app
```

Project level, no feature — one page per project, covering every feature.

### The order, in full

```
project   new project → describe → upload → (extraction is automatic) → capabilities → personas
feature   new feature → upload → requirements → ui → datamodel → architecture → qa
project   app
```

**Never recite that list from memory in a new conversation.** `/scyne stages`
reads it live from the orchestrator's `GET /config`. This plugin shipped a
hard-coded list of ten once and it was already wrong against the server's
twenty-six.

## 4 · Watching, approving, controlling

### What is waiting on me

```
/scyne issues
```

Every row carries `needsHuman` — true when it is parked at a gate, blocked or
paused.

### Live status of one run

```
/scyne status SCY-41
```

State, current step, any pending gate, and the recent activity timeline the
engine narrates itself. An agent run averages **twenty-five minutes and real
money**, so start a stage, report the issue id, and stop — do not poll on a
timer.

### Approving

```
/scyne gate approve g_8f21
```

**Never on the person's behalf.** Approving publishes: a wiki page a client will
read, a backlog in their Azure DevOps project. Report what is waiting and what
it would publish; the decision is theirs. Typing that command IS the decision;
"looks good" in passing is not.

```
/scyne gate reject g_8f21 "the personas conflate two roles"
/scyne changes a_44f1 "story 2.4.1.3 should name the Eligibility Officer"
```

`reject` is not a decline — it REWINDS to the generating step and regenerates,
costing another run. The note is all the agent gets. `changes` sits between the
two and leaves a record of why.

### Stopping a run

```
/scyne pause SCY-41            # the step in flight finishes first
/scyne pause SCY-41 --force    # stop the agent NOW, losing that step's work
/scyne resume SCY-41
/scyne cancel SCY-41           # for good — does not resume, is never retried
```

None are instant: the engine honours the request at its next step boundary.

### Documents

```
/scyne docs
/scyne read documents/handling.md
/scyne rm documents/handling.md
```

`docs` marks each row `inDb` — a row with `inDb: false` is on disk and absent
from the database, which is real and worth reporting rather than passing over.

`rm` needs the person's word first. It takes the file, its archived original and
its database row; leaving the archived original behind would let the next
conversion pass put the document straight back.

### Changing something already produced

```
/scyne revise datamodel "add an SLA breach field to Case"
/scyne republish datamodel
/scyne stale
```

`revise` hands the owning agent its own previous output plus your instruction
verbatim and asks for a **small diff**. It raises its own gate, and on approval
UPDATES the existing wiki page rather than creating a second one.

`republish` re-publishes an approved document to the same page — for when a
publish failed on a bad target and the document itself is fine. Far cheaper than
re-running the stage.

`stale` reports artefacts generated before one of their inputs last changed.
Nothing regenerates on its own; a refresh is twenty-five minutes and real money,
and it over-reports deliberately.

### Cost

```
/scyne spend --by project
/scyne runs SCY-41
/scyne log run_9c22
```

`spend` is admin-only upstream, and a refusal comes back as a refusal rather
than quietly as "no spend". `runs` gives agent, duration, tokens and cost per
run — two rows a second apart mean an automatic retry, not two mysterious runs.
`log` returns the TAIL of a transcript, capped.

## 5 · Reading a large document without running a stage

The file plane on its own, with no Scyne stack at all:

```
upload_file({ path: "/Users/you/Downloads/contract.pdf" })
job_status({ jobId })
get_result({ jobId })
search_chunks({ jobId, query: "termination", topK: 5 })
fetch_chunks({ jobId, chunkIds: ["c-000412"] })
```

Search first, fetch second — never fetch a chunk id you have not seen in a
search result. Cite a **page range**, not a page: a chunk routinely spans a
boundary, so "page 37" is wrong when the answer is "pages 37–38".

Do not run `shasum`, do not run `upload.mjs`, and do not read one byte to
"check" the file first. The checksum is computed inside the upload stream and
verified on download.

## 6 · When it goes wrong

| What you see | What it means |
|---|---|
| No `/scyne` and no tools | The plugin was installed mid-session, or the stack is down. Start a new session; check the four health URLs |
| `not_authenticated` | `SCYNE_ORCH_TOKEN` is unset in the **workspace-root** `.env`. File-plane tools are unaffected |
| `Scyne could not complete that request… reference <hex>` | Something only an operator can fix. The cause is in the server log against that reference |
| `unknown workflow <key>` | The server does not offer it. The message names what it does — do not argue from memory |
| `<stage> runs per feature` / `takes no feature` | Level mismatch. `/scyne stages` reports each one's level |
| `documents_not_ready` | Documents exist but have not finished extracting. `/scyne extracts` |
| `no_documents` | The separate refusal that really does mean "upload something" |
| `path must be absolute` | A relative path would resolve against the SERVER's cwd. Resolve it first |
| `ambiguous_kind` | The name matches neither the SOP nor the transcript pattern. Pass `sop`/`transcripts`/`notes`/`ui` |
| `unsupported extension` | Not a convertible format. Images and audio are refused deliberately |
| `file too large` | Over `MAX_UPLOAD_BYTES` — 5 GiB, which is also S3's own single-object PUT ceiling |
| 403 on a presigned URL | It expired (fifteen minutes), **or its host was edited**. SigV4 signs the Host header, so a rewritten URL cannot verify however correct it looks. Mint another; never edit one |
| `checksum_mismatch` / `size mismatch` | The upload was incomplete or the file changed mid-read. Upload again |
| `job … is not ready: state is <state>` | Called before `succeeded`. Poll `job_status` |
| `job … produced no document.md` | Processed by a worker predating markdown rendering. Re-upload |
| `unknown job <id>` | Wrong id, or the stack was reset. Start from `upload_file` |
| `NoSuchBucket` | The buckets have never been created on this endpoint. Restarting either server runs `ensureStorage`, which creates them |
| `Could not load credentials from any providers` | `AWS_ENDPOINT_URL` is unset and no credential is resolvable. Either point at LocalStack or configure a profile/role |
| `InvalidLocationConstraint` on first boot | A region mismatch at bucket creation. `us-east-1` is the one region where a `LocationConstraint` is rejected rather than required |
