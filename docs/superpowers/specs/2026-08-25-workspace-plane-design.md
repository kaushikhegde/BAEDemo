# Phase 2: The Workspace Plane

**Date:** 2026-08-25
**Status:** Design, awaiting review
**Branch:** `plugin`
**Follows:** `docs/superpowers/specs/2026-08-24-codex-azure-file-processing-design.md` (Phase 1, shipped as commit `1a8e556`)

---

## 1. What this is

Phase 1 built the **file plane**: a Codex plugin (MCP server `scyne`) that puts a
document in blob storage and lets a model read it back in pieces. It works, and
it is committed.

Phase 2 connects that to the **Scyne pipeline** — the capability maps, personas,
requirements, data models and test packs this repository already produces. Two
components, independent of each other:

- **A sync layer** that makes Azure Blob the durable home of `projects/`, with
  the local tree demoted to a disposable cache.
- **A second MCP server** that lets Codex drive and observe the existing
  orchestrator, so work started from Codex is tracked exactly like work started
  from the chatbot or the CLI.

Neither changes how a skill reads a document. That is the decision everything
else follows from.

---

## 2. Decisions taken

Recorded so a later reader does not reopen a settled question.

| # | Decision | Why |
|---|---|---|
| 1 | **Blob is the source of truth, mirroring the local folder structure.** A document lives at `SAPN/MVP/requirements/SOP/policy.md`, not at an opaque key. | The hierarchy is how the team already thinks, and it makes the migration a copy rather than a mapping. |
| 2 | **Skills are not rewritten.** A stage syncs its subtree down and reads files exactly as it does today. | Rewriting how eight skills consume input, then re-testing each against real projects, is a far larger and riskier change than the one being asked for. |
| 3 | **Single machine. Blob wins; local is disposable.** | Nobody else works on these projects concurrently. No locking, no conflict resolution, no coordination protocol. |
| 4 | **MCP server 2 is a front door to the EXISTING orchestrator**, not a second tracking system. | The orchestrator already records issues, runs, cost, gates and an audit feed. A parallel system would drift. |
| 5 | **Every creation writes BOTH stores**, exactly as `cli/dual.ts` does. | This repo has already been burned by a surface that wrote only the tree; see §5. |
| 6 | **Workspace CRUD is in scope after all** — reversing an earlier cut — because decision 5 needs a place to live. | With sync handling reads, CRUD exists to guarantee the dual-write, not to serve documents. |

### The consequence worth stating plainly

**This does not reduce context cost.** A capability map on SAPN_DEMO reads 92
files totalling 3.85 MB — roughly 986,000 tokens — and it will still read all of
them afterwards. Phase 1's `search_chunks` / `fetch_chunks` remain available for
a model to explore a document ad hoc, but the pipeline will not use them.

That was chosen with the number in view. If reducing that figure becomes the
goal, the design changes materially: skills would have to read through the tools,
and each would need re-testing. It is a different project, not a later step of
this one.

---

## 3. What Phase 1 left, and what changed under it

Phase 1 shipped and was then extended by a concurrent session. Phase 2 builds on
the current state, not on Phase 1's spec:

- The MCP server key is **`scyne`**, not `azure-files`.
- It exposes **eight** tools: the original seven plus **`upload_file`**, which
  takes an absolute local path and streams the bytes server-side. It is gated
  behind `allowLocalPathUpload`, which defaults off whenever `MCP_BEARER_TOKEN`
  is set — a remote server resolving a local path would read whatever sits at
  that path on the server.
- **`stack.sh up` runs the orchestrator natively**, with Azurite and workers in
  Docker. `up --all-docker` restores the all-container behaviour.

Phase 2 must not assume three Compose services are running.

---

## 4. Component A — the sync layer

### Shape

```
Azure Blob (source of truth)          local projects/ (cache)
  SAPN/MVP/requirements/SOP/a.md  ←→    projects/SAPN/MVP/requirements/SOP/a.md
  SAPN/documents/policy.md        ←→    projects/SAPN/documents/policy.md
  SAPN/MVP/outputs/stories.json   ←→    projects/SAPN/MVP/outputs/stories.json
```

One container, `workspace`, separate from Phase 1's `uploads` and `artifacts`.
Blob paths are the local path with the `projects/` prefix removed, so the mapping
is mechanical and reversible with no lookup table.

### Interface

```
syncDown(project, opts?) → { pulled: n, skipped: n, bytes: n }
syncUp(project, opts?)   → { pushed: n, skipped: n, bytes: n }
syncStatus(project)      → { onlyLocal: [...], onlyBlob: [...], differing: [...] }
```

