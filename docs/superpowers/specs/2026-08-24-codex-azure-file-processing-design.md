# Codex Plugin + MCP: Azure-Only Large-File Processing

**Date:** 2026-08-24
**Status:** Design approved, ready for implementation planning
**Branch:** `plugin`

---

## 1. The problem

A model reading a large document puts the whole document in its context. A 2GB
PDF simply will not fit; a 50MB one crowds out everything else and costs real
money. Every downstream consequence of that — truncated inputs, hallucinated
citations, runs that die halfway — traces back to the same root cause.

The fix is that **the model never touches the file**. It handles only a
reference: an identifier saying where the bytes live. Bytes travel from the
user's machine directly into blob storage and are read only by server-side
workers. What comes back to the model is a compact JSON summary, plus the
ability to pull back the handful of paragraphs that actually matter.

This document specifies that system: a **Codex plugin** carrying a skill and two
MCP servers, an **MCP orchestrator**, and a **worker pool**, running entirely
locally against Azurite first, designed so the move to real Azure is a change of
configuration and two component swaps rather than a rewrite.

---

## 2. Goals and non-goals

### Goals

- A Codex plugin a colleague or the client installs with two commands and runs
  with a third.
- Upload of files up to 5 GiB with **zero bytes** passing through the model or
  through an MCP tool call.
- Processing of PDF, DOCX, TXT and MD into chunked, page-mapped artifacts, in
  **bounded memory regardless of file size**.
- A model that can answer questions about a 2GB document while only ever seeing
  a few kilobytes of it.
- A worker pool that genuinely scales (`--scale worker=N`), retries, and
  dead-letters.
- Every acceptance claim proven by an assertion in a test, not by narration.

### Non-goals for v1

Named explicitly so nobody has to guess whether their absence is an oversight:

- **OCR** of scanned PDFs. Text-layer extraction only. OCR is a different
  problem (tesseract in the worker image, per-page image rendering, a
  confidence model) and would double the build.
- **AI-written summaries.** `result.json` holds computed facts only. There is no
  LLM anywhere in the stack, therefore no API key, no per-job cost and no
  non-determinism in the output tests assert against.
- **Embeddings or vector search.** `search_chunks` is a keyword scan in v1.
- **Deployment to real Azure**, Entra ID auth, private endpoints, or Managed
  Identity. Section 12 records the exact deltas so this stays true rather than
  becoming a surprise.
- **Multi-tenancy.** One local stack, one user.

---

## 3. Decisions taken

Every one of these was an explicit choice, recorded so a later reader does not
reopen a settled question.

| # | Decision | Why, and what it rules out |
|---|---|---|
| 1 | v1 is **plumbing only** — extract and chunk. | The existing requirement-generator (`scripts/pipeline.mjs`, `skills/`) is a separate product and is not touched. |
| 2 | Upload is **SAS URL + direct PUT** from the user's machine. | The brief's dev-only `upload_file({base64})` cannot work: an MCP tool call is written *by the model*, so a 50MB file becomes ~17M tokens of base64 — the exact failure the project exists to prevent. |
| 3 | Two extra tools: **`search_chunks` + `fetch_chunks`**. | With only the brief's five tools, Codex receives blob URIs it has no way to read (the Codex shell sandbox blocks outbound network; see `MCP-CODEX.md`). It would build a machine that reads documents and can never say what is in them. |
| 4 | `result.json` holds **computed facts only**. | No LLM in the worker: no key, no cost, deterministic output that tests can assert exactly. |
| 5 | **Two services** (orchestrator + worker) over an **Azurite Queue**, state in an **Azurite Table**. | The only shape where `--scale worker=3` demonstrates a real pool, and every piece maps 1:1 to prod (Queue→Service Bus, Table→Table Storage). |
| 6 | MCP transport is **streamable HTTP**, `.mcp.json` pointing at `http://127.0.0.1:8080/mcp`. | Identical wiring to prod, where the same field points at the Azure ingress. Verified against shipped plugins (`linear`, `github`, `notion`) which use `{"type":"http","url":…}`. |
| 7 | Code lives in **this repo**, entirely inside the plugin folder, with a **repo-rooted marketplace**. | A Codex marketplace is a git repo, so the same folder publishes from this repo today and from a dedicated repo later with no restructuring. |
| 8 | **Two MCP servers**, one plugin. Server 1 = files, server 2 = workspace. | Server 2 reads the *same blob storage* directly rather than proxying through server 1 over MCP. MCP is a protocol for models to call tools; server-to-server it is only a slow hop. |
| 9 | **Codex does the thinking**; MCP 2 is a workspace, not an agent runner. | A skill is instructions loaded into a model, not a program a server can execute. Running skills in the user's own Codex session means no model credentials and no per-job spend on our side. |

