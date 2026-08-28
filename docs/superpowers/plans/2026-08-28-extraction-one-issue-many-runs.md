# Extraction: One Issue, Many Runs — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Uploading N documents to a project produces ONE `extract` issue carrying one visible, costed run per document, which advances by itself when every document is extracted.

**Architecture:** Three independent changes. (1) `POST /issues` learns an optional `coalesceKey` so repeated upload-triggered starts join the open issue instead of creating a ninth. (2) `scripts/extract-documents.mjs` stops hand-copying the runner's flag list and imports `buildArgs`/`extractUsage` from `@scyne/orchestrator`, which is what makes per-document token counts and transcripts exist at all. (3) With that data in hand, the script records a `runs` row per document over two new thin routes, and re-sweeps its work list so a document uploaded mid-pass is not stranded.

**Tech Stack:** Node ESM (`.mjs`) scripts · TypeScript (`packages/orchestrator`, `scyne-chatbot/server`) · PGlite/Postgres · vitest (orchestrator) · `node --test` (root scripts) · Express router · Claude Code CLI

**Spec:** [`docs/superpowers/specs/2026-08-28-extraction-one-issue-many-runs-design.md`](../specs/2026-08-28-extraction-one-issue-many-runs-design.md)

## Global Constraints

- **No API key, no new runtime dependency.** Extraction stays on the local `claude` CLI and the local subscription. Do not add `@anthropic-ai/sdk`. Do not add `ANTHROPIC_API_KEY`. Do not use structured outputs, `count_tokens`, or the Batch API.
- **`packages/orchestrator/` must never import** `scripts/pipeline.mjs`, `orchestrator.config.ts`, or anything under `projects/`. The reverse direction (root scripts importing the package) is what this plan introduces and is allowed.
- **`openapi.yaml` and `ROUTES` are diffed in BOTH directions** by `test/openapi.test.ts`. Every new route needs an entry in both or the suite fails.
- **Run recording and narration are best-effort.** A failed bookkeeping call is logged and never fails the extraction it was describing.
- **Extraction model:** `claude-sonnet-5`, overridable with `SCYNE_EXTRACT_MODEL`. Do not change `defaults.model` in `orchestrator.config.ts` (still `claude-sonnet-4-6`) — that is out of scope.
- **Australian English** in any user-facing string (Behaviour, Authorise, Organisation).
- **Do not run `git commit`.** The user commits their own work. Each task ends with a verification step; stop there and report.

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `packages/orchestrator/src/core/repo.ts` | `findOpenByCoalesceKey` — the lookup that makes coalescing possible | 1 |
| `packages/orchestrator/src/core/engine.ts` | `start()` honours `coalesceKey`; retry counter scoped by `phase` | 1, 4 |
| `packages/orchestrator/src/http/router.ts` | `coalesceKey` on `POST /issues` (200 vs 201); the two run-recording routes | 1, 5 |
| `packages/orchestrator/openapi.yaml` | contract for the above | 1, 5 |
| `scyne-chatbot/server/orchestrator.ts` | `startWorkflow` forwards `coalesceKey` | 2 |
| `scyne-chatbot/server/index.ts` | `startExtraction` sends `extract:<project>` | 2 |
| `scripts/extract-documents.mjs` | re-sweep loop; `buildArgs`/`extractUsage`; run rows | 3, 6, 7 |
| `scripts/pipeline.mjs` | `extract.script` runs under `tsx` | 6 |

---

## Task 1: `coalesceKey` on issue creation

**Files:**
- Modify: `packages/orchestrator/src/core/repo.ts` (add `findOpenByCoalesceKey` beside `listIssues`, ~line 326)
- Modify: `packages/orchestrator/src/core/engine.ts:72-77` (the `Engine.start` signature) and `:892-914` (its body)
- Modify: `packages/orchestrator/src/http/router.ts:588-618` (`POST /issues`)
- Modify: `packages/orchestrator/openapi.yaml` (the `POST /issues` operation)
- Test: `packages/orchestrator/test/engine.test.ts`

**Interfaces:**
- Consumes: `repo.createIssue(CreateIssueInput)`, `repo.listIssues(companyId, filter)` — both exist.
- Produces:
  - `repo.findOpenByCoalesceKey(companyId: string, workflowKey: string, coalesceKey: string): Promise<IssueRow | null>`
  - `engine.start(workflowKey, params, opts?: { companyId?, createdBy?, coalesceKey?: string }): Promise<IssueRow & { coalesced: boolean }>`

> **Additive, NOT breaking — measured.** The obvious shape is `{ issue, coalesced }`, and it is wrong here: `grep -c "engine.start("` finds **72 call sites**, nearly all of them `const issue = await engine.start(...)` followed by `issue.id`. Churning 72 lines to move a boolean one level up buys nothing. The flag rides on the returned row instead, so every existing caller keeps working untouched and only the router reads the new field.
>
> It cannot leak into the database: `createIssue` inserts named columns, so a field that is not one of them has nowhere to go.

The key is stored in `issues.params.coalesceKey` — `params` is already `jsonb` ([`migrations/001_init.sql:63`](../../../packages/orchestrator/migrations/001_init.sql)), so this needs no migration.

- [ ] **Step 1: Write the failing test**

Add to `packages/orchestrator/test/engine.test.ts`. Follow the existing file's setup helpers rather than inventing new ones — open it first and reuse whatever it already uses to build an engine against a temp db.

```ts
describe("coalesceKey", () => {
  it("returns the open issue instead of creating a second", async () => {
    const a = await engine.start("extract", { project: "P" }, { coalesceKey: "extract:P" });
    const b = await engine.start("extract", { project: "P" }, { coalesceKey: "extract:P" });

    expect(a.coalesced).toBe(false);
    expect(b.coalesced).toBe(true);
    expect(b.id).toBe(a.id);
  });

  it("does not coalesce onto a terminal issue", async () => {
    const a = await engine.start("extract", { project: "P" }, { coalesceKey: "extract:P" });
    await repo.updateIssue(a.id, { status: "done" });

    const b = await engine.start("extract", { project: "P" }, { coalesceKey: "extract:P" });
    expect(b.coalesced).toBe(false);
    expect(b.id).not.toBe(a.id);
  });

  it("does not coalesce across projects", async () => {
    const a = await engine.start("extract", { project: "P" }, { coalesceKey: "extract:P" });
    const b = await engine.start("extract", { project: "Q" }, { coalesceKey: "extract:Q" });
    expect(b.id).not.toBe(a.id);
  });

  it("creates normally when no key is given", async () => {
    const a = await engine.start("extract", { project: "P" });
    const b = await engine.start("extract", { project: "P" });
    expect(b.id).not.toBe(a.id);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npm --prefix packages/orchestrator test -- engine.test.ts
```

