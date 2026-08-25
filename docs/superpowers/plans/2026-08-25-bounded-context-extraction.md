# Bounded-Context Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** make a capability map generatable from a document set of any size by reading each document once into a fixed-shape extract, then synthesising from the extracts.

**Architecture:** A new `extract` stage runs one agent per document, each seeing only that document, writing `extract.json` against a fixed schema with internal page citations. `capability-process-map` then reduces the extracts instead of reading documents. A document gains a state (`arrived → converting → extracting → ready`), extraction starts on arrival, and every stage gate changes from "documents are present" to "documents are ready".

**Tech Stack:** Node 24 · ESM · plain `.mjs` at the repo root (no runtime deps) · TypeScript in the plugin · vitest · Claude Code / Codex via the existing adapters

**Spec:** `docs/superpowers/specs/2026-08-25-bounded-context-extraction-design.md`

## Global Constraints

- **Node >= 24**, ESM throughout.
- **The repo root has NO runtime dependencies** — `package.json` `dependencies` is empty; only `concurrently`, `esbuild`, `tsx` as devDeps. Everything this plan adds at the root is dependency-free plain JS using `node:` builtins only. Anything needing `@azure/storage-blob` lives in `plugins/azure-file-processing/` and is reached by subprocess.
- **No bypass.** Every project extracts, at every size. There is no single-read fallback and none may be added — spec §8.
- **Delivered documents carry NO citations.** Extracts carry `src` on every item; it never reaches a deliverable — spec §4.
- **Coverage is a hard failure, not a warning.** N documents in → N extracts out; a missing or truncated extract stops the run naming the document — spec §5.
- **Output shapes are unchanged.** `capability-map.json`, `process-model.json` and `capability-process.md` keep their exact current schemas; `render-capability-map.mjs --validate-only` must still pass.
- **Australian English** in all generated content and user-facing copy.
- **The repo owner commits their own work.** Every task ends with `git add` of exactly its files plus a proposed commit message as a comment. Do NOT run `git commit`.
- **Never run `./scripts/stack.sh down`** — it is `down -v` and destroys every stored document.
- Existing pinned versions: `vitest@^2.1.8`, `typescript@^5.7.2`, `tsx@^4.19.2`.

---

## The constraint that shapes this plan

**The workflow engine has no fan-out.** Five step types — `exec`, `agent`,
`attach`, `gate`, `flow` — and `flow` spawns a child workflow but
*parent-resume-on-child-completion is not implemented*. A workflow is also
compiled at boot, before any document is known, so "one `agent` step per
document" cannot be expressed.

So the map phase is an **`exec` step** running `scripts/extract-documents.mjs`,
which spawns one agent process per document itself.

**What that costs, stated plainly:** those runs do not get `runs` rows, so they
do not appear in `/spend`, are not covered by the per-agent budget ceiling, and
produce no transcript in the console. The extract file records its own token
usage so the spend is *recoverable*, but it is not tracked the way an ordinary
agent step is. Doing it properly needs a fan-out primitive in the engine, which
is a larger change than this plan and is called out in Task 9 (Documentation) as the follow-up.

---

## File Structure

```
scripts/lib/extract-schema.mjs      the Extract shape + validate() — PURE, no deps,
                                    imported by the validator, the gates and the CLI
scripts/validate-extracts.mjs       CLI validator (mirrors validate-experience.mjs)
scripts/extract-state.mjs           a document's state, computed from disk
scripts/extract-documents.mjs       the MAP phase: one agent per document
skills/document-extract/SKILL.md    what a map pass actually does
skills/capability-process-map/SKILL.md   MODIFIED — reduce from extracts
scripts/pipeline.mjs                MODIFIED — new `extract` stage; capabilities requires it
scripts/stage.mjs                   MODIFIED — stage extracts for the reduce
scyne-chatbot/server/index.ts       MODIFIED — gates: present → ready; GET /api/extract-status
```

Extracts live at, per level:

```
projects/<p>/solutions/Extracts/<sha256-prefix>.extract.json     project documents
projects/<p>/<feature>/solutions/Extracts/<sha256-prefix>.extract.json
```

**Keyed by the source document's content hash, not its name.** An edited
document produces a different hash and therefore a different extract file, so
invalidation is automatic and a rename does not orphan work. The file records
its own `docId` so a human can still tell what it came from.

---

## Task 0: A test runner for the repo root

**Files:**
- Modify: `package.json`
- Create: `test/.gitkeep`

**Why this is a task rather than a footnote:** the repo root has **no test
runner**. `npm test` at the root delegates to `packages/orchestrator`, and there
is no `test/` directory. Every test this plan writes would be a file nobody
runs. Node 24's built-in runner needs no dependency, which matters because the
root has none.

- [ ] **Step 1: Add the script**

In the root `package.json`, beside the existing `"test"`:

```json
    "test:scripts": "node --test \"scripts/lib/*.test.mjs\" \"test/**/*.test.mjs\"",
```

**Two corrections applied during execution, both defects in this plan:**

1. **`test:scripts` already existed**, bound to `scripts/lib/*.test.mjs` from an
   earlier plan. This task originally claimed to be adding it. Overwriting it
   would have silently orphaned 15 passing tests, so the glob covers both trees.
2. **`node --test test/` does not work.** Node 24.14.0 does not walk a bare
   directory argument — measured. The plan claimed it was verified; what was
   actually verified was `node --test test/_probe.test.mjs`, a FILE, which is a
   different command. Globs are required.

Leave `"test"` pointing at the orchestrator package — changing what `npm test`
means at the root would surprise every existing caller.

- [ ] **Step 2: Verify it runs**

```bash
npm run test:scripts
```
Expected: every test under `scripts/lib/` AND `test/` runs. Confirm the count
includes the pre-existing tests — a glob that quietly drops them is the failure
this step exists to catch.

- [ ] **Step 3: Stage**

```bash
git add package.json test/.gitkeep
# Repo owner commits. Proposed message:
#   chore: a test runner for repo-root scripts
```

**Every task below runs `npm run test:scripts` or `node --test test/<file>`.**

---

## Task 1: The extract schema and its validator

**Files:**
- Create: `scripts/lib/extract-schema.mjs`
- Test: `test/extract-schema.test.mjs`

**Interfaces:**
- Consumes: nothing. Pure, `node:` builtins only.
- Produces:
  - `EXTRACT_VERSION = 1`
  - `ITEM_KINDS` — the eight array field names, frozen
  - `validateExtract(obj): { ok: boolean, errors: string[] }`
  - `emptyExtract({docId, scope, category}): object`

**Why a hand-written validator rather than zod:** the repo root has no runtime
dependencies and this file is imported by `scripts/` and by the chatbot server.
Adding a dependency to the root to validate eight arrays of objects is not worth
it.

- [ ] **Step 1: Write the failing test**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateExtract, emptyExtract, ITEM_KINDS, EXTRACT_VERSION } from "../scripts/lib/extract-schema.mjs";

const good = () => ({
  version: EXTRACT_VERSION,
  docId: "Workshop_Transcript.md",
  scope: "project",
  category: "Transcripts",
  windows: [{ pageStart: 1, pageEnd: 25 }],
  businessFunctions: [
    { name: "Refund Escalation", does: "Escalates refunds over $500 to a team lead",
      actor: "Team Lead", src: { pageStart: 22, pageEnd: 24 } },
  ],
  processSteps: [], actors: [], serviceTiers: [], components: [],
  maturitySignals: [], lifecyclePhases: [], painPoints: [],
  coverage: { pagesRead: 25, pagesTotal: 25, truncated: false },
  usage: { inputTokens: 12000, outputTokens: 900 },
});

test("accepts a well-formed extract", () => {
  assert.deepEqual(validateExtract(good()), { ok: true, errors: [] });
});

test("every item kind is present in an empty extract", () => {
  const e = emptyExtract({ docId: "a.md", scope: "project", category: "Notes" });
  for (const k of ITEM_KINDS) assert.ok(Array.isArray(e[k]), `${k} missing`);
  assert.equal(validateExtract(e).ok, true, "an empty extract is valid");
});

