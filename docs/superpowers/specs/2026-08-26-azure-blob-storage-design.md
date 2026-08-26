# Azure Blob as the only place bytes live

**Date:** 2026-08-26
**Status:** design, approved in principle — not yet planned or built

## The rule

1. No file content in Postgres and none durably on disk.
2. Files go to Azure Blob Storage — staged blocks above a threshold, a single
   PUT below it.
3. Postgres holds the Azure path and the metadata around it. Nothing else.
4. The orchestrator, the MCP planes and every script read from Azure. Disk is a
   scratch surface for the duration of one run and is deleted afterwards.

## Why, measured

Three ceilings were hit in one day, all of them symptoms of one cause — content
travelling through places that were never meant to hold it.

| Ceiling | Where | Whose |
|---|---|---|
| 100 MB | `multer` on the chatbot's upload routes | ours |
| ~75 MB | a document base64'd into the orchestrator's 100 MB JSON body | ours |
| **384 MB** | V8's 512 MB `MAX_STRING_LENGTH`, ÷1.33 for base64 | not ours |
| **1 GB** | Postgres `bytea` per field | not ours |

A 300 MB markdown was streamed to Azure in 8 MiB blocks, converted there, then
**downloaded into a Buffer, copied into a Blob, and posted as multipart** — about
900 MB resident across two processes, to move a file that was already in Azure —
and refused at the last step with an unexplained 500.

The last leg undid the streaming every other leg did. That is the shape of the
whole problem: Azure already holds the bytes, and everything downstream insists
on carrying them somewhere else.

Alongside it, three stores disagreed about what a project contains — the folder
tree, `blobs.content` in Postgres, and the plugin's `workspace` blob container —
with nothing reconciling them. `core/materialise.ts` states that "the store is
the system of record now"; `materialise()` and `harvest()` are exported and
**called by nothing**. The intent was written and never wired.

## What does NOT change

The skills and scripts read files **by path**. Every `SKILL.md` names
`projects/<p>/description.md`; `stage.mjs`, `extract-documents.mjs`,
`render-companion-app.mjs` and ~5,000 lines besides walk
`projects/<project>/<feature>/…`; Claude Code and Codex use Read and Glob against
real paths.

None of that is rewritten. They take their root as a parameter already, so they
receive a different one. This is the reason a scratch tree exists at all, and the
reason the alternative — every skill and script fetching from Azure — was
rejected: it is a rewrite of the pipeline to solve a plumbing problem.

`DocumentStore`'s interface does not change either. Its own header anticipated
this exact swap:

> Behind an interface because the backend is a decision that may be revisited:
> bytes in Postgres is simple … but a companion app is 3 MB and a wireframe PNG
> is not small. **Swapping in an object-store backend must not touch a single
> caller.**

## Design

### 1. The byte store, content-addressed in Azure

`blobs.content bytea` is dropped. `blobs` keeps `sha256`, `bytes`,
`content_type`, `created_at` and gains **`blob_path text`**.

The blob name **is** the hash — `documents/<aa>/<bb>/<full-sha256>`, two levels
of fan-out so one container does not carry a single flat namespace of millions of
keys.

Content addressing is kept rather than replaced by a per-document path, because
two properties depend on it and both are load-bearing:

- **Dedup.** The same 4 MB `.docx` uploaded to three features stores one blob.
- **The harvest contract.** `put()` answers `changed: false` when the bytes at a
  path already match, which is what lets a caller write a whole materialised tree
  back and believe the answer. With content addressing that comparison is a hash
  lookup — **no download, no egress** — which is what makes harvesting a
  forty-file tree after a one-file change cheap.

Writes are idempotent by construction: a blob whose name is its own hash is
either already there or is uploaded once. There is no overwrite case to reason
about, and no versioning needed at the blob layer — `documents` already carries
`version` and `is_current`.

**Deletion.** `remove()` continues to mark the document row deleted and never
touches the blob, because other paths and versions may share those bytes. Blob
reclamation is a separate, later, reference-counted sweep — not part of this.

### 2. Uploads stream to Azure

The chatbot's upload routes stop writing a folder tree and stream to the store.
Above 8 MiB the staged-block path the plugin already implements
(`upload-file.ts`, 8 MiB blocks, 4-way concurrency); below it, a single PUT.