Expected: FAIL. `a.coalesced` is `undefined` — `start` returns a bare `IssueRow`.

- [ ] **Step 3: Add the repo lookup**

In `packages/orchestrator/src/core/repo.ts`, beside `listIssues`:

```ts
/**
 * An open issue for this workflow carrying this coalesce key, or null.
 *
 * "Open" is every status a run can still move out of. `done` and `cancelled`
 * are terminal and deliberately excluded: the next upload after a finished
 * extraction starts a fresh issue, rather than reopening one that has
 * accumulated a project's entire history.
 *
 * The key lives in `params` because that column is already jsonb and already
 * carries everything else a caller passes. A dedicated column would need a
 * migration to express something only one workflow uses.
 */
async findOpenByCoalesceKey(
  companyId: string, workflowKey: string, coalesceKey: string,
): Promise<IssueRow | null> {
  const { rows } = await db.query<IssueRow>(
    `select * from issues
      where company_id=$1 and workflow_key=$2
        and params->>'coalesceKey' = $3
        and status not in ('done','cancelled')
      order by created_at asc limit 1`,
    [companyId, workflowKey, coalesceKey]);
  return rows[0] ?? null;
},
```

`order by created_at asc` is not cosmetic: if two somehow exist, joining the OLDEST means work converges on one issue rather than ping-ponging.

Declare it on the `Repo` interface in the same file.

- [ ] **Step 4: Make `engine.start` honour it**

Change the `Engine` interface at `packages/orchestrator/src/core/engine.ts:72-77`:

```ts
start(
  workflowKey: string,
  params: Record<string, string>,
  opts?: { companyId?: string; createdBy?: string | null; coalesceKey?: string },
): Promise<{ issue: IssueRow; coalesced: boolean }>;
```

And the body at `:892`, right after `companyId` is resolved and before the agent lookup:

```ts
// Before creating anything. An upload-triggered start is fired once per
// document, so nine uploads used to mean nine issues racing over one
// project's document tree — eight of which blocked. Joining the open one
// is what makes this a single unit of work.
if (opts.coalesceKey) {
  const open = await repo.findOpenByCoalesceKey(companyId, workflowKey, opts.coalesceKey);
  if (open) return { ...open, coalesced: true };
}
```

Then wrap the existing `return repo.createIssue({...})` so the key is persisted and the shape matches:

```ts
const issue = await repo.createIssue({
  companyId, title,
  workflowKey,
  params: opts.coalesceKey ? { ...params, coalesceKey: opts.coalesceKey } : params,
  assigneeAgentId: agent?.id ?? null, status: "todo",
  createdBy: opts.createdBy ?? null,
});
return { ...issue, coalesced: false };
```

- [ ] **Step 5: Update both call sites**

`packages/orchestrator/src/http/router.ts`, in `POST /issues` (~line 588):

```ts
const { workflow, params, coalesceKey } = (req.body ?? {}) as
  { workflow?: string; params?: Record<string, unknown>; coalesceKey?: string };
if (!workflow) { badRequest(res, "workflow is required"); return; }
let issue;
try {
  const principal = (req as AuthedRequest).principal!;
  issue = await orch.engine.start(workflow, (params ?? {}) as Record<string, string>, {
    companyId: principal.companyId,
    createdBy: principal.user.id,
    ...(coalesceKey ? { coalesceKey } : {}),
  });
} catch (err) {
  badRequest(res, err instanceof Error ? err.message : String(err));
  return;
}
```

Then, at the end of the handler — the advance and the status code both change:

```ts
// Only a NEW issue is advanced. Advancing a coalesced one would be a second
// concurrent advance() on an issue already mid-run: the in-memory lock in
// advance() would drop it, but relying on that is relying on a guard for
// something we can simply not do.
if (!issue.coalesced) {
  orch.engine.advance(issue.id).catch((err: unknown) => {
    console.error(`[orchestrator] advance(${issue.id}) failed:`, err);
  });
}
// 200 means "one was already going", 201 means "I started one". A caller
// that cannot tell those apart is the bug this route was changed for.
res.status(issue.coalesced ? 200 : 201).json(issue);
```

Leave the existing long comment about why `advance` is never called bare exactly where it is.

`src/cli.ts` needs **no change** — it reads `issue.id` off the returned row, which is exactly what it still gets. That is the whole point of the additive shape.

- [ ] **Step 6: Document the route**

In `packages/orchestrator/openapi.yaml`, find the `POST /issues` operation. Add `coalesceKey` to its request-body schema properties:

```yaml
coalesceKey:
  type: string
  description: >-
    Optional. When an open issue (any status but done/cancelled) already
    exists for this workflow with this key, that issue is returned with 200
    instead of a second being created with 201.
```

And add a `200` response beside the existing `201`, with the same schema as the 201.

- [ ] **Step 7: Run the tests**

```bash
npm --prefix packages/orchestrator test
```

Expected: PASS, including `openapi.test.ts` (no new route was added, so it should be unaffected — if it complains, the yaml edit broke its parse).

- [ ] **Step 8: Typecheck**

```bash
npm run typecheck
```

Expected: clean. If `cli.ts` still errors, Step 5's destructure was missed there.

---

## Task 2: The chatbot sends the key

**Files:**
- Modify: `scyne-chatbot/server/orchestrator.ts:168-169` (`startWorkflow`)
- Modify: `scyne-chatbot/server/index.ts:2507-2537` (`startExtraction`)
- Test: `scyne-chatbot/server/limits.test.ts`

**Interfaces:**
- Consumes: Task 1's `coalesceKey` field on `POST /issues`.
- Produces: nothing other tasks read.

- [ ] **Step 1: Write the failing test**

`limits.test.ts` already asserts things about `startExtraction`'s body by reading the source (see its existing `routeBody(src, "function startExtraction(")` assertions). Add one in the same style:

