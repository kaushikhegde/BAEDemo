# Azure File Processing

A Codex plugin that lets a model upload, process and query files of up to
5 GiB without a single byte of file content ever entering its context. Two
Node processes behind Azurite: an orchestrator exposing MCP tools over
streamable HTTP, and a worker pool that extracts and chunks documents in the
background. See `docs/superpowers/specs/2026-08-24-codex-azure-file-processing-design.md`
for the full design.

The **`scyne` skill** is the other half of the deliverable: it is what stops a
model from opening the file itself once the tools exist, and it is what `$scyne`
invokes. One skill covers both planes — see `skills/scyne/SKILL.md`.

## Install

```bash
codex plugin marketplace add <git-url-or-local-path>   # this repo registers as "scyne"
codex plugin add azure-file-processing@scyne
cd plugins/azure-file-processing && ./scripts/stack.sh up
```

`stack.sh up` starts Azurite and two workers in Docker, starts **the
orchestrator natively on this machine**, waits for `GET /health` to answer,
and prints the MCP URL once it does. Each service creates the containers,
queue and table it needs on boot if they are not already there, so there is no
separate provisioning step.

**Why the orchestrator is not in a container.** `upload_file` takes a path on
the caller's own filesystem and streams the bytes to storage itself — which is
what removes the shell step, the SAS round-trip and the `shasum` from the
model's turn. A container's filesystem is the image's, so a host path resolves
to nothing there. Azurite and the workers stay containerised; neither ever
touches a path the caller named. `./scripts/stack.sh up --all-docker` runs the
old all-container stack, on which `upload_file` is simply not registered and
`create_upload_url` + `scripts/upload.mjs` is the only way in.

## Running the stack

```bash
./scripts/stack.sh up                # azurite + workers in Docker, orchestrator native
./scripts/stack.sh up --all-docker   # everything in Docker — no upload_file
./scripts/stack.sh status            # container states + a live /health check
./scripts/stack.sh logs              # follow every container's logs
./scripts/stack.sh workers <n>       # scale the worker pool to exactly n
./scripts/stack.sh down              # stops the native orchestrator, then
                                      # docker compose down -v — DESTROYS the Azurite
                                      # volume, and with it every stored document
```

The native orchestrator logs to `.orchestrator.log` and records its pid in
`.orchestrator.pid` (both gitignored). `stack.sh logs` follows that file
alongside the container logs. `tsx` re-execs, so the recorded pid can be a
parent whose child holds the port — `down` therefore also clears the listener
on `ORCH_PORT`, but only once `/health` has identified it as ours.

`workers <n>` matters because two of the test tiers need a specific worker
count and will give misleading results with the wrong one:

| Before running | Worker count | Why |
|---|---|---|
| `npm run test:integration` | `./scripts/stack.sh workers 0` | those tests drive a single turn of the worker loop in-process; a live container worker would race it for the same queue message |
| `npm run test:acceptance` | `./scripts/stack.sh workers 3` | the "the pool is a pool" case needs more than one worker actually competing for work |

`workers 0` stops the worker containers rather than removing them, so `workers
3` afterwards brings the same containers straight back — no rebuild.

## Tools

Eight MCP tools, registered as the **`scyne`** server — the key in `.mcp.json`
is the namespace Codex prefixes each tool with, so they surface as
`scyne__upload_file`, `scyne__search_chunks` and so on. Names and payload
shapes are the contract the skill is written against — see
`src/orchestrator/mcp.ts` for the exact Zod schemas.