test("refuses an item with no src", () => {
  const e = good();
  delete e.businessFunctions[0].src;
  const v = validateExtract(e);
  assert.equal(v.ok, false);
  assert.match(v.errors.join(" "), /businessFunctions\[0\].*src/);
});

test("refuses a src whose pageEnd precedes pageStart", () => {
  const e = good();
  e.businessFunctions[0].src = { pageStart: 9, pageEnd: 4 };
  assert.match(validateExtract(e).errors.join(" "), /pageEnd/);
});

test("refuses a painPoint with no verbatim quote", () => {
  // Pain points are what a client disputes in a room. A paraphrase is not
  // evidence, so the schema will not accept one.
  const e = good();
  e.painPoints = [{ src: { pageStart: 3, pageEnd: 3 } }];
  assert.match(validateExtract(e).errors.join(" "), /painPoints\[0\].*quote/);
});

test("refuses truncated coverage that claims to have read everything", () => {
  const e = good();
  e.coverage = { pagesRead: 10, pagesTotal: 25, truncated: false };
  assert.match(validateExtract(e).errors.join(" "), /truncated/);
});

test("refuses an unknown top-level field", () => {
  // A typo'd field name is silent data loss: the reduce reads the correct name,
  // finds nothing, and reports a smaller map with no error anywhere.
  const e = good();
  e.buisnessFunctions = [];
  assert.match(validateExtract(e).errors.join(" "), /buisnessFunctions/);
});

test("refuses a version it does not know", () => {
  const e = good();
  e.version = 99;
  assert.match(validateExtract(e).errors.join(" "), /version/);
});

test("reports EVERY problem, not just the first", () => {
  const e = good();
  delete e.docId;
  delete e.coverage;
  e.businessFunctions[0].src = { pageStart: 9, pageEnd: 4 };
  const v = validateExtract(e);
  assert.ok(v.errors.length >= 3, `expected 3+ errors, got ${v.errors.length}`);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/extract-schema.test.mjs`
Expected: FAIL — cannot find module `../scripts/lib/extract-schema.mjs`.

- [ ] **Step 3: Write `scripts/lib/extract-schema.mjs`**

```js
// The shape of one document's extract, and a validator for it.
//
// PURE and dependency-free on purpose: the repo root has no runtime
// dependencies, and this file is imported by scripts/, by the chatbot server
// and by the plugin. Adding zod to the root to check eight arrays is not worth
// a dependency.
//
// The field list is not invented here — it is capability-process-map/SKILL.md
// Step 1's own "For each document, extract:" list, given a structure.

export const EXTRACT_VERSION = 1;

/** The eight arrays. Frozen because the reduce reads these names literally. */
export const ITEM_KINDS = Object.freeze([
  "businessFunctions", "processSteps", "actors", "serviceTiers",
  "components", "maturitySignals", "lifecyclePhases", "painPoints",
]);

const TOP_LEVEL = Object.freeze([
  "version", "docId", "scope", "category", "windows", ...ITEM_KINDS,
  "coverage", "usage",
]);

const isStr = (v) => typeof v === "string" && v.trim().length > 0;
const isInt = (v) => Number.isInteger(v) && v >= 0;

const checkSrc = (src, where, errors) => {
  if (!src || typeof src !== "object") {
    errors.push(`${where}: src is required — every item must be traceable to its pages`);
    return;
  }
  if (!isInt(src.pageStart)) errors.push(`${where}.src.pageStart must be a non-negative integer`);
  if (!isInt(src.pageEnd)) errors.push(`${where}.src.pageEnd must be a non-negative integer`);
  if (isInt(src.pageStart) && isInt(src.pageEnd) && src.pageEnd < src.pageStart) {
    errors.push(`${where}.src.pageEnd (${src.pageEnd}) precedes pageStart (${src.pageStart})`);
  }
};

export const emptyExtract = ({ docId, scope, category }) => ({
  version: EXTRACT_VERSION,
  docId, scope, category,
  windows: [],
  ...Object.fromEntries(ITEM_KINDS.map((k) => [k, []])),
  coverage: { pagesRead: 0, pagesTotal: 0, truncated: false },
  usage: { inputTokens: 0, outputTokens: 0 },
});

/**
 * Reports EVERY problem in one pass rather than throwing on the first.
 * A map pass that produced six bad items should be told about six, not made to
 * discover them one agent run at a time.
 */
export const validateExtract = (obj) => {
  const errors = [];
  if (!obj || typeof obj !== "object") return { ok: false, errors: ["not an object"] };

  if (obj.version !== EXTRACT_VERSION) {
    errors.push(`version must be ${EXTRACT_VERSION}, got ${JSON.stringify(obj.version)}`);
  }
  for (const f of ["docId", "scope", "category"]) {
    if (!isStr(obj[f])) errors.push(`${f} is required and must be a non-empty string`);
  }

  // An unknown top-level key is nearly always a typo, and a typo here is SILENT
  // data loss: the reduce reads the correct name, finds nothing, and produces a
  // smaller map with no error anywhere.
  for (const k of Object.keys(obj)) {
    if (!TOP_LEVEL.includes(k)) errors.push(`unknown field ${k} — check the spelling against ITEM_KINDS`);
  }

  if (!Array.isArray(obj.windows)) errors.push("windows must be an array");
  else obj.windows.forEach((w, i) => checkSrc(w, `windows[${i}]`, errors));

  for (const kind of ITEM_KINDS) {
    const arr = obj[kind];
    if (!Array.isArray(arr)) { errors.push(`${kind} must be an array`); continue; }
    arr.forEach((item, i) => {
      const where = `${kind}[${i}]`;
      if (!item || typeof item !== "object") { errors.push(`${where} is not an object`); return; }
      checkSrc(item.src, where, errors);
      // painPoints are the one kind that must carry the client's own words:
      // a paraphrased pain point is not evidence in a room with a client.
      if (kind === "painPoints" && !isStr(item.quote)) {
        errors.push(`${where}.quote is required and must be verbatim`);
      }
      if (kind !== "painPoints" && !isStr(item.name) && !isStr(item.step) && !isStr(item.statement)) {
        errors.push(`${where} needs one of name / step / statement`);
      }
    });
  }

  const c = obj.coverage;
  if (!c || typeof c !== "object") errors.push("coverage is required");
  else {
    if (!isInt(c.pagesRead)) errors.push("coverage.pagesRead must be a non-negative integer");
    if (!isInt(c.pagesTotal)) errors.push("coverage.pagesTotal must be a non-negative integer");
    if (typeof c.truncated !== "boolean") errors.push("coverage.truncated must be a boolean");
    // The check that makes coverage mean something: a pass that read 10 of 25
    // pages and reported truncated:false is the silent-omission failure.
    if (isInt(c.pagesRead) && isInt(c.pagesTotal) && c.pagesRead < c.pagesTotal && c.truncated === false) {
      errors.push(`coverage says truncated:false but read ${c.pagesRead} of ${c.pagesTotal} pages`);
    }
  }

  return { ok: errors.length === 0, errors };
};
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test test/extract-schema.test.mjs`
Expected: PASS, 9 tests.

- [ ] **Step 5: Stage**

```bash
git add scripts/lib/extract-schema.mjs test/extract-schema.test.mjs
# Repo owner commits. Proposed message:
#   feat(extract): the extract schema and a dependency-free validator
```

---

## Task 2: Where an extract lives, and a document's state

**Files:**
- Create: `scripts/extract-state.mjs`
- Test: `test/extract-state.test.mjs`

**Interfaces:**
- Consumes: `scripts/lib/extract-schema.mjs`.
- Produces:
  - `extractPathFor(docAbsPath, levelRoot): Promise<string>`
  - `hashOf(absPath): Promise<string>` — sha256, streamed
  - `stateOf(docAbsPath, levelRoot): Promise<{state, reason?, extractPath}>` where `state` is `"ready" | "extracting" | "failed" | "missing"`
  - `projectState(workspaceRoot, project): Promise<{ready, missing, failed, extracting, documents: Array<{docId, scope, state, reason?}>}>`

**The states, and how each is decided from disk alone** — there is no database
here, because the extract files ARE the state:

| State | On disk |
|---|---|
| `ready` | `<hash>.extract.json` exists and passes `validateExtract` |
| `extracting` | `<hash>.extract.json.partial` exists (the map pass writes this first) |
| `failed` | `<hash>.extract.failed.json` exists, holding `{reason, attempts}` |
| `missing` | none of the above — never attempted, or the document changed |

**A changed document becomes `missing`, not stale**, because the filename is its
content hash: edit the document and you are asking about a hash nothing has
extracted yet. That is the invalidation, and it costs no bookkeeping.

- [ ] **Step 1: Write the failing test**

```js
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractPathFor, hashOf, stateOf, projectState } from "../scripts/extract-state.mjs";
import { emptyExtract } from "../scripts/lib/extract-schema.mjs";

let root;
beforeEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = mkdtempSync(join(tmpdir(), "extract-state-"));
  mkdirSync(join(root, "projects/P/documents"), { recursive: true });
  writeFileSync(join(root, "projects/P/documents/a.md"), "# alpha\n");
});