```ts
it("startExtraction coalesces onto the project's open extract issue", () => {
  const fn = routeBody(src, "function startExtraction(");
  // Nine uploads must not mean nine issues. The key is per PROJECT because
  // extract is a project-level stage — one pass sweeps every feature.
  expect(fn).toMatch(/coalesceKey:\s*`extract:\$\{project\}`/);
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npm --prefix scyne-chatbot test -- limits.test.ts
```

Expected: FAIL — no `coalesceKey` in the function body.

- [ ] **Step 3: Widen `startWorkflow`**

`scyne-chatbot/server/orchestrator.ts`, replacing lines 168-169:

```ts
startWorkflow: (
  workflow: string,
  params: Record<string, string>,
  coalesceKey?: string,
) => call<any>("POST", "/issues", { workflow, params, ...(coalesceKey ? { coalesceKey } : {}) }),
```

Optional third argument, so every other caller is untouched.

- [ ] **Step 4: Pass the key**

`scyne-chatbot/server/index.ts`, in `startExtraction` (~line 2523):

```ts
    void paperclip.startWorkflow("extract", { project }, `extract:${project}`)
```

Everything else in that function — the `void`, the `.then` logging, the `.catch`, the `extra` handling — stays exactly as it is. Add a line to its doc comment above:

```
 * ## Why it coalesces
 *
 * This fires once per uploaded document. Nine uploads used to start nine
 * `extract` issues, racing each other over one project's document tree;
 * eight of them blocked. `coalesceKey` joins the project's open extract
 * issue instead, and the script's own re-sweep (Task 3) is what stops a
 * document that arrived mid-pass from being stranded by that.
```

- [ ] **Step 5: Run the tests**

```bash
npm --prefix scyne-chatbot test -- limits.test.ts
```

Expected: PASS, and the existing assertions in that file (`void` not `await`, `startWorkflow("extract"` present) still pass.

- [ ] **Step 6: Verify routing is untouched**

```bash
npm run check:routing
```

Expected: PASS. This does not touch the title→workflow mapping, but that script is the guard for `server/index.ts` edits and is cheap.

---

## Task 3: Re-sweep, so nothing uploaded mid-pass is stranded

**Files:**
- Modify: `scripts/extract-documents.mjs` (the block from `const results = []` to the `Promise.all` lanes, ~lines 300-340)
- Test: `test/extract-resweep.test.mjs` (create)

**Interfaces:**
- Consumes: `projectState(root, project)` from `scripts/extract-state.mjs` — exists.
- Produces: nothing other tasks read. Task 7 wraps the same lane loop, so read this task's final shape before doing Task 7.

**Why:** the script resolves `todo` once, at the top. SCY-5 resolved it when one document had landed, extracted that one, and then `validate-extracts.mjs` found nine and blocked the issue. Coalescing alone makes that *more* likely, not less — every upload now joins a pass that has already chosen its work list.

- [ ] **Step 1: Write the failing test**

Create `test/extract-resweep.test.mjs`. It runs the real script with `SCYNE_EXTRACT_CMD` pointed at a stub, so no model is called and no money is spent.

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const REPO = path.resolve(import.meta.dirname, "..");

/**
 * A stub standing in for one `claude` invocation: `<cmd> <outPath> <docPath>`.
 * It writes a minimal schema-valid extract, and — on the FIRST call only —
 * drops a second document into the tree, standing in for an upload that lands
 * while the pass is running. That is the exact SCY-5 sequence.
 */
const STUB = `#!/usr/bin/env node
import { writeFile, stat } from "node:fs/promises";
import path from "node:path";
const [out, doc] = process.argv.slice(2);
const root = process.env.STUB_DOCS_DIR;
const flag = path.join(root, ".dropped");
let first = false;
try { await stat(flag); } catch { first = true; }
if (first) {
  await writeFile(flag, "1");
  await writeFile(path.join(root, "Late.md"), "# Late\\nArrived mid-pass.\\n");
}
await writeFile(out, JSON.stringify({
  version: 1, docId: path.basename(doc), scope: "project", category: "documents",
  windows: [{ pageStart: 1, pageEnd: 1 }],
  businessFunctions: [], processSteps: [], actors: [], serviceTiers: [],
  components: [], maturitySignals: [], lifecyclePhases: [], painPoints: [],
  coverage: { pagesRead: 1, pagesTotal: 1, truncated: false },
  usage: { inputTokens: 0, outputTokens: 0 },
}));
`;

test("a document that lands mid-pass is extracted by a later sweep", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "resweep-"));
  const docs = path.join(root, "projects", "P", "documents");
  await mkdir(docs, { recursive: true });
  await writeFile(path.join(docs, "First.md"), "# First\nOriginal document.\n");

  const stub = path.join(root, "stub.mjs");
  await writeFile(stub, STUB, { mode: 0o755 });

  await exec("node", [path.join(REPO, "scripts", "extract-documents.mjs"), "P",
                      "--root", root, "--concurrency", "1"], {
    env: { ...process.env, SCYNE_EXTRACT_CMD: `node ${stub}`, STUB_DOCS_DIR: docs },
  });

  const extracts = (await readdir(path.join(root, "projects", "P", "solutions", "Extracts")))
    .filter(f => f.endsWith(".extract.json"));
  // Two: the original, and the one that appeared while the pass was running.
  assert.equal(extracts.length, 2);
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
node --test test/extract-resweep.test.mjs
```

Expected: FAIL — `1 !== 2`. The work list was a snapshot.

- [ ] **Step 3: Wrap the lane loop in a sweep loop**

In `scripts/extract-documents.mjs`, the current shape is:

```js
const results = [];
const queue = [...todo];
const lanes = Math.min(concurrency, queue.length);
...
await Promise.all(Array.from({ length: lanes }, async () => { ... }));
```

Replace the single pass with a bounded loop. Add above it:

```js
/**
 * How many times a pass re-resolves its work list before giving up.
 *
 * The list is a SNAPSHOT, and uploads keep arriving: extraction now starts
 * once per project rather than once per document, so a pass routinely begins
 * before the last file has landed. SCY-5 is the measured case — it resolved
 * one document, extracted it, and `validate-extracts.mjs` then found nine and
 * blocked the issue.
 *
 * Bounded rather than "until nothing is left", because a document that fails
 * on every attempt would otherwise loop forever. `attempted` is what makes
 * each sweep strictly smaller: a document is tried at most once per pass, so
 * the loop drains even when everything fails.
 */