| Tool | Does |
|---|---|
| `upload_file` | **The one-call path.** Takes an absolute local path, streams the file to blob storage in 8 MiB blocks (four in flight, so ~32 MiB of memory whatever the file's size), records the SHA-256 of the bytes it actually sent, and queues the job. Registered only when `ALLOW_LOCAL_PATH_UPLOAD` is on. `start: false` uploads without queueing. |
| `create_upload_url` | The fallback, for when the file is not on the orchestrator's machine. Mints a `jobId` and a short-lived, write-only SAS URL for one blob. Refuses a filename with a path separator, an unsupported extension, or a size over `MAX_UPLOAD_BYTES`. |
| `start_job` | Verifies the upload landed at the declared size, then queues processing. Idempotent — calling it again on a job already queued/running reports the current state rather than enqueueing twice. |
| `job_status` | Polls `state` (`awaiting_upload → queued → running → succeeded`/`failed`/`deleted`), `phase` within `running`, and page-count progress. |
| `get_result` | Computed facts once a job has `succeeded` — pages, words, chunk count, language, up to 50 short headings, table count, and which engine rendered the markdown — plus artifact paths. Never returns passage text; the whole response is capped under 8 KB. |
| `search_chunks` | A bounded, server-side streaming scan of the document's chunks for the query terms. Returns short snippets with `pageStart`/`pageEnd` and `chunkId`, capped at `topK` (default 5, max 20) hits and at `SEARCH_MAX_SCAN_BYTES` of scanning. |
| `fetch_chunks` | Full text of up to 10 named chunk ids, read as ranged blob reads — never a whole artifact download. Hard-capped at `FETCH_MAX_BYTES` (32 KB) per call. |
| `delete_job` | Permanently deletes every blob under that job's upload and artifact prefixes. The job row is kept, marked `deleted`, so a later `job_status` explains the absence rather than 404ing. |

### Five artifacts, not four

A succeeded job writes `chunks.jsonl`, `index.json`, `metadata.json`,
`result.json` and — since the workspace plane needed one — **`document.md`**: a
structured markdown rendering of the whole document, produced by the same
`markitdown-ts` + `@firecrawl/anydoc` pair `scripts/convert-to-md.mjs` uses, so
a document converts identically whichever door it came in by.

It is rendered **separately from the chunks**, deliberately, rather than by
chunking the markdown. The two artifacts want opposite things: chunks want page
numbers, because every citation `search_chunks` returns is a page reference, and
markitdown throws pagination away (it is a rendering decision, absent from a
`.docx` entirely). The markdown wants headings and tables, which the
page-at-a-time extractor cannot see. Producing each with the engine that suits
it costs one extra pass over a file already on local disk and keeps both
properties instead of trading one away.

**The markdown engine buffers, so it is bounded by the heap.** `markdownMaxBytes`
defaults to a twelfth of this process's heap limit, capped at 256 MiB — derived
rather than fixed, because a fixed number is only ever right for one heap size.
Above it, `document.md` is written by the STREAMING extractor instead: flat
text, no headings, one page of memory regardless of the document's size. Which
engine ran is recorded in `result.json` as `converter`, never guessed at
afterwards.

That default is not a guess. A fixed 256 MiB ceiling passed every unit and
integration test and then failed the acceptance suite's bounded-memory case,
where a 40,000-page (~130 MB) PDF sits *below* the ceiling and is therefore
buffered — inside a worker deliberately capped at `--max-old-space-size=256`.
The guarantee that suite exists to prove is exactly the one a fixed ceiling
breaks.

Formats: PDF, Word, PowerPoint, Excel, HTML, CSV, RTF, EPUB, ODF and plain
text. Images and audio are refused deliberately — a markdown rendering of a
screenshot loses the point of the screenshot, and audio has a better path.

File content travels exactly two ways, neither of them a tool response:
`upload_file` streaming disk → orchestrator process → storage, and
`scripts/upload.mjs` PUT-ing straight to the SAS URL. Every MCP response above
is compact JSON — `test/upload-file.int.test.ts` plants a needle in a file and
asserts it appears nowhere in what `upload_file` returns.

## Environment

None of these need setting for local development — the defaults make the
stack work with no `.env` at all. `src/shared/config.ts` is the source of
truth; `docker-compose.yml` sets `AZURE_STORAGE_CONNECTION_STRING` (pointed
at the `azurite` service name) and `SAS_PUBLIC_BLOB_ENDPOINT` (pointed back
at `127.0.0.1`, so a SAS minted inside the container is still usable from the
host) for you.

| Variable | Default | Notes |
|---|---|---|
| `AZURE_STORAGE_CONNECTION_STRING` | Azurite's published development connection string | |
| `ORCH_PORT` | `8080` | |
| `MCP_BEARER_TOKEN` | unset — no auth | required once the endpoint is reachable from anywhere but localhost |
| `SAS_TTL_SECONDS` | `900` | how long an upload URL from `create_upload_url` stays valid |
| `MAX_UPLOAD_BYTES` | `5368709120` (5 GiB) | |
| `FETCH_MAX_BYTES` | `32768` | `fetch_chunks` response cap |
| `SEARCH_MAX_SCAN_BYTES` | `134217728` (128 MiB) | `search_chunks` scan ceiling — see *Known limits* |
| `DEFAULT_CHUNK_CHARS` | `4000` | |
| `DEFAULT_OVERLAP_CHARS` | `200` | |
| `DEFAULT_PAGE_WINDOW` | `25` | |
| `MAX_DEQUEUE_COUNT` | `3` | attempts before a job is dead-lettered |
| `TEMP_DIR` | `/tmp/afp` | worker scratch space, cleaned up per job |
| `ALLOW_LOCAL_PATH_UPLOAD` | on, unless `MCP_BEARER_TOKEN` is set | whether `upload_file` is registered at all. It reads a path on the SERVER's filesystem, which is the point when that is also the caller's machine and a nonsense when it is not — so setting a token, the only reason for which is that the port is reachable from elsewhere, turns it off. Set it explicitly to force either way |
| `SAS_PUBLIC_BLOB_ENDPOINT` | unset — falls back to the connection string's own blob endpoint | needed only when the orchestrator resolves Azurite by a hostname the SAS's *caller* cannot reach (exactly the Docker-Compose case above) |

The design spec (§14) also lists `WORKER_CONCURRENCY` ("1, per container;
scale by replicas"). Nothing in the code reads that variable — a worker
process always handles one queue message at a time
(`src/worker/index.ts:runOnce`) by design, and the pool is scaled by running
more worker *processes* (`docker compose up --scale worker=N`, i.e.
`./scripts/stack.sh workers N`), not by a concurrency knob inside one. Treat
that spec line as documenting the fixed value, not a settable variable.

## Development loop

Codex caches an installed plugin's manifest, so an edit to the skill, the
tools or `.mcp.json` is not picked up until the version changes and a fresh
thread starts:

```bash
python3 ~/.codex/skills/.system/plugin-creator/scripts/update_plugin_cachebuster.py \
  plugins/azure-file-processing
python3 ~/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py \
  plugins/azure-file-processing
codex plugin add azure-file-processing@scyne
# then start a NEW Codex thread — tools and skills are bound at thread start
```

If code under `src/` changed, rebuild the images too:
`docker compose up -d --build`.

## Verifying an install

Confirming the plugin is visible costs nothing — it needs no model turn, only
the Codex CLI itself:

```bash
python3 ~/.codex/skills/.system/plugin-creator/scripts/update_plugin_cachebuster.py \
  plugins/azure-file-processing
python3 ~/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py \
  plugins/azure-file-processing
codex plugin add azure-file-processing@scyne
codex plugin list
codex mcp get scyne
```

`codex plugin list` should show `azure-file-processing@scyne` as
`installed, enabled`; `codex mcp get scyne` should show
`enabled: true` and `url: http://127.0.0.1:8080/mcp`.

**The one thing that check cannot prove is that a live Codex thread actually
uses the tools correctly instead of reading the file.** That is the owner's
own final step, deliberately not automated here — it spends real model
credits and everything else about the pipeline is already proven by
`test/mcp-server.int.test.ts` (the MCP handshake and tool registration) and
`test/acceptance.acc.test.ts` (the whole pipeline, against a 634,596,908-byte
fixture, three times). To run it:

1. Make sure the stack is up (`./scripts/stack.sh up`, `./scripts/stack.sh status`).
2. Start a **new** Codex thread — an already-open one will not see a
   just-reinstalled plugin.
3. Give it a real, large document and ask a question that requires reading
   deep into it, e.g.:

   > Process ~/Downloads/some-large.pdf and tell me what section 4 says.
   > Cite the page.

4. A correct run calls, in order: `upload_file` with the absolute path, polls
   `job_status` until `succeeded`, calls `search_chunks` for terms related to
   "section 4", then `fetch_chunks` on the best-scoring chunk ids, and answers
   citing a page range — **without any tool call that reads, opens or `cat`s
   the PDF itself, and without a `shasum` or an `upload.mjs` shell step.**
   Check the thread's tool-call list, not just the prose answer; that ordering
   is the entire deliverable. On an `--all-docker` stack the first step is
   instead `create_upload_url` → `node scripts/upload.mjs` → `start_job`,
   which is the same deliverable by the fallback route.

## Acceptance

`test/acceptance.acc.test.ts` turns each spec §11 row into an assertion and
requires a real stack: `./scripts/stack.sh up`, `./scripts/stack.sh workers 3`,
then `npm run test:acceptance` (its own Vitest config —
`vitest.acceptance.config.ts`, matching `test/*.acc.test.ts` — kept separate
from the integration suite). **All five tests across all four blocks pass
together, in one unfiltered run of the suite exactly as committed** —
`313.66 s` total, `EXIT:0`, verified 2026-08-25.

| §11 claim | Result |
|---|---|
| No bytes traverse MCP | PASS — the planted needle appears in no tool response and no `docker compose logs` line |
| Bounded memory | PASS — see below |
| Results stay compact | PASS — `get_result` well under 8 KB; `fetch_chunks` capped at `FETCH_MAX_BYTES` and marks `truncated` |
| The pool is a pool | PASS — three jobs submitted together landed on more than one worker (see below for the exact split) |

**The large-document fixture:** `make-fixture-pdf.mjs` generated a **634,596,908-byte**
(≈605 MiB) PDF of **40,000 pages** at 200 lines/page — sized well past a
256 MB heap on purpose (20,000 pages at the default 40 lines/page measures only
≈63 MB, which fits inside 256 MB and would prove nothing). `upload.mjs` staged
it as **19 blocks** of up to 32 MiB each. The `mkdtempSync` directory each run
writes fixtures into is removed in an `afterAll`, so repeated runs (this
fixture alone is ≈605 MiB) do not accumulate on disk.

**Bounded memory — the block now proves it did the work, not merely that
the job finished.** The claim is that a worker started with
`NODE_OPTIONS=--max-old-space-size=256` completes this document — not that
*some* worker does. An early version of this test only asserted `job.state
=== "succeeded"`, and that was not enough: with the documented three-worker
stack live, a job succeeding does not say which worker did it, and "the pool
is a pool" is itself evidence that more than one candidate is racing for the
same message (see *the wrong-worker discovery* below). The block now:

1. stops the docker worker pool for its own exclusive duration
   (`scripts/stack.sh workers 0`, restored to 3 in `finally` so the blocks
   that follow still have it live);
2. spawns its own worker with `--max-old-space-size=256` and captures the
   `workerId` it logs to stdout on `"worker.started"` — the *only* other
   place that id is recorded;
3. once the job reaches `succeeded`, asserts `job.workerId === <the id just
   captured>`.

**Measured, in the run that verified the suite exactly as committed** — the
single unfiltered `npm run test:acceptance` referenced at the top of this
section, the one that also exercised `restorePoolAndWaitReady` for the first
time (see *the cold-start race* below): with the pool stopped and the capped
worker the only live consumer, the whole block — generate the ≈605 MiB
fixture, upload it, process it, verify `job.workerId` matches, restore the
pool and confirm it is actually ready, and verify both search properties
below — completed in **306,136 ms (≈5.10 min)**. `job.state` reached
`succeeded`, `result.pages` was `40000`, the worker's stderr never matched
`heap out of memory`, **and the succeeded job's `workerId` (`w-3862823b`)
equalled the captured id of the worker this test itself spawned** — the
property that actually backs the "under a 256 MB heap" claim.

Three earlier measurements of the same case, kept here as consistency
context rather than as the authoritative figure — 294,578 ms (a prior full
unfiltered run, before `restorePoolAndWaitReady` existed), 301,237 ms (the
`workerId`-guarded block run filtered to itself during development), and
567,063 ms (a still-earlier isolated measurement, before the equality check
existed at all, so the *job completed* claim was true but nothing yet
asserted *which worker* did it). The spread across all four is real,
machine-load-dependent variance on the same ≈605 MiB fixture, not a
regression — the run that matters is the one above, because it is the one
that ran every line of the suite exactly as committed, including the
readiness poll.

**The wrong-worker discovery — why the guard exists.** Before the equality
check was added, running the suite exactly as documented (three docker
workers live throughout, per `stack.sh workers 3`) still reported a pass:
5/5 tests, 223.17 s total, the bounded-memory block itself 217,552 ms.
That number is real, but it is a **full-suite throughput figure, not a
bounded-memory result**: cross-referencing the succeeded job's `workerId`
(`w-699b39aa`) against each container's own `worker.started` log line showed
an *ordinary, unconstrained* pool worker (container `worker-3`) had claimed
the message before the test's dedicated 256 MB process finished its `tsx`
cold start. The assertions in place at the time still passed — the job
succeeded, and the capped worker's stderr trivially showed no heap error,
since it never received any work — which is precisely the "passes by being
undemanding" failure this suite exists to prevent. **217,552 ms must not be
read as a bounded-memory figure**; it describes how fast an unconstrained
pool worker processes this document, which is a different, valid fact, not
this one.

**Discrimination proof.** An assertion that always passes is not a guard, so
the equality check above was proved capable of failing before being trusted.
A fresh, short-lived worker was spawned (same command the block uses) purely
to capture its own generated `workerId`, then compared — using the exact
`job.workerId === capturedId` check the block now runs — against the
already-known wrong-worker job from the discovery above (`workerId
w-699b39aa`, definitely not this fresh process's id):

```
captured fresh workerId: w-f36d30e7
known job's actual workerId: w-699b39aa
ASSERTION FAILS as expected: job.workerId === cappedWorkerId (wrong-worker scenario) — actual "w-699b39aa" !== expected "w-f36d30e7"
DISCRIMINATION PROVEN: the guard would have failed loudly on a wrong-worker run.
```

The check throws exactly when it should — a wrong-worker run is now a loud,
named failure rather than a silent pass.

**The cold-start race — closed structurally, and exercised for real in the
run that verifies this suite.** `scripts/stack.sh workers 3` (`docker
compose up --scale worker=3`) returns once the containers have *started*,
not once the Node process inside each has cold-started, connected to Azurite
and begun polling `job-queue`. The bounded-memory block restores the pool in
its `finally` and the next two blocks (`results stay compact`, `the pool is
a pool`) hand it work immediately — a real, structural window in which
fewer than three workers could be ready to consume. `restorePoolAndWaitReady`
closes it: it polls `docker compose logs` for `expected` DISTINCT workers'
own `"worker.started"` lines, logged after the moment the pool was told to
come back up, and only returns once all three have actually reported in
(60 s budget; throws, naming how many were seen, if they have not). A run of
the block filtered to itself is not evidence this helper works — a polling
helper is exactly the kind of code that can hang, throw, or report ready
when it is not, and none of that had been exercised until the suite ran
whole. It has now: the run reported at the top of this section (313.66 s,
`EXIT:0`) is the one where `restorePoolAndWaitReady` actually executed as
part of the full, unfiltered, committed suite — it neither hung nor threw,
`the pool is a pool` passed immediately after the restore it performed, and
the workers that picked up that block's jobs (below) were freshly started
during it, not the bounded-memory block's own already-terminated capped
worker. The gap is closed structurally, not merely observed to be absent
once.

**The pool is a pool.** In that same run, three same-sized jobs (`p1.pdf`,
`p2.pdf`, `p3.pdf`, 200 pages each) submitted together landed on two
distinct freshly-restored workers — `w-aa0234ab` and `w-11a40bda` (the
latter processed two of the three) — satisfying "more than one," which is
exactly what this test asserts (`workers.size` > 1, not `=== 3`); a
competing-consumer queue is not obliged to spread work perfectly evenly
every run. A separate run (a prior full unfiltered run, before
`restorePoolAndWaitReady` existed) landed all three on three distinct
workers — `w-035049be`, `w-76214ea9`, `w-54112ed6` — and the wrong-worker discovery's
own evidence run showed the same full-utilisation property with yet another
worker set (`w-699b39aa`, `w-04f01b18`, `w-d127ca8a`). Both shapes are valid
outcomes of the same property; neither is cherry-picked.

**Scan-ceiling finding, surfaced by the same large fixture.** `chunks.jsonl`
for the 40,000-page document is **159,511,458 bytes** — larger than
`search_chunks`'s `SEARCH_MAX_SCAN_BYTES` ceiling (**134,217,728 bytes** /
128 MiB). Measured directly against this job's `index.json`, the ceiling is
reached inside the chunk covering pages 33684–33686, ≈84.1% through the file.
The acceptance test asserts both sides of that boundary as named properties
rather than assuming the whole document is always reachable: a term unique to
page 30,000 (well inside the scanned 84%) is found there; the needle planted
at page 39,997 (past the ceiling) returns zero hits with `truncated: true`.
See *Known limits* below.

### Proven elsewhere

Three §11 rows are asserted by earlier tasks' tests rather than duplicated
here, so their absence from `acceptance.acc.test.ts` is not an oversight:

| Row | Proven in |
|---|---|
| SAS is least-privilege | `test/sas.int.test.ts` (Task 6) — five negative assertions |
| `delete_job` really deletes | `test/delete-job.int.test.ts` (Task 18) |
| Failures dead-letter | `test/worker.int.test.ts` (Task 14) |

## Known limits

- **`index.json` is downloaded whole on every `fetch_chunks` call.** The
  index maps each `chunkId` to its `byteOffset`/`byteLength` in
  `chunks.jsonl`, and `fetch_chunks` reads the whole file to look entries up.
  For a 2 GB source document — proportionally many chunks — that index can
  run to tens of megabytes, which is real added latency per call. It never
  reaches the model: the download happens server-side, inside the
  orchestrator process, purely to resolve the ranged read that follows.
  **Upgrade path:** a fixed-width sorted index format, read with a ranged
  binary search over the same ranged-GET mechanism `fetch_chunks` already
  uses for `chunks.jsonl` — turning an O(index size) download into
  O(log n) small reads. Not built: nothing measured on the documents
  exercised so far shows it is needed yet.
- **`search_chunks` never scans past `SEARCH_MAX_SCAN_BYTES` (128 MiB), so a
  match late in a very large document can be missed entirely.** It is a
  server-side streaming scan of `chunks.jsonl` from the start, with early
  termination at `topK` hits or the ceiling — deliberate, since a search must
  not be allowed to cost as much as extracting the document did. MEASURED: on
  the acceptance suite's 634,596,908-byte / 40,000-page fixture,
  `chunks.jsonl` is 159,511,458 bytes; the 134,217,728-byte ceiling lands
  inside the chunk covering pages 33684–33686, ≈84.1% through the file — a
  query matching only content past that point returns zero hits with
  `truncated: true`, which `test/acceptance.acc.test.ts`'s bounded-memory case
  now asserts on both sides of the boundary. **Upgrade path:** either a
  fixed-width sorted index read with a ranged binary search — the same shape
  already proposed above for `index.json` — or an inverted index, named in
  the design spec §6.5 as the option "if scan latency ever matters"; either
  would make search cost proportional to matches rather than document size,
  removing the ceiling's blind spot along with the latency it exists to
  bound. Not built: the streaming scan is simpler and cannot go stale, and
  nothing before this suite had exercised a document large enough to hit the
  ceiling.

## The workspace plane

A second MCP server, **`scyne-workspace`**, ships in this same plugin and does
a different job. Where the file plane (above) moves large documents through
Azure without filling the context window, the workspace plane fronts the
**Scyne requirements pipeline** — the same one the chatbot drives — so a stage
started from Codex is the SAME tracked issue the chatbot creates, visible in
the orchestrator console, in Spend and in Actions. See
`skills/scyne/SKILL.md` for the full method; this section covers what
a reader needs before any of it works.

**Four facts, none of them guessable:**

1. **Two servers, two ports.** `scyne` on `:8080` is the file plane; the
   workspace plane, `scyne-workspace`, listens on **`:8081`**. They are
   independent processes — either runs without the other, and `stack.sh up`
   starts both.
2. **`SCYNE_ORCH_TOKEN` is required** for every workspace tool, and for
   nothing in the file plane. Set it in the workspace-root `.env` (the same
   `.env` the orchestrator, the chatbot and `.mcp.json` all read) to a live
   Scyne API token — the same Bearer token the `scyne` CLI uses. Without it
   every workspace call answers `not_authenticated`.
3. **The workspace server needs the Scyne stack running.** `npm run dev` at
   the repo root brings up the orchestrator on `:3100` and the chatbot on
   `:4000` — the workspace server is only a front door to those, so
   `start_stage`, `create_project` and everything else in it fail loudly,
   naming what could not be reached, when the stack is down. The file plane
   has no such dependency.
4. **Blob is the source of truth for `projects/`; local disk is a cache.**
   Nothing under `projects/` is ever deleted implicitly, in either direction —
   `sync push` uploads what changed, `sync pull` downloads what changed, and a
   file present only on one side survives every sync.

### Starting it

```bash
npm run dev                    # repo root: orchestrator :3100, chatbot :4000
cd plugins/azure-file-processing && ./scripts/stack.sh up   # this plugin, both MCP servers
```

`stack.sh up` starts Azurite, the workers and the file-plane orchestrator as it
always has, then starts the workspace server **natively** alongside it — native
either way, even under `--all-docker`, because it reaches the Scyne stack on
`127.0.0.1:3100` and `127.0.0.1:4000`, neither of which is in Compose. It logs
to `.workspace.log` and its pid is `.workspace.pid` (both gitignored, mirroring
`.orchestrator.log` / `.orchestrator.pid`). `stack.sh status` reports both
servers' health; `stack.sh down` stops both — remember `down` is `docker
compose down -v` and **destroys the Azurite volume**, so never run it if the
documents synced into blob matter.

### The sync CLI

Three verbs, `npm run sync -- <project> --up|--down|--status [--prefix P] [--dry-run]`
(equivalently `./node_modules/.bin/tsx scripts/sync.mjs <project> --up|--down|--status`):

| Verb | Does |
|---|---|
| `--status` | Compares local `projects/<p>/` against blob and reports `onlyLocal` / `onlyBlob` / `differing` / `same` — nothing is written |
| `--up` | Uploads every local file that is new or different. Never deletes a blob a local `rm` removed |
| `--down` | Downloads every blob file that is new or different, to a temp file renamed atomically into place. Never deletes a local file blob does not have |

### `$scyne` — the command surface

```
$scyne use SAPN "CRM Management"
$scyne run datamodel                 → created SCY-41 · Data Modeler working…
$scyne status SCY-41                 → in_review · gate pending your approval
$scyne gate approve g_8f21
$scyne spend --by feature
```

**`$`, not `/`, and it is a SKILL rather than a command.** Codex removed custom
slash commands in **0.117.0** in favour of skills, and invokes a skill with `$`.
`skills/scyne/SKILL.md` is the whole mechanism — and it is the plugin's ONLY
skill, covering both planes, so there is one `$scyne` rather than three entries
in the picker.

Three other mechanisms were tried first and every one of them was inert — worth
recording, because each looks correct and none of them announces its failure:

| Tried | Result |
|---|---|
| `commands/scyne.md` at the plugin root — the shape Figma, Vercel and Zoom ship | Installed, present in the cache, never surfaced |
| An **MCP prompt** (`prompts/list` → `scyne`) | Served correctly on the wire, never surfaced |
| The command→skill migration (`migrated-command-skills` in the binary) | Never ran; `commands/` sat untouched |

The symptom in every case was `Unrecognized command '/scyne'` while every MCP
tool worked perfectly — which reads like a broken plugin and is actually a
plugin using a mechanism the host retired.

**The skill lives in the PLUGIN, not in `<repo>/.codex/skills/`.** The
project-level path works and is where this was first proved, but it is
project-scoped: install the plugin anywhere else and `$scyne` would not exist.
Under `skills/` it ships with the plugin and appears as `scyne` in the `$`
picker alongside `scyne-workspace` and `azure-file-processing`.

`src/workspace/prompts.ts` still registers the MCP prompt, and serves **that same
SKILL.md** rather than a copy — `prompts/list` is real protocol other clients do
surface, and reading one file means the two cannot drift.

There is deliberately **no `$scyne login`**. Credentials are `SCYNE_ORCH_TOKEN`
and `SCYNE_ORCH_URL` in the workspace-root `.env`, shared with the orchestrator,
the chatbot and `.mcp.json`. `$scyne use` pins a target for the conversation
only — it writes no config file.

### The thirty-one tools

Enough to cover what the web chat and the `scyne` CLI can each do, so a person
working from Codex is not driven back to a browser for an ordinary operation.

| Group | Tools |
|---|---|
| documents | `ingest_document` · `attach_document` · `read_document` · `replace_document` · `delete_document` · `list_documents` |
| pipeline | `stages` · `start_stage` · `revise_artefact` · `republish_artefact` · `staleness` |
| gates | `approve_gate` · `reject_gate` · `request_changes` |
| issues | `issue_status` · `list_issues` · `pause_issue` · `resume_issue` · `cancel_issue` · `issue_runs` · `run_transcript` |
| workspace | `create_project` · `create_feature` · `list_projects` · `list_features` · `get_project_definition` · `save_project_definition` · `extract_brand` |
| reporting | `spend` · `actions` · `history` |

Deliberately **not** covered: organisations, users, members, model prices and
installations. Those are installation administration, guarded by role upstream,
and the console is the right surface for them — a plugin that can re-price every
run in the install is not a document tool.

**`stages` is read from the server, never shipped.** `start_stage` takes a
free-string workflow key and validates it against `GET /config` at call time, so
a stage the pipeline gains appears without upgrading this plugin. It used to
carry its own array of ten while the server had twenty-six — and `extract`, a
stage added after that array was written, was refused by the plugin while the
engine ran it perfectly well. Same mistake `cli/stages.ts` exists to correct,
and the failure mode a separately-distributed plugin is most exposed to.

`test/workspace-tools.test.ts` asserts this list against what is actually
registered, in both directions, and separately asserts that every chatbot LLM
tool and every daily-work CLI verb maps to something here. A tool added without
a line in the table fails the suite.

**`ingest_document` is the large-file door**, and the reason the workspace plane
is more than a launcher. `attach_document` reads the whole file into the
workspace server's memory and posts it to the chatbot — fine for a 200 KB note,
hopeless for a 2 GB PDF, which is the exact ceiling this plugin exists to
remove. `ingest_document` streams the bytes to Azure in 8 MiB blocks, has a
worker convert them to markdown *there*, and sends only the **markdown** on to
the chatbot to be filed and recorded:

```
local file ──8 MiB blocks──▶ Azure ──worker──▶ document.md
                                                   │
                        (orders of magnitude smaller than the source)
                                                   ▼
                                   chatbot ──▶ projects/<p>/…/x.md + DB row
```

Measured end to end: a 2000-page, 6.5 MB PDF processed in 5.2 s into 5.4 MB of
markdown, filed at `documents/…md`, with `search_chunks` afterwards resolving a
phrase on page 1450 to `pageStart: 1448, pageEnd: 1450`. The document's text
never appears in a tool response — what comes back is counts, a path and an
engine name.

The chatbot still writes the database row, because it is the only thing that
may: only the server knows the name a file converts to and where `routeFile()`
put it. Filing the markdown here and asking for a row afterwards is how the CLI
once ended up writing rows naming files the converter had already renamed.

The original is archived **in Azure**, under `uploads/<jobId>/`, not in
`original-files/` — it is the only copy that was never size-limited.
`delete_job` disposes of it.

### A worked sequence

```
create_project { project: "Acme Insurance", description: "…" }
→ { project: "Acme-Insurance", slugged: { from: "Acme Insurance", to: "Acme-Insurance" }, dbError: null, adoError: null }

ingest_document { project: "Acme-Insurance", path: "/Users/me/policy.pdf" }
→ { jobId: "j-…", bytes: 6543826, converter: "markitdown", pages: 2000,
    filename: "policy.md", storedPath: "documents/policy.md" }

start_stage { workflow: "capabilities", project: "Acme-Insurance" }
→ { issueId: "…", state: "todo" }

issue_status { issueId: "…" }
→ { status: "in_review", gate: { id: "…" } }

approve_gate { gateId: "…" }
→ { decision: "approved" }
```

## Moving to Azure

Everything here runs against Azurite. Design spec §12 records the deltas so
"local first" does not quietly become "local only":

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

Most of those rows are configuration — a connection string, an endpoint URL, an
auth middleware swapped in. **Two rows are genuinely code, not config**, and
both are already isolated behind a single module each for exactly this
reason: the queue client (`src/shared/storage.ts`, the `queue()` accessor
used everywhere a message is sent or received) and `mintUploadSas`
(`src/shared/sas.ts`) — the entire service-SAS-vs-user-delegation-SAS switch
is contained in that one function, and nothing outside it needs to know which
kind of SAS it is holding.

**The sandbox question, largely answered by `upload_file`.**
`scripts/upload.mjs` PUTs straight from the caller's machine to the signed
URL. Locally that URL points at `127.0.0.1`, which is exactly what Codex's
shell sandbox permits — its outbound network access is loopback-only. A SAS
pointed at a public Azure endpoint would not be reachable from inside that
sandbox without a network exception. `upload_file` sidesteps this: the PUT is
made by the orchestrator process, which is not inside the sandbox, so the
sandbox's loopback-only rule never applies to it. The fallback path still
carries the original constraint, which is one more reason it is the fallback.

**Where `upload_file` needs more before it leaves this machine.** It is gated
off by default the moment `MCP_BEARER_TOKEN` is set, because a path is only
meaningful where the caller and the server share a filesystem. If a future
deployment wants both — a token AND local paths, e.g. a per-user orchestrator
on a workstation — the gate can be forced back on, but the tool should
probably grow an allowlist of permitted root directories first
(`LOCAL_UPLOAD_ROOTS`, not built). Today the only restraint beyond the gate is
the extension whitelist, which confines it to `.pdf` / `.docx` / `.txt` /
`.md`; that is a real limit, not a permission model.