---

## 4. Architecture

Two planes. The control plane never sees file bytes; the data plane never talks
to Codex.

```
┌─ Codex CLI + plugin ────────────────────────────────────────────┐
│  skills (in-context)  ·  tools from BOTH MCP servers            │
└──────┬───────────────────────────────────────┬──────────────────┘
       │ MCP / HTTP                            │ MCP / HTTP
┌──────▼──────────────────┐         ┌──────────▼──────────────────┐
│  MCP 1 · FILE PLANE     │         │  MCP 2 · WORKSPACE PLANE    │
│  :8080/mcp              │         │  :8081/mcp    (phase 2)     │
│  upload · job · search  │         │  projects · features ·      │
│  · fetch · delete       │         │  documents · artefacts ·    │
│                         │         │  publish                    │
└──────┬──────────────────┘         └──────────┬──────────────────┘
       │ enqueue / job state                   │ read + write
┌──────▼───────────────────────────────────────▼──────────────────┐
│  Azurite:  blob (uploads · artifacts · workspace)               │
│            queue (job-queue · job-queue-poison)                 │
│            table (jobs)                                         │
└──────┬───────────────────────────────────────────────────────────┘
       │ dequeue · read upload · write artifacts
┌──────▼──────────────────┐
│  worker × N             │
│  (no ingress at all)    │
└─────────────────────────┘

        the user's file:  laptop ──PUT(SAS)──► uploads/   (never via Codex)
```

The orchestrator holds job rows and blob paths and nothing else. That
separation is the product.

---

## 5. Distribution and packaging

### Layout

Everything sits inside the plugin folder, so publishing is a copy rather than a
restructure.

```
requirement-generator/
  .agents/plugins/marketplace.json           repo marketplace, git-tracked
  plugins/azure-file-processing/
    .codex-plugin/plugin.json                validated by Codex's validate_plugin.py
    .mcp.json                                declares MCP 1 (MCP 2 added in phase 2)
    skills/azure-file-processing/SKILL.md    tool sequence + "never paste file contents"
    scripts/stack.sh                         up | down | status | logs
    scripts/upload.mjs                       SAS PUT, block-staged above 64MB
    services/orchestrator/                   Node/TS, MCP over streamable HTTP
    services/worker/                         Node/TS, queue consumer
    docker-compose.yml
    README.md
```

### `.mcp.json`

Shape verified against shipped first-party plugins. Server 2's entry is added in
phase 2; phase 1 ships server 1 alone.

```json
{
  "mcpServers": {
    "azure-files": { "type": "http", "url": "http://127.0.0.1:8080/mcp" }
  }
}
```

### Install, for anyone

```bash
codex plugin marketplace add <git-url-or-local-path>
codex plugin add azure-file-processing@scyne
cd <plugin-path> && ./scripts/stack.sh up
```

`stack.sh up` brings up Azurite, the orchestrator and two workers, waits for
`/health`, creates the containers, queues and table if absent, and prints the
MCP URL. `stack.sh status` reports health, queue depth and worker count.