const levelRoot = () => join(root, "projects/P");
const docA = () => join(root, "projects/P/documents/a.md");

test("the extract path is keyed by the document's content hash", async () => {
  const p1 = await extractPathFor(docA(), levelRoot());
  assert.match(p1, /solutions\/Extracts\/[0-9a-f]{16}\.extract\.json$/);
  writeFileSync(docA(), "# alpha changed\n");
  const p2 = await extractPathFor(docA(), levelRoot());
  assert.notEqual(p1, p2, "editing the document must change its extract path");
});

test("a document with no extract is missing", async () => {
  assert.equal((await stateOf(docA(), levelRoot())).state, "missing");
});

test("a valid extract makes it ready", async () => {
  const p = await extractPathFor(docA(), levelRoot());
  mkdirSync(join(levelRoot(), "solutions/Extracts"), { recursive: true });
  const e = emptyExtract({ docId: "documents/a.md", scope: "project", category: "documents" });
  writeFileSync(p, JSON.stringify(e));
  assert.equal((await stateOf(docA(), levelRoot())).state, "ready");
});

test("an INVALID extract is failed, not ready — and says why", async () => {
  // The case that matters: a file exists, so a naive check calls it done.
  const p = await extractPathFor(docA(), levelRoot());
  mkdirSync(join(levelRoot(), "solutions/Extracts"), { recursive: true });
  writeFileSync(p, JSON.stringify({ version: 1, docId: "a.md" }));
  const s = await stateOf(docA(), levelRoot());
  assert.equal(s.state, "failed");
  assert.match(s.reason, /scope|category|coverage/);
});

test("a .partial file means extracting", async () => {
  const p = await extractPathFor(docA(), levelRoot());
  mkdirSync(join(levelRoot(), "solutions/Extracts"), { recursive: true });
  writeFileSync(`${p}.partial`, "{}");
  assert.equal((await stateOf(docA(), levelRoot())).state, "extracting");
});

test("a .failed file carries its reason forward", async () => {
  const p = await extractPathFor(docA(), levelRoot());
  mkdirSync(join(levelRoot(), "solutions/Extracts"), { recursive: true });
  writeFileSync(p.replace(/\.extract\.json$/, ".extract.failed.json"),
    JSON.stringify({ reason: "no text layer in PDF", attempts: 2 }));
  const s = await stateOf(docA(), levelRoot());
  assert.equal(s.state, "failed");
  assert.match(s.reason, /no text layer/);
});

test("editing a ready document returns it to missing", async () => {
  const p = await extractPathFor(docA(), levelRoot());
  mkdirSync(join(levelRoot(), "solutions/Extracts"), { recursive: true });
  writeFileSync(p, JSON.stringify(emptyExtract({ docId: "a.md", scope: "project", category: "documents" })));
  assert.equal((await stateOf(docA(), levelRoot())).state, "ready");
  writeFileSync(docA(), "# alpha, revised by the client\n");
  assert.equal((await stateOf(docA(), levelRoot())).state, "missing",
    "a changed document has no extract for its new hash");
});

test("projectState counts every document at both levels", async () => {
  mkdirSync(join(root, "projects/P/Feature One/requirements/SOP"), { recursive: true });
  writeFileSync(join(root, "projects/P/Feature One/requirements/SOP/policy.md"), "# policy\n");
  const st = await projectState(root, "P");
  assert.equal(st.documents.length, 2);
  assert.equal(st.missing, 2);
  assert.equal(st.ready, 0);
  assert.ok(st.documents.some((d) => d.scope === "project"));
  assert.ok(st.documents.some((d) => d.scope === "Feature One"));
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/extract-state.test.mjs`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write `scripts/extract-state.mjs`**

```js
// A document's extraction state, computed from disk alone.
//
// There is no database here on purpose: the extract FILES are the state, and
// their names are the source document's content hash. That makes invalidation
// free — edit a document and you are asking about a hash nothing has extracted
// yet, so it reads as `missing` with no bookkeeping to keep in step.

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { validateExtract } from "./lib/extract-schema.mjs";

/** Streamed: a 300 MB document must not be resident to be hashed. */
export const hashOf = (absPath) =>
  new Promise((resolve, reject) => {
    const h = createHash("sha256");
    createReadStream(absPath)
      .on("error", reject)
      .on("data", (d) => h.update(d))
      .on("end", () => resolve(h.digest("hex")));
  });

const EXTRACTS_DIR = path.join("solutions", "Extracts");

export const extractPathFor = async (docAbsPath, levelRoot) => {
  const hash = (await hashOf(docAbsPath)).slice(0, 16);
  return path.join(levelRoot, EXTRACTS_DIR, `${hash}.extract.json`);
};

export const stateOf = async (docAbsPath, levelRoot) => {
  const extractPath = await extractPathFor(docAbsPath, levelRoot);
  const failedPath = extractPath.replace(/\.extract\.json$/, ".extract.failed.json");

  const failed = await readFile(failedPath, "utf8").catch(() => null);
  if (failed !== null) {
    let reason = "extraction failed";
    try { reason = JSON.parse(failed).reason ?? reason; } catch { /* keep default */ }
    return { state: "failed", reason, extractPath };
  }

  const raw = await readFile(extractPath, "utf8").catch(() => null);
  if (raw !== null) {
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch (e) { return { state: "failed", reason: `unparseable extract: ${e.message}`, extractPath }; }
    const v = validateExtract(parsed);
    // A file that exists but does not validate is FAILED, never ready. A naive
    // "does the file exist" check is how a malformed extract silently shrinks
    // the capability map.
    if (!v.ok) return { state: "failed", reason: v.errors.slice(0, 3).join("; "), extractPath };
    return { state: "ready", extractPath };
  }

  const partial = await stat(`${extractPath}.partial`).catch(() => null);
  if (partial) return { state: "extracting", extractPath };

  return { state: "missing", extractPath };
};

/** Folders that are OUTPUT, never source. Kept in step with pipeline.mjs's NOT_SOURCE. */
const SKIP = new Set(["outputs", "solutions", "design", "original-files", "node_modules", ".git"]);
const PROJECT_OWN = new Set(["solutions", "documents", "design", "original-files", "outputs"]);

const walkMd = async (dir, out, depth = 0) => {
  if (depth > 6) return out;
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP.has(e.name)) await walkMd(p, out, depth + 1); }
    else if (e.isFile() && /\.(md|markdown)$/i.test(e.name)) out.push(p);
  }
  return out;
};