`opts.prefix` narrows to a subtree (`MVP/requirements`), which is what a feature
stage needs. `opts.dryRun` reports without moving anything.

### How it decides what to move

Each blob carries the local file's **SHA-256 in its metadata**. A file whose hash
matches is skipped. This is content-addressed rather than mtime-based, because a
sync-down rewrites mtimes and an mtime comparison would then push everything
straight back.

`syncStatus` never mutates; it is what a user runs when they want to know before
they act.

### Conflict rule

**Blob wins on `syncDown`. Local wins on `syncUp`.** There is no merge, because
decision 3 says there is exactly one machine. A file changed in both places is
reported by `syncStatus` as `differing`, and the user picks a direction.

Nothing is ever deleted implicitly. A file present in one place and absent in the
other is reported, not removed — an accidental `rm -rf projects/` followed by a
`syncUp` must not empty the blob store.

### Hooks — three, and only three

| Where | What |
|---|---|
| `scripts/stage.mjs` | `syncDown(project, { prefix })` before staging, so a stage always works from the authoritative copy |
| `scyne-chatbot/server` upload routes | after conversion and archiving, `syncUp` the touched paths |
| `orchestrator.workflows.ts` | a final `exec` step per stage: `npm run sync -- "{project}" --up --prefix <the stage's produces>` |

The third deserves precision, because "on stage completion" could mean three
different places. It is an **`exec` step appended to each compiled workflow**,
after `attach` and the publish step. That site is chosen because:

- workflows are compiled from `scripts/pipeline.mjs`, so adding the step once in
  `orchestrator.workflows.ts` gives every stage the behaviour for free — the same
  property that makes "add a stage, get a workflow" true;
- an `exec` step that exits non-zero blocks the issue with the real stderr, so a
  failed sync is visible rather than silent;
- it runs after `attach`, so a sync never races the agent still writing.

It uses each stage's own `produces[]` as the prefix, which is already declared in
`pipeline.mjs` and is level-relative — `projects/<p>/` for a project stage,
`projects/<p>/<feature>/` for a feature stage. Resolving those against the
workspace root instead is the exact mistake that blocked a completed run during
the Phase 1 prototype.

Note this is the one place Phase 2 touches the compiled workflows, and
`npm run check:workflows` asserts their shape — it must be run after the change.

Everything else in the repo — the other ~39 files that read `projects/` — is
untouched and stays unaware that blob exists.

### CLI

```bash
npm run sync -- SAPN --down          # blob → local
npm run sync -- SAPN --up            # local → blob
npm run sync -- SAPN --status        # what differs, moving nothing
npm run sync -- SAPN --down --prefix MVP/requirements
```

---

## 5. Component B — MCP server 2 (`scyne-workspace`)

A distinct key in `.mcp.json`; `scyne` is taken by the file plane.

### Job 1 — a front door to the orchestrator

Thin HTTP client over the existing API, authenticating with
`Authorization: Bearer` (`auth-middleware.ts` accepts
`bearerFrom(headers) ?? cookieCredential(headers)`). No business logic: every
tool is a shaped call to an endpoint that already exists.

| Tool | Wraps | Notes |
|---|---|---|
| `start_stage` | `POST /issues` | `{ workflow, project, feature? }`. Returns the issue id. Answers 202 — it does not wait. |
| `issue_status` | `GET /issues/{id}` + `/comments` | State, current step, gate, and the narration the engine posts |
| `list_issues` | `GET /issues` | Filterable by project, feature, status |
| `approve_gate` / `reject_gate` | `POST /gates/{id}/approve\|reject` | Reject takes a note |
| `pause_issue` / `resume_issue` | `POST /issues/{id}/pause\|resume` | The control-request verbs |
| `spend` | `GET /usage` | Passes the upstream 403 through rather than flattening it to an empty table |

Because these are the same endpoints the chatbot and CLI use, a stage Codex
starts appears in `/orch`, Issues, Spend and Actions with no extra work.

### Job 2 — workspace CRUD, and the dual-write it exists to guarantee

| Tool | Writes |
|---|---|
| `create_project` | folder tree **and** `projects` row |
| `create_feature` | folder tree **and** `features` row |
| `attach_document` | file on disk, blob copy, **and** document row |
| `list_projects` / `list_features` / `list_documents` | reads, reported from **disk**, each row flagged with whether its database row exists |