`multer.memoryStorage()` goes with it. The 100 MB cap and the base64 JSON hop
both stop existing rather than being raised — raising them would have moved the
failure, since 384 MB and 1 GB are not ours to move.

`ingest_document`'s final leg stops being `downloadToBuffer` → `Blob` →
multipart. The markdown is already in Azure; what moves is a reference.

### 3. Postgres holds the path

Rule 3, satisfied by `blobs.blob_path`. No content column anywhere.

### 4. A scratch tree per run

Wire what exists:

```
createWorkRoot()      mkdtemp under the OS temp dir
materialise()         store → tree, per project + its features
<the run>             agents and scripts, unchanged, given this root
harvest()             tree → store, diffed against the manifest
discardWorkRoot()     rm -rf
```

Two rules the transport must enforce, not convention:

- **`original-files/` is never materialised.** It is the archive of raw uploads
  and the only thing that reaches gigabytes. It lives in Azure and nothing pulls
  it down. Today `syncDown` would drag it onto a container happily.
- **A size ceiling, refused loudly.** Materialise refuses above a configured
  total and fails with what it was asked to place, so a container can never be
  filled by a document nobody expected.

**Measured, so the ceiling is set from data rather than guessed:** SAPN_DEMO's
whole working set is **8 MB** (1 MB of that originals, excluded);
`generated-apps/` is **3 MB**. A scratch tree is converted markdown, JSON, a few
screenshots and a rendered page — tens of megabytes. Azure Container Apps
provides ~1–2 GB of ephemeral disk per replica.

Harvest stays **non-destructive**: a file that vanished from the tree is
reported, never deleted from the store. An agent that crashes mid-write must not
turn into permanent data loss, and after this change there is no second copy to
recover from.

### 5. Generated apps

`generated-apps/<project>/` is served off disk today. It becomes a harvested
artefact like any other and is streamed from Azure by the companion-app routes.
It is also the largest single artefact (3 MB, one self-contained HTML page), so
it is the first thing to check when sizing the ceiling in §4.

### 6. The plugin's `workspace` container

`syncUp` currently mirrors the tree to blob as an export, and `syncDown` has no
production caller. Once the store IS Azure, that container is a third copy of
material the store already holds. It is retired, and `test/sync-one-way.test.ts`
retired with it — that guard exists to stop blob becoming a second opinion, and
after this change blob is the only opinion.

### 7. Migration

One script, plan-then-apply, in the shape of `sync:docs`:

- every `blobs.content` row → Azure, `blob_path` written back, column dropped
  after a verified pass;
- the project trees currently on disk → the store;
- a report of anything that resolves to neither.

## Staging

Each stage leaves the system working. This is not a session's work and it will
break things if done as one change.

| # | Stage | Visible effect |
|---|---|---|
| 1 | Azure backend behind the unchanged `DocumentStore` interface, chosen by config, defaulting off | none — dead code until flipped |
| 2 | Migration script; run it; flip the default | reads and writes go to Azure; disk unchanged |
| 3 | Upload routes stream to the store instead of writing the tree | the ceilings disappear |
| 4 | Wire `materialise`/`harvest` into the engine's agent steps | disk becomes scratch |
| 5 | Companion app served from the store; `workspace` container retired | one store |
| 6 | Drop `blobs.content` | Postgres holds paths only |

## Risks

- **Egress and latency.** Every run now pulls its tree over the network. Small in
  absolute terms (tens of MB) but no longer free, and a slow pull delays every
  stage. Materialise is the place to measure.
- **A half-harvested run.** If harvest fails partway, the store holds some of a
  run's output and not the rest. Harvest is non-destructive and idempotent, so
  the recovery is to re-run — but the failure must be loud, and the issue must
  block rather than record `succeeded`.
- **Azure availability becomes a hard dependency.** Today a failed blob sync is
  reported and ignored because the tree is real. After this there is no tree: an
  Azure outage stops the pipeline. That is the honest cost of one store.
- **`original-files/` exclusion is load-bearing.** If it is ever materialised by
  accident, a container fills. It needs a test, not a comment.

## Out of scope

Per-user authentication, connection pooling, and a run-concurrency cap. All three
are needed before multiple clients use this, and none of them is made better or
worse by this change — the order is independent.