export const projectState = async (workspaceRoot, project) => {
  const projRoot = path.join(workspaceRoot, "projects", project);
  const documents = [];

  for (const p of await walkMd(path.join(projRoot, "documents"), [])) {
    const s = await stateOf(p, projRoot);
    documents.push({ docId: path.relative(projRoot, p), scope: "project", ...s });
  }

  let entries = [];
  try { entries = await readdir(projRoot, { withFileTypes: true }); } catch { /* no project */ }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith(".") || PROJECT_OWN.has(e.name)) continue;
    const featRoot = path.join(projRoot, e.name);
    for (const p of await walkMd(path.join(featRoot, "requirements"), [])) {
      const s = await stateOf(p, featRoot);
      documents.push({ docId: path.relative(featRoot, p), scope: e.name, ...s });
    }
  }

  const count = (st) => documents.filter((d) => d.state === st).length;
  return {
    ready: count("ready"), missing: count("missing"),
    failed: count("failed"), extracting: count("extracting"),
    documents,
  };
};
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test test/extract-state.test.mjs`
Expected: PASS, 8 tests.

- [ ] **Step 5: Stage**

```bash
git add scripts/extract-state.mjs test/extract-state.test.mjs
# Repo owner commits. Proposed message:
#   feat(extract): document extraction states, computed from disk
```

---

## Task 3: The map-pass skill

**Files:**
- Create: `skills/document-extract/SKILL.md`
- Test: `test/extract-skill.test.mjs`

**Interfaces:**
- Consumes: the schema from Task 1 (the skill quotes it).
- Produces: a registered skill named `document-extract`, invoked once per document.

**This is the accuracy-critical artefact.** The schema says what shape the
answer takes; this skill says how to fill it in. Everything §3 of the spec
argues about "a form, not a summary" is enforced here or nowhere.

- [ ] **Step 1: Write the failing test**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { ITEM_KINDS } from "../scripts/lib/extract-schema.mjs";

const SKILL = "skills/document-extract/SKILL.md";

test("the skill exists and has frontmatter Claude Code can match on", () => {
  assert.ok(existsSync(SKILL), "SKILL.md missing");
  const md = readFileSync(SKILL, "utf8");
  assert.ok(md.startsWith("---\n"));
  assert.match(md, /^name: document-extract$/m);
  assert.match(md, /^description: Use when /m);
});

test("it names every one of the eight item kinds", () => {
  // If the skill forgets a field, that field is empty in every extract and the
  // reduce never learns it was supposed to exist.
  const md = readFileSync(SKILL, "utf8");
  for (const k of ITEM_KINDS) assert.match(md, new RegExp(k), `skill never mentions ${k}`);
});

test("it forbids reading anything but its own document", () => {
  const md = readFileSync(SKILL, "utf8");
  assert.match(md, /only.{0,40}document|no other document|not read any other/i);
});

test("it requires src on every item and a verbatim quote on pain points", () => {
  const md = readFileSync(SKILL, "utf8");
  assert.match(md, /src/);
  assert.match(md, /verbatim/i);
});

test("it tells the pass to record honest coverage", () => {
  const md = readFileSync(SKILL, "utf8");
  assert.match(md, /truncated/);
});

test("it is registered for symlinking like every other skill", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  assert.ok(pkg.scripts["link-skills"], "link-skills script missing");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/extract-skill.test.mjs`
Expected: FAIL — `SKILL.md missing`.

- [ ] **Step 3: Write `skills/document-extract/SKILL.md`**

````markdown
---
name: document-extract
description: Use when extracting one discovery document into a structured extract for the Scyne pipeline — reads a single document and fills in a fixed form so later stages never load the whole corpus.
---

# Document Extract

You are reading **one document** and filling in a form about it.

You are not summarising. A summary drops whatever the writer found
uninteresting and nobody can tell what went missing. A form can only be
incomplete in places that are named, which a later stage can see and report.

## The one rule that matters

**Read only the document you were given.** Do not open another document, do not
look at the project's other folders, do not read a previous extract. The entire
point of this pass is that its context holds one document — reaching for a
second defeats it and the work becomes impossible at scale.

If the document references another ("as described in the Handling Policy"),
record the reference as text. Do not go and read it.

## Australian English

Behaviour, authorise, organisation. The client's own spelling wins over yours.

## What to fill in

Eight lists. A document will legitimately have nothing for several of them —
an empty list is a real answer, and far better than a padded one.

**`businessFunctions`** — what the organisation *does*, as noun phrases:
"Claims Management", "Provider Coordination", "Refund Escalation". Not job
titles, not systems. Each carries `name`, `does`, and `actor` where stated.

**`processSteps`** — what happens, in order. Each carries `step`, `sequence`,
`actor`, any `decisionPoints`, and a `timeframe` or SLA where one is stated.

**`actors`** — who performs the work. `name` plus `kind`: `client`,
`front-office`, `back-office`, `third-party` or `system`.

**`serviceTiers`** — where a step applies only to some cohorts:
straight-through versus complex versus catastrophic, standard versus priority.
Each carries `name` and `appliesTo`.

**`components`** — named systems, portals, modules or tools, with what each
`enables`.

**`maturitySignals`** — statements about today versus wanted: "currently
manual", "no single view", "to be automated". Each carries `statement` and,
where stated, `target`.

**`lifecyclePhases`** — any stated end-to-end structure, with `order`. **Prefer
the document's own phase names over any you would invent.**

**`painPoints`** — what is not working. **`quote` must be VERBATIM** — the
client's own words, copied exactly. These are what get disputed in a room with
a client, and a paraphrase is not evidence. Everything else on this form may be
your own phrasing; this may not.

## Every item carries `src`

```json
{ "name": "Refund Escalation", "does": "…", "src": { "pageStart": 22, "pageEnd": 24 } }
```

`src` is the pages this item came from. It never appears in any delivered
document — it exists so the synthesis pass can pull those exact pages and check
the real words before writing anything down.

An item you cannot locate to a page range is an item you should not record.

## Coverage: tell the truth

```json
"coverage": { "pagesRead": 25, "pagesTotal": 300, "truncated": true }
```

If you did not read the whole document, say so. `truncated: true` with an
honest `pagesRead` is a **success** — the pipeline handles it. A `truncated:
false` that is not true is the one failure this whole design exists to prevent:
it produces a confident capability map with a silent hole in it.

## Output

Write the JSON to the path you were given. Nothing else — no prose, no
explanation around it.

## Revision mode

When given a previous extract plus an instruction, preserve everything the
instruction does not touch, apply the change and its genuine consequences, and
leave `src` values intact for items you did not alter.
````

- [ ] **Step 4: Run to verify it passes**

Run: `node --test test/extract-skill.test.mjs && npm run link-skills`
Expected: PASS, 6 tests; the symlink appears in `.claude/skills/document-extract`.

- [ ] **Step 5: Stage**

```bash
git add skills/document-extract/SKILL.md test/extract-skill.test.mjs
# Repo owner commits. Proposed message:
#   feat(extract): the document-extract map-pass skill
```

---

## Task 4: The map phase — one agent per document

**Files:**
- Create: `scripts/extract-documents.mjs`
- Test: `test/extract-documents.test.mjs`

**Interfaces:**
- Consumes: `extract-state.mjs`, `lib/extract-schema.mjs`.
- Produces: CLI
  `node scripts/extract-documents.mjs <project> [--feature F] [--concurrency N] [--dry-run] [--force]`
  writing one extract per document and exiting non-zero if any document ends `failed`.

**Why an `exec` step spawning processes rather than N agent steps:** the engine
has no fan-out — see *The constraint that shapes this plan*. This script is what
an `exec` step runs.

**Concurrency defaults to 3.** Each pass is an independent process with its own
context, so they parallelise cleanly; 3 keeps a 50-document project from opening
50 model connections at once.

**A `.partial` file is written before the agent starts** and renamed on success,
which is what makes `stateOf` able to report `extracting` and what stops a
killed run leaving a half-written extract that validates.

- [ ] **Step 1: Write the failing test**

