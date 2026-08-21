# One Azure DevOps Project Per Scyne Project — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every Scyne project its own Azure DevOps project, created from the name the user enters, and drop the `/Scyne/<project>/` wiki prefix that only existed to keep tenants apart inside one shared project.

**Architecture:** The Azure DevOps target is resolved once, when the project is created, and recorded in `projects/<project>/.published.json` as a new top-level `adoTarget` key. Everything downstream reads it from there. A precondition is fixing a latent bug: `.published.json` records where a page was published but never steers a republish back to it, so changing the path template would silently move pages that already exist.

**Tech Stack:** TypeScript (chatbot Express server, orchestrator), plain ESM `.mjs` (publishing scripts), vitest (orchestrator suite), `node --test` (cli and scripts), Azure DevOps REST API 7.1.

**Spec:** `docs/superpowers/specs/2026-08-21-ado-project-per-scyne-project-design.md`

## Global Constraints

- **Australian English** in all generated content and user-facing copy.
- **Do not `git commit`.** The user commits their own work. Every task ends with a verification step instead; leave changes in the working tree.
- **Azure DevOps API version is `7.1`** — the `API` constant in `scripts/lib/ado.mjs`.
- **A 401 from Azure DevOps means a missing SCOPE, not a bad token.** Never write an error message that tells someone to regenerate their token on a 401.
- **`ADO_ORG` stays.** Only `ADO_PROJECT` and `ADO_WORK_ITEM_TYPE` are retired.
- **Agile process template**, resolved by NAME via `GET /_apis/process/processes`. Never hardcode the GUID — it is stable in this organisation and not guaranteed in another.
- **Nothing under `packages/orchestrator/` may import** `scripts/pipeline.mjs`, `orchestrator.config.ts`, `orchestrator.workflows.ts`, or anything under `projects/`. Root-level assertions belong in `scripts/check-workflows.mts`.
- **Verified, do not re-litigate:** the PAT already has `vso.project_manage` (a create with an invalid name returned `400 TF50316`, not 401). Agile is `adcc42ab-9882-485e-a3ed-7678f01f66bc` here. The existing shared project runs Basic, so its types are `Issue, Epic, Task, …` with no `User Story`.

---

## ⚠️ Read before touching `scyne-chatbot/server/index.ts`

**There are TWO `app.post("/api/projects", …)` handlers in that file** — one at **line 1480** and one at **line 2048**. Express matches the first registration, so **line 1480 is live and line 2048 is dead code**. The dead one predates the project-level restructure: it requires a `feature` in the body and creates a per-feature `design/` folder that moved up to the project long ago.

Editing the wrong one produces a change that type-checks, runs, and does nothing. **Task 4 modifies 1480 and deletes 2048.**

---

## File Structure

| File | Responsibility after this change |
|---|---|
| `scripts/lib/ado.mjs` | Adds `resolvePagePath()` and `readAdoTarget()`. `loadAdo()` stops falling back to `ADO_PROJECT` / `ADO_WORK_ITEM_TYPE`. |
| `scripts/lib/ado.test.mjs` | **New.** Unit tests for the two new helpers. |
| `scripts/ado-publish.mjs` | Resolves target from `adoTarget`; publishes to the recorded path when one exists. |
| `scripts/ado-workitems.mjs` | Takes project and work item type from `adoTarget`. |
| `scyne-chatbot/server/services/adoProject.ts` | **New.** `ensureAdoProject()` — create, poll, wiki, verify. Kept out of `adoVerify.ts` so that file keeps its single "verify only" job. |
| `scyne-chatbot/server/services/adoVerify.ts` | `adoConfigured()` stops reading `ADO_PROJECT`. Otherwise unchanged. |
| `scyne-chatbot/server/index.ts` | Wizard creates the ADO project (line 1480); dead route at 2048 deleted; 3 `ADO_PROJECT` reads removed. |
| `orchestrator.workflows.ts` | `wikiPathTpl` loses the `/Scyne/{project}` prefix; publish prompt resolves target from `adoTarget`. |
| `scripts/check-workflows.mts` | Asserts the new path shapes. |
| `scripts/check-routing.mts` | Expectations updated for the dropped global `adoProject`. |
| `projects/SAPN/.published.json` | The backfill. |
| `.env.example`, `CLAUDE.md` | Documentation of the retired variables and the reversed "never create" rule. |

---

## Task 1: A published page keeps its path