const MAX_SWEEPS = 3;
const attempted = new Set();
```

Then the loop itself, replacing the single `Promise.all`:

```js
const results = [];
let sweep = 0;
let queue = todo.filter((d) => !attempted.has(`${d.scope}/${d.docId}`));

while (queue.length && sweep < MAX_SWEEPS) {
  sweep++;
  for (const d of queue) attempted.add(`${d.scope}/${d.docId}`);
  const lanes = Math.min(concurrency, queue.length);
  if (sweep === 1) {
    const waves = Math.ceil(queue.length / Math.max(1, lanes));
    await narrate(
      `Extracting ${queue.length} document(s), ${lanes} at a time — about ` +
      `${waves * 2}–${waves * 5} minutes. One agent reads each document once and ` +
      `fills in a fixed form; a long PDF is the slow one.` +
      (st.ready ? ` ${st.ready} already extracted and skipped.` : ""));
  } else {
    await narrate(`${queue.length} more document(s) arrived while that ran — extracting those too.`);
  }

  const lane = [...queue];
  const total = results.length + lane.length;
  await Promise.all(Array.from({ length: lanes }, async () => {
    while (lane.length) {
      const r = await extractOne(absOf(lane.shift()));
      results.push(r);
      await narrate(r.ok
        ? `${results.length}/${total} · extracted \`${r.docId}\`${r.skipped ? ` (${r.skipped})` : ""}`
        : `${results.length}/${total} · FAILED \`${r.docId}\` — ${r.reason}`);
    }
  }));

  // Re-resolve from disk. A document uploaded while the sweep above was
  // running is invisible to the list that sweep started from.
  const fresh = await projectState(root, project);
  queue = fresh.documents
    .filter((d) => d.state !== "ready")
    .filter((d) => !attempted.has(`${d.scope}/${d.docId}`));
  if (onlyFeature) queue = queue.filter((d) => d.scope === onlyFeature);
}

if (queue.length) {
  console.error(
    `⚠ ${queue.length} document(s) still unextracted after ${MAX_SWEEPS} sweeps — ` +
    `documents are arriving faster than they extract, or something is wrong:`);
  for (const d of queue) console.error(`  - ${d.scope}/${d.docId}`);
}
```

The old `let done = 0` counter is deleted — `results.length` is the same number and cannot drift from it.

**Do not** move `narrate`, `absOf`, `extractOne` or `st`. They are all defined above this block already.

- [ ] **Step 4: Run the test**

```bash
node --test test/extract-resweep.test.mjs
```

Expected: PASS — two extracts.

- [ ] **Step 5: Run every script test**

```bash
npm run test:scripts
```

Expected: PASS. Any existing extraction test that asserted on the single-pass narration wording will need its expectation updated to match Step 3's strings — update the expectation, not the strings.

---

## Task 4: Scope the retry counter by phase

**Files:**
- Modify: `packages/orchestrator/src/core/engine.ts` (~line 494 inside `attemptOnce`, and ~line 625 where the blocking comment counts attempts)
- Test: `packages/orchestrator/test/retry.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: the invariant Task 7 depends on. Task 7 writes N run rows at one `step_index`; without this, an unrelated `agent` step would read them as attempts.

**Why now, before Task 7:** the engine counts a step's attempts as *every run row at this step index*. Task 7 puts nine there. Extraction is an `exec` step and `exec` steps are never retried, so nothing miscounts today — this is a trap being laid, and it is cheaper to close before it is sprung than to debug afterwards.

- [ ] **Step 1: Write the failing test**

Add to `packages/orchestrator/test/retry.test.ts` (or `engine.test.ts` if that file has the engine harness — use whichever already builds a repo with runs):

```ts
it("counts only the engine's own runs as attempts, not fan-out rows", async () => {
  const issue = await repo.createIssue({ companyId, title: "t", workflowKey: "extract", status: "todo" });

  // Nine fan-out rows at step 1, as scripts/extract-documents.mjs writes them.
  for (let i = 0; i < 9; i++) {
    await repo.startRun({ issueId: issue.id, stepIndex: 1, phase: `extract: doc${i}.md`, logPath: `/tmp/x${i}` });
  }
  // One engine-started run at the same step.
  await repo.startRun({ issueId: issue.id, stepIndex: 1, phase: "generate", logPath: "/tmp/g" });

  const runs = await repo.listRuns(issue.id);
  const attempts = runs.filter(r => r.step_index === 1 && r.phase === "generate").length;
  expect(attempts).toBe(1);
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npm --prefix packages/orchestrator test -- retry.test.ts
```

Expected: this test passes on its own (it asserts the filter, not the engine). Its purpose is to pin the shape. The real change is Step 3 — after it, grep proves no unscoped count remains.

- [ ] **Step 3: Scope both counts**

In `packages/orchestrator/src/core/engine.ts`, inside `attemptOnce` (~line 494):

```ts
// Scoped by PHASE, not just step index. A fan-out step writes one run row
// per item at a single step_index (scripts/extract-documents.mjs writes one
// per document), and those are not attempts at this step — they are its
// output. An engine-started run carries the step's own phase; a fan-out row
// carries `extract: <docId>`. `agent_id` cannot be the discriminator: the
// fan-out rows deliberately carry one, because that spend must attribute to
// the agent that incurred it.
const attempt = (await repo.listRuns(issue.id))
  .filter(r => r.step_index === issue.step_index && r.phase === step.phase).length;
```

And the same filter at the second site (~line 625), where the blocking comment counts attempts:

```ts
const attempts = (await repo.listRuns(issue.id))
  .filter(r => r.step_index === issue.step_index && r.phase === step.phase).length;
```

- [ ] **Step 4: Prove no unscoped count survives**

```bash
grep -n "step_index === issue.step_index" packages/orchestrator/src/core/engine.ts
```

Expected: exactly two hits, both with `&& r.phase === step.phase` on the same line.

- [ ] **Step 5: Run the full suite**

```bash
npm --prefix packages/orchestrator test
```

Expected: PASS. `retry.test.ts` exercises the retry path directly — if a retry test now fails, an existing fixture is creating runs with a phase that does not match its step's, which is worth reading rather than working around.