### Iterating during development

Codex caches installed plugins, so an edit is not picked up until the manifest
version changes. The supported loop, from Codex's own `plugin-creator` skill:

```bash
python3 ~/.codex/skills/.system/plugin-creator/scripts/update_plugin_cachebuster.py \
  plugins/azure-file-processing
codex plugin add azure-file-processing@scyne
# then start a NEW Codex thread — tools and skills are bound at thread start
```

The manifest is validated before every hand-off:

```bash
python3 ~/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py \
  plugins/azure-file-processing
```

### If the stack is not running

The MCP server will not connect and its tools will not register. The skill
handles this explicitly: it instructs Codex to check `GET /health` before the
first tool call and, on failure, to tell the user to run `./scripts/stack.sh up`
and start a new thread. Silence is not an acceptable failure mode for a
first-time installer.

---

## 6. MCP 1 — the file plane

Seven tools. Names and payloads are the contract; the skill depends on them.

### 6.1 `create_upload_url`

```
in   { filename, sizeBytes, contentType?, sha256? }
out  { jobId, uploadUrl, blobPath, container, expiresAt, maxSinglePutBytes }
```

Mints the `jobId` up front so the blob lands at `uploads/<jobId>/<filename>` and
every later call takes only that id — Codex never carries a container/path pair.

Returns a **service SAS scoped to that one blob**, permissions `c` (create) and
`w` (write) only, TTL 900 seconds. It cannot read, cannot list, and cannot write
any other blob name.

Refuses: a filename containing a path separator or `..`; `sizeBytes` above
`MAX_UPLOAD_BYTES` (default 5 GiB); an extension outside `.pdf .docx .txt .md`.
Records the job row with state `awaiting_upload`.

### 6.2 `start_job`

```
in   { jobId, pipeline: { id: "extract-chunks", params?: {...} } }
out  { jobId, state, queuedAt }
```

`params` accepts `chunkChars` (default 4000), `overlapChars` (default 200) and
`pageWindow` (default 25).

Verifies the blob exists and that its committed size matches what was declared
at upload time. Enqueues `{ jobId }` — the message carries nothing else — and
moves the row to `queued`.

**The orchestrator does not verify `sha256` here.** Hashing means reading every
byte, and §4 makes the control plane a place bytes never reach. The worker
computes the digest as it streams the download (§8.1 step 1) and fails the job
with `checksum_mismatch` if it disagrees. Integrity is still checked; it is
checked by the component that is already holding the bytes.

**Idempotent.** Calling it on a job already queued or running returns the current
state rather than enqueueing a second message. A model that retries on a slow
response must not be able to double-process a 2GB file.

### 6.3 `job_status`

```
in   { jobId }
out  { jobId, state, phase, progress: { done, total, unit }, attempts,
       createdAt, startedAt?, finishedAt?, error? }
```

States: `awaiting_upload` · `queued` · `running` · `succeeded` · `failed` ·
`deleted`. Phases within `running`: `downloading` · `extracting` · `chunking` ·
`uploading`.

### 6.4 `get_result`

```
in   { jobId }
out  { jobId, result: {...}, artifacts: [{ type, blobPath, contentType, bytes }] }
```

Refuses unless the state is `succeeded`. `result` is the computed-facts object:
`pages`, `words`, `chunks`, `language`, `headings` (capped at 50), `tables`,
`durationMs`. The whole response is asserted under 8KB by a test.

### 6.5 `search_chunks`

```
in   { jobId, query, topK? (default 5, max 20) }
out  { hits: [{ chunkId, page, snippet, score }], scanned, truncated }
```

v1 is a **server-side streaming scan** of `chunks.jsonl` with bounded memory and
early termination once `topK` is satisfied or `SEARCH_MAX_SCAN_BYTES` is reached.
No index artifact to build or keep consistent. Snippets are capped at 300
characters. Scoring is term-frequency over the query terms.