The precondition for everything else. `readPublished` is imported at `scripts/ado-publish.mjs:40` and never called; the page path comes only from `--path`. Until that is fixed, changing `wikiPathTpl` in Task 5 would republish SAPN's capability map to the root of the shared wiki and orphan the original.

**Files:**
- Modify: `scripts/lib/ado.mjs` (append after `recordPublished`)
- Create: `scripts/lib/ado.test.mjs`
- Modify: `package.json` (add `test:scripts`)

**Interfaces:**
- Produces: `resolvePagePath(template: string, publishedFile: string|null, artefactKey: string|null): Promise<string>`

- [ ] **Step 1: Write the failing test**

Create `scripts/lib/ado.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolvePagePath } from "./ado.mjs";

async function tmpPublished(contents) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ado-test-"));
  const file = path.join(dir, ".published.json");
  await fs.writeFile(file, JSON.stringify(contents), "utf8");
  return file;
}

test("falls back to the template when nothing has been published", async () => {
  const file = await tmpPublished({});
  assert.equal(await resolvePagePath("/New Page", file, "capabilities"), "/New Page");
});

test("a previously published artefact keeps its recorded path", async () => {
  const file = await tmpPublished({
    ado: { capabilities: { wikiPath: "/Scyne/SAPN/Capability & Process Map" } },
  });
  // This is the whole point: the template moved, the page must not.
  assert.equal(
    await resolvePagePath("/Capability & Process Map", file, "capabilities"),
    "/Scyne/SAPN/Capability & Process Map");
});

test("another artefact's record does not leak", async () => {
  const file = await tmpPublished({ ado: { personas: { wikiPath: "/Old/Personas" } } });
  assert.equal(await resolvePagePath("/Capability & Process Map", file, "capabilities"),
    "/Capability & Process Map");
});

test("a malformed record is ignored rather than trusted", async () => {
  const file = await tmpPublished({ ado: { capabilities: { wikiPath: "no-leading-slash" } } });
  assert.equal(await resolvePagePath("/Good", file, "capabilities"), "/Good");
});

test("no published file at all is not an error", async () => {
  assert.equal(await resolvePagePath("/Good", "/nonexistent/.published.json", "capabilities"), "/Good");
  assert.equal(await resolvePagePath("/Good", null, null), "/Good");
});
```

- [ ] **Step 2: Add the test script and run it to verify it fails**

Add to `package.json` scripts, after `test:cli`:

```json
"test:scripts": "node --test \"scripts/lib/*.test.mjs\"",
```

Run: `npm run test:scripts`
Expected: FAIL — `resolvePagePath` is not exported from `./ado.mjs`.

- [ ] **Step 3: Implement `resolvePagePath`**

Append to `scripts/lib/ado.mjs`:

```js
/**
 * The path an artefact's page is published at.
 *
 * `template` is where a FIRST publish goes. Once an artefact has been
 * published, its recorded `wikiPath` wins for good — a client has a link to
 * that page, and a change to the template must never silently move it and
 * leave the original orphaned.
 *
 * This is what `.published.json` has always been DESCRIBED as doing ("so a
 * later revision updates that page instead of creating a second one") and did
 * not do: `ado-publish.mjs` imported `readPublished` and then resolved the
 * path from `--path` alone. It was harmless only while the template never
 * changed.
 */
export async function resolvePagePath(template, publishedFile, artefactKey) {
  if (!publishedFile || !artefactKey) return template;
  const record = (await readPublished(publishedFile))?.ado?.[artefactKey];
  const recorded = record?.wikiPath;
  // A path that does not start with "/" is not one ADO can address, so it is
  // a corrupt record rather than an instruction — prefer the template.
  return typeof recorded === "string" && recorded.startsWith("/") ? recorded : template;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test:scripts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Use it in `ado-publish.mjs`**

In `scripts/ado-publish.mjs`, add `resolvePagePath` to the import at line 40, then replace the `pagePath` block (currently around lines 137-140):

```js
const publishedJson = typeof flags["published-json"] === "string" ? flags["published-json"] : null;
const artefactKey = typeof flags["artefact-key"] === "string" ? flags["artefact-key"] : null;