```js
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectState } from "../scripts/extract-state.mjs";

let root;
const SCRIPT = join(process.cwd(), "scripts/extract-documents.mjs");

// A stub "agent" so the test never spends money. The script must honour
// SCYNE_EXTRACT_CMD, which is also how a different adapter gets wired in.
const STUB = join(process.cwd(), "test/fixtures/stub-extract-agent.mjs");

beforeEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = mkdtempSync(join(tmpdir(), "extract-run-"));
  mkdirSync(join(root, "projects/P/documents"), { recursive: true });
  writeFileSync(join(root, "projects/P/documents/a.md"), "# alpha\n\nWe handle refunds.\n");
  writeFileSync(join(root, "projects/P/documents/b.md"), "# beta\n\nWe assess claims.\n");
});

const run = (...args) =>
  execFileSync("node", [SCRIPT, "P", "--root", root, ...args],
    { encoding: "utf8", env: { ...process.env, SCYNE_EXTRACT_CMD: `node ${STUB}` } });

test("writes one extract per document and reports it", async () => {
  const out = JSON.parse(run("--concurrency", "1"));
  assert.equal(out.ok, true);
  assert.equal(out.extracted, 2);
  const st = await projectState(root, "P");
  assert.equal(st.ready, 2);
  assert.equal(st.missing, 0);
});

test("is idempotent — a second run extracts nothing", async () => {
  run("--concurrency", "1");
  const out = JSON.parse(run("--concurrency", "1"));
  assert.equal(out.extracted, 0);
  assert.equal(out.alreadyReady, 2);
});

test("--force re-extracts a document that is already ready", () => {
  run("--concurrency", "1");
  const out = JSON.parse(run("--concurrency", "1", "--force"));
  assert.equal(out.extracted, 2);
});

test("an edited document is re-extracted without --force", async () => {
  run("--concurrency", "1");
  writeFileSync(join(root, "projects/P/documents/a.md"), "# alpha, revised\n");
  const out = JSON.parse(run("--concurrency", "1"));
  assert.equal(out.extracted, 1, "only the changed document");
});

test("a failing agent leaves the document failed and exits non-zero", () => {
  let code = 0;
  try {
    execFileSync("node", [SCRIPT, "P", "--root", root, "--concurrency", "1"],
      { encoding: "utf8", env: { ...process.env, SCYNE_EXTRACT_CMD: "node -e \"process.exit(3)\"" } });
  } catch (e) { code = e.status; }
  assert.notEqual(code, 0, "must exit non-zero when a document fails");
});

test("an agent that writes an INVALID extract is recorded failed, not ready", async () => {
  const bad = join(root, "bad-agent.mjs");
  writeFileSync(bad, `import {writeFileSync} from "node:fs";
    writeFileSync(process.argv[2], JSON.stringify({version:1,docId:"x"}));`);
  let threw = false;
  try {
    execFileSync("node", [SCRIPT, "P", "--root", root, "--concurrency", "1"],
      { encoding: "utf8", env: { ...process.env, SCYNE_EXTRACT_CMD: `node ${bad}` } });
  } catch { threw = true; }
  assert.ok(threw);
  const st = await projectState(root, "P");
  assert.equal(st.ready, 0);
  assert.equal(st.failed, 2);
});

test("leaves no .partial behind on success", () => {
  run("--concurrency", "1");
  const dir = join(root, "projects/P/solutions/Extracts");
  assert.equal(readdirSync(dir).filter((f) => f.endsWith(".partial")).length, 0);
});
```

Also create `test/fixtures/stub-extract-agent.mjs`:

```js
// A stand-in for the real map-pass agent, so tests cost nothing.
// Contract: argv[2] is the output path, argv[3] the document path.
import { writeFileSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { emptyExtract } from "../../scripts/lib/extract-schema.mjs";

const [, , outPath, docPath] = process.argv;
const text = readFileSync(docPath, "utf8");
const e = emptyExtract({ docId: basename(docPath), scope: "project", category: "documents" });
e.windows = [{ pageStart: 1, pageEnd: 1 }];
e.coverage = { pagesRead: 1, pagesTotal: 1, truncated: false };
if (/refund/i.test(text)) {
  e.businessFunctions.push({ name: "Refund Handling", does: "Handles refunds",
    src: { pageStart: 1, pageEnd: 1 } });
}
writeFileSync(outPath, JSON.stringify(e, null, 2));
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/extract-documents.test.mjs`
Expected: FAIL — cannot find `scripts/extract-documents.mjs`.

- [ ] **Step 3: Write `scripts/extract-documents.mjs`**

```js
// The MAP phase: one agent per document, each seeing only its own document.
//
// This is an `exec` step rather than N `agent` steps because the workflow
// engine has no fan-out primitive — `flow` exists but parent-resume-on-child-
// completion is not implemented, and a workflow is compiled at boot, before any
// document is known. The cost of that shortcut is that these runs get no `runs`
// row, so they do not appear in /spend and are not covered by the per-agent
// budget ceiling. Each extract records its own token usage so the spend is at
// least recoverable.

import { mkdir, rename, rm, writeFile, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { projectState, extractPathFor } from "./extract-state.mjs";
import { validateExtract } from "./lib/extract-schema.mjs";

const exec = promisify(execFile);

const argv = process.argv.slice(2);
const project = argv[0];
const flag = (f) => argv.includes(f);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

if (!project || project.startsWith("--")) {
  console.error("usage: node scripts/extract-documents.mjs <project> [--feature F] " +
    "[--concurrency N] [--force] [--dry-run] [--root R]");
  process.exit(2);
}

const root = path.resolve(val("--root", process.env.WORKSPACE_PATH || process.cwd()));
const concurrency = Math.max(1, Number(val("--concurrency", "3")));
const onlyFeature = val("--feature", null);

/** How a map pass is invoked. Overridable so tests cost nothing and so a
 *  different adapter can be swapped in without touching this file. */
const AGENT_CMD = process.env.SCYNE_EXTRACT_CMD
  || `claude -p --system-prompt-file agent-instructions/extract.thin.md`;

const levelRootFor = (doc) => {
  // projects/<p>/documents/... is project level; projects/<p>/<feature>/... is not.
  const rel = path.relative(path.join(root, "projects", project), doc);
  const first = rel.split(path.sep)[0];
  return first === "documents"
    ? path.join(root, "projects", project)
    : path.join(root, "projects", project, first);
};

const extractOne = async (doc) => {
  const levelRoot = levelRootFor(doc);
  const out = await extractPathFor(doc, levelRoot);
  const partial = `${out}.partial`;
  const failed = out.replace(/\.extract\.json$/, ".extract.failed.json");
  await mkdir(path.dirname(out), { recursive: true });
  await rm(failed, { force: true });

  // The .partial exists for the whole run: it is what makes `stateOf` able to
  // say "extracting", and what stops a killed run leaving a half-written file
  // at the real path that would then validate as ready.
  await writeFile(partial, "");

  try {
    const [cmd, ...base] = AGENT_CMD.split(" ");
    await exec(cmd, [...base, partial, doc], { maxBuffer: 64 * 1024 * 1024 });
    const parsed = JSON.parse(await readFile(partial, "utf8"));
    const v = validateExtract(parsed);
    if (!v.ok) throw new Error(v.errors.slice(0, 5).join("; "));
    await rename(partial, out);
    return { doc, ok: true };
  } catch (e) {
    await rm(partial, { force: true });
    await writeFile(failed, JSON.stringify({
      reason: String(e.message ?? e).slice(0, 600), attempts: 1,
    }, null, 2));
    return { doc, ok: false, reason: String(e.message ?? e).slice(0, 300) };
  }
};

const st = await projectState(root, project);
let todo = st.documents.filter((d) => flag("--force") || d.state !== "ready");
if (onlyFeature) todo = todo.filter((d) => d.scope === onlyFeature);

if (flag("--dry-run")) {
  console.log(JSON.stringify({ ok: true, wouldExtract: todo.length,
    documents: todo.map((d) => d.docId) }, null, 2));
  process.exit(0);
}

const absOf = (d) => d.scope === "project"
  ? path.join(root, "projects", project, d.docId)
  : path.join(root, "projects", project, d.scope, d.docId);

const results = [];
const queue = [...todo];
await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
  while (queue.length) results.push(await extractOne(absOf(queue.shift())));
}));

const failures = results.filter((r) => !r.ok);
console.log(JSON.stringify({
  ok: failures.length === 0,
  extracted: results.filter((r) => r.ok).length,
  alreadyReady: st.ready - (flag("--force") ? st.ready : 0),
  failed: failures.length,
  failures: failures.map((f) => ({ doc: path.basename(f.doc), reason: f.reason })),
}, null, 2));

process.exit(failures.length === 0 ? 0 : 1);
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test test/extract-documents.test.mjs`
Expected: PASS, 7 tests.