**These go through the chatbot's existing routes** (`POST /api/projects`,
`POST /api/features`, `POST /api/upload`), which already scaffold the tree, write
the row via `store.createProject` / `createFeature` / `createDocumentRow`, pull
branding and convert documents on arrival. MCP 2 does not reimplement any of it.

That is the whole point. This repository has already been burned once by a
surface that wrote only the tree: a project created in the web wizard existed for
every agent and for no API, its definition silently failed to save, and
`/spend?by=project` filed every run under one anonymous row because
`repo.createIssue` resolves `params.project` into `issues.project_id` **by name**
and there was nothing to resolve to. `cli/dual.ts` was written to stop exactly
that. MCP 2 is a third surface, and it inherits the same obligation.

A failure of the database half is **reported, never swallowed** — the response
carries `dbError`, as the chatbot's own routes do, because everything that
resolves a project by name stays broken until the row exists.

### On Postgres

Projects are **already** in a `projects` table
(`packages/orchestrator/migrations/002_platform.sql:79`), and the driver already
supports a real server: `db.ts` offers `"pglite" | "native" | "external"`. Moving
off PGlite is a connection string, not a migration.

So "store projects in Postgres" needs no schema work in Phase 2. What it needs is
decision 5 honoured by every write, which is what Job 2 is for.

---

## 6. What changes and what does not

**New:** the sync module, its CLI, MCP server 2, one `.mcp.json` entry.

**Modified:** `scripts/stage.mjs` (one call), the chatbot's upload routes (one
call), stage completion (one call).

**Untouched:** all eight skills, the orchestrator, the console, the chatbot UI,
and the ~39 other files that read `projects/`.

**Deliberately not built:** publishing tools (the ADO scripts already work and
the publish step is inside the workflow, not outside it); artefact read/write
tools (sync handles them); any merge or locking machinery (decision 3).

---

## 7. Failure behaviour

Phase 1's weakest area was error paths — two tasks leaked temp files, one could
crash the worker through an unlistened stream error. The same scrutiny applies:

- A sync interrupted part-way leaves both stores **valid but divergent**, and
  `syncStatus` names every file that differs. Nothing is left half-written: each
  file is uploaded or downloaded whole, then verified by hash.
- A `syncDown` never deletes a local file that is absent from blob, and a
  `syncUp` never deletes a blob absent locally. Deletion is always explicit.
- MCP 2 passes an orchestrator error through verbatim rather than reshaping it. A
  502 from the orchestrator must not become a cheerful empty result.
- If the orchestrator is unreachable, every tool in Job 1 fails with a message
  saying so and naming the URL it tried — not a timeout with no explanation.

---

## 8. Testing

| Claim | Assertion |
|---|---|
| Blob mirrors the tree | Round-trip a real project: `syncUp`, delete the local tree, `syncDown`, and diff — byte-identical, same paths |
| Unchanged files are skipped | A second `syncUp` with no edits reports `pushed: 0` |
| No implicit deletion | A file present in one store only is reported by `syncStatus` and still present after a sync in either direction |
| A stage works from blob | Delete the local tree, run a feature stage, and confirm it completes — proving `stage.mjs`'s hook is load-bearing |
| Dual-write holds | `create_project` via MCP 2, then assert both the folder tree **and** the `projects` row exist. Then assert the failure path reports `dbError` rather than returning success |
| Codex-started work is tracked | `start_stage` through MCP 2 produces an issue visible in `GET /issues`, with runs and an audit row |
| Errors surface | With the orchestrator stopped, every Job 1 tool fails naming the URL |

Integration tests run against real Azurite and a real orchestrator, sequentially,
as Phase 1's do. Any test that could pass while the property it names is false is
a defect — Phase 1 found several of those and the same bar applies.

---

## 9. Phasing

**2a — the sync layer.** Module, CLI, three hooks, tests. Delivers blob as the
source of truth on its own; nothing depends on MCP 2.

**2b — MCP server 2.** Job 1 then Job 2. Depends on 2a only for `attach_document`.

They are independent and either is useful alone.

---

## 10. Open question, recorded rather than hidden

`upload_file` (Phase 1, added by the concurrent session) streams a local path
into the `uploads` container for **processing**. `attach_document` (Phase 2) puts
a document into the `workspace` container as **project material**. A user will
reasonably expect one call to do both — attach a document to a feature *and* make
it searchable.

This design keeps them separate, because the containers have different
lifecycles: `uploads` is transient and `delete_job` reclaims it, while
`workspace` is durable. Whether `attach_document` should also kick off a
processing job — returning a `jobId` alongside the path — is left for after 2a,
when the actual usage is visible rather than guessed at.