if (typeof flags.path !== "string" || !flags.path.startsWith("/")) {
  fail(`--path is required and must start with "/" (e.g. --path "/Appeals/Salesforce Data Model")`);
}
// `--path` is where a first publish goes. An artefact already recorded in
// .published.json keeps the path it was published at.
const pagePath = await resolvePagePath(flags.path, publishedJson, artefactKey);
if (pagePath !== flags.path) {
  say(`  note: already published at ${pagePath} — updating that page rather than ${flags.path}`);
}
```

Then update the recording block near line 183 to reuse the two constants:

```js
if (publishedJson && artefactKey) {
  await recordPublished(publishedJson, artefactKey, {
```

- [ ] **Step 6: Verify the whole script still parses and the flag still works**

Run: `node --check scripts/ado-publish.mjs && node scripts/ado-publish.mjs 2>&1 | head -3`
Expected: the usage line, no syntax error.

---

## Task 2: Scripts resolve their target from `adoTarget`

**Files:**
- Modify: `scripts/lib/ado.mjs` (`loadAdo`, plus a new `readAdoTarget`)
- Modify: `scripts/lib/ado.test.mjs` (append)
- Modify: `scripts/ado-publish.mjs:47-48`
- Modify: `scripts/ado-workitems.mjs:49`

**Interfaces:**
- Consumes: `readPublished` from Task 1's file.
- Produces: `readAdoTarget(publishedFile: string|null): Promise<{org?, project, wiki?, wikiId?, processTemplate?, workItemType?}|null>`

- [ ] **Step 1: Write the failing test**

Append to `scripts/lib/ado.test.mjs`:

```js
import { readAdoTarget } from "./ado.mjs";

test("reads an adoTarget", async () => {
  const file = await tmpPublished({
    adoTarget: { org: "Scyne-AI-Lab", project: "SAPN", workItemType: "User Story" },
  });
  const t = await readAdoTarget(file);
  assert.equal(t.project, "SAPN");
  assert.equal(t.workItemType, "User Story");
});

test("a target without a project is not a target", async () => {
  const file = await tmpPublished({ adoTarget: { org: "Scyne-AI-Lab" } });
  assert.equal(await readAdoTarget(file), null);
});

test("absent adoTarget and absent file both yield null", async () => {
  assert.equal(await readAdoTarget(await tmpPublished({ ado: {} })), null);
  assert.equal(await readAdoTarget("/nonexistent/.published.json"), null);
  assert.equal(await readAdoTarget(null), null);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test:scripts`
Expected: FAIL — `readAdoTarget` is not exported.

- [ ] **Step 3: Implement `readAdoTarget` and strip the env fallbacks**

Append to `scripts/lib/ado.mjs`:

```js
/**
 * The Azure DevOps target a Scyne project publishes to.
 *
 * Written once, when the project is created. There is no environment
 * fallback: one target for the whole installation is exactly what this
 * replaced, and falling back to one would send a client's document to
 * another client's project.
 */
export async function readAdoTarget(publishedFile) {
  if (!publishedFile) return null;
  const target = (await readPublished(publishedFile))?.adoTarget;
  return target && typeof target.project === "string" && target.project ? target : null;
}
```

In `loadAdo`, replace the two env-fallback lines:

```js
  const org = overrides.org || env.ADO_ORG;
  const project = overrides.project || null;   // ADO_PROJECT is retired: the
                                               // target comes from adoTarget
```

and the return's `workItemType`:

```js
    workItemType: overrides.workItemType || null,
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test:scripts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Resolve the target in both scripts**

In `scripts/ado-publish.mjs`, replace lines 47-48:

```js
const target = await readAdoTarget(
  typeof flags["published-json"] === "string" ? flags["published-json"] : null);

const ado = await loadAdo({
  org: flags.org || target?.org,
  project: flags.project || target?.project,
  workItemType: target?.workItemType,
});
if (!ado.project) {
  fail(
    `No Azure DevOps project.\n` +
    `  Pass --project, or point --published-json at a projects/<project>/.published.json\n` +
    `  carrying an "adoTarget". A project created before per-project targets needs one\n` +
    `  backfilled — see docs/superpowers/specs/2026-08-21-ado-project-per-scyne-project-design.md.`);
}
```

Add `readAdoTarget` to the import at line 40. Apply the same replacement to `scripts/ado-workitems.mjs:49`, using its own flag names for `--published-json`.

- [ ] **Step 6: Verify both scripts parse**

Run: `node --check scripts/ado-publish.mjs && node --check scripts/ado-workitems.mjs && echo OK`
Expected: `OK`

---

## Task 3: `ensureAdoProject()`

A new module rather than an addition to `adoVerify.ts`, whose header states it verifies and never creates. That file keeps that job; creation is a separate concern with a separate failure model.

**Files:**
- Create: `scyne-chatbot/server/services/adoProject.ts`

**Interfaces:**
- Produces:
  - `interface AdoTargetRecord { org, project, wiki, wikiId, processTemplate, workItemType, createdAt }`
  - `ensureAdoProject(opts: { org: string; project: string; processTemplate?: string; workItemType?: string }): Promise<{ ok: true; target: AdoTargetRecord } | { ok: false; error: string }>`

- [ ] **Step 1: Write the module**

Create `scyne-chatbot/server/services/adoProject.ts`:

```ts
/**
 * Create an Azure DevOps project for a Scyne project, and its wiki.
 *
 * This deliberately does NOT live in `adoVerify.ts`, whose contract is
 * "verify, never create". That rule was written because a half-created
 * project is worse to hand a client than a clear refusal — which is still
 * true, and is why everything here polls to a TERMINAL state and reports the
 * operation's own failure text rather than a generic one.
 *
 * What changed is only WHERE creation happens: in the New Project wizard,
 * where the user is still present and nothing has been generated yet — not at
 * an approval gate, after a document exists and a human has approved it.
 */

const API = "7.1";

export interface AdoTargetRecord {
  org: string;
  project: string;
  wiki: string;
  wikiId: string;
  processTemplate: string;
  workItemType: string;
  createdAt: string;
}

export type EnsureResult =
  | { ok: true; target: AdoTargetRecord }
  | { ok: false; error: string };

function pat(): string | null {
  return process.env.ADO_PAT || process.env.MCP_TOKEN_FOR_AZURE || null;
}

function headers(token: string): Record<string, string> {
  return {
    Authorization: "Basic " + Buffer.from(`:${token}`).toString("base64"),
    Accept: `application/json;api-version=${API}`,
    "Content-Type": "application/json",
  };
}

/** ADO answers a MISSING SCOPE with 401, so never advise regenerating a token. */
function explain(status: number, body: string): string {
  if (status === 401) {
    return "401 from Azure DevOps. The token is probably valid and missing a scope — " +
      "creating a project needs vso.project_manage, and a wiki needs vso.wiki_write.";
  }
  try {
    const parsed = JSON.parse(body);
    if (parsed?.message) return String(parsed.message);
  } catch { /* not JSON — fall through to the raw body */ }
  return `HTTP ${status}. ${body.slice(0, 300)}`;
}

async function call(
  url: string, token: string, init: RequestInit = {},
): Promise<{ ok: boolean; status: number; body: string; json: any }> {
  const res = await fetch(url, { ...init, headers: { ...headers(token), ...(init.headers ?? {}) } })
    .catch(() => null);
  if (!res) return { ok: false, status: 0, body: "no response from dev.azure.com", json: null };
  const body = await res.text();
  let json: any = null;
  try { json = body ? JSON.parse(body) : null; } catch { /* left null */ }
  return { ok: res.ok, status: res.status, body, json };
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export async function ensureAdoProject(opts: {
  org: string;
  project: string;
  processTemplate?: string;
  workItemType?: string;
}): Promise<EnsureResult> {
  const token = pat();
  if (!token) return { ok: false, error: "No Azure DevOps token (ADO_PAT or MCP_TOKEN_FOR_AZURE) in the root .env." };

  const org = opts.org;
  const project = opts.project;
  const templateName = opts.processTemplate ?? "Agile";
  const wantType = opts.workItemType ?? "User Story";
  const orgUrl = `https://dev.azure.com/${encodeURIComponent(org)}`;
  const projUrl = `${orgUrl}/${encodeURIComponent(project)}`;

  // 1. Already there? Creating is idempotent from the caller's point of view,
  //    which is what makes a failed wizard run resumable.
  const existing = await call(`${orgUrl}/_apis/projects/${encodeURIComponent(project)}?api-version=${API}`, token);

  if (!existing.ok && existing.status !== 404) {
    return { ok: false, error: explain(existing.status, existing.body) };
  }

  if (!existing.ok) {
    // 2. Resolve the process template BY NAME. A hardcoded GUID is correct in
    //    one organisation and a silent failure in every other.
    const processes = await call(`${orgUrl}/_apis/process/processes?api-version=${API}`, token);
    if (!processes.ok) return { ok: false, error: explain(processes.status, processes.body) };

    const template = (processes.json?.value ?? [])
      .find((p: any) => String(p.name).toLowerCase() === templateName.toLowerCase());
    if (!template) {
      const names = (processes.json?.value ?? []).map((p: any) => p.name).join(", ");
      return { ok: false, error: `No "${templateName}" process template in ${org}. Available: ${names}.` };
    }

    // 3. Create. Returns 202 and an operation id — the project does not exist yet.
    const created = await call(`${orgUrl}/_apis/projects?api-version=${API}`, token, {
      method: "POST",
      body: JSON.stringify({
        name: project,
        description: `Scyne delivery pack for ${project}.`,
        capabilities: {
          versioncontrol: { sourceControlType: "Git" },
          processTemplate: { templateTypeId: template.id },
        },
      }),
    });
    // ADO validates the name itself (TF50316 covers length, illegal characters
    // and reserved names), so its message is surfaced rather than second-guessed.
    if (!created.ok) return { ok: false, error: explain(created.status, created.body) };

    const operationId = created.json?.id;
    if (!operationId) return { ok: false, error: "Azure DevOps accepted the create but returned no operation id." };

    // 4. Poll to a TERMINAL state. Reporting success before the project is
    //    usable is how a half-created project reaches a client.
    let state = "queued";
    for (let i = 0; i < 60 && state !== "succeeded" && state !== "failed" && state !== "cancelled"; i++) {
      await sleep(2000);
      const op = await call(`${orgUrl}/_apis/operations/${operationId}?api-version=${API}`, token);
      if (!op.ok) return { ok: false, error: explain(op.status, op.body) };
      state = String(op.json?.status ?? "queued");
      if (state === "failed" || state === "cancelled") {
        return { ok: false, error: `Project creation ${state}: ${op.json?.detailedMessage ?? op.json?.resultMessage ?? "no reason given"}` };
      }
    }
    if (state !== "succeeded") {
      return { ok: false, error: `Project creation did not finish within two minutes (last state: ${state}). It may still complete — check ${orgUrl} before retrying.` };
    }
  }

  // 5. The wiki. A brand-new project has none, and a publish step must not be
  //    the thing that decides where a client's documents live.
  const wikis = await call(`${projUrl}/_apis/wiki/wikis?api-version=${API}`, token);
  if (!wikis.ok) return { ok: false, error: explain(wikis.status, wikis.body) };

  let wiki = (wikis.json?.value ?? [])[0];
  if (!wiki) {
    const madeWiki = await call(`${projUrl}/_apis/wiki/wikis?api-version=${API}`, token, {
      method: "POST",
      body: JSON.stringify({ name: `${project}.wiki`, projectId: (existing.json?.id) ?? undefined, type: "projectWiki" }),
    });
    if (!madeWiki.ok) return { ok: false, error: explain(madeWiki.status, madeWiki.body) };
    wiki = madeWiki.json;
  }
  if (!wiki?.id) return { ok: false, error: `Could not resolve a wiki in "${project}".` };

  // 6. Confirm the work item type exists BY NAME. The publishing agent is
  //    handed this exact string and told not to substitute a familiar one, so
  //    a wrong value fails every story at once — after the gate was approved.
  const types = await call(`${projUrl}/_apis/wit/workitemtypes?api-version=${API}`, token);
  if (!types.ok) return { ok: false, error: explain(types.status, types.body) };
  const names = (types.json?.value ?? []).map((t: any) => String(t.name));
  if (!names.includes(wantType)) {
    return { ok: false, error: `"${project}" has no "${wantType}" work item type. It has: ${names.join(", ")}.` };
  }

  return {
    ok: true,
    target: {
      org, project,
      wiki: String(wiki.name),
      wikiId: String(wiki.id),
      processTemplate: templateName,
      workItemType: wantType,
      createdAt: new Date().toISOString(),
    },
  };
}
```

- [ ] **Step 2: Verify it type-checks**

Run: `npm run typecheck`
Expected: no errors from `adoProject.ts`.

---

## Task 4: The wizard creates the project

**Files:**
- Modify: `scyne-chatbot/server/index.ts` — **the handler at line 1480, not the one at 2048**
- Delete: `scyne-chatbot/server/index.ts:2046-…` — the dead duplicate route and its `// 6b.` comment block

**Interfaces:**
- Consumes: `ensureAdoProject`, `AdoTargetRecord` from Task 3.

- [ ] **Step 1: Import the new module**

At the top of `scyne-chatbot/server/index.ts`, beside the existing `adoVerify` import:

```ts
import { ensureAdoProject } from "./services/adoProject.js";
```

- [ ] **Step 2: Create the ADO project, after the folder tree and before branding**

In the handler at line 1480, immediately after the `description.md` write block (around line 1506) and before the `// Branding is a fetch…` comment:

```ts
    // The Azure DevOps target, resolved once and recorded. Everything
    // downstream reads it from .published.json rather than an environment
    // variable, because one target for the whole installation is what this
    // replaced.
    //
    // A failure here is NOT fatal to the wizard: the folder tree, the
    // definition and the branding are real and worth keeping. It returns with
    // `adoError` set and no `adoTarget`, which leaves the project INCOMPLETE
    // rather than broken — re-running creation completes it.
    let adoTarget: any = null;
    let adoError: string | null = null;
    if (process.env.ADO_ORG) {
      const ensured = await ensureAdoProject({ org: process.env.ADO_ORG, project });
      if (ensured.ok) {
        const publishedFile = path.join(root, ".published.json");
        let current: any = {};
        try { current = JSON.parse(await fs.readFile(publishedFile, "utf8")); } catch { /* first write */ }
        current.adoTarget = ensured.target;
        await fs.writeFile(publishedFile, JSON.stringify(current, null, 2) + "\n", "utf8");
        adoTarget = ensured.target;
      } else {
        adoError = ensured.error;
        console.error(`[projects] ${project}: Azure DevOps setup failed — ${ensured.error}`);
      }
    } else {
      adoError = "ADO_ORG is not set, so no Azure DevOps project was created.";
    }
```

- [ ] **Step 3: Report it in the response**

Replace the response at line 1531:

```ts
    console.log(`[projects] created ${project} (definition=${definitionWritten}, brand=${Boolean(brand)}, ado=${Boolean(adoTarget)})`);
    res.json({ ok: true, project, definitionWritten, brand, brandError, adoTarget, adoError });
```

- [ ] **Step 4: Make an incomplete project resumable**

Replace the `409 exists` early return (around line 1491-1493):

```ts
    let exists = false;
    try { await fs.access(root); exists = true; } catch { /* new project */ }
    if (exists) {
      // A project whose Azure DevOps setup failed is INCOMPLETE, not taken.
      // Refusing it with 409 would strand it: the wizard is the only way to
      // create the target, and it is the thing being refused.
      let hasTarget = false;
      try {
        const p = JSON.parse(await fs.readFile(path.join(root, ".published.json"), "utf8"));
        hasTarget = Boolean(p?.adoTarget?.project);
      } catch { /* no record — treat as missing */ }
      if (hasTarget) {
        return res.status(409).json({ error: "exists", message: `A project called "${project}" already exists.` });
      }
      console.log(`[projects] ${project} exists but has no Azure DevOps target — completing it`);
    }
```

- [ ] **Step 5: Delete the dead duplicate route**

Delete the entire second `app.post("/api/projects", …)` handler beginning at the `// 6b. Create a new project/feature` comment (around line 2046) through its closing `});`. It is unreachable — Express matches the handler at 1480 — and it scaffolds a per-feature `design/` folder that the project-level restructure moved up to the project.

- [ ] **Step 6: Verify exactly one route remains, and it type-checks**

Run:
```bash
grep -c 'app.post("/api/projects"' scyne-chatbot/server/index.ts
npm run typecheck
```
Expected: `1`, and no type errors.

---

## Task 5: The path scheme

**Files:**
- Modify: `orchestrator.workflows.ts:94-95` and the publish prompt at `:123`
- Modify: `scripts/check-workflows.mts` (append assertions)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: the new `wikiPathTpl` shape that Task 1's `resolvePagePath` protects existing pages from.

- [ ] **Step 1: Write the failing assertions**

Append to `scripts/check-workflows.mts`, before its final `console.log`:

```ts
// The wiki path scheme. One Azure DevOps project per Scyne project means the
// project name is no longer needed IN the path — the project IS the container.
// A regression here does not throw: it publishes a client's document to a
// plausible-looking path nobody links to.
{
  const workflows = buildWorkflows();
  const publishPrompts = workflows
    .flatMap(w => w.steps.map(s => ({ w, s })))
    .filter(({ s }) => s.type === "agent" && s.phase === "publish")
    .map(({ w, s }) => ({ key: w.key, prompt: String((s as any).prompt ?? "") }));

  for (const { key, prompt } of publishPrompts) {
    if (prompt.includes("/Scyne/")) {
      fail(`${key}: publish prompt still carries the retired /Scyne/ path prefix`);
    }
    if (/`\/\{project\}\//.test(prompt)) {
      fail(`${key}: publish prompt still puts {project} in the wiki path`);
    }
  }

  // A project-level artefact sits at the wiki root and therefore has NO parent
  // page; a feature-level one has exactly one, `/{feature}`.
  const capabilities = publishPrompts.find(p => p.key === "capabilities");
  if (capabilities && !capabilities.prompt.includes("`/Capability & Process Map`")) {
    fail("capabilities: expected the page path `/Capability & Process Map`");
  }
  const datamodel = publishPrompts.find(p => p.key === "datamodel");
  if (datamodel && !datamodel.prompt.includes("`/{feature}/Salesforce Data Model`")) {
    fail("datamodel: expected the page path `/{feature}/Salesforce Data Model`");
  }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run check:workflows`
Expected: FAIL — several `still carries the retired /Scyne/ path prefix`.

- [ ] **Step 3: Change the template**

Replace `orchestrator.workflows.ts:94-95`:

```ts
const wikiPathTpl = (s: Stage): string =>
  isProject(s) ? `/${s.label}` : `/{feature}/${s.label}`;
```

Update the doc comment above it — it currently explains that project and feature are both in the path so two features cannot collide:

```ts
/**
 * The wiki path a stage's document lives at.
 *
 * Identity is the PATH, not a title lookup plus a remembered id — which is
 * what makes republishing a revision idempotent. The Scyne project is NOT in
 * the path: each one has its own Azure DevOps project now, so the wiki
 * already belongs to exactly one client. The feature is, so two features
 * cannot collide on a stage name.
 *
 * This is a FIRST-publish path only. An artefact already recorded in
 * `.published.json` keeps the path it was published at — see
 * `resolvePagePath` in `scripts/lib/ado.mjs`.
 */
```

- [ ] **Step 4: Point the publish prompt at `adoTarget`**

Replace `orchestrator.workflows.ts:123`:

```ts
    `- **Project**: the \`adoProject\` parameter if one is listed, otherwise the`,
    `  \`adoTarget.project\` recorded in \`projects/{project}/.published.json\`.`,
    `  There is no environment fallback: one Azure DevOps project for the whole`,
    `  installation is exactly what per-project targets replaced, and guessing`,
    `  one would publish a client's document into another client's project. If`,
    `  neither is present, STOP and say the project has no Azure DevOps target.`,
```

- [ ] **Step 5: Run the assertions to verify they pass**

Run: `npm run check:workflows`
Expected: `every workflow correct` (or the file's existing success line), no FAILs.

---

## Task 6: Backfill SAPN and retire `ADO_PROJECT`

**Files:**
- Modify: `projects/SAPN/.published.json`
- Modify: `scyne-chatbot/server/index.ts:174, 480, 925`
- Modify: `scyne-chatbot/server/services/adoVerify.ts:51`
- Modify: `scripts/check-routing.mts:63`
- Modify: `.env`, `.env.example`, `CLAUDE.md`

- [ ] **Step 1: Backfill SAPN**

Add `adoTarget` as the FIRST key of `projects/SAPN/.published.json`, leaving the existing `ado` block untouched:

```json
{
  "adoTarget": {
    "org": "Scyne-AI-Lab",
    "project": "Scyne AI Project",
    "wiki": "Scyne-AI-Project-Wiki",
    "wikiId": "a4ca915c-fc13-43a4-9e99-1097ec5d69c1",
    "processTemplate": "Basic",
    "workItemType": "Issue",
    "backfilled": "2026-08-21"
  },
  "ado": { … leave exactly as it is … }
}
```

`backfilled` rather than `createdAt` marks it as a legacy row the wizard did not create. Its two artefacts keep publishing to `/Scyne/SAPN/…` because Task 1 makes their recorded paths authoritative.

- [ ] **Step 2: Verify the backfill resolves**

Run:
```bash
node -e '
import("./scripts/lib/ado.mjs").then(async m => {
  const t = await m.readAdoTarget("projects/SAPN/.published.json");
  console.log("target:", t?.project, "| type:", t?.workItemType);
  console.log("capabilities path:", await m.resolvePagePath("/Capability & Process Map", "projects/SAPN/.published.json", "capabilities"));
})'
```
Expected:
```
target: Scyne AI Project | type: Issue
capabilities path: /Scyne/SAPN/Capability & Process Map
```
That second line is the whole point — the template says `/Capability & Process Map`, and SAPN's page does not move.

- [ ] **Step 3: Remove the three `ADO_PROJECT` reads**

`scyne-chatbot/server/index.ts:174` — drop the fallback and the stale `Issue` comment:

```ts
      ado_project: overrides.ado_project || "",
      ado_wiki: overrides.ado_wiki || process.env.ADO_WIKI || "",
      // The work item type comes from the project's own adoTarget. Agile
      // projects have `User Story`, which is what the BA's house style
      // describes; the pre-existing shared project runs Basic and has `Issue`.
      ado_work_item_type: overrides.ado_work_item_type || "",
```

`:480` — `const ado_project = String(req.body?.ado_project || "").trim();`

`:925` — `const project = grab("ADO project") || "";`

- [ ] **Step 4: Update `adoConfigured()`**

`scyne-chatbot/server/services/adoVerify.ts:51`:

```ts
export function adoConfigured(): boolean {
  return Boolean(pat() && process.env.ADO_ORG);
}
```

- [ ] **Step 5: Update the routing check**

In `scripts/check-routing.mts:63`, the fixture describes a description built by `index.ts`. Since `ado_project` now comes from the issue description rather than the environment, the round-trip assertion still holds — but the comment above it claiming a fallback to "whatever the environment happens to hold" is now wrong. Replace it:

```ts
// The ADO target must survive the round trip. There is no environment
// fallback any more: a publish step handed no project stops rather than
// guessing, so a parameter lost here is a blocked run, not a misfiled page.
```

- [ ] **Step 6: Retire the variables from `.env` and `.env.example`**

In both files, delete `ADO_PROJECT` and `ADO_WORK_ITEM_TYPE`. Leave `ADO_ORG`, `ADO_WIKI` and `MCP_TOKEN_FOR_AZURE`. In `.env.example`, add above `ADO_ORG`:

```bash
# One Azure DevOps ORGANISATION holds every project. The PROJECT is created
# per Scyne project by the New Project wizard and recorded in
# projects/<project>/.published.json under "adoTarget" — there is deliberately
# no ADO_PROJECT, because one target for the whole installation is what that
# replaced.
```

- [ ] **Step 7: Update CLAUDE.md**

Two sections are now wrong:

1. **"One Azure DevOps target for the whole install"** — replace with the per-project rule: the ADO project is created by the wizard from the name the user enters, using the Agile template, recorded in `.published.json` under `adoTarget`; wiki paths are `/<artefact>` for project level and `/<feature>/<artefact>` for feature level; `ADO_ORG` remains and `ADO_PROJECT` is gone.
2. **"The target is verified at approval, never created"** — creation now happens in the wizard. Keep the reasoning about half-created projects, and say where creation lives and why it is not at the gate.

Also update the `ADO_WORK_ITEM_TYPE` paragraph in the diagrams/publishing blockquote near the top: the type is per project now, and Agile projects have `User Story`.

- [ ] **Step 8: Full verification**

Run:
```bash
npm run test:scripts
npm run check:workflows
npm run check:routing
npm run typecheck
npm test
grep -rn "ADO_PROJECT" --include="*.ts" --include="*.mjs" --include="*.mts" . | grep -v node_modules | grep -v docs/
```
Expected: all green, and the final `grep` returns **nothing**.

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| §1 target recorded once | 2 (read), 4 (write) |
| §2 creation in the wizard | 3, 4 |
| §2 resumable / partial failure | 4 steps 2, 4 |
| §3 paths | 5 |
| §4 work item type | 3 (verify), 6 (retire the global) |
| §5 SAPN backfill | 6 steps 1-2 |
| §6 retiring `ADO_PROJECT` | 6 steps 3-6 |
| Latent `.published.json` bug | 1 |
| Testing: recorded-path unit test | 1 step 1 |
| Testing: resumable path | 4 step 4 |
| Testing: `check:routing` | 6 steps 5, 8 |
| CLAUDE.md | 6 step 7 |

**Not automated, by design:** creating a real project against a live organisation (Task 3 is exercised by the wizard on first use), and confirming a created wiki is reachable by browsing. Both are named in the spec's Testing section as manual.

**Type consistency:** `AdoTargetRecord` (Task 3) matches the `adoTarget` JSON written in Task 4 step 2 and read by `readAdoTarget` (Task 2) and the backfill (Task 6). `resolvePagePath(template, publishedFile, artefactKey)` has the same signature at its definition (Task 1 step 3), its call site (Task 1 step 5) and its verification (Task 6 step 2).

**Ordering:** Task 1 must precede Task 5. Publishing to the new template before recorded paths win would move SAPN's live pages.