An inverted index is the upgrade if scan latency ever matters; it is not needed
to be correct, and the streaming scan cannot go stale.

### 6.6 `fetch_chunks`

```
in   { jobId, chunkIds (max 10) }
out  { chunks: [{ chunkId, page, text }], bytes, truncated }
```

Reads each chunk as a **ranged blob GET** using the byte offsets in
`index.json`. Total response is hard-capped at `FETCH_MAX_BYTES` (32768); when
the cap bites, the response says `truncated: true` rather than silently
shortening. There is no code path in the server that returns a whole artifact.

### 6.7 `delete_job`

```
in   { jobId }
out  { deleted: true, blobsRemoved }
```

Deletes every blob under `uploads/<jobId>/` and `artifacts/<jobId>/`, then marks
the job row `deleted`. The row is retained, not dropped, so a later
`job_status` explains the absence rather than 404ing on an id the user still has
in their transcript.

---

## 7. Storage layout

One Azurite storage account.

```
blob   uploads/<jobId>/<filename>
       artifacts/<jobId>/chunks.jsonl     one JSON object per line
       artifacts/<jobId>/index.json       chunkId → { byteOffset, byteLength, page }
       artifacts/<jobId>/metadata.json    title, pages, producer, language
       artifacts/<jobId>/result.json      what get_result returns
       workspace/projects/<project>/…     phase 2 only

queue  job-queue                          message body: { jobId }
       job-queue-poison                   dead letters

table  jobs                               PartitionKey "job", RowKey <jobId>
```

The `jobs` row holds: `jobId`, `state`, `phase`, `pipelineId`, `params`,
`blobPath`, `filename`, `sizeBytes`, `sha256`, `progressDone`, `progressTotal`,
`attempts`, `workerId`, `createdAt`, `startedAt`, `finishedAt`, `error`.

`workerId` is written when a worker claims the message. It is not exposed by
`job_status` — it is an operational detail, not something a model should reason
about — but it is what lets the concurrency test in §11 prove three jobs ran on
three *different* workers rather than three times on one.

Both blob containers are private. `index.json` is what makes `fetch_chunks`
constant-cost: without it, reading one paragraph from a 100MB chunk file means
downloading 100MB.

A chunk line:

```json
{"chunkId":"c-000412","page":37,"charStart":1648000,"charEnd":1652000,"text":"…"}
```

Chunk ids are zero-padded and assigned in document order, so they sort
lexicographically into reading order.

---

## 8. The worker

### 8.1 Bounded memory, honestly

The brief asks to verify *"worker streaming (no full-file memory load)"*. A PDF
**cannot be stream-parsed**: its cross-reference table sits at the end of the
file, so a parser must seek backwards. Every Node library that accepts a stream
buffers the whole file internally. A 2GB PDF would kill the worker.

The requirement is met a different way:

1. **Blob → temp file on local disk**, streamed in 8MB buffers. Disk, not RAM.
2. **Extract one page window at a time** — `pdftotext -f 1 -l 25`, then 26–50,
   and so on. `poppler-utils` is installed in the worker image. Only one window
   of text is ever resident.
3. **Chunk that window**, append lines to `chunks.jsonl`, record byte offsets
   into `index.json`.
4. **Upload the artifacts, delete the temp file.**

Memory stays flat whether the input is 5MB or 2GB, which is the claim the test
in §11 measures.

DOCX needs none of this: it is a zip, so `word/document.xml` is unzipped and
SAX-parsed as a genuine stream. TXT and MD stream directly.

### 8.2 Chunking

Fixed-size windows of `chunkChars` (4000) with `overlapChars` (200) of overlap,
split at the nearest paragraph boundary and falling back to a sentence boundary,
then to a hard cut. Overlap exists so a sentence spanning a boundary is still
findable from either side. Page numbers are carried from the extraction window,
so every chunk cites the page it came from.

