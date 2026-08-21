# One Azure DevOps project per Scyne project

**Date:** 21 August 2026
**Status:** design, awaiting review
**Supersedes:** the "One Azure DevOps target for the whole install" decision in
`2026-08-20-azure-devops-publishing-design.md` and the matching CLAUDE.md section.

---

## The change

Publishing currently goes to ONE Azure DevOps project for the entire
installation (`ADO_PROJECT`, "Scyne AI Project"), and every client's work is
kept apart by burying it under a wiki path prefix — `/Scyne/<project>/…`. The
prefix exists only to stop tenants colliding inside a shared project.

Each Scyne project gets its **own** Azure DevOps project, created from the name
the user enters. The prefix then has nothing left to disambiguate and is
removed.

| | Now | After |
|---|---|---|
| ADO project | `ADO_PROJECT`, one per install | one per Scyne project, created on demand |
| Project artefact | `/Scyne/SAPN/Capability & Process Map` | `/Capability & Process Map` |
| Feature artefact | `/Scyne/SAPN/Appeals/Salesforce Data Model` | `/Appeals/Salesforce Data Model` |
| Work item type | `ADO_WORK_ITEM_TYPE=Issue`, global | `User Story`, per project |

## Decisions taken

| Question | Answer |
|---|---|
| When is the ADO project created? | In the New Project wizard — `POST /api/projects` |
| Process template | **Agile** (Epic → Feature → User Story → Task) |
| SAPN's two live pages | Left exactly where they are |
| Name derivation | The Scyne project name **verbatim**; refuse if ADO rejects it |
| `ADO_PROJECT` | Deleted, via a one-off backfill of SAPN |

## What was verified against the live API first

Not assumed — measured, before any of this was designed:

- **The PAT can already create projects.** A `POST /_apis/projects` with a
  deliberately unusable name (`zz/invalid*probe`) returned **400
  `TF50316: The following name is not valid`**, not 401. Azure DevOps reports a
  missing scope as 401 (the trap CLAUDE.md documents), so 400 is positive
  evidence that `vso.project_manage` is present. **No new token scope is
  needed.**
- **ADO validates names for us.** That same `TF50316` covers length, illegal
  characters and reserved names. "Refuse if invalid" is therefore one API call
  whose message we surface verbatim — not a regex we write and maintain against
  rules Microsoft can change.
- **Process template ids are stable but discoverable.** Agile is
  `adcc42ab-9882-485e-a3ed-7678f01f66bc` in this organisation. The
  implementation still looks it up by name via `GET /_apis/process/processes`,
  because a hardcoded GUID is a silent failure on any other organisation.
- **The current shared project runs Basic** — its work item types are `Issue,
  Epic, Task, …` with no `User Story`. This is exactly why
  `ADO_WORK_ITEM_TYPE` defaults to `Issue` today, and why Agile changes it.

## The latent bug this uncovers

`.published.json` exists so "a later revision updates that page instead of
creating a second one". **That is not implemented.** `readPublished` is
imported at `scripts/ado-publish.mjs:40` and never called; the page path comes
solely from `--path`, which the workflow fills from `wikiPathTpl`.

The file is therefore write-only with respect to the publish path — it records
where a page went and never steers anything back there. It has worked until now
only because the template has never changed.

The moment `wikiPathTpl` changes, that stops being harmless: SAPN's next
revision would republish its capability map to `/Capability & Process Map` at
the **root of the shared wiki**, leaving the original orphaned at
`/Scyne/SAPN/…`. Fixing this is a precondition of the backfill, not an
optional extra.

**Fix:** a recorded `wikiPath` wins for any artefact that has been published
before. `wikiPathTpl` decides a **first** publish only.

This is what makes "leave SAPN where it is" cost nothing: no legacy flag, no
per-project branch in the path logic, no special case anywhere. SAPN keeps its
recorded paths because they are recorded.

---

## Design

### 1. The target, recorded once

`POST /api/projects` resolves the Azure DevOps target and writes it to
`projects/<project>/.published.json` as a **new top-level key**:

```json
{
  "adoTarget": {
    "org": "Scyne-AI-Lab",
    "project": "SAPN",
    "wiki": "SAPN.wiki",
    "wikiId": "…",
    "processTemplate": "Agile",
    "workItemType": "User Story",
    "createdAt": "2026-08-21T…"
  },
  "ado": {
    "capabilities": { "wikiPath": "…", "pageId": 22, … }
  }
}
```

`ado` keeps holding per-artefact records, untouched, so every existing reader
(`verify-published.mjs`, `readPublished`) keeps working against the shape it
knows.

The alternative — re-deriving "ADO project = Scyne project name" at each of the
five call sites — was rejected: it breaks on a Scyne project rename, and gives
`check:routing` nothing to assert against.

### 2. Creation, in the wizard

`POST /api/projects` gains a step, after the folder tree and before branding:

1. `GET /_apis/process/processes` → the id for `Agile`, by name.
2. `POST /_apis/projects` with `{ name, capabilities: { versioncontrol:
   { sourceControlType: "Git" }, processTemplate: { templateTypeId } } }`.
3. Poll the returned operation id until `succeeded` / `failed`, with a timeout.
4. Create the project wiki (`type: "projectWiki"`).
5. Confirm `User Story` exists in the new project, by name.
6. Write `adoTarget`.

Failing here is cheap: the user is still in the wizard, nothing has been
generated, and ADO's own error text is what they see. This is the reason
creation is not lazy — at approval time the same failure arrives after a
document has been built and a human has approved it.

**Where it sits in the route, and what happens when it fails.** The wizard runs
validate name → `409 exists` check → folder tree → `description.md` → branding.
Azure DevOps creation goes **after the folder tree and before branding**, and
that ordering has a consequence worth stating: a failure there leaves a local
project that exists with no `adoTarget`, and the `409 exists` check then blocks
the obvious fix of running the wizard again.

So creation must be **resumable, not all-or-nothing**:

- The wizard returns `201` with the project created locally and an explicit
  `adoError` in the body. It does not pretend to have failed — the folder tree,
  the definition and the branding are all real and worth keeping.
- A project with no `adoTarget` is **incomplete, not broken**. Re-running
  creation against it completes the missing step instead of returning `409`.
- Nothing downstream may assume `adoTarget` exists. A publish against a project
  without one blocks with "this project has no Azure DevOps target — finish
  creating it", which is a caller error with an obvious fix, not a mid-run
  mystery.

Note that the wizard's own name check (`letters, numbers, spaces, and . _ & -`)
is **more permissive than ADO's** — `&` is accepted locally and rejected by
`TF50316`. That is fine and deliberate: ADO is the authority, and its message
is surfaced rather than second-guessed. It does mean a name can pass step one
and fail at creation, which is exactly the case the resumable path above
exists for.

**This reverses `adoVerify.ts`'s "VERIFY ONLY, NEVER CREATE" rule**, whose
stated reason was that a half-created project is worse to hand a client than a
clear refusal. That reasoning holds and is why creation is confined to one
place, polls to a terminal state, and reports the operation's own failure
message rather than a generic one. `adoVerify` keeps verifying at the gate; it
does not gain creation.

### 3. Paths

```ts
const wikiPathTpl = (s: Stage): string =>
  isProject(s) ? `/${s.label}` : `/{feature}/${s.label}`;
```

`parentPagesTpl` already derives from `wikiPathTpl` by dropping the last
segment, so it needs no change and cannot describe a stale shape: a project
artefact yields `[]`, a feature artefact yields `["/{feature}"]`. Its warning
about detached pages stays true for the feature case.

### 4. Work item type

`adoTarget.workItemType` replaces the `ADO_WORK_ITEM_TYPE` environment default.
Agile projects have a real `User Story`, which is what
`requirement-generator/SKILL.md`'s house style has always described.

`ado-workitems.mjs` keeps discovering the type itself — that behaviour is
unchanged and remains the fallback.

### 5. The SAPN backfill

A one-off, hand-written `adoTarget` on the one project that predates this:

```json
"adoTarget": {
  "org": "Scyne-AI-Lab",
  "project": "Scyne AI Project",
  "wiki": "Scyne-AI-Project-Wiki",
  "wikiId": "a4ca915c-fc13-43a4-9e99-1097ec5d69c1",
  "processTemplate": "Basic",
  "workItemType": "Issue",
  "backfilled": "2026-08-21"
}
```

With §2's recorded-path rule in place, SAPN's two artefacts keep publishing to
`/Scyne/SAPN/…` in the shared project, because that is what their `ado` entries
already say. Nothing moves and nothing is deleted.

`backfilled` marks it as a legacy row rather than something the wizard created.

### 6. Retiring `ADO_PROJECT`

Once SAPN carries an `adoTarget`, no code path needs the variable. Removed
from `.env.example`, `scripts/lib/ado.mjs`, `adoVerify.adoConfigured()`, and
the three reads in `scyne-chatbot/server/index.ts`.

`ADO_ORG` **stays** — one organisation still holds every project, and a new
project must be created somewhere.

---

## Files touched

| File | Change |
|---|---|
| `scyne-chatbot/server/index.ts` | wizard creates the ADO project; drop 3 `ADO_PROJECT` reads |
| `scyne-chatbot/server/services/adoVerify.ts` | `ensureProject()`; verify against `adoTarget` |
| `orchestrator.workflows.ts` | `wikiPathTpl`; publish prompt resolves target from `adoTarget` |
| `scripts/ado-publish.mjs` | **call `readPublished`** — recorded path wins on republish |
| `scripts/lib/ado.mjs` | drop the `env.ADO_PROJECT` fallback |
| `scripts/ado-workitems.mjs` | project + work item type from `adoTarget` |
| `scripts/check-routing.mts` | expected params no longer include a global `adoProject` |
| `scyne-chatbot/server/orchestrator.ts` | title/description → param mapping |
| `projects/SAPN/.published.json` | the backfill |
| `.env.example` | `ADO_PROJECT` and `ADO_WORK_ITEM_TYPE` removed |
| `CLAUDE.md` | the "One Azure DevOps target" and "never create" sections |

## Testing

- **`npm run check:routing`** — every chatbot title/description still routes to
  the right workflow with the right params. Must be updated and must pass.
- **`npm run check:workflows`** and the orchestrator suite — `wikiPathTpl` and
  `parentPagesTpl` for both levels; a project artefact must yield no parent.
- **`ado-publish.mjs` path resolution** — a new unit test: with a recorded
  `wikiPath`, republish targets the recorded path, not the template. This is
  the test the current code would fail, and the one the backfill rests on.
- **Project creation** — against a real organisation, once, with a throwaway
  name, then deleted by hand. The name-validation path is already proven by the
  `TF50316` probe above.
- **The resumable path** — a project whose ADO creation failed must not be left
  stranded: re-running creation completes it rather than returning `409`, and a
  publish attempted before then blocks with a message naming the missing step.
  Testable without touching ADO by stubbing the creation call to fail.
- **Not covered by automation:** that a created project's wiki is reachable by
  browsing. Verify by eye on the first real one.

## Risks

- **Creating a project is not reversible from here.** The first project created
  after this ships gets a real ADO project. Deleting one is a manual,
  destructive act in the ADO UI.
- **Organisation project limits.** One ADO project per client will hit a
  ceiling that one shared project never would. Not a blocker at current scale;
  worth knowing before a bulk import.
- **A failed create leaves a partial project.** Mitigated by polling to a
  terminal state, reporting the operation's own error, and writing `adoTarget`
  only when every step succeeded — a half-written target is worse than none,
  because a later publish would trust it. The resumable path in §2 is what
  makes the "none" case recoverable.
- **`ADO_WORK_ITEM_TYPE` disappearing** is a behaviour change for anyone
  running the scripts by hand. `ado-workitems.mjs` still discovers the type, so
  the failure mode is a correct guess rather than a crash.

## Out of scope

- Migrating SAPN. Explicitly decided against.
- Deleting or redirecting the existing `/Scyne/SAPN/…` pages.
- Per-project Azure DevOps **organisations** — one org still holds everything.
- Choosing the process template per project. Agile is fixed for now; the field
  exists in `adoTarget` if that changes.