---

## Task 5: Routes for recording a run

**Files:**
- Modify: `packages/orchestrator/src/http/router.ts` (`CORE_ROUTES` ~line 70; handlers beside the existing `GET /runs/{id}`)
- Modify: `packages/orchestrator/openapi.yaml`
- Test: `packages/orchestrator/test/router.test.ts`

**Interfaces:**
- Consumes: `repo.startRun(StartRunInput)`, `repo.finishRun(id, FinishRunResult)`, `repo.getAgentByKey(companyId, key)` — all exist.
- Produces, for Task 7:
  - `POST /issues/{id}/runs` — body `{ agentKey?, phase, stepIndex?, adapter?, model? }` → `201` with the run row (`id`, `log_path`)
  - `PATCH /runs/{id}` — body `{ status, exitCode?, inputTokens?, outputTokens?, cacheReadTokens?, cacheCreationTokens?, costUsd?, durationMs?, numTurns? }` → `200` with the finished row

- [ ] **Step 1: Write the failing test**

Add to `packages/orchestrator/test/router.test.ts`, in the style that file already uses to make authenticated requests:

```ts
it("records a run against an issue and finishes it", async () => {
  const issue = await createIssueViaApi();   // reuse this file's existing helper

  const started = await api("POST", `/issues/${issue.id}/runs`, {
    agentKey: "capArchitect", phase: "extract: documents/A.md",
    stepIndex: 1, adapter: "claude_local", model: "claude-sonnet-5",
  });
  expect(started.status).toBe(201);
  expect(started.body.status).toBe("running");
  expect(started.body.log_path).toBeTruthy();

  const finished = await api("PATCH", `/runs/${started.body.id}`, {
    status: "succeeded", exitCode: 0, inputTokens: 1200, outputTokens: 300, costUsd: 0.004,
  });
  expect(finished.status).toBe(200);
  expect(finished.body.status).toBe("succeeded");
  expect(Number(finished.body.cost_usd)).toBeCloseTo(0.004);
  expect(finished.body.cost_source).toBe("reported");
});

it("refuses a run against an issue in another organisation", async () => {
  const other = await createIssueInOtherOrg();   // reuse this file's tenancy helper
  const r = await api("POST", `/issues/${other.id}/runs`, { phase: "extract: x" });
  expect(r.status).toBe(404);
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npm --prefix packages/orchestrator test -- router.test.ts
```

Expected: FAIL with 404 on both — the routes do not exist.

- [ ] **Step 3: Declare the routes**

In `packages/orchestrator/src/http/router.ts`, `CORE_ROUTES`, beside `{ method: "GET", path: "/issues/{id}/runs" }`:

```ts
  { method: "POST",  path: "/issues/{id}/runs" },   // a fan-out step records its own
  { method: "PATCH", path: "/runs/{id}" },
```

- [ ] **Step 4: Add the handlers**

Beside the existing `r.get("/runs/:id", ...)`:

```ts
/**
 * Record a run the ENGINE did not start.
 *
 * `scripts/extract-documents.mjs` spawns one agent per document inside a
 * single `exec` step. Those are real agent invocations that cost real money,
 * and before this they had no run row at all: no transcript, no cost, nothing
 * in /spend, and no way to tell a working pass from a wedged one during the
 * twenty-odd minutes it takes.
 *
 * Deliberately thin. It creates the row and hands back the log path the
 * caller should write its transcript to; it does not spawn, supervise, or
 * budget anything. A step that wants those things should be an `agent` step.
 */
r.post("/issues/:id/runs", guard, wrap(async (req, res) => {
  const principal = (req as AuthedRequest).principal!;
  const issue = await orch.repo.getIssue(req.params.id);
  // Tenancy: 404 rather than 403, so an id from another organisation is
  // indistinguishable from one that does not exist.
  if (!issue || issue.company_id !== principal.companyId) { notFound(res); return; }

  const { agentKey, phase, stepIndex, adapter, model } = (req.body ?? {}) as {
    agentKey?: string; phase?: string; stepIndex?: number; adapter?: string; model?: string;
  };
  if (!phase) { badRequest(res, "phase is required"); return; }

  const agent = agentKey ? await orch.repo.getAgentByKey(principal.companyId, agentKey) : null;
  const idx = typeof stepIndex === "number" ? stepIndex : issue.step_index;
  const run = await orch.repo.startRun({
    issueId: issue.id, agentId: agent?.id ?? null, stepIndex: idx, phase,
    logPath: join(installRoot, ".orchestrator", "runs", `${issue.id}-${idx}-${newId()}.jsonl`),
    adapter: adapter ?? null, model: model ?? null,
  });
  res.status(201).json(run);
}));

/** Close a run opened by POST /issues/{id}/runs. */
r.patch("/runs/:id", guard, wrap(async (req, res) => {
  const principal = (req as AuthedRequest).principal!;
  const run = await orch.repo.getRun(req.params.id);
  if (!run) { notFound(res); return; }
  const issue = await orch.repo.getIssue(run.issue_id);
  if (!issue || issue.company_id !== principal.companyId) { notFound(res); return; }

  const b = (req.body ?? {}) as Record<string, unknown>;
  if (typeof b.status !== "string") { badRequest(res, "status is required"); return; }
  const num = (v: unknown) => (typeof v === "number" ? v : null);

  // est_cost_usd is deliberately NOT accepted from the caller. `finishRun`
  // derives cost_source from which figure is present, and a client-supplied
  // estimate would let a caller label its own arithmetic as ours.
  const finished = await orch.repo.finishRun(run.id, {
    status: b.status, exitCode: num(b.exitCode),
    sessionId: typeof b.sessionId === "string" ? b.sessionId : null,
    inputTokens: num(b.inputTokens), outputTokens: num(b.outputTokens),
    cacheReadTokens: num(b.cacheReadTokens), cacheCreationTokens: num(b.cacheCreationTokens),
    costUsd: num(b.costUsd), durationMs: num(b.durationMs), numTurns: num(b.numTurns),
  });
  res.json(finished);
}));
```

Check the imports this file already has for `join`, `newId`, `notFound`, `badRequest`, `installRoot` and `orch.repo.getRun` — add whichever are missing, and if `getRun` does not exist on the repo, use whatever `GET /runs/{id}` already calls.

- [ ] **Step 5: Document both routes**