Chunking is pure and deterministic: same bytes and same params produce the same
chunk ids and offsets, every run. That is what lets tests assert exact output.

### 8.3 Reliability

The queue does the work rather than a hand-rolled lease:

- Message body is `{ jobId }`. Nothing large is ever in a queue message.
- Visibility timeout is renewed periodically while processing, acting as a
  heartbeat. A crashed worker stops renewing and the message reappears.
- On failure the worker does **not** delete the message; it becomes visible
  again and another worker picks it up.
- `dequeueCount > 3` moves the message to `job-queue-poison` and marks the job
  `failed` with the error text. That is the DLQ the brief asks for.
- Temp files are removed in a `finally`, and the worker sweeps its temp
  directory at startup so a SIGKILL cannot leak disk across restarts.

---

## 9. MCP 2 — the workspace plane (phase 2)

Specified here at contract level so phase 1 does not paint itself into a corner.

### The seam between the two servers

**A document in server 2 *is* a jobId in server 1.** That is the only coupling,
and it is one field. Server 2 stores `{ jobId, category, filename, attachedAt }`
against a project/feature; when a skill needs to read that document it calls
server 1's `search_chunks` / `fetch_chunks` with the jobId. Server 2 never
returns document text and never proxies server 1.

### Tools

```
list_projects                 → [{ project, features, documentCount }]
create_project                { project, description?, website? }
list_features                 { project }
create_feature                { project, feature }

attach_document               { project, feature?, jobId, category }
list_documents                { project, feature? }  → includes jobId per document
detach_document               { project, feature?, jobId }

list_artefacts                { project, feature? }
read_artefact                 { project, feature?, name }   → capped like fetch_chunks
write_artefact                { project, feature?, name, content }

stage_status                  { project, feature? }  → what is ready, what is stale
publish_artefact              { project, feature?, name, target }
```

`category` is the existing vocabulary: `SOP`, `Transcripts`, `Notes`, `UI` at
feature level, `documents` at project level.

### How a skill uses both servers

```
codex> generate requirements for SAPN / Appeals

  skill loads in Codex's context
  → mcp2.list_documents(SAPN, Appeals)        which documents exist, and their jobIds
  → mcp1.search_chunks(jobId, "eligibility")  find the relevant passages
  → mcp1.fetch_chunks(jobId, [c-000088, …])   read only those
  → mcp2.write_artefact("product-summary.md") persist the output
  → mcp2.publish_artefact(…)                  push to the wiki
```

The eight existing skills under `skills/` are ported in phase 2 by replacing
their "read every file in this folder" step with the search/fetch pair. Their
method sections — house style, section structure, evidence rules — are unchanged.

---

## 10. Security

Local-first, but shaped so the prod version is a swap and not a redesign.

- **SAS is least-privilege by construction**: service SAS, one blob, `cw`
  permissions, 900-second TTL. Not container-scoped, not readable, not reusable
  for a second filename.
- **No payload ever reaches a log line.** The logger takes an explicit field
  allowlist rather than logging objects wholesale. §11 turns this into an
  assertion.
- **Responses are capped in code, not by convention.** `fetch_chunks` truncates
  at 32KB and reports it.
- **Auth is off locally and pluggable.** The orchestrator reads
  `MCP_BEARER_TOKEN`; when set, every MCP request must carry it, and `.mcp.json`
  gains `bearer_token_env_var`. Unset locally, required in prod.
- **The worker has no ingress.** It is reachable only through the queue.
- Input validation refuses path traversal in filenames, oversized declared
  sizes, and unsupported extensions before any blob is touched.

---

## 11. Testing and acceptance

Each row of the client's acceptance criteria becomes an assertion.