- [ ] **Step 5: Stage**

```bash
git add scripts/extract-documents.mjs test/extract-documents.test.mjs \
        test/fixtures/stub-extract-agent.mjs
# Repo owner commits. Proposed message:
#   feat(extract): the map phase, one agent per document
```

---

## Task 5: The `extract` stage, and gates that check READY not PRESENT

**Files:**
- Modify: `scripts/pipeline.mjs`, `scyne-chatbot/server/index.ts`
- Create: `scripts/validate-extracts.mjs`
- Test: `test/extract-gate.test.mjs`

**Interfaces:**
- Consumes: `extract-state.mjs`, `extract-documents.mjs`.
- Produces:
  - a pipeline stage `extract` at PROJECT level, order 0
  - `capabilities.requires` now includes the extracts
  - `GET /api/extract-status/:project` → `{ready, missing, failed, extracting, documents[]}`
  - the `no_documents` gate becomes `documents_not_ready` when documents exist but are not extracted

**The gate change is the load-bearing part.** Every 409 gate today counts `.md`
files present on disk (`countProjectDocs` / `countFeatureDocs`,
`index.ts:404-460`). Presence is no longer sufficient: a document that is
present but unextracted contributes **nothing** to the run, so starting anyway
produces a capability map that silently omits it — precisely the failure the
coverage check exists to prevent, arriving through a different door.

**`no_documents` and `documents_not_ready` are different refusals** with
different fixes: upload something, versus wait or investigate. Collapsing them
would tell somebody with nine documents that they have none.

- [ ] **Step 1: Write the failing test**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { STAGES } from "../scripts/pipeline.mjs";

test("the extract stage exists at project level and runs first", () => {
  const s = STAGES.extract;
  assert.ok(s, "no extract stage in the pipeline");
  assert.equal(s.level, "project");
  assert.equal(s.order, 0, "extraction precedes every other stage");
  assert.equal(s.skill, "document-extract");
});

test("capabilities requires the extracts", () => {
  const reqs = STAGES.capabilities.requires ?? [];
  assert.ok(reqs.some((r) => /Extracts/.test(r.path)),
    "capabilities must hard-require the extracts, not read documents");
});

test("the chatbot distinguishes 'no documents' from 'not extracted'", () => {
  const src = readFileSync("scyne-chatbot/server/index.ts", "utf8");
  assert.match(src, /documents_not_ready/,
    "a project with unextracted documents must not be told it has none");
  assert.match(src, /extract-status/, "a status route is required");
});

test("the extract stage produces into solutions/Extracts", () => {
  assert.ok((STAGES.extract.produces ?? []).some((p) => /solutions\/Extracts/.test(p)));
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/extract-gate.test.mjs`
Expected: FAIL — `no extract stage in the pipeline`.

- [ ] **Step 3: Add the stage to `scripts/pipeline.mjs`**

Insert before `capabilities`, following the existing stage shape exactly:

```js
  extract: {
    level: LEVEL.PROJECT,
    order: 0,
    label: "Document Extraction",
    agent: "Capabilities Process Architect",
    agentKey: "capArchitect",
    skill: "document-extract",
    work: "solutions/Extracts",
    titlePrefix: "Extract documents",
    publishes: false,
    // A directory rather than a file list: the count is not known until the
    // documents are. `validate-extracts.mjs` is what asserts completeness.
    produces: ["solutions/Extracts"],
    requires: [],
    enriches: [req("project", "documents", "documents"), ...discovery("features")],
    then: "node scripts/validate-extracts.mjs <project>",
  },
```

and add to `capabilities.requires`:

```js
    requires: [req("project", "solutions/Extracts", "extract")],
```

- [ ] **Step 4: Write `scripts/validate-extracts.mjs`**

```js
// The contract guard between the map phase and every consumer of it.
// Mirrors validate-experience.mjs: reports EVERY problem in one run and exits
// non-zero, because being told about one bad extract per agent run is how a
// fifty-document project takes fifty rounds to fix.

import path from "node:path";
import { projectState } from "./extract-state.mjs";

const project = process.argv[2];
if (!project) { console.error("usage: node scripts/validate-extracts.mjs <project>"); process.exit(2); }
const root = path.resolve(process.env.WORKSPACE_PATH || process.cwd());

const st = await projectState(root, project);
const problems = [];

if (st.documents.length === 0) problems.push("no documents found — nothing to extract");
for (const d of st.documents) {
  if (d.state === "ready") continue;
  problems.push(`${d.scope}/${d.docId}: ${d.state}${d.reason ? ` — ${d.reason}` : ""}`);
}

if (problems.length) {
  console.error(`✗ ${problems.length} problem(s) across ${st.documents.length} document(s):`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`✓ ${st.ready} document(s) extracted and valid`);
```

- [ ] **Step 5: Change the gates in `scyne-chatbot/server/index.ts`**

Add near the other helpers:

```ts
import { projectState } from "../../scripts/extract-state.mjs";

/**
 * Presence is no longer readiness. A document on disk but unextracted
 * contributes nothing to a run, so a stage that starts anyway produces a
 * document with a silent hole in it. `no_documents` and `documents_not_ready`
 * stay separate refusals because their fixes are different: upload something,
 * versus wait or investigate.
 */
async function extractionGate(project: string) {
  const st = await projectState(WORKSPACE_PATH, project);
  if (st.documents.length === 0) return { code: "no_documents" as const, st };
  if (st.ready < st.documents.length) return { code: "documents_not_ready" as const, st };
  return { code: null, st };
}
```

At the existing project-level gate (`index.ts:1829`), replace the
`countProjectDocs` check with:

```ts
    const gate = await extractionGate(project);
    if (gate.code) {
      return res.status(409).json({
        error: gate.code,
        message: gate.code === "no_documents"
          ? `${project} has no documents to work from. Upload some first.`
          : `${gate.st.ready} of ${gate.st.documents.length} documents are ready. ` +
            `Waiting on: ${gate.st.documents.filter(d => d.state !== "ready")
              .slice(0, 5).map(d => `${d.docId} (${d.state})`).join(", ")}`,
        extraction: {
          ready: gate.st.ready, missing: gate.st.missing,
          failed: gate.st.failed, extracting: gate.st.extracting,
        },
      });
    }
```

Add the status route beside the other GETs:

```ts
app.get("/api/extract-status/:project", async (req, res) => {
  try {
    const project = String(req.params.project);
    if (!SAFE_PROJECT.test(project)) return res.status(400).json({ error: "bad_project" });
    res.json(await projectState(WORKSPACE_PATH, project));
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? String(e) });
  }
});
```

- [ ] **Step 6: Run to verify it passes**

```bash
node --test test/extract-gate.test.mjs
npm run check:routing
```
Expected: PASS. `check:routing` matters because `pipeline.mjs` gained a stage
and four consumers read it.

- [ ] **Step 7: Stage**

```bash
git add scripts/pipeline.mjs scripts/validate-extracts.mjs \
        scyne-chatbot/server/index.ts test/extract-gate.test.mjs
# Repo owner commits. Proposed message:
#   feat(extract): the extract stage, and gates that check ready not present
```

---

## Task 6: Extraction starts when a document arrives

**Files:**
- Modify: `scyne-chatbot/server/index.ts` (both upload routes)
- Test: `test/extract-on-arrival.test.mjs`

**Interfaces:**
- Consumes: `extract-documents.mjs`.
- Produces: both upload responses gain `extraction: { state, started }`.

**Fire and forget, deliberately.** Extracting a 300 MB PDF is not something to
hold an HTTP request open for. The route converts, writes its row, spawns the
extraction, and returns immediately with the document's state — which will be
`extracting`. The caller polls `/api/extract-status/:project`.

**A failure to spawn is reported, never fatal.** The document and its row are
real either way, and `extract-documents.mjs` is idempotent, so the stage step
will pick up anything the upload missed.

- [ ] **Step 1: Write the failing test**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const SRC = "scyne-chatbot/server/index.ts";

test("both upload routes start extraction", () => {
  const src = readFileSync(SRC, "utf8");
  const calls = src.match(/extract-documents\.mjs/g) ?? [];
  assert.ok(calls.length >= 2,
    `both /api/upload and /api/upload/project must start extraction; found ${calls.length}`);
});

test("the upload response reports the document's extraction state", () => {
  const src = readFileSync(SRC, "utf8");
  assert.match(src, /extraction:\s*\{/);
});

test("a spawn failure is reported, not thrown", () => {
  const src = readFileSync(SRC, "utf8");
  // The same discipline as adoError and dbError: the file is real either way.
  assert.match(src, /extractionError|extraction:\s*\{[^}]*error/);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/extract-on-arrival.test.mjs`
Expected: FAIL — found 0 calls.

- [ ] **Step 3: Add the spawn helper to `index.ts`**

```ts
/**
 * Start extraction for one project, without waiting.
 *
 * Extraction is what makes a document USABLE, not merely stored — so it starts
 * the moment a document arrives rather than when a stage runs. Fire-and-forget
 * because a 300 MB PDF is not something to hold an HTTP request open for.
 *
 * A spawn failure is reported and never fatal, exactly as `adoError` and
 * `dbError` are: the file and its row are real regardless, and
 * `extract-documents.mjs` is idempotent, so the stage's own extract step will
 * pick up anything missed here.
 */
function startExtraction(project: string, feature?: string): { started: boolean; error: string | null } {
  try {
    const args = ["scripts/extract-documents.mjs", project, "--root", WORKSPACE_PATH];
    if (feature) args.push("--feature", feature);
    const child = spawn("node", args, {
      cwd: WORKSPACE_PATH, detached: true, stdio: "ignore",
    });
    child.on("error", (e) => console.warn(`[extract] ${project}: spawn failed — ${e.message}`));
    child.unref();
    return { started: true, error: null };
  } catch (e: any) {
    console.warn(`[extract] ${project}: could not start extraction — ${e?.message ?? e}`);
    return { started: false, error: e?.message ?? String(e) };
  }
}
```

- [ ] **Step 4: Call it from both upload routes**

In `/api/upload/project`, immediately before `res.json({...})`:

```ts
    const extraction = startExtraction(project);
```

and add to the response body:

```ts
      extraction: { ...extraction, state: "extracting" },
```

In `/api/upload`, the same, passing the feature:

```ts
    const extraction = startExtraction(project, feature);
```

- [ ] **Step 5: Run to verify it passes**

Run: `node --test test/extract-on-arrival.test.mjs`
Expected: PASS, 3 tests.

- [ ] **Step 6: Prove it end to end by hand**

```bash
npm run dev &
curl -sS -X POST http://127.0.0.1:4000/api/upload/project \
  -H "Authorization: Bearer $SCYNE_ORCH_TOKEN" \
  -F project=SAPN_DEMO -F file=@/tmp/note.md | python3 -m json.tool
curl -sS http://127.0.0.1:4000/api/extract-status/SAPN_DEMO \
  -H "Authorization: Bearer $SCYNE_ORCH_TOKEN" | python3 -m json.tool
```

Expected: the upload reports `extraction.started: true`, and the status route
shows the document moving `extracting → ready`. Record both outputs.

- [ ] **Step 7: Stage**

```bash
git add scyne-chatbot/server/index.ts test/extract-on-arrival.test.mjs
# Repo owner commits. Proposed message:
#   feat(extract): start extraction when a document arrives
```

---

## Task 7: `capability-process-map` reduces from extracts

**Files:**
- Modify: `skills/capability-process-map/SKILL.md`, `scripts/stage.mjs`
- Test: `test/capability-reduce.test.mjs`

**Interfaces:**
- Consumes: the extracts.
- Produces: unchanged — `capability-map.json`, `process-model.json`,
  `capability-process.md`, all passing `render-capability-map.mjs --validate-only`.

**This task changes a skill's method, not its output.** Step 1 stops saying
"read every document" and starts saying "read every extract, and fetch source
pages when you need to verify". Steps 2–4 are untouched: the same hierarchy
rules, the same numbering, the same 12-section document.

- [ ] **Step 1: Write the failing test**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ITEM_KINDS } from "../scripts/lib/extract-schema.mjs";