Add both to `packages/orchestrator/openapi.yaml`, matching the shape of the neighbouring `/issues/{id}/runs` GET entry: request bodies as in the **Interfaces** block above, `201`/`200` responses referencing the existing Run schema, and `404` for both.

- [ ] **Step 6: Run the tests**

```bash
npm --prefix packages/orchestrator test
```

Expected: PASS — `router.test.ts` for behaviour and `openapi.test.ts` for the both-directions diff. If `openapi.test.ts` fails, one of the two lists is missing an entry; its message names which.

- [ ] **Step 7: Typecheck**

```bash
npm run typecheck
```

---

## Task 6: The spawn adopts the runner's flags

**Files:**
- Modify: `scripts/extract-documents.mjs` (delete `CLAUDE_ARGS` ~lines 60-80; rewrite `runClaude` ~lines 175-215)
- Modify: `scripts/pipeline.mjs:108` (`extract.script`)
- Test: `test/extract-spawn-args.test.mjs` (create)

**Interfaces:**
- Consumes: `buildArgs`, `extractUsage` from `@scyne/orchestrator` — both exported at [`packages/orchestrator/src/index.ts:22,60`](../../../packages/orchestrator/src/index.ts).
- Produces, for Task 7: `runClaude(docPath, outPath, meta, logPath)` resolves to `{ usage }`, where `usage` is `RunUsage | null`.

**Why:** `CLAUDE_ARGS` is a hand-copy of `buildArgs` that says it mirrors it *"minus the streaming output this script has no use for"*. That streaming output is where usage comes from — no `--output-format stream-json --verbose`, no `result` event, no tokens, no cost, no transcript. The script opted out of the data Task 7 needs. `runner.ts`'s own header insists every flag there is "confirmed against a real invocation, not assumed"; a second, assumed list is the defect.

- [ ] **Step 1: Write the failing test**

Create `test/extract-spawn-args.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

const SRC = path.resolve(import.meta.dirname, "..", "scripts", "extract-documents.mjs");

test("the spawn's flags come from the runner, not a local copy", async () => {
  const src = await readFile(SRC, "utf8");
  assert.match(src, /import\s*\{[^}]*buildArgs[^}]*\}\s*from\s*"@scyne\/orchestrator"/);
  assert.match(src, /import\s*\{[^}]*extractUsage[^}]*\}\s*from\s*"@scyne\/orchestrator"/);
  // The hand-maintained copy is gone, not merely unused. Leaving it in place
  // is how it comes back.
  assert.doesNotMatch(src, /CLAUDE_ARGS/);
  assert.doesNotMatch(src, /"--permission-mode"/);
});

test("usage comes back from a stream-json transcript", async () => {
  const { extractUsage } = await import("@scyne/orchestrator");
  const fixture = await readFile(
    path.resolve(import.meta.dirname, "..", "packages", "orchestrator",
                 "fixtures", "result-event.jsonl"), "utf8");
  const usage = extractUsage(fixture);
  assert.ok(usage, "the fixture carries a result event");
  assert.equal(typeof usage.costUsd, "number");
});

test("a transcript with no result event yields null rather than throwing", async () => {
  const { extractUsage } = await import("@scyne/orchestrator");
  assert.equal(extractUsage('{"type":"system","subtype":"init"}\n'), null);
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npx --prefix packages/orchestrator tsx --test test/extract-spawn-args.test.mjs
```

Expected: FAIL on the first test — `CLAUDE_ARGS` is present and there are no imports.

If the import of `@scyne/orchestrator` cannot resolve, the package is not linked from the root. Check `node_modules/@scyne/orchestrator` exists; if not, add `"@scyne/orchestrator": "file:packages/orchestrator"` to the root `package.json` dependencies and run `npm install`. That is a workspace link, not a new third-party dependency.

- [ ] **Step 3: Replace the flag list with the import**

At the top of `scripts/extract-documents.mjs`, alongside the existing imports:

```js
import { buildArgs, extractUsage } from "@scyne/orchestrator";
```

Delete the whole `CLAUDE_ARGS` const and its doc comment. Replace it with:

```js
/**
 * The model this pass runs on.
 *
 * Pinned here rather than taken from `orchestrator.config.ts`'s default
 * (`claude-sonnet-4-6`), because extraction is form-filling from one document
 * and every other stage is not — they are separate decisions and should stay
 * separately changeable. `--effort low` for the same reason.
 */
const EXTRACT_MODEL = process.env.SCYNE_EXTRACT_MODEL || "claude-sonnet-5";
```

- [ ] **Step 4: Rewrite `runClaude`**

Replace the existing `runClaude` with the version below. Keep its entire doc comment — every paragraph in it records a real failure — and add the note about the log path.

```js
/**
 * [KEEP the existing doc comment verbatim, then append:]
 *
 * The argv is `buildArgs`', not a local copy. The copy this replaces omitted
 * `--output-format stream-json --verbose` as "streaming output this script has
 * no use for", which is precisely why a document's extraction had no token
 * count, no cost and no transcript: the `result` event only exists on that
 * output format. stdout is therefore both the transcript and the usage record,
 * and is written to `logPath` so the console can render it.
 */
const runClaude = (docPath, outPath, meta, logPath) => new Promise((resolve, reject) => {
  const args = buildArgs({
    agent: {
      key: "capArchitect",
      bundlePath: path.join(REPO, "agent-instructions", "extract.thin.md"),
      mcpEnabled: false,
      extraArgs: [],
    },
    model: EXTRACT_MODEL,
    effort: "low",
    prompt: "",          // the prompt goes on stdin, as it does in the runner
    cwd: REPO,
    logPath,
  });

  const child = spawn("claude", args, { cwd: REPO, stdio: ["pipe", "pipe", "pipe"] });
  const log = logPath ? createWriteStream(logPath, { flags: "a" }) : null;
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => { stdout += d.toString(); log?.write(d); });
  child.stderr.on("data", (d) => { stderr += d.toString().slice(0, 4000); });
  child.on("error", reject);
  child.on("close", async (code) => {
    log?.end();
    const tail = stderr.trim().slice(-500);
    if (code !== 0) return reject(new Error(`claude exited ${code}: ${tail}`));
    const wroteSomething = await stat(outPath).then((s) => s.size > 0).catch(() => false);
    if (!wroteSomething) {
      return reject(new Error(
        `claude exited 0 without writing an extract` + (tail ? `: ${tail}` : " and said nothing on stderr")));
    }
    // null when the CLI emitted no result event. Not an error: the extract is
    // the work, its price tag is bookkeeping.
    let usage = null;
    try { usage = extractUsage(stdout); } catch { /* bookkeeping never fails the work */ }
    resolve({ usage });
  });
  child.stdin.on("error", () => {});
  child.stdin.end(promptFor(docPath, outPath, meta));
});
```