| Claim | Assertion |
|---|---|
| No bytes traverse MCP | A unique sentence is planted in the test document; every captured log line and every MCP response is grepped for it. Failure if found. |
| Bounded memory | The worker runs under `--max-old-space-size=256` against a generated large file. Completion is the proof. |
| Results stay compact | `get_result` response < 8KB. `fetch_chunks` never exceeds 32KB and sets `truncated` when it caps. |
| `delete_job` really deletes | No blobs remain under either prefix; the job row reads `deleted`. |
| SAS is least-privilege | The SAS is rejected for a read, for a list, for a write to a different blob name, and after its expiry. |
| The pool is a pool | With `--scale worker=3`, three jobs submitted together are observed running concurrently across distinct workers. |
| Failures dead-letter | A job whose input is a deliberately corrupt PDF fails 3 times, lands in `job-queue-poison`, and reports `failed` with the error. |

Unit tests cover the chunker's determinism and boundary behaviour, `index.json`
offsets round-tripping through a ranged read, search ranking, and every tool's
input validation.

Integration tests run against a real Azurite container, not a mock. The whole
point is the storage semantics — SAS scoping, ranged reads, queue visibility —
and a mock would assert our assumptions rather than Azure's behaviour.

Test fixtures are **generated, not committed**: a script builds a PDF of N pages
with known text at known pages, so tests can assert that a needle on page 37 is
found on page 37, and no large binaries enter git.

---

## 12. Migration to Azure — the deltas

Recorded now so "local first" does not quietly become "local only".

| Local | Azure | Touches |
|---|---|---|
| Azurite blob | Storage account, private containers | connection string |
| Azurite queue | Service Bus queue | the dispatch module |
| Azurite table | Table Storage | connection string |
| Shared-key service SAS | User-delegation SAS via Managed Identity | the SAS minting function |
| `docker compose` | Container Apps: orchestrator with ingress, worker scaling on queue length | compose → bicep/terraform |
| No auth | Entra ID, device-code flow | the orchestrator's auth middleware |
| `delete_job` only | Lifecycle TTL rules on `uploads/` and `artifacts/` | storage policy |
| `http://127.0.0.1:8080/mcp` | the Container App ingress URL | `.mcp.json` |

Two are more than configuration: the queue client and the SAS minting function.
Both are isolated behind a single module each for exactly this reason.

One constraint to carry forward: `MCP-CODEX.md` records that Codex's shell
sandbox permits outbound network to loopback only. `scripts/upload.mjs` reaching
`127.0.0.1` works locally; reaching a public Azure endpoint will not, without
either a sandbox setting or performing the upload outside the Codex session.
This is a known prod question, not a local one, and it does not affect phase 1.

---

## 13. Phasing

**Phase 1 — the file plane.** MCP 1 with all seven tools, the worker pool,
Azurite, the plugin skeleton with its own skill, `stack.sh`, `upload.mjs`,
docker-compose, and every acceptance test in §11. This is the client's brief
delivered whole and installable.

**Phase 2 — the workspace plane.** MCP 2 as specified in §9, plus porting the
eight existing skills to read through search/fetch instead of off disk.

Phase 1 is a hard prerequisite: phase 2's skills are useless without a cheap way
to read a large document, which is precisely what phase 1 builds.

---

## 14. Environment

```
AZURE_STORAGE_CONNECTION_STRING   Azurite default connection string
ORCH_PORT                         8080
MCP_BEARER_TOKEN                  unset locally; required in prod
SAS_TTL_SECONDS                   900
MAX_UPLOAD_BYTES                  5368709120        (5 GiB)
FETCH_MAX_BYTES                   32768
SEARCH_MAX_SCAN_BYTES             134217728         (128 MiB)
DEFAULT_CHUNK_CHARS               4000
DEFAULT_OVERLAP_CHARS             200
DEFAULT_PAGE_WINDOW               25
WORKER_CONCURRENCY                1                 per container; scale by replicas
MAX_DEQUEUE_COUNT                 3
TEMP_DIR                          /tmp/afp
```

Defaults are chosen so the stack runs correctly with no `.env` at all.