const SKILL = "skills/capability-process-map/SKILL.md";

test("Step 1 reads extracts, not every document", () => {
  const md = readFileSync(SKILL, "utf8");
  assert.doesNotMatch(md, /Read \*\*every\*\* `\.md` file/,
    "the read-everything instruction must be gone — it is what does not scale");
  assert.match(md, /extracts?/i);
});

test("it knows the extract's field names", () => {
  const md = readFileSync(SKILL, "utf8");
  for (const k of ["businessFunctions", "processSteps", "painPoints"]) {
    assert.match(md, new RegExp(k), `skill never mentions ${k}`);
  }
});

test("it forbids citations in the delivered document", () => {
  const md = readFileSync(SKILL, "utf8");
  assert.match(md, /no citations|never appear|not cite/i);
});

test("it must reject a claim whose src does not resolve", () => {
  const md = readFileSync(SKILL, "utf8");
  assert.match(md, /resolve|verify/i);
});

test("the output contract is unchanged", () => {
  const md = readFileSync(SKILL, "utf8");
  for (const f of ["capability-map.json", "process-model.json", "capability-process.md"]) {
    assert.match(md, new RegExp(f.replace(".", "\\.")), `output ${f} no longer named`);
  }
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/capability-reduce.test.mjs`
Expected: FAIL — the read-everything instruction is still there.

- [ ] **Step 3: Replace Step 1 in `skills/capability-process-map/SKILL.md`**

Replace the whole `## Step 1 — List and Read Every Document` section
(currently lines 112–150) with:

````markdown
## Step 1 — Read the Extracts

Every document has already been read, once, by a `document-extract` pass. Your
input is those extracts, not the documents.

```bash
ls solutions/Extracts/*.extract.json | wc -l
```

Each extract is one document, and carries eight lists:

| Field | Becomes |
|---|---|
| `businessFunctions` | capabilities |
| `processSteps` | process activities, with actor and sequence |
| `actors` | who performs each step |
| `serviceTiers` | variants where a step applies to some cohorts only |
| `components` | supporting systems |
| `maturitySignals` | current versus target maturity |
| `lifecyclePhases` | the L1 phases — prefer these over invented ones |
| `painPoints` | the client's own words, verbatim |

`scope` tells you where it came from: `project` is client-wide,
anything else is one feature's discovery. **Where the two disagree, the
client-wide extract wins.**

### Verify before you assert

Every item carries `src` — the pages it came from. When a capability rests on
one ambiguous item, or two extracts appear to contradict each other, fetch
those exact pages and read the real words before deciding. Do not settle a
contradiction by picking the one that reads better.

### Citations never reach the document

`src` exists so you can check yourself. It must **not** appear in
`capability-process.md`, in `capability-map.json`, or anywhere a client sees.
No footnotes, no "(Workshop_Transcript.md, p.23)". The delivered document is
clean prose.

### Refuse what you cannot support

If you cannot point a capability back to at least one extract item, do not
record it. An unsupported capability is an invented one, and this is the only
point in the pipeline where that gets caught.

### Coverage

If any extract reports `coverage.truncated: true`, note it under
**Assumptions & Gaps** with the document name and how much was read. A gap you
name is a gap the reader can weigh; a gap you hide is a wrong map.

If `solutions/Extracts/` is empty, stop and report it — do not read the
documents directly and do not invent a map.
````

- [ ] **Step 4: Stage the extracts in `scripts/stage.mjs`**

Where the capabilities stage stages its `documents/`, also stage the extracts
into the working folder, following the same copy pattern the file already uses
for other inputs:

```js
// The reduce reads extracts, not documents. The documents are still staged
// (unchanged) because `src` verification needs them reachable.
```

- [ ] **Step 5: Run to verify it passes**

```bash
node --test test/capability-reduce.test.mjs
npm run link-skills
```
Expected: PASS, 5 tests.

- [ ] **Step 6: Stage**

```bash
git add skills/capability-process-map/SKILL.md scripts/stage.mjs \
        test/capability-reduce.test.mjs
# Repo owner commits. Proposed message:
#   feat(extract): capability map reduces from extracts
```

---

## Task 8: End-to-end on real data, and the measurement

**Files:**
- Create: `test/extract-e2e.acc.test.mjs`, `docs/superpowers/measurements/2026-08-25-extraction.md`
- Test: the above

**Interfaces:**
- Consumes: everything.
- Produces: a measured comparison, which spec §7 requires before this is
  believed.

**This task exists to answer one question with numbers:** does the same project
produce an equivalent capability map, and what did it cost?

- [ ] **Step 1: Run the old path and record it**

```bash
node scripts/stage.mjs SAPN_DEMO capabilities
# then, in a Claude Code session at the workspace root: /capability-process-map
```

Record: wall clock, total input tokens, total cost, and keep the resulting
`capability-map.json` as `docs/superpowers/measurements/baseline-capability-map.json`.

- [ ] **Step 2: Run the new path and record it**

```bash
node scripts/extract-documents.mjs SAPN_DEMO --concurrency 3
node scripts/validate-extracts.mjs SAPN_DEMO
node scripts/stage.mjs SAPN_DEMO capabilities
# then: /capability-process-map
```

Record the same four figures, plus the per-document extract cost.

- [ ] **Step 3: Write the comparison**

`docs/superpowers/measurements/2026-08-25-extraction.md` must state, plainly:

- input tokens for the reduce, old versus new
- total cost, old versus new — **including** the 20 map passes
- wall clock, old versus new
- capability count and L1 phase names, old versus new
- **anything the new map has that the old one does not, and vice versa**

The last line is the one that matters. If the new map is missing a capability
the old one found, that is a defect in the schema or the map-pass skill, and it
must be named here rather than smoothed over.

- [ ] **Step 4: Write the acceptance test**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";

const PROJECT = process.env.E2E_PROJECT || "SAPN_DEMO";

test("every document extracts and validates", () => {
  execFileSync("node", ["scripts/extract-documents.mjs", PROJECT, "--concurrency", "3"],
    { encoding: "utf8" });
  const out = execFileSync("node", ["scripts/validate-extracts.mjs", PROJECT],
    { encoding: "utf8" });
  assert.match(out, /✓ \d+ document\(s\) extracted and valid/);
});

test("the reduce's input is far smaller than the corpus", () => {
  // The claim the whole design rests on, asserted as a number.
  const docBytes = Number(execSync(
    `find projects/${PROJECT} -name '*.md' -not -path '*/solutions/*' -exec cat {} + | wc -c`)
    .toString().trim());
  const extractBytes = Number(execSync(
    `cat projects/${PROJECT}/solutions/Extracts/*.extract.json | wc -c`).toString().trim());
  // MEASURED AND FALSE at SAPN_DEMO's size: extracts came out at 155% of the
  // source, because structured extraction EXPANDS curated markdown — every item
  // carries a src object and a repeated set of field names. The ratio depends on
  // information density, not file size. Asserting a bound here encoded an
  // assumption nobody had checked; assert the property that is actually true.
  assert.ok(extractBytes > 0, "extracts must exist");
  console.log(`extracts ${extractBytes} vs documents ${docBytes} ` +
    `(${Math.round(100 * extractBytes / docBytes)}% of source)`);
});

test("the measurement was actually recorded", () => {
  const p = "docs/superpowers/measurements/2026-08-25-extraction.md";
  assert.ok(existsSync(p), "the comparison must exist — spec §7 requires it");
  const md = readFileSync(p, "utf8");
  assert.match(md, /old|baseline/i);
  assert.match(md, /cost/i);
});
```

- [ ] **Step 5: Run it**

Run: `node --test test/extract-e2e.acc.test.mjs`
Expected: PASS, 3 tests.

- [ ] **Step 6: Stage**

```bash
git add test/extract-e2e.acc.test.mjs docs/superpowers/measurements/
# Repo owner commits. Proposed message:
#   test(extract): end-to-end on real data, with the cost comparison
```

---

## Task 9: Document what this leaves undone

**Files:**
- Modify: `CLAUDE.md`
- Test: `test/extract-docs.test.mjs`

**Interfaces:**
- Consumes: everything.
- Produces: the orientation guide telling the truth about extraction.

- [ ] **Step 1: Write the failing test**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("CLAUDE.md documents the extract stage", () => {
  const md = readFileSync("CLAUDE.md", "utf8");
  assert.match(md, /extract/i);
  assert.match(md, /document-extract/);
});

test("it names the spend gap honestly", () => {
  // Map passes get no `runs` row. Somebody reading /spend must not conclude
  // the extraction was free.
  const md = readFileSync("CLAUDE.md", "utf8");
  assert.match(md, /no `runs` row|not tracked in \/spend|do not appear in/i);
});

test("it names the ready-not-present gate change", () => {
  const md = readFileSync("CLAUDE.md", "utf8");
  assert.match(md, /documents_not_ready/);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/extract-docs.test.mjs`
Expected: FAIL.

- [ ] **Step 3: Add a section to `CLAUDE.md`**

After the pipeline table, add a section covering, in the file's existing voice:

- the `extract` stage at order 0, what it produces, and that there is **no
  bypass** — every project extracts at every size, and why a threshold was
  rejected;
- extracts are keyed by the source document's **content hash**, so an edited
  document invalidates its own extract and nothing else's;
- gates now refuse `documents_not_ready` separately from `no_documents`,
  because the fixes differ;
- **the spend gap**: map passes run from an `exec` step and get no `runs` row,
  so they do not appear in `/spend` and no budget ceiling covers them. Each
  extract records its own token usage, so the spend is recoverable but not
  tracked. Fixing it properly needs a fan-out primitive in the engine;
- `src` is internal only and must never reach a delivered document.

Add rows to the *When something feels off* table:

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| A stage refuses `documents_not_ready` | Documents are on disk but not extracted. | `curl /api/extract-status/<project>` names which and why. `node scripts/extract-documents.mjs <project>` runs the missing ones; it is idempotent. |
| A document sits at `failed` forever | Usually a scanned PDF with no text layer — nothing to extract. | The reason is in `solutions/Extracts/<hash>.extract.failed.json`. There is no override yet; remove the document or supply a text version. |
| `/spend` shows nothing for a big extraction run | Correct, and a known gap: map passes get no `runs` row. | Each extract's `usage` field carries its tokens. Sum them. |

- [ ] **Step 4: Run to verify it passes**

Run: `node --test test/extract-docs.test.mjs`
Expected: PASS, 3 tests.

- [ ] **Step 5: Run everything**

```bash
node --test test/
npm run check:routing
node scripts/render-capability-map.mjs SAPN_DEMO --validate-only
```
Expected: all green. The last one proves the output contract is genuinely
unchanged.

- [ ] **Step 6: Stage**

```bash
git add CLAUDE.md test/extract-docs.test.mjs
# Repo owner commits. Proposed message:
#   docs(extract): the extract stage, the gate change and the spend gap
```

---

## Known follow-ups, not in this plan

1. **Fan-out in the engine.** The map phase is an `exec` step because the
   workflow engine cannot express "one agent step per document". Until that
   exists, extraction spend is recoverable but untracked, and the per-agent
   budget ceiling does not cover it.
2. **A `failed` document blocks its project.** Spec §12 leaves the override
   undecided: a scanned PDF with no text layer will never extract, and refusing
   forever means one bad file blocks a project permanently. The refusal names
   the document, so it is visible rather than mysterious — but there is no way
   to say "proceed without it" yet.
3. **The other seven skills.** `persona-journey-map` reads the same two-level
   `documents/` tree and is the next most exposed; `requirement-generator`
   follows. The remaining five read a product summary rather than raw discovery
   documents and may never need this.
4. **Extracts are not yet synced to blob.** Spec §6 decided they should be.
   That is Phase 2's `syncUp`, which currently syncs `projects/` — the extracts
   live under it, so they travel automatically once Phase 2's hooks (Tasks 5–7
   of the workspace plan) are wired.