Add `createWriteStream` to the `node:fs` imports at the top. Note the file currently imports only from `node:fs/promises` — `createWriteStream` comes from `node:fs`:

```js
import { createWriteStream } from "node:fs";
```

Then in `extractOne`, capture the result. `usage` must be declared **before**
the `if (override)` branch, not inside the `else` — the `SCYNE_EXTRACT_CMD`
path never calls `runClaude`, and a `const` inside the `else` is out of scope
by the time the function returns:

```js
    let usage = null;
    const override = process.env.SCYNE_EXTRACT_CMD;
    if (override) {
      // Test/adapter path: positional contract, no shell, no stdin. It spawns
      // no agent, so there is no usage to record — null, not zero.
      const [cmd, ...base] = override.split(" ");
      await exec(cmd, [...base, partial, doc], { maxBuffer: 64 * 1024 * 1024 });
    } else {
      ({ usage } = await runClaude(path.resolve(doc), path.resolve(partial), {
        docId,
        scope: levelRoot === path.join(root, "projects", project)
          ? "project" : path.basename(levelRoot),
        category: path.basename(path.dirname(doc)),
      }));
    }
```

Note the parentheses around the destructuring assignment — without them the
line parses as a block, not an expression.

`usage` is unused until Task 7. Return it from `extractOne` alongside the rest
— `return { doc, docId, ok: true, usage };` — so Task 7 has it without touching
this function again. Add `usage: null` to the `done-by-other` early return and
to the failure return, so every result has the same shape.

- [ ] **Step 5: Run the stage under tsx**

`scripts/pipeline.mjs:108`:

```js
    script: "./packages/orchestrator/node_modules/.bin/tsx scripts/extract-documents.mjs <project>",
```

Precedent: `migrate:blobs` in the root `package.json` already invokes that binary for a root script.

- [ ] **Step 6: Run the tests**

```bash
npx --prefix packages/orchestrator tsx --test test/extract-spawn-args.test.mjs test/extract-resweep.test.mjs
npm run test:scripts
```

Expected: PASS. `extract-resweep.test.mjs` from Task 3 uses `SCYNE_EXTRACT_CMD` and never reaches `runClaude`, so it must still pass unchanged — if it does not, the override branch was disturbed.

- [ ] **Step 7: Prove the stage still starts**

```bash
npm run check:workflows
```

Expected: PASS. This validates the compiled workflows against the pipeline graph and will catch a malformed `script:` line.

---

## Task 7: A run row per document

**Files:**
- Modify: `scripts/extract-documents.mjs` (a `recordRun` helper beside `narrate`; `extractOne` opens and closes a run)
- Test: `test/extract-run-rows.test.mjs` (create)

**Interfaces:**
- Consumes: Task 5's `POST /issues/{id}/runs` and `PATCH /runs/{id}`; Task 6's `{ usage }` from `runClaude`.
- Produces: nothing further.

- [ ] **Step 1: Write the failing test**

Create `test/extract-run-rows.test.mjs`. It stands up a stub orchestrator on a local port and asserts the script talks to it — no real server, no database.

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const REPO = path.resolve(import.meta.dirname, "..");

const STUB = `#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import path from "node:path";
const [out, doc] = process.argv.slice(2);
await writeFile(out, JSON.stringify({
  version: 1, docId: path.basename(doc), scope: "project", category: "documents",
  windows: [{ pageStart: 1, pageEnd: 1 }],
  businessFunctions: [], processSteps: [], actors: [], serviceTiers: [],
  components: [], maturitySignals: [], lifecyclePhases: [], painPoints: [],
  coverage: { pagesRead: 1, pagesTotal: 1, truncated: false },
  usage: { inputTokens: 0, outputTokens: 0 },
}));
`;

test("one run row is opened and closed per document", async () => {
  const seen = { started: [], finished: [] };
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      const parsed = body ? JSON.parse(body) : {};
      if (req.method === "POST" && req.url.endsWith("/runs")) {
        seen.started.push(parsed);
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: `run-${seen.started.length}`, log_path: path.join(tmpdir(), `r${seen.started.length}.jsonl`) }));
        return;
      }
      if (req.method === "PATCH" && req.url.startsWith("/runs/")) {
        seen.finished.push({ url: req.url, ...parsed });
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;

  const root = await mkdtemp(path.join(tmpdir(), "runrows-"));
  const docs = path.join(root, "projects", "P", "documents");
  await mkdir(docs, { recursive: true });
  await writeFile(path.join(docs, "A.md"), "# A\n");
  await writeFile(path.join(docs, "B.md"), "# B\n");
  const stub = path.join(root, "stub.mjs");
  await writeFile(stub, STUB, { mode: 0o755 });

  await exec("node", [path.join(REPO, "scripts", "extract-documents.mjs"), "P",
                      "--root", root, "--concurrency", "1"], {
    env: { ...process.env,
      SCYNE_EXTRACT_CMD: `node ${stub}`,
      SCYNE_ISSUE_ID: "issue-1",
      ORCHESTRATOR_API_URL: `http://127.0.0.1:${port}`,
    },
  });
  server.close();

  assert.equal(seen.started.length, 2, "one run opened per document");
  assert.equal(seen.finished.length, 2, "each one closed");
  // The phase carries the document, so nine rows are nine distinguishable rows.
  assert.ok(seen.started.every((s) => s.phase.startsWith("extract: ")));
  assert.deepEqual(seen.started.map((s) => s.phase).sort(),
    ["extract: documents/A.md", "extract: documents/B.md"]);
  assert.ok(seen.finished.every((f) => f.status === "succeeded"));
});

test("an unreachable orchestrator does not fail the extraction", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "runrows-down-"));
  const docs = path.join(root, "projects", "P", "documents");
  await mkdir(docs, { recursive: true });
  await writeFile(path.join(docs, "A.md"), "# A\n");
  const stub = path.join(root, "stub.mjs");
  await writeFile(stub, STUB, { mode: 0o755 });

  // Port 1 is closed. Every bookkeeping call fails; the extract must still land.
  await exec("node", [path.join(REPO, "scripts", "extract-documents.mjs"), "P",
                      "--root", root], {
    env: { ...process.env,
      SCYNE_EXTRACT_CMD: `node ${stub}`,
      SCYNE_ISSUE_ID: "issue-1",
      ORCHESTRATOR_API_URL: "http://127.0.0.1:1",
    },
  });
  // Exit code 0 is the assertion — exec rejects on non-zero.
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npx --prefix packages/orchestrator tsx --test test/extract-run-rows.test.mjs
```

Expected: FAIL — `0 !== 2`, nothing is recorded.

- [ ] **Step 3: Add `recordRun`**

In `scripts/extract-documents.mjs`, directly beneath `narrate` (which already owns `ISSUE_ID`, `ORCH` and the token header):

```js
/**
 * Open and close a `runs` row for one document's extraction.
 *
 * Nine agent invocations inside one `exec` step used to leave no trace: no
 * transcript, no cost, nothing in /spend, and no way to tell a working pass
 * from a wedged one during the twenty minutes it takes. The engine cannot
 * narrate inside a step, so the step records itself — the same seam `narrate`
 * already uses, and for the same reason.
 *
 * Best-effort in every direction, exactly as `narrate` is: no issue id (a hand
 * run from the CLI), no token, an unreachable orchestrator or a rejected
 * insert must never fail an extraction that is otherwise working. A run row is
 * bookkeeping; the extract is the work.
 */
const orchHeaders = () => {
  const h = { "content-type": "application/json" };
  if (process.env.SCYNE_ORCH_TOKEN) h.authorization = `Bearer ${process.env.SCYNE_ORCH_TOKEN}`;
  return h;
};

const startRun = async (docId) => {
  if (!ISSUE_ID) return null;
  try {
    const res = await fetch(`${ORCH}/issues/${ISSUE_ID}/runs`, {
      method: "POST", headers: orchHeaders(),
      body: JSON.stringify({
        agentKey: "capArchitect",
        // The docId IS the label: nine rows at one step index are only useful
        // if a reader can tell which document each one is.
        phase: `extract: ${docId}`,
        adapter: "claude_local",
        model: EXTRACT_MODEL,
      }),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
};

const finishRun = async (run, { status, usage }) => {
  if (!run?.id) return;
  try {
    await fetch(`${ORCH}/runs/${run.id}`, {
      method: "PATCH", headers: orchHeaders(),
      body: JSON.stringify({
        status,
        exitCode: status === "succeeded" ? 0 : 1,
        sessionId: usage?.sessionId ?? null,
        inputTokens: usage?.inputTokens ?? null,
        outputTokens: usage?.outputTokens ?? null,
        cacheReadTokens: usage?.cacheReadTokens ?? null,
        cacheCreationTokens: usage?.cacheCreationTokens ?? null,
        costUsd: usage?.costUsd ?? null,
        durationMs: usage?.durationMs ?? null,
        numTurns: usage?.numTurns ?? null,
      }),
    });
  } catch { /* bookkeeping never fails the work */ }
};
```

- [ ] **Step 4: Wire it into `extractOne`**

In `extractOne`, immediately after the claim is taken (after the `claimPartial` block returns `"claimed"`):

```js
  const run = await startRun(docId);
```

In the success path, before `return { doc, docId, ok: true, usage }`:

```js
    await finishRun(run, { status: "succeeded", usage });
```

In the `catch`, before the failure `return`:

```js
    await finishRun(run, { status: "failed", usage: null });
```

Pass `run?.log_path` as `runClaude`'s fourth argument, so the transcript lands where the console will look for it:

```js
      const { usage } = await runClaude(path.resolve(doc), path.resolve(partial), {
        docId, scope: ..., category: ...,
      }, run?.log_path);
```

The `done-by-other` early return takes no run row — no work was done, so there is nothing to record.

- [ ] **Step 5: Run the tests**

```bash
npx --prefix packages/orchestrator tsx --test test/extract-run-rows.test.mjs
npm run test:scripts
```

Expected: PASS, both tests, including the unreachable-orchestrator one.

- [ ] **Step 6: Full suite and typecheck**

```bash
npm --prefix packages/orchestrator test && npm run typecheck && npm run check:routing && npm run check:workflows
```

Expected: all PASS.

- [ ] **Step 7: End-to-end, by hand**

```bash
npm run dev
```

Upload two documents to a test project through the chatbot, then open `http://127.0.0.1:3100/orch`:

- **one** `extract` issue, not two
- its Activity timeline shows a line per document
- its run list shows one row per document, each labelled `extract: <docId>`, each with tokens and a cost
- clicking a row opens that document's transcript
- the issue advances to `validate-extracts.mjs` on its own and passes

Report what you see. If the run rows are missing but extraction succeeded, check `SCYNE_ORCH_TOKEN` is set in the root `.env` — narration and run recording share that credential, so if the timeline comments appear the token is fine.

---

## Cleanup (one-off, after Task 7 lands)

SA-DEMO's nine blocked `extract` issues are cancelled by hand from the console. Not scripted: a one-time mess from a fixed bug does not earn a migration.

---

## Self-Review Notes

**Spec coverage.** Part 1 → Task 6. Part 2 → Tasks 4, 5, 7. Part 3 → Tasks 1, 2, 3. The spec's open decision (`node` → `tsx`) is resolved in Task 6 Step 5 in favour of the import; if the reviewer prefers the copy, Task 6 collapses to adding two flags to `CLAUDE_ARGS` and Task 6 Step 5 is dropped.

**Deliberately not covered**, per the spec's out-of-scope section: the SDK, structured outputs, `count_tokens`, the Batch API, a general `fanout` step type, chunking beyond 1M context, and the org-wide default model.

**Ordering constraint.** Task 4 must land before Task 7 — Task 7 writes nine run rows at one `step_index`, which is exactly what Task 4's phase-scoped counter protects against. Task 6 must land before Task 7, which consumes its `{ usage }`. Tasks 1 and 2 are a pair: Task 1 without Task 2 changes nothing observable.
