# Workspace Plane (Phase 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Azure Blob the durable home of `projects/`, and let Codex drive and observe the existing Scyne orchestrator so work started from Codex is tracked exactly like work started from the chatbot.

**Architecture:** Two independent components inside the existing plugin. A **sync layer** mirrors `projects/` to a `workspace` blob container and back, hooked in at three chokepoints so the other ~39 files that read `projects/` stay unaware blob exists. A **second MCP server** wraps the orchestrator's HTTP API over a Bearer token, and performs workspace creation through the chatbot's existing routes so every write hits the folder tree **and** the database row.

**Tech Stack:** Node 24 · TypeScript (ESM, strict) · `@azure/storage-blob` · `@modelcontextprotocol/sdk` · vitest · Azurite

**Spec:** `docs/superpowers/specs/2026-08-25-workspace-plane-design.md`

## Global Constraints

- **Node >= 24**, ESM throughout. Relative imports carry a `.js` suffix even in `.ts` files.
- **TypeScript strict**, `moduleResolution: "bundler"`, `target: ES2023`.
- **All new code lives in `plugins/azure-file-processing/`.** The repo root has NO runtime dependencies (`package.json` `dependencies` is empty; only `concurrently`, `esbuild`, `tsx` as devDeps). `@azure/storage-blob` exists only in the plugin's `node_modules`. Root hooks therefore **shell out** to the plugin's CLI rather than importing it.
- **vitest.** Unit tests `test/*.test.ts` (`npm test`); integration `test/*.int.test.ts` (`npm run test:integration`, sequential via `vitest.integration.config.ts`). Integration tests must FAIL LOUDLY when Azurite is unreachable, never skip.
- **The MCP server key `scyne` is taken** by the file plane. Server 2 registers under **`scyne-workspace`**.
- **`stack.sh up` runs the orchestrator NATIVELY**, with Azurite and workers in Docker. Do not assume three Compose services. `up --all-docker` is the all-container variant.
- **Blob is the source of truth; local `projects/` is a disposable cache.** Blob wins on `syncDown`, local wins on `syncUp`, and **nothing is ever deleted implicitly**.
- **Every creation writes BOTH stores** — folder tree and database row — by going through the chatbot's existing routes. A database-half failure is reported as `dbError`, never swallowed.
- **No payload in a log line.** The plugin's logger refuses non-scalar fields and throws above 512 characters.
- **Australian English** in user-facing copy.
- **The repo owner commits their own work.** Every task ends with `git add` of exactly its files plus a proposed commit message as a comment. Do not run `git commit`.
- Pinned versions already present in the plugin: `@azure/storage-blob@^12.33.0`, `@modelcontextprotocol/sdk@^1.30.0`, `zod@^4.4.3`, `vitest@^2.1.8`, `typescript@^5.7.2`, `tsx@^4.19.2`.

### Three places this plan corrects the spec

Each was checked against the code, and each would have been a broken task:

1. **`spend` wraps `GET /spend`, not `GET /usage`.** `/usage` on the engine
   router is the whole company as ONE row and accepts no grouping; the
   `?by=project|feature|user|agent|adapter|model` report is
   `GET /spend` on the platform router, behind `requireAdmin`
   (`platform-router.ts:767`). The 403-pass-through the spec asks for belongs to
   that route.
2. **`POST /issues` answers 201, not 202**, returning the issue row; it is the
   GATE decisions that answer 202. Either way the tool returns an id and does
   not wait.
3. **`GET /issues` cannot filter by project or feature.** `ListIssuesFilter`
   (`core/repo.ts:111`) accepts `parentId`, `status` and `assigneeAgentId` only
   — the project lives in `params` as jsonb. `list_issues` therefore sends
   `status` over the wire and filters the rest locally. Sending `?project=`
   would be worse than not filtering: an unknown query parameter is ignored, so
   the tool would return every issue in the company while appearing to have
   filtered.

### Out of scope, recorded

Spec §10's open question — whether `attach_document` should also start a
processing job so a document is searchable as well as attached — stays open.
The two containers have different lifecycles (`uploads` is transient,
`workspace` is durable), and the spec defers the decision until the usage is
visible. No task here couples them.

---

## File Structure

```
plugins/azure-file-processing/
  src/workspace/
    paths.ts        local path <-> blob path mapping (pure)
    manifest.ts     hash a tree, diff two trees (pure)
    sync.ts         syncDown · syncUp · syncStatus
    server.ts       MCP server 2: HTTP + transport
    mcp.ts          tool registration for server 2
    orchestrator.ts Bearer HTTP client for the orchestrator API
    tools/
      start-stage.ts  issue-status.ts  list-issues.ts
      gates.ts        control.ts       spend.ts
      workspace.ts    create_project · create_feature · attach_document · list_*
  scripts/
    sync.mjs        the CLI the root hooks shell out to
  test/
    paths.test.ts  manifest.test.ts        (unit)
    sync.int.test.ts  workspace-mcp.int.test.ts  dual-write.int.test.ts  (integration)

repo root (three hook sites only):
  scripts/stage.mjs                 + one syncDown call
  scyne-chatbot/server/index.ts     + syncUp after each upload route
  orchestrator.workflows.ts         + one exec step per compiled workflow
```

`paths.ts` and `manifest.ts` are pure and unit-tested with no Azurite, which is what lets every later task assert exact behaviour.

---

> **How the three hooks invoke the sync CLI** (Tasks 5, 6 and 7 all use this, and
> the plan was internally inconsistent about it until Task 4 was exercised).
> Two constants, resolved from the workspace root:
>
> ```js
> const SYNC_TSX = path.join(WORKSPACE, "plugins/azure-file-processing/node_modules/.bin/tsx");
> const SYNC_CLI = path.join(WORKSPACE, "plugins/azure-file-processing/scripts/sync.mjs");
> ```
>
> Bare `node` cannot run the script — it imports the TypeScript sync engine and
> the plugin has no build step, so it dies with `ERR_MODULE_NOT_FOUND`. `npx tsx`
> was rejected because on a machine where tsx is not cached `npx` DOWNLOADS it,
> putting a network fetch inside a hook that runs before every pipeline stage.
> The plugin-local binary is this repo's existing precedent: `scripts/stack.sh:45`
> starts the file-plane orchestrator exactly that way.

# PHASE 2a — THE SYNC LAYER

## Task 1: Path mapping

**Files:**
- Create: `plugins/azure-file-processing/src/workspace/paths.ts`
- Test: `plugins/azure-file-processing/test/paths.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `WORKSPACE_CONTAINER = "workspace"`
  - `blobPathFor(localPath: string, workspaceRoot: string): string` — strips `<root>/projects/`
  - `localPathFor(blobPath: string, workspaceRoot: string): string` — the inverse
  - `projectPrefix(project: string): string` → `"SAPN/"`
  - `assertSafeSegment(name: string): void` — throws on `..`, path separators, absolute paths

> **Correction applied during execution (Task 1 review).** As first drafted, this
> task declared `assertSafeSegment` and then called it from nowhere — dead code —
> while `localPathFor` raw-joined its input. Task 3's `syncDown` calls
> `localPathFor(entry.path, root)` with `entry.path` taken from **enumerating
> blobs**, and blob is the source of truth, so blob names are the one input this
> layer cannot assume is well-formed: `"SAPN/../../../etc/x"` escaped
> `<root>/projects/`. `localPathFor` now validates every segment with
> `assertSafeSegment` before joining, and `assertSafeSegment` also rejects a bare
> `"."` and an empty segment. The signature is unchanged — it throws on a hostile
> path. Task 3 needs no change; the guard sits one layer below it.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { blobPathFor, localPathFor, projectPrefix, assertSafeSegment } from "../src/workspace/paths.js";

const ROOT = "/repo";

describe("blobPathFor", () => {
  it("strips the workspace root and the projects/ prefix", () => {
    expect(blobPathFor("/repo/projects/SAPN/MVP/requirements/SOP/a.md", ROOT))
      .toBe("SAPN/MVP/requirements/SOP/a.md");
  });

  it("handles a project-level document", () => {
    expect(blobPathFor("/repo/projects/SAPN/documents/policy.md", ROOT))
      .toBe("SAPN/documents/policy.md");
  });

  it("refuses a path outside projects/", () => {
    expect(() => blobPathFor("/repo/scripts/stage.mjs", ROOT)).toThrow(/outside/);
  });

  it("round-trips through localPathFor", () => {
    const local = "/repo/projects/SAPN/MVP/outputs/stories.json";
    expect(localPathFor(blobPathFor(local, ROOT), ROOT)).toBe(local);
  });

  it("normalises a trailing slash on the root", () => {
    expect(blobPathFor("/repo/projects/X/a.md", "/repo/")).toBe("X/a.md");
  });
});

describe("projectPrefix", () => {
  it("ends with a slash so one project cannot prefix another", () => {
    // "SA" must not match "SAPN/..." — the slash forces a segment boundary.
    expect(projectPrefix("SA")).toBe("SA/");
    expect("SAPN/MVP/a.md".startsWith(projectPrefix("SA"))).toBe(false);
  });
});

describe("assertSafeSegment", () => {
  it("accepts an ordinary name", () => {
    expect(() => assertSafeSegment("Appeals & Reviews")).not.toThrow();
  });

  it("refuses traversal, separators and absolute paths", () => {
    for (const bad of ["..", "a/b", "a\\b", "/abs", "../x"]) {
      expect(() => assertSafeSegment(bad), bad).toThrow();
    }
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm --prefix plugins/azure-file-processing test -- paths`
Expected: FAIL — `Cannot find module '../src/workspace/paths.js'`

- [ ] **Step 3: Implement**

```ts
import { relative, isAbsolute, sep, posix } from "node:path";

export const WORKSPACE_CONTAINER = "workspace";

/** Blob paths mirror the local tree with `projects/` removed, so the mapping is
 *  mechanical and reversible with no lookup table. Always POSIX separators —
 *  a blob name containing a backslash is a different blob. */
export const blobPathFor = (localPath: string, workspaceRoot: string): string => {
  const root = workspaceRoot.replace(/[/\\]+$/, "");
  const rel = relative(`${root}${sep}projects`, localPath);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`path is outside projects/: ${localPath}`);
  }
  return rel.split(sep).join(posix.sep);
};

export const localPathFor = (blobPath: string, workspaceRoot: string): string => {
  const root = workspaceRoot.replace(/[/\\]+$/, "");
  return [root, "projects", ...blobPath.split(posix.sep)].join(sep);
};

/** The trailing slash matters: without it, prefix "SA" would also match every
 *  blob under "SAPN/". */
export const projectPrefix = (project: string): string => `${project}/`;

export const assertSafeSegment = (name: string): void => {
  if (!name || name.includes("..") || /[/\\]/.test(name) || isAbsolute(name)) {
    throw new Error(`unsafe name segment: ${JSON.stringify(name)}`);
  }
};
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm --prefix plugins/azure-file-processing test -- paths`
Expected: PASS (11 assertions)

- [ ] **Step 5: Stage**

```bash
git add plugins/azure-file-processing/src/workspace/paths.ts \
        plugins/azure-file-processing/test/paths.test.ts
# Repo owner commits. Proposed message:
#   feat(workspace): local <-> blob path mapping
```

---

## Task 2: The manifest — hashing a tree and diffing two of them

**Files:**
- Create: `plugins/azure-file-processing/src/workspace/manifest.ts`
- Test: `plugins/azure-file-processing/test/manifest.test.ts`

**Interfaces:**
- Consumes: `blobPathFor` (Task 1).
- Produces:
  - `interface Entry { path: string; sha256: string; bytes: number }` — `path` is the BLOB path
  - `hashFile(absPath: string): Promise<string>`
  - `localManifest(workspaceRoot: string, project: string, prefix?: string): Promise<Entry[]>`

> **Corrections applied during execution (Task 2 review).** The reference code in
> this task's Step 3 had four defects, all fixed before Task 3 was dispatched:
> **(a)** `walk` used `stat`, which FOLLOWS symlinks — a link inside a project
> pointing outside it was hashed as its target's content while keeping a path
> that the prefix guard accepted, so `syncUp` would have uploaded arbitrary
> locally-readable content into a client's blob container. It uses `lstat` and
> skips symlinks. **(b)** Only `readdir` was guarded, so a file deleted mid-walk
> rejected the whole manifest; `ENOENT` now omits that file and is counted.
> **(c)** Entry order followed `readdir`, which guarantees nothing; entries are
> sorted by path, because Task 3 compares manifests. **(d)** No test used two
> files of the SAME byte length and different bytes — the one case a size-only
> implementation gets wrong, and the property this task exists for.
  - `diff(local: Entry[], remote: Entry[]): { onlyLocal: Entry[]; onlyRemote: Entry[]; differing: Entry[]; same: Entry[] }`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashFile, localManifest, diff, type Entry } from "../src/workspace/manifest.js";

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "ws-man-"));
  mkdirSync(join(root, "projects/SAPN/MVP/requirements/SOP"), { recursive: true });
  mkdirSync(join(root, "projects/SAPN/documents"), { recursive: true });
  mkdirSync(join(root, "projects/OTHER"), { recursive: true });
  writeFileSync(join(root, "projects/SAPN/MVP/requirements/SOP/a.md"), "alpha");
  writeFileSync(join(root, "projects/SAPN/documents/policy.md"), "policy");
  writeFileSync(join(root, "projects/OTHER/x.md"), "other");
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

const e = (path: string, sha256: string, bytes = 1): Entry => ({ path, sha256, bytes });

describe("hashFile", () => {
  it("is the sha256 of the contents", async () => {
    // echo -n alpha | shasum -a 256
    expect(await hashFile(join(root, "projects/SAPN/MVP/requirements/SOP/a.md")))
      .toBe("6c0e2f1b0e1e0b3a4e0d6e0e3e5b6f4f2a5a3a1b8c9d0e1f2a3b4c5d6e7f8a9b".length === 64
        ? await hashFile(join(root, "projects/SAPN/MVP/requirements/SOP/a.md"))
        : "");
  });

  it("returns 64 hex characters", async () => {
    const h = await hashFile(join(root, "projects/SAPN/documents/policy.md"));
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it("differs for different content", async () => {
    const a = await hashFile(join(root, "projects/SAPN/MVP/requirements/SOP/a.md"));
    const b = await hashFile(join(root, "projects/SAPN/documents/policy.md"));
    expect(a).not.toBe(b);
  });
});

describe("localManifest", () => {
  it("lists a project's files as blob paths, recursively", async () => {
    const m = await localManifest(root, "SAPN");
    expect(m.map((x) => x.path).sort()).toEqual([
      "SAPN/MVP/requirements/SOP/a.md",
      "SAPN/documents/policy.md",
    ]);
  });

  it("does not leak another project's files", async () => {
    const m = await localManifest(root, "SAPN");
    expect(m.some((x) => x.path.startsWith("OTHER/"))).toBe(false);
  });

  it("narrows to a prefix", async () => {
    const m = await localManifest(root, "SAPN", "MVP/requirements");
    expect(m.map((x) => x.path)).toEqual(["SAPN/MVP/requirements/SOP/a.md"]);
  });

  it("returns empty for a project that does not exist locally", async () => {
    expect(await localManifest(root, "NOPE")).toEqual([]);
  });

  it("records byte length", async () => {
    const m = await localManifest(root, "SAPN", "documents");
    expect(m[0].bytes).toBe(6); // "policy"
  });
});

describe("diff", () => {
  it("classifies every file exactly once", () => {
    const local = [e("a", "h1"), e("b", "h2"), e("c", "h3")];
    const remote = [e("b", "h2"), e("c", "hX"), e("d", "h4")];
    const d = diff(local, remote);
    expect(d.onlyLocal.map((x) => x.path)).toEqual(["a"]);
    expect(d.onlyRemote.map((x) => x.path)).toEqual(["d"]);
    expect(d.differing.map((x) => x.path)).toEqual(["c"]);
    expect(d.same.map((x) => x.path)).toEqual(["b"]);
  });

  it("is empty on both sides for identical trees", () => {
    const both = [e("a", "h1"), e("b", "h2")];
    const d = diff(both, both);
    expect(d.onlyLocal).toEqual([]);
    expect(d.onlyRemote).toEqual([]);
    expect(d.differing).toEqual([]);
    expect(d.same).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm --prefix plugins/azure-file-processing test -- manifest`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { blobPathFor, projectPrefix } from "./paths.js";

export interface Entry { path: string; sha256: string; bytes: number }

/** Streamed, so a large artefact does not land in memory just to be hashed. */
export const hashFile = (absPath: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const h = createHash("sha256");
    createReadStream(absPath)
      .on("data", (c) => h.update(c))
      .on("end", () => resolve(h.digest("hex")))
      .on("error", reject);
  });

const walk = async (dir: string, out: string[]): Promise<string[]> => {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (e: any) {
    if (e?.code === "ENOENT") return out;
    throw e;
  }
  for (const n of names) {
    const p = join(dir, n);
    const s = await stat(p);
    if (s.isDirectory()) await walk(p, out);
    else out.push(p);
  }
  return out;
};

export const localManifest = async (
  workspaceRoot: string, project: string, prefix?: string,
): Promise<Entry[]> => {
  const base = prefix
    ? join(workspaceRoot, "projects", project, prefix)
    : join(workspaceRoot, "projects", project);
  const files = await walk(base, []);
  const entries: Entry[] = [];
  for (const f of files) {
    const path = blobPathFor(f, workspaceRoot);
    // Belt and braces: walk() already starts inside the project, but a symlink
    // could otherwise carry us out of it.
    if (!path.startsWith(projectPrefix(project))) continue;
    entries.push({ path, sha256: await hashFile(f), bytes: (await stat(f)).size });
  }
  return entries;
};

export const diff = (local: Entry[], remote: Entry[]) => {
  const r = new Map(remote.map((e) => [e.path, e]));
  const l = new Map(local.map((e) => [e.path, e]));
  const onlyLocal: Entry[] = [], differing: Entry[] = [], same: Entry[] = [];
  for (const e of local) {
    const other = r.get(e.path);
    if (!other) onlyLocal.push(e);
    else if (other.sha256 !== e.sha256) differing.push(e);
    else same.push(e);
  }
  const onlyRemote = remote.filter((e) => !l.has(e.path));
  return { onlyLocal, onlyRemote, differing, same };
};
```

- [ ] **Step 4: Simplify the first test**

The first `hashFile` test as written is circular — it compares the function to
itself. Replace it with a fixed expected value so it can actually fail:

```ts
  it("is the sha256 of the contents", async () => {
    // Verify independently: printf 'alpha' | shasum -a 256
    const h = await hashFile(join(root, "projects/SAPN/MVP/requirements/SOP/a.md"));
    const { createHash } = await import("node:crypto");
    expect(h).toBe(createHash("sha256").update("alpha").digest("hex"));
  });
```

- [ ] **Step 5: Run to verify it passes**

Run: `npm --prefix plugins/azure-file-processing test -- manifest`
Expected: PASS. If `localManifest` returns `OTHER/x.md`, the prefix guard is wrong.

- [ ] **Step 6: Stage**

```bash
git add plugins/azure-file-processing/src/workspace/manifest.ts \
        plugins/azure-file-processing/test/manifest.test.ts
# Repo owner commits. Proposed message:
#   feat(workspace): content-addressed tree manifest and diff
```

---

## Task 3: syncStatus, syncDown, syncUp

**Files:**
- Create: `plugins/azure-file-processing/src/workspace/sync.ts`
- Test: `plugins/azure-file-processing/test/sync.int.test.ts`

**Interfaces:**
- Consumes: `Storage`/`getStorage`/`ensureStorage` (`src/shared/storage.ts`), `Config`/`loadConfig` (`src/shared/config.ts`), `log` (`src/shared/logger.ts`), Task 1's paths, Task 2's manifest.
- Produces:
  - `ensureWorkspaceContainer(s: Storage): Promise<void>`
  - `remoteManifest(s: Storage, project: string, prefix?: string): Promise<Entry[]>`
  - `syncStatus(s, root, project, prefix?): Promise<{ onlyLocal: string[]; onlyBlob: string[]; differing: string[]; same: number }>`
  - `syncDown(s, root, project, opts?): Promise<{ pulled: number; skipped: number; bytes: number }>`
  - `syncUp(s, root, project, opts?): Promise<{ pushed: number; skipped: number; bytes: number }>`

> **Corrections applied during execution (Task 3 review).** Three, and the third
> is a defect this task's own fix created. **(a)** `syncStatus` and
> `remoteManifest` did not call `ensureWorkspaceContainer`, and `listBlobsFlat`
> on a container that does not exist THROWS a 404 rather than returning empty —
> verified against a live Azurite — so "what is out of sync?", the natural first
> command, failed on a fresh install. **(b)** `project` and `prefix` reach this
> module as bare strings that nothing upstream validated (Task 2 left that
> deliberately undecided): unchecked, `project = "../../etc"` resolves through
> `path.join` inside `localManifest`, which then WALKS and hashes that directory
> before `blobPathFor`'s guard three frames in can throw — a real read outside
> the sandbox as a side effect. `assertSafeScope` now validates at all four
> exported entry points. **(c)** The illustrative `downloadToFile(dest)` writes
> the final path directly, so an interrupted download left a TRUNCATED file at
> `dest` that a later hash check would call "in sync". Downloading to a sibling
> temp file and renaming fixes that — but a SIGKILL between the two (this
> orchestrator's own `Pause now` and `Cancel` verbs) then leaves a
> `<dest>.sync-<uuid>.tmp` that `localManifest`'s unfiltered walk would hash and
> `syncUp` would push to blob as a real document, permanently, since nothing
> deletes implicitly. `localManifest` excludes the pattern (the guard that holds
> whoever wrote the file) AND `syncDown` sweeps stale siblings before writing.
  - `opts` is `{ prefix?: string; dryRun?: boolean }`

**The rule this task exists to enforce:** blob wins on down, local wins on up, and **nothing is ever deleted implicitly**. A file present on one side only is reported, never removed — an accidental `rm -rf projects/` followed by `syncUp` must not empty the blob store.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/shared/config.js";
import { getStorage, ensureStorage } from "../src/shared/storage.js";
import { WORKSPACE_CONTAINER } from "../src/workspace/paths.js";
import { ensureWorkspaceContainer, syncUp, syncDown, syncStatus } from "../src/workspace/sync.js";

const cfg = loadConfig();
const s = getStorage(cfg);
let root: string;
const PROJ = "SYNCTEST";

const write = (rel: string, body: string) => {
  const p = join(root, "projects", PROJ, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, body);
  return p;
};

const wipeBlob = async () => {
  const c = s.blob.getContainerClient(WORKSPACE_CONTAINER);
  for await (const b of c.listBlobsFlat({ prefix: `${PROJ}/` })) {
    await c.getBlockBlobClient(b.name).deleteIfExists();
  }
};

beforeAll(async () => {
  try {
    await ensureStorage(s);
    await ensureWorkspaceContainer(s);
  } catch (e) {
    throw new Error("Azurite is not reachable. Run ./scripts/stack.sh up first.\n" + String(e));
  }
});

beforeEach(async () => {
  await wipeBlob();
  if (root) rmSync(root, { recursive: true, force: true });
  root = mkdtempSync(join(tmpdir(), "ws-sync-"));
});

afterAll(async () => {
  await wipeBlob();
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("syncUp / syncDown", () => {
  it("round-trips a tree byte-for-byte", async () => {
    write("documents/policy.md", "# policy\n");
    write("MVP/requirements/SOP/a.md", "alpha");
    const up = await syncUp(s, root, PROJ);
    expect(up.pushed).toBe(2);

    rmSync(join(root, "projects", PROJ), { recursive: true, force: true });
    const down = await syncDown(s, root, PROJ);
    expect(down.pulled).toBe(2);

    expect(readFileSync(join(root, "projects", PROJ, "documents/policy.md"), "utf8")).toBe("# policy\n");
    expect(readFileSync(join(root, "projects", PROJ, "MVP/requirements/SOP/a.md"), "utf8")).toBe("alpha");
  });

  it("skips unchanged files on a second push", async () => {
    write("documents/policy.md", "same");
    expect((await syncUp(s, root, PROJ)).pushed).toBe(1);
    const again = await syncUp(s, root, PROJ);
    expect(again.pushed).toBe(0);
    expect(again.skipped).toBe(1);
  });

  it("pushes a changed file on the second pass", async () => {
    write("documents/policy.md", "v1");
    await syncUp(s, root, PROJ);
    write("documents/policy.md", "v2");
    expect((await syncUp(s, root, PROJ)).pushed).toBe(1);
  });

  it("NEVER deletes: a blob absent locally survives syncUp", async () => {
    write("documents/a.md", "a");
    write("documents/b.md", "b");
    await syncUp(s, root, PROJ);
    rmSync(join(root, "projects", PROJ, "documents/b.md"));
    await syncUp(s, root, PROJ);
    const st = await syncStatus(s, root, PROJ);
    expect(st.onlyBlob).toContain(`${PROJ}/documents/b.md`);
  });

  it("NEVER deletes: a local file absent in blob survives syncDown", async () => {
    write("documents/a.md", "a");
    await syncUp(s, root, PROJ);
    write("documents/local-only.md", "keep me");
    await syncDown(s, root, PROJ);
    expect(existsSync(join(root, "projects", PROJ, "documents/local-only.md"))).toBe(true);
  });

  it("blob wins on syncDown", async () => {
    write("documents/x.md", "from blob");
    await syncUp(s, root, PROJ);
    write("documents/x.md", "local edit");
    await syncDown(s, root, PROJ);
    expect(readFileSync(join(root, "projects", PROJ, "documents/x.md"), "utf8")).toBe("from blob");
  });

  it("narrows to a prefix", async () => {
    write("documents/p.md", "p");
    write("MVP/requirements/SOP/s.md", "s");
    const up = await syncUp(s, root, PROJ, { prefix: "MVP/requirements" });
    expect(up.pushed).toBe(1);
    const st = await syncStatus(s, root, PROJ);
    expect(st.onlyLocal).toContain(`${PROJ}/documents/p.md`);
  });

  it("dryRun moves nothing", async () => {
    write("documents/p.md", "p");
    const up = await syncUp(s, root, PROJ, { dryRun: true });
    expect(up.pushed).toBe(1);            // reports what it WOULD do
    expect((await syncStatus(s, root, PROJ)).onlyLocal).toContain(`${PROJ}/documents/p.md`);
  });
});

describe("syncStatus", () => {
  it("reports a file changed on both sides as differing", async () => {
    write("documents/x.md", "one");
    await syncUp(s, root, PROJ);
    write("documents/x.md", "two");
    const st = await syncStatus(s, root, PROJ);
    expect(st.differing).toEqual([`${PROJ}/documents/x.md`]);
  });

  it("mutates nothing", async () => {
    write("documents/x.md", "one");
    await syncStatus(s, root, PROJ);
    const st = await syncStatus(s, root, PROJ);
    expect(st.onlyLocal).toEqual([`${PROJ}/documents/x.md`]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm --prefix plugins/azure-file-processing run test:integration -- sync`
Expected: FAIL — `Cannot find module '../src/workspace/sync.js'`

- [ ] **Step 3: Implement**

```ts
import { createReadStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { WORKSPACE_CONTAINER, localPathFor, projectPrefix } from "./paths.js";
import { localManifest, diff, type Entry } from "./manifest.js";
import type { Storage } from "../shared/storage.js";
import { log } from "../shared/logger.js";

export interface SyncOpts { prefix?: string; dryRun?: boolean }

export const ensureWorkspaceContainer = async (s: Storage): Promise<void> => {
  await s.blob.getContainerClient(WORKSPACE_CONTAINER).createIfNotExists();
};

/** The hash lives in blob METADATA, so a comparison costs a list call rather
 *  than a download. Content-addressed rather than mtime-based deliberately: a
 *  syncDown rewrites mtimes, and an mtime comparison would then push every file
 *  straight back up. */
export const remoteManifest = async (
  s: Storage, project: string, prefix?: string,
): Promise<Entry[]> => {
  const c = s.blob.getContainerClient(WORKSPACE_CONTAINER);
  const full = prefix ? `${projectPrefix(project)}${prefix.replace(/^\/+|\/+$/g, "")}/` : projectPrefix(project);
  const out: Entry[] = [];
  for await (const b of c.listBlobsFlat({ prefix: full, includeMetadata: true })) {
    out.push({
      path: b.name,
      sha256: b.metadata?.sha256 ?? "",
      bytes: b.properties.contentLength ?? 0,
    });
  }
  return out;
};

const paths = (es: Entry[]) => es.map((e) => e.path);

export const syncStatus = async (
  s: Storage, root: string, project: string, prefix?: string,
) => {
  const [local, remote] = await Promise.all([
    localManifest(root, project, prefix),
    remoteManifest(s, project, prefix),
  ]);
  const d = diff(local, remote);
  return {
    onlyLocal: paths(d.onlyLocal),
    onlyBlob: paths(d.onlyRemote),
    differing: paths(d.differing),
    same: d.same.length,
  };
};

export const syncUp = async (
  s: Storage, root: string, project: string, opts: SyncOpts = {},
) => {
  await ensureWorkspaceContainer(s);
  const [local, remote] = await Promise.all([
    localManifest(root, project, opts.prefix),
    remoteManifest(s, project, opts.prefix),
  ]);
  const d = diff(local, remote);
  const toPush = [...d.onlyLocal, ...d.differing];
  let bytes = 0;
  if (!opts.dryRun) {
    const c = s.blob.getContainerClient(WORKSPACE_CONTAINER);
    for (const e of toPush) {
      // uploadFile streams from disk: a 500 MB artefact is never resident.
      await c.getBlockBlobClient(e.path).uploadFile(localPathFor(e.path, root), {
        metadata: { sha256: e.sha256 },
      });
      bytes += e.bytes;
    }
  } else {
    bytes = toPush.reduce((n, e) => n + e.bytes, 0);
  }
  // d.onlyRemote is deliberately ignored: syncUp never deletes a blob.
  log.info("workspace.sync_up", {
    project, pushed: toPush.length, skipped: d.same.length,
    bytes, dryRun: Boolean(opts.dryRun),
  });
  return { pushed: toPush.length, skipped: d.same.length, bytes };
};

export const syncDown = async (
  s: Storage, root: string, project: string, opts: SyncOpts = {},
) => {
  await ensureWorkspaceContainer(s);
  const [local, remote] = await Promise.all([
    localManifest(root, project, opts.prefix),
    remoteManifest(s, project, opts.prefix),
  ]);
  // Invert the diff: from blob's point of view, "onlyRemote" is what we lack.
  const d = diff(remote, local);
  const toPull = [...d.onlyLocal, ...d.differing]; // onlyLocal here == only in blob
  let bytes = 0;
  if (!opts.dryRun) {
    const c = s.blob.getContainerClient(WORKSPACE_CONTAINER);
    for (const e of toPull) {
      const dest = localPathFor(e.path, root);
      await mkdir(dirname(dest), { recursive: true });
      await c.getBlockBlobClient(e.path).downloadToFile(dest);
      bytes += e.bytes;
    }
  } else {
    bytes = toPull.reduce((n, e) => n + e.bytes, 0);
  }
  // d.onlyRemote here == present locally, absent in blob. Never deleted.
  log.info("workspace.sync_down", {
    project, pulled: toPull.length, skipped: d.same.length,
    bytes, dryRun: Boolean(opts.dryRun),
  });
  return { pulled: toPull.length, skipped: d.same.length, bytes };
};
```

- [ ] **Step 4: Run to verify it passes**

Run:
```bash
cd plugins/azure-file-processing && ./scripts/stack.sh workers 0
npm run test:integration -- sync
```
Expected: PASS, 10 tests. The two "NEVER deletes" cases are the ones that matter — if either fails, the diff is being used to drive deletion somewhere.

- [ ] **Step 5: Prove the no-delete guard discriminates**

Temporarily add a deletion of `d.onlyRemote` to `syncUp`, re-run, and confirm the
"a blob absent locally survives syncUp" test fails. Restore. Record the output in
your report — a guard nobody has seen fail is a guard nobody has tested.

- [ ] **Step 6: Stage**

```bash
git add plugins/azure-file-processing/src/workspace/sync.ts \
        plugins/azure-file-processing/test/sync.int.test.ts
# Repo owner commits. Proposed message:
#   feat(workspace): syncUp, syncDown and syncStatus against blob
```

---

## Task 4: The sync CLI

**Files:**
- Create: `plugins/azure-file-processing/scripts/sync.mjs`
- Modify: `plugins/azure-file-processing/package.json` (add a `sync` script)
- Test: `plugins/azure-file-processing/test/sync-cli.int.test.ts`

**Interfaces:**
- Consumes: Task 3's `syncUp`/`syncDown`/`syncStatus`.
- Produces: a CLI the repo-root hooks shell out to —
  `plugins/azure-file-processing/node_modules/.bin/tsx scripts/sync.mjs <project> --up|--down|--status [--prefix P] [--dry-run] [--root R]`
  printing one JSON line to stdout and exiting non-zero on failure.

> **Correction applied during execution (Task 4).** The invocation is
> `plugins/azure-file-processing/node_modules/.bin/tsx scripts/sync.mjs …`, NOT
> bare `node`. The script imports the TypeScript sync engine and the plugin has
> no build step, so `node` dies with `ERR_MODULE_NOT_FOUND` before doing
> anything. `npx tsx` was rejected as the alternative: on a machine where tsx is
> not cached it DOWNLOADS, putting a network fetch inside a hook that runs
> before every pipeline stage. The plugin-local binary is the precedent already
> in this repo — `scripts/stack.sh:45` starts the file-plane orchestrator the
> same way. Tasks 5, 6 and 7 use this invocation.

**Why a CLI and not an import:** the repo root has NO runtime dependencies —
`@azure/storage-blob` lives only in this plugin's `node_modules`. `stage.mjs` and
the chatbot therefore invoke this script as a subprocess rather than importing
the module.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/shared/config.js";
import { getStorage, ensureStorage } from "../src/shared/storage.js";
import { WORKSPACE_CONTAINER } from "../src/workspace/paths.js";
import { ensureWorkspaceContainer } from "../src/workspace/sync.js";

const script = resolve(dirname(fileURLToPath(import.meta.url)), "../scripts/sync.mjs");
const cfg = loadConfig();
const s = getStorage(cfg);
const PROJ = "CLITEST";
let root: string;

const run = (...args: string[]) =>
  JSON.parse(execFileSync("node", [script, PROJ, "--root", root, ...args], { encoding: "utf8" }).trim());

const wipeBlob = async () => {
  const c = s.blob.getContainerClient(WORKSPACE_CONTAINER);
  for await (const b of c.listBlobsFlat({ prefix: `${PROJ}/` })) {
    await c.getBlockBlobClient(b.name).deleteIfExists();
  }
};

beforeAll(async () => { await ensureStorage(s); await ensureWorkspaceContainer(s); });
beforeEach(async () => {
  await wipeBlob();
  if (root) rmSync(root, { recursive: true, force: true });
  root = mkdtempSync(join(tmpdir(), "ws-cli-"));
  mkdirSync(join(root, "projects", PROJ, "documents"), { recursive: true });
  writeFileSync(join(root, "projects", PROJ, "documents/a.md"), "hello");
});
afterAll(async () => { await wipeBlob(); if (root) rmSync(root, { recursive: true, force: true }); });

describe("sync.mjs", () => {
  it("pushes and reports JSON", () => {
    const out = run("--up");
    expect(out).toMatchObject({ ok: true, direction: "up", pushed: 1 });
  });

  it("pulls into an empty tree", () => {
    run("--up");
    rmSync(join(root, "projects", PROJ), { recursive: true, force: true });
    const out = run("--down");
    expect(out).toMatchObject({ ok: true, direction: "down", pulled: 1 });
    expect(existsSync(join(root, "projects", PROJ, "documents/a.md"))).toBe(true);
  });

  it("reports status without moving anything", () => {
    const out = run("--status");
    expect(out.onlyLocal).toContain(`${PROJ}/documents/a.md`);
    expect(run("--status").onlyLocal).toHaveLength(1);
  });

  it("honours --dry-run", () => {
    expect(run("--up", "--dry-run")).toMatchObject({ dryRun: true, pushed: 1 });
    expect(run("--status").onlyLocal).toHaveLength(1);
  });

  it("exits non-zero and names the problem with no direction flag", () => {
    let code = 0, err = "";
    try {
      execFileSync("node", [script, PROJ, "--root", root], { encoding: "utf8" });
    } catch (e: any) { code = e.status; err = String(e.stderr ?? ""); }
    expect(code).not.toBe(0);
    expect(err).toMatch(/--up|--down|--status/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm --prefix plugins/azure-file-processing run test:integration -- sync-cli`
Expected: FAIL — script not found.

- [ ] **Step 3: Implement `scripts/sync.mjs`**

```js
#!/usr/bin/env node
// Mirrors projects/<project>/ between the local tree and the `workspace` blob
// container. Invoked as a subprocess by repo-root hooks, which cannot import
// this plugin's dependencies.
//
//   plugins/azure-file-processing/node_modules/.bin/tsx scripts/sync.mjs <project> --up|--down|--status [--prefix P] [--dry-run] [--root R]
import { resolve } from "node:path";
import { loadConfig } from "../src/shared/config.js";
import { getStorage } from "../src/shared/storage.js";
import { syncUp, syncDown, syncStatus } from "../src/workspace/sync.js";

const argv = process.argv.slice(2);
const project = argv[0];
const has = (f) => argv.includes(f);
const val = (f, d) => { const i = argv.indexOf(f); return i === -1 ? d : argv[i + 1]; };

const fail = (why) => { console.error(`sync failed: ${why}`); process.exit(2); };

if (!project || project.startsWith("--")) fail("usage: sync.mjs <project> --up|--down|--status");
const directions = ["--up", "--down", "--status"].filter(has);
if (directions.length !== 1) fail("pass exactly one of --up, --down or --status");

const root = resolve(val("--root", process.env.WORKSPACE_PATH || process.cwd()));
const prefix = val("--prefix", undefined);
const dryRun = has("--dry-run");

const cfg = loadConfig();
const s = getStorage(cfg);

try {
  if (has("--status")) {
    const st = await syncStatus(s, root, project, prefix);
    console.log(JSON.stringify({ ok: true, direction: "status", project, ...st }));
  } else if (has("--up")) {
    const r = await syncUp(s, root, project, { prefix, dryRun });
    console.log(JSON.stringify({ ok: true, direction: "up", project, dryRun, ...r }));
  } else {
    const r = await syncDown(s, root, project, { prefix, dryRun });
    console.log(JSON.stringify({ ok: true, direction: "down", project, dryRun, ...r }));
  }
} catch (e) {
  // Never print file contents; the message alone.
  fail(String(e?.message ?? e).slice(0, 400));
}
```

Note the plugin runs TypeScript through `tsx`, so this `.mjs` importing `.ts`
modules must be invoked accordingly. Add the npm script in Step 4 and have the
test call it the same way if a bare `node` invocation cannot resolve them.

- [ ] **Step 4: Add the npm script**

In `plugins/azure-file-processing/package.json`:

```json
    "sync": "node_modules/.bin/tsx scripts/sync.mjs",
```

**This script cannot run under bare `node`, and that is settled rather than
conditional.** It imports the TypeScript sync engine and the plugin has no build
step, so `node scripts/sync.mjs` dies with `ERR_MODULE_NOT_FOUND` before doing
anything — measured, not predicted. The plugin's other `.mjs` scripts
(`upload.mjs`, `make-fixture-pdf.mjs`) import only `node:` builtins, which is
why they do not hit this and are not the precedent to copy here.

Run it through the **plugin-local** binary, matching `scripts/stack.sh:45`:

```
plugins/azure-file-processing/node_modules/.bin/tsx scripts/sync.mjs …
```

Not `npx tsx`: on a machine where tsx is not cached, `npx` downloads it, and
this script runs inside a hook that fires before every pipeline stage. A network
fetch there is a failure mode nobody would predict from reading the hook.

The test must invoke the script **the same way the real callers do** — the
plugin-local binary, no `npx`. A subprocess test whose invocation differs from
production pins the wrong contract, and Tasks 5, 6 and 7 depend on this one.

- [ ] **Step 5: Run to verify it passes**

Run: `npm --prefix plugins/azure-file-processing run test:integration -- sync-cli`
Expected: PASS, 5 tests.

- [ ] **Step 6: Stage**

```bash
git add plugins/azure-file-processing/scripts/sync.mjs \
        plugins/azure-file-processing/package.json \
        plugins/azure-file-processing/test/sync-cli.int.test.ts
# Repo owner commits. Proposed message:
#   feat(workspace): sync CLI for the repo-root hooks
```

---

## Task 5: Hook 1 — `stage.mjs` syncs down before staging

**Files:**
- Modify: `scripts/stage.mjs` (repo root)
- Test: `plugins/azure-file-processing/test/stage-hook.int.test.ts`

**Interfaces:**
- Consumes: Task 4's CLI, invoked as a subprocess.
- Produces: nothing importable. The behaviour is that a stage always works from the authoritative copy.

**Context for the implementer:** `scripts/stage.mjs` resolves its tree root as
`const WORKSPACE = WORK_ROOT` (line 41), imported from `./lib/roots.mjs`. It runs
document conversion as step 0 via `convertTree` (imported line 32). The sync must
happen **before** conversion, so a document that exists only in blob is present
on disk to be converted.

**This file is at the repo root and cannot import the plugin's modules** — the
root has no runtime dependencies. Shell out.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/shared/config.js";
import { getStorage, ensureStorage } from "../src/shared/storage.js";
import { WORKSPACE_CONTAINER } from "../src/workspace/paths.js";
import { ensureWorkspaceContainer, syncUp } from "../src/workspace/sync.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const cfg = loadConfig();
const s = getStorage(cfg);
const PROJ = "HOOKTEST";
const FEAT = "demo";

const wipeBlob = async () => {
  const c = s.blob.getContainerClient(WORKSPACE_CONTAINER);
  for await (const b of c.listBlobsFlat({ prefix: `${PROJ}/` })) {
    await c.getBlockBlobClient(b.name).deleteIfExists();
  }
};
const localProj = join(repoRoot, "projects", PROJ);

beforeAll(async () => {
  await ensureStorage(s);
  await ensureWorkspaceContainer(s);
  await wipeBlob();
  rmSync(localProj, { recursive: true, force: true });
  // Seed a project locally, push it to blob, then delete the local copy —
  // so the only way stage.mjs can find it is by syncing down.
  mkdirSync(join(localProj, FEAT, "requirements/SOP"), { recursive: true });
  writeFileSync(join(localProj, FEAT, "requirements/SOP/policy.md"), "# policy\n\nrule one\n");
  mkdirSync(join(localProj, "documents"), { recursive: true });
  writeFileSync(join(localProj, "documents/client.md"), "# client\n");
  await syncUp(s, repoRoot, PROJ);
  rmSync(localProj, { recursive: true, force: true });
});

afterAll(async () => {
  await wipeBlob();
  rmSync(localProj, { recursive: true, force: true });
});

describe("stage.mjs sync hook", () => {
  it("stages a project that exists ONLY in blob", () => {
    expect(existsSync(localProj)).toBe(false);
    execFileSync("node", ["scripts/stage.mjs", PROJ, FEAT, "requirements"], {
      cwd: repoRoot, encoding: "utf8",
    });
    expect(existsSync(join(localProj, FEAT, "requirements/SOP/policy.md"))).toBe(true);
  });

  it("is a no-op on a second run — nothing to pull", () => {
    const out = execFileSync("node", ["scripts/stage.mjs", PROJ, FEAT, "requirements"], {
      cwd: repoRoot, encoding: "utf8",
    });
    expect(out).toMatch(/pulled 0|already up to date|synced/i);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run:
```bash
cd plugins/azure-file-processing && ./scripts/stack.sh workers 0
npm run test:integration -- stage-hook
```
Expected: FAIL — the project does not exist locally and `stage.mjs` refuses with
`no such project: projects/HOOKTEST`.

- [ ] **Step 3: Add the hook to `scripts/stage.mjs`**

Near the other imports (the file already imports from `./lib/roots.mjs` at
line 31):

```js
import { execFileSync } from "node:child_process";
```

Then, in the staging entry point — **before** the `convertTree` conversion pass,
and after `project` has been resolved — insert:

```js
/**
 * Blob is the source of truth for projects/; this local tree is a cache.
 *
 * Shelled out rather than imported on purpose: the repo root has NO runtime
 * dependencies, and @azure/storage-blob lives only in the plugin's
 * node_modules. A subprocess is the seam that keeps the root install lean.
 *
 * Non-fatal by design. A developer with no Azurite running must still be able
 * to stage from a local tree — the sync is an enrichment, not a gate.
 */
function syncDownFromBlob(project) {
  const cli = path.join(WORKSPACE, "plugins/azure-file-processing/scripts/sync.mjs");
  try {
    const out = execFileSync(
      SYNC_TSX, [cli, project, "--down", "--root", WORKSPACE],
      { cwd: path.join(WORKSPACE, "plugins/azure-file-processing"), encoding: "utf8" },
    );
    const r = JSON.parse(out.trim());
    console.log(`  synced: pulled ${r.pulled}, skipped ${r.skipped}`);
  } catch (e) {
    console.log(`  sync skipped: ${String(e?.message ?? e).split("\n")[0]}`);
  }
}
```

Call it as the first thing the staging path does for a resolved project, before
conversion.

- [ ] **Step 4: Run to verify it passes**

Run: `npm --prefix plugins/azure-file-processing run test:integration -- stage-hook`
Expected: PASS. The first test is the one that matters — it proves the hook is
load-bearing, because the project exists nowhere but blob.

- [ ] **Step 5: Confirm the non-fatal path**

Stop Azurite (`docker compose stop azurite`), run
`npm run stage -- SAPN MVP requirements` from the repo root, and confirm it still
stages from the local tree with a `sync skipped:` line rather than failing.
Restart Azurite afterwards (`docker compose start azurite`). Record the output.

- [ ] **Step 6: Stage**

```bash
git add scripts/stage.mjs \
        plugins/azure-file-processing/test/stage-hook.int.test.ts
# Repo owner commits. Proposed message:
#   feat(workspace): stage.mjs syncs down from blob before staging
```

---

## Task 6: Hook 2 — the chatbot's upload routes sync up

**Files:**
- Modify: `scyne-chatbot/server/index.ts` — `POST /api/upload` (line ~2505) and `POST /api/upload/project` (line ~2455)
- Test: `plugins/azure-file-processing/test/upload-hook.int.test.ts`

**Interfaces:**
- Consumes: Task 4's CLI as a subprocess.
- Produces: nothing importable. The behaviour is that an uploaded document reaches blob without anyone running a command.

**Context:** both routes already convert the document to markdown on arrival and
move the original into `original-files/`. The sync belongs **after** that, so blob
receives the converted `.md` and not the raw `.docx`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/shared/config.js";
import { getStorage, ensureStorage } from "../src/shared/storage.js";
import { WORKSPACE_CONTAINER } from "../src/workspace/paths.js";
import { ensureWorkspaceContainer, syncStatus } from "../src/workspace/sync.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const cfg = loadConfig();
const s = getStorage(cfg);
const PROJ = "UPLOADHOOK";

const wipeBlob = async () => {
  const c = s.blob.getContainerClient(WORKSPACE_CONTAINER);
  for await (const b of c.listBlobsFlat({ prefix: `${PROJ}/` })) {
    await c.getBlockBlobClient(b.name).deleteIfExists();
  }
};

beforeAll(async () => { await ensureStorage(s); await ensureWorkspaceContainer(s); await wipeBlob(); });
afterAll(async () => {
  await wipeBlob();
  rmSync(join(repoRoot, "projects", PROJ), { recursive: true, force: true });
});

describe("upload route sync hook", () => {
  it("a document written into the tree reaches blob when the hook runs", async () => {
    // The hook is a subprocess call; exercise it exactly as the route does.
    const docs = join(repoRoot, "projects", PROJ, "documents");
    mkdirSync(docs, { recursive: true });
    writeFileSync(join(docs, "uploaded.md"), "# uploaded\n");

    execFileSync(SYNC_TSX, [SYNC_CLI, PROJ, "--up", "--root", repoRoot], {
      cwd: join(repoRoot, "plugins/azure-file-processing"), encoding: "utf8",
    });

    const st = await syncStatus(s, repoRoot, PROJ);
    expect(st.onlyLocal).toEqual([]);
    expect(st.same).toBe(1);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm --prefix plugins/azure-file-processing run test:integration -- upload-hook`
Expected: FAIL — `sync.mjs` has not been wired anywhere yet, so nothing pushes.
(If Task 4 is complete this test may pass immediately; that is fine — it is
guarding the behaviour, and Step 3 is what makes the ROUTE do it.)

- [ ] **Step 3: Add a shared helper to the chatbot server**

Near the top of `scyne-chatbot/server/index.ts`:

```ts
import { execFile } from "node:child_process";

/**
 * Push this project's tree to blob after an upload.
 *
 * Fire-and-forget and non-fatal: the document is already on disk and already in
 * the database by the time this runs, and a sync failure must not turn a
 * successful upload into a 500. Failures are logged, exactly as `adoError` is
 * reported rather than thrown.
 */
function syncProjectToBlob(project: string): void {
  const cwd = path.join(WORKSPACE, "plugins/azure-file-processing");
  execFile(SYNC_TSX, [SYNC_CLI, project, "--up", "--root", WORKSPACE],
    { cwd },
    (err, stdout) => {
      if (err) console.warn(`[sync] ${project}: ${String(err.message).split("\n")[0]}`);
      else console.log(`[sync] ${project}: ${stdout.trim()}`);
    });
}
```

- [ ] **Step 4: Call it from both upload routes**

In `POST /api/upload` and `POST /api/upload/project`, after the conversion and
the database row are done and immediately before the response is sent:

```ts
  syncProjectToBlob(project);
```

Do not `await` it. The response must not wait on a blob round-trip.

- [ ] **Step 5: Verify end to end by hand**

Start the stack and the chatbot, upload a document through the Docs tab, then:

```bash
cd plugins/azure-file-processing
plugins/azure-file-processing/node_modules/.bin/tsx \
  plugins/azure-file-processing/scripts/sync.mjs <project> --status --root .
```

Expected: the uploaded document appears under `same`, not `onlyLocal`. Record the
output.

- [ ] **Step 6: Stage**

```bash
git add scyne-chatbot/server/index.ts \
        plugins/azure-file-processing/test/upload-hook.int.test.ts
# Repo owner commits. Proposed message:
#   feat(workspace): chatbot uploads sync through to blob
```

---

## Task 7: Hook 3 — every compiled workflow syncs its outputs up

**Files:**
- Modify: `orchestrator.workflows.ts`
- Test: `plugins/azure-file-processing/test/workflow-sync-step.test.ts`

**Interfaces:**
- Consumes: Task 4's CLI.
- Produces: a `syncOutputsStep(s: Stage): Step` appended to each compiled workflow.

**Context:** workflows are compiled from `scripts/pipeline.mjs`, which is what
makes "add a stage, get a workflow for free" true — so the step is added **once**
and every stage inherits it. Copy the shape of the existing
`ensureAdoProjectStep()` (around line 298):

```ts
function ensureAdoProjectStep(): Step {
  return {
    type: "exec",
    label: "Making sure the Azure DevOps project exists",
    cmd: `node --import tsx scripts/ensure-ado-project.mts "{project}"`,
    timeoutMs: 5 * MINUTES,
  };
}
```

Two rules this must respect, both learned the hard way in this repo:

1. **Quote every placeholder.** An `exec` step runs through `/bin/sh -c`, so an
   unquoted `{project}` word-splits and a project called `SA Demo` arrives as
   `SA`. `swap()` in this file already emits them quoted — follow it.
2. **`produces[]` is level-relative** — `projects/<p>/` for a project stage,
   `projects/<p>/<feature>/` for a feature stage. Resolving against the workspace
   root instead is what blocked a completed run during the Phase 1 prototype.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const src = readFileSync(resolve(repoRoot, "orchestrator.workflows.ts"), "utf8");

describe("workflow sync step", () => {
  it("defines a sync-outputs exec step", () => {
    expect(src).toMatch(/function syncOutputsStep/);
  });

  it("quotes the project placeholder — an unquoted one word-splits in sh", () => {
    const m = src.match(/function syncOutputsStep[\s\S]{0,600}?\}/);
    expect(m).toBeTruthy();
    expect(m![0]).toMatch(/"\{project\}"/);
    expect(m![0]).not.toMatch(/[^"]\{project\}[^"]/);
  });

  it("runs the plugin's sync CLI with --up", () => {
    const m = src.match(/function syncOutputsStep[\s\S]{0,600}?\}/)![0];
    expect(m).toMatch(/sync\.mjs/);
    expect(m).toMatch(/--up/);
  });

  it("is appended to the compiled workflow after attach", () => {
    // The step must exist in the step list, not merely be defined.
    expect(src).toMatch(/syncOutputsStep\(/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm --prefix plugins/azure-file-processing test -- workflow-sync-step`
Expected: FAIL — `syncOutputsStep` is not defined.

- [ ] **Step 3: Add the step**

```ts
/**
 * Push a stage's outputs to blob.
 *
 * Blob is the source of truth for projects/; the local tree is a cache. An agent
 * writes its artefacts to disk, so without this they exist only in the cache and
 * a `syncDown` on another day would not restore them.
 *
 * An `exec` step rather than a paragraph in a prompt, for the same reason the
 * work-item creation is a step: an instruction a model may or may not follow,
 * running beside a script that always does, is how you get half a backlog. A
 * non-zero exit blocks the issue with the real stderr, so a failed sync is
 * visible rather than silent.
 *
 * Placed AFTER attach so it can never race the agent still writing.
 */
function syncOutputsStep(s: Stage): Step {
  const prefix = s.level === LEVEL.FEATURE ? ` --prefix "{feature}"` : "";
  return {
    type: "exec",
    label: "Saving this stage's outputs",
    cmd:
      `plugins/azure-file-processing/node_modules/.bin/tsx ` +
      `plugins/azure-file-processing/scripts/sync.mjs "{project}" --up${prefix}`,
    timeoutMs: 10 * MINUTES,
  };
}
```

Then append `syncOutputsStep(s)` to each compiled workflow's step list, after the
`attach` step and after the publish step where one exists.

- [ ] **Step 4: Run to verify it passes**

Run: `npm --prefix plugins/azure-file-processing test -- workflow-sync-step`
Expected: PASS, 4 tests.

- [ ] **Step 5: Assert the workflows are still well-formed**

Run from the repo root:
```bash
npm run check:workflows
npm run check:routing
```
Expected: both pass. `check-workflows.mts` asserts the compiled shape; this task
changes it, so a green run is the evidence the change is legal.

- [ ] **Step 6: Stage**

```bash
git add orchestrator.workflows.ts \
        plugins/azure-file-processing/test/workflow-sync-step.test.ts
# Repo owner commits. Proposed message:
#   feat(workspace): every stage syncs its outputs to blob
```

---

# PHASE 2b — MCP SERVER 2

## Task 8: The orchestrator client and the server skeleton

**Files:**
- Create: `plugins/azure-file-processing/src/workspace/orchestrator.ts`, `src/workspace/mcp.ts`, `src/workspace/server.ts`
- Modify: `plugins/azure-file-processing/.mcp.json` (a SECOND entry), `package.json` (a `workspace-server` script)
- Test: `plugins/azure-file-processing/test/workspace-mcp.int.test.ts`

**Interfaces:**
- Consumes: `Config`/`loadConfig`, `log`.
- Produces:
  - `interface OrchCtx { cfg: Config }`
  - `orchFetch<T>(cfg: Config, method: string, path: string, body?: unknown): Promise<T>` — Bearer-authenticated, throws a named error the tools surface verbatim
  - `buildWorkspaceServer(ctx: OrchCtx): McpServer`
  - `startWorkspaceServer(ctx: OrchCtx, port: number): Promise<http.Server>`

**Two facts to build against:**

1. The orchestrator accepts `Authorization: Bearer` —
   `auth-middleware.ts` uses `bearerFrom(headers) ?? cookieCredential(headers)`.
2. **The `scyne` key is taken** by the file plane. This server registers as
   **`scyne-workspace`** on its own port (default **8081**), so both can run.

Config gains two values, following the existing `loadConfig` pattern in
`src/shared/config.ts`: `orchUrl` (default `http://127.0.0.1:3100`) and
`orchToken` (from `SCYNE_ORCH_TOKEN`, default `null`).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadConfig } from "../src/shared/config.js";
import { startWorkspaceServer } from "../src/workspace/server.js";

let server: Server;
let port: number;

beforeAll(async () => {
  // Port 0 lets the OS pick one, so the test never collides with a running
  // server. `orchPort` belongs to the FILE plane and is untouched here.
  server = await startWorkspaceServer({ cfg: loadConfig() }, 0);
  port = (server.address() as any).port;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });

const connect = async () => {
  const c = new Client({ name: "test", version: "0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
  return c;
};

describe("workspace MCP server", () => {
  it("serves health without a credential", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
    expect((await res.json() as any).service).toBe("scyne-workspace");
  });

  it("completes a handshake and lists its tools", async () => {
    const c = await connect();
    const names = (await c.listTools()).tools.map((t) => t.name).sort();
    expect(names).toContain("start_stage");
    await c.close();
  });

  it("404s an unknown path", async () => {
    expect((await fetch(`http://127.0.0.1:${port}/nope`)).status).toBe(404);
  });
});

describe(".mcp.json", () => {
  it("declares BOTH servers under distinct keys", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve, dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const p = resolve(dirname(fileURLToPath(import.meta.url)), "../.mcp.json");
    const m = JSON.parse(readFileSync(p, "utf8"));
    expect(Object.keys(m.mcpServers).sort()).toEqual(["scyne", "scyne-workspace"]);
    expect(m.mcpServers["scyne-workspace"].url).toBe("http://127.0.0.1:8081/mcp");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm --prefix plugins/azure-file-processing run test:integration -- workspace-mcp`
Expected: FAIL — module not found.

- [ ] **Step 3: Extend `src/shared/config.ts`**

Add to the `Config` interface and `loadConfig`, beside the existing values:

```ts
  /** Where MCP server 2 reaches the Scyne orchestrator. */
  orchUrl: string;
  /** Bearer token for it. auth-middleware accepts
   *  `bearerFrom(headers) ?? cookieCredential(headers)`, and this server is not
   *  a browser, so a token is the only option it has. */
  orchToken: string | null;
  /** Port for MCP server 2. 8080 belongs to the file plane. */
  workspacePort: number;
```

```ts
  orchUrl: env.SCYNE_ORCH_URL || "http://127.0.0.1:3100",
  orchToken: env.SCYNE_ORCH_TOKEN || null,
  workspacePort: num(env, "WORKSPACE_PORT", 8081),
```

Update `test/config.test.ts`'s defaults assertion to include the three.

- [ ] **Step 4: Write `src/workspace/orchestrator.ts`**

```ts
import type { Config } from "../shared/config.js";

export interface OrchCtx { cfg: Config }

/**
 * One call to the Scyne orchestrator.
 *
 * Errors are surfaced VERBATIM rather than reshaped. A 502 from the orchestrator
 * must not become a cheerful empty result — a model that cannot tell "no issues"
 * from "the server is down" will report the wrong thing to a person.
 */
export const orchFetch = async <T>(
  cfg: Config, method: string, path: string, body?: unknown,
): Promise<T> => {
  const url = `${cfg.orchUrl.replace(/\/+$/, "")}${path}`;
  const headers: Record<string, string> = { accept: "application/json" };
  if (cfg.orchToken) headers.authorization = `Bearer ${cfg.orchToken}`;
  if (body !== undefined) headers["content-type"] = "application/json";

  let res: Response;
  try {
    res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch (e: any) {
    throw new Error(
      `cannot reach the orchestrator at ${url}: ${e?.message ?? e}. ` +
      `Is it running? \`npm run dev\` from the repo root starts it on :3100.`);
  }

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`orchestrator answered ${res.status} for ${method} ${path}: ${text.slice(0, 400)}`);
  }
  return (text ? JSON.parse(text) : undefined) as T;
};
```

- [ ] **Step 5: Write `src/workspace/mcp.ts` with one tool registered**

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { OrchCtx } from "./orchestrator.js";

export type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  [k: string]: unknown;
};

export const jsonResult = (value: unknown): ToolResult => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
});

export const buildWorkspaceServer = (ctx: OrchCtx): McpServer => {
  const server = new McpServer({ name: "scyne-workspace", version: "0.1.0" });

  server.registerTool(
    "start_stage",
    {
      title: "Start a pipeline stage",
      description: "Placeholder — implemented in the next task.",
      inputSchema: { workflow: z.string(), project: z.string(), feature: z.string().optional() },
    },
    async () => jsonResult({ error: "not_implemented" }),
  );

  return server;
};
```

- [ ] **Step 6: Write `src/workspace/server.ts`**

Copy the shape of `src/orchestrator/server.ts`, which already solves the
stateless transport, the body cap and the `/health` route. Change four things:

1. the `/health` body's `service` to **`scyne-workspace`** — the file plane
   answers `"service":"azure-files"`, and `stack.sh`'s `orch_is_ours` shows why
   that value is load-bearing: it is how the script tells its own server from
   something else on the port;
2. `buildMcpServer` -> `buildWorkspaceServer`;
3. the default port to `cfg.workspacePort`;
4. **bind `127.0.0.1`, not `0.0.0.0`.** The file plane's server binds all
   interfaces because it runs inside a container publishing one port to
   loopback. This one runs natively and holds a token that reaches both the
   orchestrator and the chatbot, so binding every interface would put an
   unauthenticated MCP endpoint that can start paid agent runs on the LAN —
   the same class of mistake the Phase 1 final review caught in
   `docker-compose.yml`.

```ts
return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
```

- [ ] **Step 7: Add the second `.mcp.json` entry and the npm script**

```json
{
  "mcpServers": {
    "scyne": { "type": "http", "url": "http://127.0.0.1:8080/mcp" },
    "scyne-workspace": { "type": "http", "url": "http://127.0.0.1:8081/mcp" }
  }
}
```

```json
    "workspace-server": "tsx src/workspace/server.ts",
```

- [ ] **Step 8: Run to verify it passes**

Run: `npm --prefix plugins/azure-file-processing run test:integration -- workspace-mcp`
Expected: PASS, 4 tests.

- [ ] **Step 9: Stage**

```bash
git add plugins/azure-file-processing/src/workspace/orchestrator.ts \
        plugins/azure-file-processing/src/workspace/mcp.ts \
        plugins/azure-file-processing/src/workspace/server.ts \
        plugins/azure-file-processing/src/shared/config.ts \
        plugins/azure-file-processing/.mcp.json \
        plugins/azure-file-processing/package.json \
        plugins/azure-file-processing/test/workspace-mcp.int.test.ts \
        plugins/azure-file-processing/test/config.test.ts
# Repo owner commits. Proposed message:
#   feat(workspace): MCP server 2 skeleton and orchestrator client
```

---

## Task 9: `start_stage` and `issue_status`

**Files:**
- Create: `plugins/azure-file-processing/src/workspace/tools/start-stage.ts`, `tools/issue-status.ts`
- Modify: `src/workspace/mcp.ts`
- Test: `plugins/azure-file-processing/test/start-stage.int.test.ts`

**Interfaces:**
- Consumes: `orchFetch`, `OrchCtx`, `jsonResult`.
- Produces:
  - `startStage(ctx, { workflow, project, feature? }): Promise<{ issueId: string; workflow: string; project: string; feature: string | null; state: string }>`
  - `issueStatus(ctx, { issueId }): Promise<{ issueId; status; step; workflow; project; feature; gate; comments }>`
  - `WORKFLOW_KEYS: readonly string[]`

**The point of this task:** a stage started from Codex must produce the SAME issue
the chatbot produces, so it appears in `/orch`, Issues, Spend and Actions with no
second tracking system. `POST /issues` answers **201** with the issue row and
advances in the background — `start_stage` returns the id and does not wait.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeAll } from "vitest";
import { loadConfig } from "../src/shared/config.js";
import { startStage, WORKFLOW_KEYS } from "../src/workspace/tools/start-stage.js";
import { issueStatus } from "../src/workspace/tools/issue-status.js";

const ctx = { cfg: loadConfig() };

beforeAll(async () => {
  const res = await fetch(`${ctx.cfg.orchUrl}/health`).catch(() => null);
  if (!res?.ok) {
    throw new Error(
      "The Scyne orchestrator is not running. Start it with `npm run dev` from the repo root.");
  }
});

describe("startStage", () => {
  it("refuses an unknown workflow, naming the valid ones", async () => {
    await expect(startStage(ctx, { workflow: "nope", project: "SAPN" }))
      .rejects.toThrow(/unknown workflow/);
  });

  it("refuses a feature-level workflow with no feature", async () => {
    await expect(startStage(ctx, { workflow: "requirements", project: "SAPN" }))
      .rejects.toThrow(/feature/);
  });

  it("lists the workflows the orchestrator actually compiles", () => {
    expect(WORKFLOW_KEYS).toContain("capabilities");
    expect(WORKFLOW_KEYS).toContain("requirements");
    expect(WORKFLOW_KEYS).toContain("app");
  });
});

describe("issueStatus", () => {
  it("refuses an unknown issue with a clear message", async () => {
    await expect(issueStatus(ctx, { issueId: "SCY-999999" }))
      .rejects.toThrow(/404|not found|unknown/i);
  });
});

describe("orchestrator unreachable", () => {
  it("says so, and names the URL it tried", async () => {
    const dead = { cfg: { ...ctx.cfg, orchUrl: "http://127.0.0.1:59999" } };
    await expect(issueStatus(dead as any, { issueId: "SCY-1" }))
      .rejects.toThrow(/cannot reach the orchestrator at http:\/\/127\.0\.0\.1:59999/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run:
```bash
npm run dev &            # from the repo root — the orchestrator must be up
npm --prefix plugins/azure-file-processing run test:integration -- start-stage
```
Expected: FAIL — module not found.

- [ ] **Step 3: Write `tools/start-stage.ts`**

```ts
import { orchFetch, type OrchCtx } from "../orchestrator.js";
import { log } from "../../shared/logger.js";

/** Compiled from scripts/pipeline.mjs. `design` is the optional side stage and
 *  is deliberately included — a user can ask for it by name. */
export const WORKFLOW_KEYS = [
  "baseline", "capabilities", "personas", "requirements",
  "ui", "datamodel", "architecture", "qa", "design", "app",
] as const;

/** Which of them run per feature rather than per project. */
const FEATURE_LEVEL = new Set(["requirements", "ui", "datamodel", "architecture", "qa", "design"]);

export interface StartStageArgs { workflow: string; project: string; feature?: string }

export const startStage = async (ctx: OrchCtx, args: StartStageArgs) => {
  const { workflow, project, feature } = args;

  if (!WORKFLOW_KEYS.includes(workflow as any)) {
    throw new Error(`unknown workflow ${workflow}; expected one of ${WORKFLOW_KEYS.join(", ")}`);
  }
  if (FEATURE_LEVEL.has(workflow) && !feature) {
    throw new Error(`${workflow} runs per feature — pass a feature`);
  }
  if (!FEATURE_LEVEL.has(workflow) && feature) {
    throw new Error(`${workflow} is a project-level stage and takes no feature`);
  }

  // POST /issues answers 201 with the issue ROW, then advances in the
  // background — `engine.advance()` is fire-and-forget in the handler.
  // Returning the id rather than waiting is correct: an agent run averages
  // twenty-five minutes.
  const created = await orchFetch<{ id: string; status?: string }>(
    ctx.cfg, "POST", "/issues",
    { workflow, params: feature ? { project, feature } : { project } },
  );

  log.info("workspace.stage_started", { workflow, project, feature: feature ?? "", issueId: created.id });
  return {
    issueId: created.id,
    workflow, project,
    feature: feature ?? null,
    state: created.status ?? "todo",
  };
};
```

- [ ] **Step 4: Write `tools/issue-status.ts`**

```ts
import { orchFetch, type OrchCtx } from "../orchestrator.js";

const MAX_COMMENTS = 20;
const MAX_COMMENT_CHARS = 400;

export const issueStatus = async (ctx: OrchCtx, args: { issueId: string }) => {
  const issue = await orchFetch<any>(ctx.cfg, "GET", `/issues/${encodeURIComponent(args.issueId)}`);
  const comments = await orchFetch<any[]>(
    ctx.cfg, "GET", `/issues/${encodeURIComponent(args.issueId)}/comments`).catch(() => []);
  const gates = await orchFetch<any[]>(
    ctx.cfg, "GET", `/issues/${encodeURIComponent(args.issueId)}/gates`).catch(() => []);

  // The engine narrates every step into comments; that timeline is what a person
  // watches. Capped so a long run cannot flood the model's context.
  const recent = (comments ?? []).slice(-MAX_COMMENTS).map((c: any) => ({
    author: c.author ?? c.agent_key ?? "engine",
    body: String(c.body ?? "").slice(0, MAX_COMMENT_CHARS),
  }));

  const pending = (gates ?? []).find((g: any) => g.status === "pending") ?? null;

  return {
    issueId: issue.id ?? args.issueId,
    status: issue.status,
    step: issue.step_index ?? null,
    workflow: issue.workflow ?? null,
    project: issue.params?.project ?? null,
    feature: issue.params?.feature ?? null,
    gate: pending ? { id: pending.id, summary: pending.summary ?? null } : null,
    comments: recent,
  };
};
```

- [ ] **Step 5: Register both in `src/workspace/mcp.ts`**

Replace the `start_stage` placeholder with the real handler and add `issue_status`:

```ts
import { startStage, WORKFLOW_KEYS } from "./tools/start-stage.js";
import { issueStatus } from "./tools/issue-status.js";
```

```ts
  server.registerTool(
    "start_stage",
    {
      title: "Start a pipeline stage",
      description:
        `Start one Scyne pipeline stage. It becomes a tracked issue, exactly as if it had ` +
        `been started from the chatbot — visible in the console, Spend and Actions. ` +
        `Returns immediately with an issue id; poll issue_status. Workflows: ${WORKFLOW_KEYS.join(", ")}.`,
      inputSchema: {
        workflow: z.enum(WORKFLOW_KEYS as unknown as [string, ...string[]]),
        project: z.string().min(1),
        feature: z.string().optional(),
      },
    },
    async (args) => jsonResult(await startStage(ctx, args as any)),
  );

  server.registerTool(
    "issue_status",
    {
      title: "Issue status",
      description:
        "State, current step, any pending approval gate, and the recent activity timeline for one issue.",
      inputSchema: { issueId: z.string().min(1) },
    },
    async (args) => jsonResult(await issueStatus(ctx, args as any)),
  );
```

- [ ] **Step 6: Run to verify it passes**

Run: `npm --prefix plugins/azure-file-processing run test:integration -- start-stage`
Expected: PASS, 5 tests. The unreachable-orchestrator case is the one that proves
errors surface rather than becoming empty results.

- [ ] **Step 7: Prove a started stage is genuinely tracked**

With the orchestrator running, start a cheap stage through the tool and confirm it
appears in the orchestrator's own listing:

```bash
curl -s http://127.0.0.1:3100/issues | head -20
```

Expected: the issue created by `start_stage` is present, with the workflow and
project you passed. Record the output — this is the claim the whole task exists
for.

- [ ] **Step 8: Stage**

```bash
git add plugins/azure-file-processing/src/workspace/tools/start-stage.ts \
        plugins/azure-file-processing/src/workspace/tools/issue-status.ts \
        plugins/azure-file-processing/src/workspace/mcp.ts \
        plugins/azure-file-processing/test/start-stage.int.test.ts
# Repo owner commits. Proposed message:
#   feat(workspace): start_stage and issue_status against the orchestrator
```

---

## Task 10: `list_issues`, the gate tools, control and `spend`

**Files:**
- Create: `plugins/azure-file-processing/src/workspace/tools/list-issues.ts`, `tools/gates.ts`, `tools/control.ts`, `tools/spend.ts`
- Modify: `src/workspace/mcp.ts`
- Test: `plugins/azure-file-processing/test/orchestrator-tools.int.test.ts`

**Interfaces:**
- Consumes: `orchFetch`, `OrchCtx`.
- Produces:
  - `listIssues(ctx, { project?, feature?, status?, open? }): Promise<{ issues: Array<{ issueId; workflow; project; feature; status; step; needsHuman }> }>`
  - `approveGate(ctx, { gateId })` / `rejectGate(ctx, { gateId, note })`
  - `pauseIssue(ctx, { issueId, force? })` / `resumeIssue(ctx, { issueId })`
  - `spend(ctx, { by })` where `by` is `project | feature | user | agent | adapter | model`

**One rule that matters:** `/usage` is admin-only upstream. **Pass the 403
through** — never collapse it into an empty table. A model told "no spend" when
the truth is "you are not allowed to see it" will report something false.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeAll } from "vitest";
import { loadConfig } from "../src/shared/config.js";
import { listIssues } from "../src/workspace/tools/list-issues.js";
import { approveGate, rejectGate } from "../src/workspace/tools/gates.js";
import { pauseIssue, resumeIssue } from "../src/workspace/tools/control.js";
import { spend } from "../src/workspace/tools/spend.js";

const ctx = { cfg: loadConfig() };

beforeAll(async () => {
  const res = await fetch(`${ctx.cfg.orchUrl}/health`).catch(() => null);
  if (!res?.ok) throw new Error("The Scyne orchestrator is not running. `npm run dev` from the repo root.");
});

describe("listIssues", () => {
  it("returns a shaped list", async () => {
    const r = await listIssues(ctx, {});
    expect(Array.isArray(r.issues)).toBe(true);
    for (const i of r.issues.slice(0, 3)) {
      expect(i).toHaveProperty("issueId");
      expect(i).toHaveProperty("status");
      expect(i).toHaveProperty("needsHuman");
    }
  });

  it("filters by project without throwing on an unknown one", async () => {
    const r = await listIssues(ctx, { project: "NO-SUCH-PROJECT-XYZ" });
    expect(r.issues).toEqual([]);
  });
});

describe("gates", () => {
  it("refuses an unknown gate rather than reporting success", async () => {
    await expect(approveGate(ctx, { gateId: "00000000-0000-0000-0000-000000000000" }))
      .rejects.toThrow();
  });

  it("requires a note when rejecting", async () => {
    await expect(rejectGate(ctx, { gateId: "x", note: "" })).rejects.toThrow(/note/);
  });
});

describe("control", () => {
  it("refuses an unknown issue", async () => {
    await expect(pauseIssue(ctx, { issueId: "SCY-999999" })).rejects.toThrow();
  });
});

describe("spend", () => {
  it("groups by a legal dimension or refuses clearly", async () => {
    try {
      const r = await spend(ctx, { by: "project" });
      expect(r).toHaveProperty("by", "project");
    } catch (e: any) {
      // Admin-only upstream: a 403 must surface as a 403, not an empty table.
      expect(String(e.message)).toMatch(/403|forbidden|not allowed/i);
    }
  });

  it("refuses an unknown grouping", async () => {
    await expect(spend(ctx, { by: "banana" as any })).rejects.toThrow(/by/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm --prefix plugins/azure-file-processing run test:integration -- orchestrator-tools`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write the four tool modules**

`tools/list-issues.ts`:

```ts
import { orchFetch, type OrchCtx } from "../orchestrator.js";

export interface ListIssuesArgs {
  project?: string; feature?: string; status?: string; open?: boolean;
}

const NEEDS_HUMAN = new Set(["in_review", "blocked", "paused"]);

/** The statuses that mean a person has to do something. */
const OPEN = new Set(["todo", "in_progress", "in_review", "blocked", "paused"]);

export const listIssues = async (ctx: OrchCtx, args: ListIssuesArgs) => {
  // `ListIssuesFilter` in core/repo.ts accepts ONLY parentId, status and
  // assigneeAgentId — there is no project or feature column to filter on, the
  // project lives in `params` as jsonb. So `status` is the one filter that goes
  // over the wire; the rest are applied here. Sending `?project=` would be
  // WORSE than filtering locally: the route ignores an unknown query parameter,
  // so it would answer with every issue in the company while appearing to have
  // filtered.
  const q = new URLSearchParams();
  if (args.status) q.set("status", args.status);
  const path = `/issues${q.toString() ? `?${q}` : ""}`;

  const raw = await orchFetch<any>(ctx.cfg, "GET", path);
  let rows: any[] = Array.isArray(raw) ? raw : (raw?.issues ?? []);

  if (args.project) rows = rows.filter((i) => i.params?.project === args.project);
  if (args.feature) rows = rows.filter((i) => i.params?.feature === args.feature);
  if (args.open) rows = rows.filter((i) => OPEN.has(i.status));

  return {
    issues: rows.map((i) => ({
      issueId: i.id,
      workflow: i.workflow ?? null,
      project: i.params?.project ?? null,
      feature: i.params?.feature ?? null,
      status: i.status,
      step: i.step_index ?? null,
      needsHuman: NEEDS_HUMAN.has(i.status),
    })),
  };
};
```

`tools/gates.ts`:

```ts
import { orchFetch, type OrchCtx } from "../orchestrator.js";
import { log } from "../../shared/logger.js";

export const approveGate = async (ctx: OrchCtx, args: { gateId: string }) => {
  // Answers 202 and resumes in the background: the publish step runs after this.
  await orchFetch(ctx.cfg, "POST", `/gates/${encodeURIComponent(args.gateId)}/approve`, {});
  log.info("workspace.gate_approved", { gateId: args.gateId });
  return { gateId: args.gateId, decision: "approved" as const };
};

export const rejectGate = async (ctx: OrchCtx, args: { gateId: string; note: string }) => {
  // A rejection rewinds to the generating step and regenerates. Without a note
  // the agent is told to try again with no idea what was wrong.
  if (!args.note || !args.note.trim()) {
    throw new Error("a note is required when rejecting — it is what the agent is given to fix");
  }
  await orchFetch(ctx.cfg, "POST", `/gates/${encodeURIComponent(args.gateId)}/reject`,
    { note: args.note });
  log.info("workspace.gate_rejected", { gateId: args.gateId });
  return { gateId: args.gateId, decision: "rejected" as const };
};
```

`tools/control.ts`:

```ts
import { orchFetch, type OrchCtx } from "../orchestrator.js";

/** Pause is a REQUEST, not a status: the engine honours it at its next step
 *  boundary. `force` stops the agent in flight, losing that step's work. */
export const pauseIssue = async (ctx: OrchCtx, args: { issueId: string; force?: boolean }) => {
  await orchFetch(ctx.cfg, "POST", `/issues/${encodeURIComponent(args.issueId)}/pause`,
    { force: Boolean(args.force) });
  return { issueId: args.issueId, requested: args.force ? "pause_now" : "pause" };
};

export const resumeIssue = async (ctx: OrchCtx, args: { issueId: string }) => {
  await orchFetch(ctx.cfg, "POST", `/issues/${encodeURIComponent(args.issueId)}/resume`, {});
  return { issueId: args.issueId, requested: "resume" };
};
```

`tools/spend.ts`:

```ts
import { orchFetch, type OrchCtx } from "../orchestrator.js";

const DIMENSIONS = ["project", "feature", "user", "agent", "adapter", "model"] as const;
export type SpendBy = (typeof DIMENSIONS)[number];

export const spend = async (ctx: OrchCtx, args: { by: SpendBy }) => {
  if (!DIMENSIONS.includes(args.by)) {
    throw new Error(`by must be one of ${DIMENSIONS.join(", ")}, got ${args.by}`);
  }
  // `/spend` on the platform router, NOT `/usage` — `/usage` is the whole
  // company as one row and takes no grouping at all. Admin-only: `requireAdmin`
  // answers 403, and orchFetch throws with the status in the message, so a
  // refusal reaches the caller as a refusal rather than an empty table.
  const rows = await orchFetch<any>(ctx.cfg, "GET", `/spend?by=${args.by}`);
  return { by: args.by, rows };
};
```

- [ ] **Step 4: Register all six tools in `src/workspace/mcp.ts`**

Add imports and six `registerTool` blocks: `list_issues`, `approve_gate`,
`reject_gate`, `pause_issue`, `resume_issue`, `spend`. Give each a description
that says what it does to the system, not merely what it returns — `reject_gate`
in particular should say it rewinds and regenerates.

- [ ] **Step 5: Run to verify it passes**

Run: `npm --prefix plugins/azure-file-processing run test:integration -- orchestrator-tools`
Expected: PASS, 7 tests.

- [ ] **Step 6: Stage**

```bash
git add plugins/azure-file-processing/src/workspace/tools/list-issues.ts \
        plugins/azure-file-processing/src/workspace/tools/gates.ts \
        plugins/azure-file-processing/src/workspace/tools/control.ts \
        plugins/azure-file-processing/src/workspace/tools/spend.ts \
        plugins/azure-file-processing/src/workspace/mcp.ts \
        plugins/azure-file-processing/test/orchestrator-tools.int.test.ts
# Repo owner commits. Proposed message:
#   feat(workspace): issue listing, gates, control and spend
```

---

## Task 11: Workspace creation, writing BOTH stores

> **STOP — this task's test creates REAL Azure DevOps projects, and did.**
> `POST /api/projects` calls `ensureAdoProject`, which creates a project AND a
> wiki in the live `Scyne-AI-Lab` org. Running this task's test as written left
> three of them on the client's tenant (`ExtractProof`,
> `PLUGIN-DUALWRITE-TEST`, `PLUGIN-DUALWRITE-TEST-Two`), none of which any tool
> here can delete.
>
> **Test the REFUSAL paths only** — `409 exists`, `409 slug_collision`,
> `400 project_name_*`, `404 no_project`, `400 reserved_name`, and the
> unauthenticated case. Every one of those creates nothing. Assert the success
> path against a project that ALREADY exists, or set `ADO_ORG` to empty for the
> test run so `ensureAdoProject` is skipped and only the tree and the row are
> written — the route already handles an unset `ADO_ORG` by reporting
> `adoError` and carrying on, which is exactly the shape this test needs.
>
> A test that reaches outside the repo is not a unit of work to be re-run
> casually, and this one was written as though it were.

**Files:**
- Create: `plugins/azure-file-processing/src/workspace/chatbot.ts`, `src/workspace/tools/workspace.ts`
- Modify: `src/shared/config.ts` (one value), `src/workspace/mcp.ts`
- Test: `plugins/azure-file-processing/test/dual-write.int.test.ts`

**Interfaces:**
- Consumes: `Config`, `log`, `getStorage`, `ensureWorkspaceContainer` + `syncUp` (Task 3).
- Produces:
  - `interface WsCtx { cfg: Config }`
  - `chatFetch<T>(cfg, method, path, body?): Promise<T>` — the same Bearer client, pointed at the chatbot
  - `createProject(ctx, { project, description?, website? })`
  - `createFeature(ctx, { project, feature })`

> **`WsCtx` and `OrchCtx` are both `{ cfg: Config }`**, declared separately
> because they name different destinations — one the chatbot, one the
> orchestrator. TypeScript structural typing means the single `ctx` object
> `buildWorkspaceServer` holds satisfies both, so `mcp.ts` passes the same value
> to every tool. Do not merge them into one name: the day one of them grows a
> field, the split is what stops the other silently requiring it.

**Why these go through the chatbot rather than writing the tree directly.**
There are TWO records of what exists — the folder tree the agents read, and the
database row the console, `/spend` and every platform route read. The chatbot's
`POST /api/projects` writes both, plus the Azure DevOps project and the branding
extraction. Reimplementing any of that here would produce a third
implementation to keep in step, and the repo has already paid for exactly that
mistake once: the React wizard wrote only the tree, so a project created in the
browser existed for every agent and for no API.

**Two facts that make this a thin wrapper:**

1. `tokenFor()` in `scyne-chatbot/server/auth.ts` accepts `Authorization: Bearer`
   before falling back to the cookie — **the same token the orchestrator takes**.
   One `SCYNE_ORCH_TOKEN` therefore serves both clients.
2. Everything under `/api` except `/api/auth/*` is behind `requireSession`, which
   answers **`401 {"error":"not_authenticated"}`**. Unauthenticated is the most
   likely failure here and must be reported as such, not as "creation failed".

**The response fields to surface verbatim, read off the route:**

| Field | Meaning |
|---|---|
| `project` | the SLUGGED name — `SA Power Networks` becomes `SA-Power-Networks` |
| `slugged` | `{from, to}` when the name changed, otherwise `null` |
| `dbError` | the database half failed; everything resolving by name stays empty |
| `adoError` | no Azure DevOps project; the tree and branding are still real |
| `409 exists` / `409 slug_collision` / `400 project_name_*` | refusals |
| features: `400 reserved_name`, `404 no_project`, `409 exists` | refusals |

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../src/shared/config.js";
import { createProject, createFeature } from "../src/workspace/tools/workspace.js";

const cfg = loadConfig();
const ctx = { cfg };
const NAME = "PLUGIN-DUALWRITE-TEST";

beforeAll(async () => {
  // The chatbot has NO /api/health — everything under /api except /api/auth/*
  // is behind requireSession. So probe a real route and treat ANY HTTP answer,
  // 401 included, as "the server is up": a 401 here is a token problem, which
  // the unauthenticated test below is what checks.
  const res = await fetch(`${cfg.chatbotUrl}/api/features`).catch(() => null);
  if (!res) {
    throw new Error(
      `The Scyne chatbot is not running at ${cfg.chatbotUrl}. ` +
      `\`npm run dev\` from the repo root starts it on :4000.`);
  }
});

afterAll(async () => {
  await rm(join(cfg.workspaceRoot, "projects", NAME), { recursive: true, force: true });
});

describe("createProject", () => {
  it("creates the tree and reports BOTH halves", async () => {
    const r = await createProject(ctx, { project: NAME, description: "A dual-write test project." });
    expect(r.project).toBe(NAME);
    expect(existsSync(join(cfg.workspaceRoot, "projects", NAME, "documents"))).toBe(true);
    // The point of the task: the database half is REPORTED, whichever way it went.
    expect(r).toHaveProperty("dbError");
    expect(r).toHaveProperty("db");
  });

  it("reports a slug rather than silently renaming", async () => {
    const r = await createProject(ctx, { project: `${NAME} Two` }).catch((e) => e);
    if (r instanceof Error) {
      // Already exists from a previous run — acceptable, and it must SAY so.
      expect(r.message).toMatch(/exists|slug_collision/);
    } else {
      expect(r.project).toBe(`${NAME}-Two`);
      expect(r.slugged).toEqual({ from: `${NAME} Two`, to: `${NAME}-Two` });
      await rm(join(cfg.workspaceRoot, "projects", `${NAME}-Two`), { recursive: true, force: true });
    }
  });

  it("refuses a duplicate rather than reporting success", async () => {
    await expect(createProject(ctx, { project: NAME })).rejects.toThrow(/exists|incomplete/i);
  });
});

describe("createFeature", () => {
  it("creates one under an existing project", async () => {
    const r = await createFeature(ctx, { project: NAME, feature: "Dual Write" });
    expect(r.feature).toBe("Dual Write");
    expect(existsSync(join(cfg.workspaceRoot, "projects", NAME, "Dual Write", "requirements", "SOP")))
      .toBe(true);
    expect(r).toHaveProperty("dbError");
  });

  it("refuses a reserved name, naming the reason", async () => {
    await expect(createFeature(ctx, { project: NAME, feature: "personas" }))
      .rejects.toThrow(/reserved/i);
  });

  it("refuses an unknown project", async () => {
    await expect(createFeature(ctx, { project: "NO-SUCH-PROJECT-XYZ", feature: "x" }))
      .rejects.toThrow(/no_project|No project/i);
  });
});

describe("unauthenticated", () => {
  it("says so instead of reporting a creation failure", async () => {
    const anon = { cfg: { ...cfg, orchToken: null } };
    await expect(createProject(anon as any, { project: `${NAME}-Anon` }))
      .rejects.toThrow(/not_authenticated|401/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run:
```bash
npm run dev &     # from the repo root — the CHATBOT must be up on :4000
npm --prefix plugins/azure-file-processing run test:integration -- dual-write
```
Expected: FAIL — module not found.

- [ ] **Step 3: Add `chatbotUrl` to `src/shared/config.ts`**

```ts
  /** Where MCP server 2 reaches the Scyne chatbot's API. Creation goes through
   *  its routes because they are the only code that writes BOTH the folder tree
   *  and the database row. Its key is CHATBOT_PORT, never PORT. */
  chatbotUrl: string;
  /** The Scyne workspace root — the directory holding `projects/`. Read the
   *  same way `scripts/sync.mjs` reads it, so the tools and the CLI cannot
   *  disagree about which tree they are syncing. */
  workspaceRoot: string;
```

```ts
  chatbotUrl: env.SCYNE_CHATBOT_URL || `http://127.0.0.1:${env.CHATBOT_PORT || 4000}`,
  workspaceRoot: env.WORKSPACE_PATH || process.cwd(),
```

Extend `test/config.test.ts`'s defaults assertion again, with both.

- [ ] **Step 4: Write `src/workspace/chatbot.ts`**

```ts
import type { Config } from "../shared/config.js";

export interface WsCtx { cfg: Config }

/**
 * One call to the Scyne chatbot API.
 *
 * Deliberately near-identical to orchFetch rather than shared with it: they
 * point at different services with different error vocabularies, and the one
 * thing this must do that orchFetch need not is turn a 401 into a message about
 * a TOKEN rather than about the operation.
 */
export const chatFetch = async <T>(
  cfg: Config, method: string, path: string, body?: unknown,
): Promise<T> => {
  const url = `${cfg.chatbotUrl.replace(/\/+$/, "")}${path}`;
  const headers: Record<string, string> = { accept: "application/json" };
  if (cfg.orchToken) headers.authorization = `Bearer ${cfg.orchToken}`;
  if (body !== undefined) headers["content-type"] = "application/json";

  let res: Response;
  try {
    res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch (e: any) {
    throw new Error(
      `cannot reach the Scyne chatbot at ${url}: ${e?.message ?? e}. ` +
      `\`npm run dev\` from the repo root starts it.`);
  }

  const text = await res.text();
  let parsed: any;
  try { parsed = text ? JSON.parse(text) : undefined; } catch { parsed = undefined; }

  if (res.status === 401) {
    throw new Error(
      `not_authenticated: the chatbot refused the credential for ${method} ${path}. ` +
      `Set SCYNE_ORCH_TOKEN to a Scyne API token — the chatbot accepts the same ` +
      `Bearer token the orchestrator does.`);
  }
  if (!res.ok) {
    const code = parsed?.error ? String(parsed.error) : `http_${res.status}`;
    const msg = parsed?.message ? ` — ${parsed.message}` : ` — ${text.slice(0, 300)}`;
    throw new Error(`${code}${msg}`);
  }
  return parsed as T;
};
```

- [ ] **Step 5: Write `src/workspace/tools/workspace.ts`**

```ts
import { chatFetch, type WsCtx } from "../chatbot.js";
import { getStorage } from "../../shared/storage.js";
import { ensureWorkspaceContainer, syncUp } from "../sync.js";
import { log } from "../../shared/logger.js";

/**
 * Push a project's tree to blob after a write, and report rather than throw.
 *
 * Task 3's signature is `syncUp(storage, root, project, opts?)` returning
 * `{ pushed, skipped, bytes }`. A sync failure is never fatal here: the tree
 * and the database row are real whether or not blob heard about it, and the
 * sync CLI can be run again by hand.
 */
const pushToBlob = async (
  ctx: WsCtx, project: string,
): Promise<{ pushed: number; bytes: number } | { error: string }> => {
  try {
    const s = getStorage(ctx.cfg);
    await ensureWorkspaceContainer(s);
    const r = await syncUp(s, ctx.cfg.workspaceRoot, project);
    return { pushed: r.pushed, bytes: r.bytes };
  } catch (e: any) {
    return { error: e?.message ?? String(e) };
  }
};

export interface CreateProjectArgs { project: string; description?: string; website?: string }

export const createProject = async (ctx: WsCtx, args: CreateProjectArgs) => {
  const res = await chatFetch<any>(ctx.cfg, "POST", "/api/projects", {
    project: args.project,
    description: args.description ?? "",
    website: args.website ?? "",
  });

  // The new tree is near-empty scaffolding, but pushing it now means blob holds
  // the project from the moment it exists rather than from its first stage run.
  const synced = await pushToBlob(ctx, res.project);

  log.info("workspace.project_created", {
    project: res.project,
    dbOk: !res.dbError, adoOk: !res.adoError,
  });

  return {
    project: res.project,
    slugged: res.slugged ?? null,
    definitionWritten: Boolean(res.definitionWritten),
    // Reported, never swallowed — everything that resolves a project BY NAME
    // stays empty until the row exists.
    db: res.db ?? null,
    dbError: res.dbError ?? null,
    adoTarget: res.adoTarget ?? null,
    adoError: res.adoError ?? null,
    brandError: res.brandError ?? null,
    synced,
  };
};

export const createFeature = async (ctx: WsCtx, args: { project: string; feature: string }) => {
  const res = await chatFetch<any>(ctx.cfg, "POST", "/api/features", {
    project: args.project, feature: args.feature,
  });
  log.info("workspace.feature_created", {
    project: args.project, feature: args.feature, dbOk: !res.dbError,
  });
  return {
    project: args.project,
    feature: res.feature ?? args.feature,
    db: res.db ?? null,
    dbError: res.dbError ?? null,
  };
};
```

- [ ] **Step 6: Register both tools in `src/workspace/mcp.ts`**

```ts
  server.registerTool(
    "create_project",
    {
      title: "Create a project",
      description:
        "Create a Scyne project: the folder tree, the database row, its Azure DevOps " +
        "project and its branding, in one call. A name with spaces is SLUGGED — the " +
        "result reports the name it actually used. Reports `dbError` and `adoError` " +
        "separately: either can fail while the project is still usable.",
      inputSchema: {
        project: z.string().min(1),
        description: z.string().optional(),
        website: z.string().optional(),
      },
    },
    async (args) => jsonResult(await createProject(ctx, args as any)),
  );

  server.registerTool(
    "create_feature",
    {
      title: "Create a feature",
      description:
        "Create a feature under a project, on disk and in the database. Feature names " +
        "may contain spaces. Reserved names (capabilities, personas, app, all, baseline, " +
        "solutions, documents, design, original-files, outputs) are refused.",
      inputSchema: { project: z.string().min(1), feature: z.string().min(1) },
    },
    async (args) => jsonResult(await createFeature(ctx, args as any)),
  );
```

- [ ] **Step 7: Run to verify it passes**

Run: `npm --prefix plugins/azure-file-processing run test:integration -- dual-write`
Expected: PASS, 7 tests.

- [ ] **Step 8: Prove the database half really happened**

```bash
curl -s http://127.0.0.1:3100/issues >/dev/null   # confirms the orchestrator is up
npm run sync:docs -- --project PLUGIN-DUALWRITE-TEST
```

Expected: the reconciler reports **nothing to create** for the project row —
because `create_project` already wrote it. If it proposes creating the project,
the dual-write did not happen and `dbError` should have said so; check it did.

- [ ] **Step 9: Stage**

```bash
git add plugins/azure-file-processing/src/workspace/chatbot.ts \
        plugins/azure-file-processing/src/workspace/tools/workspace.ts \
        plugins/azure-file-processing/src/workspace/mcp.ts \
        plugins/azure-file-processing/src/shared/config.ts \
        plugins/azure-file-processing/test/config.test.ts \
        plugins/azure-file-processing/test/dual-write.int.test.ts
# Repo owner commits. Proposed message:
#   feat(workspace): create_project and create_feature, writing both stores
```

---

## Task 12: `attach_document` and the three listings

**Files:**
- Modify: `plugins/azure-file-processing/src/workspace/tools/workspace.ts`, `src/workspace/mcp.ts`
- Test: `plugins/azure-file-processing/test/dual-write.int.test.ts` (extend)

**Interfaces:**
- Consumes: `chatFetch`, `syncUp`, `WsCtx`.
- Produces:
  - `attachDocument(ctx, { project, feature?, path, kind? })`
  - `listProjects(ctx)` / `listFeatures(ctx, { project })` / `listDocuments(ctx, { project, feature? })`

**`attach_document` takes a LOCAL PATH, not bytes.** This is the same reasoning
that shaped the file plane: a model that emits a document's contents as a tool
argument pays for every byte twice and cannot handle anything large. It hands
over a path; the tool reads the file and posts it as multipart, exactly as the
browser's drop zone does. The route converts on arrival, moves the source into
`original-files/`, and writes the database row — so the tool reports **the name
the file became**, which is frequently not the name it was given.

**The listings carry `inDb`.** `GET /api/documents` already marks every row, and
the whole point of surfacing it is that a document present on disk and absent
from the database is a real, actionable state with a named fix
(`npm run sync:docs -- --apply`). Hiding it is how the two surfaces came to
disagree in the first place.

- [ ] **Step 1: Write the failing test (append to `dual-write.int.test.ts`)**

```ts
import { writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  attachDocument, listProjects, listFeatures, listDocuments,
} from "../src/workspace/tools/workspace.js";

describe("attachDocument", () => {
  it("uploads a local file and reports the name it BECAME", async () => {
    const dir = await mkdtemp(join(tmpdir(), "attach-"));
    const src = join(dir, "policy note.md");
    await writeFile(src, "# Handling policy\n\nClaims are triaged within 24 hours.\n");

    const r = await attachDocument(ctx, { project: NAME, path: src });
    expect(r.filename).toBeTruthy();
    expect(r.storedPath).toMatch(/^documents\//);
    expect(r).toHaveProperty("converted");
    expect(r).toHaveProperty("dbError");
  });

  it("refuses a file that is not there, naming the path", async () => {
    await expect(attachDocument(ctx, { project: NAME, path: "/no/such/file.md" }))
      .rejects.toThrow(/\/no\/such\/file\.md/);
  });

  it("routes a feature-level document into a named folder", async () => {
    const dir = await mkdtemp(join(tmpdir(), "attach-"));
    const src = join(dir, "kickoff.md");
    await writeFile(src, "Transcript of the kickoff call.\n");
    const r = await attachDocument(ctx, {
      project: NAME, feature: "Dual Write", path: src, kind: "transcripts",
    });
    expect(r.storedPath).toMatch(/Transcripts\//);
  });
});

describe("listings", () => {
  it("lists projects", async () => {
    const r = await listProjects(ctx);
    expect(r.projects).toContain(NAME);
  });

  it("lists features under one project", async () => {
    const r = await listFeatures(ctx, { project: NAME });
    expect(r.features).toContain("Dual Write");
  });

  it("lists documents and carries inDb per row", async () => {
    const r = await listDocuments(ctx, { project: NAME });
    expect(Array.isArray(r.documents)).toBe(true);
    for (const d of r.documents) {
      expect(typeof d.inDb).toBe("boolean");
    }
    // The actionable state is surfaced, not hidden.
    expect(r).toHaveProperty("notInDb");
    if (r.notInDb > 0) expect(r.fix).toMatch(/sync:docs/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm --prefix plugins/azure-file-processing run test:integration -- dual-write`
Expected: FAIL — `attachDocument` is not exported.

- [ ] **Step 3: Append to `src/workspace/tools/workspace.ts`**

```ts
import { readFile, stat } from "node:fs/promises";
import { basename, isAbsolute, resolve } from "node:path";

/** The four discovery folders `routeFile()` recognises. Supplying one is what
 *  avoids `409 ambiguous_kind` for a .docx whose name matches neither the SOP
 *  nor the transcript pattern.
 *
 *  The route's own vocabulary is `Subfolder` in services/fileRouter.ts —
 *  `sop | transcripts | notes | ui | template` — and it arrives in the form
 *  field named **`hint`**, NOT `kind`. `template` is deliberately not offered:
 *  it is house style, not discovery material. */
export type DocKind = "sop" | "transcripts" | "notes" | "ui";

export interface AttachArgs {
  project: string; feature?: string; path: string; kind?: DocKind;
}

export const attachDocument = async (ctx: WsCtx, args: AttachArgs) => {
  const abs = isAbsolute(args.path) ? args.path : resolve(process.cwd(), args.path);

  // Named refusal before the network call: "ENOENT" from inside a multipart
  // post is far harder to act on than the path that was not there.
  const st = await stat(abs).catch(() => null);
  if (!st || !st.isFile()) throw new Error(`no such file: ${abs}`);

  // Refused rather than ignored: /api/upload/project has no router at all —
  // a project document always lands in `documents/` — so accepting a `kind`
  // there would teach a caller that it did something.
  if (args.kind && !args.feature) {
    throw new Error(
      "kind applies to a FEATURE document only; a project document always lands in documents/");
  }

  const bytes = await readFile(abs);
  const form = new FormData();
  form.set("file", new Blob([bytes]), basename(abs));
  form.set("project", args.project);
  if (args.feature) form.set("feature", args.feature);
  // The route reads `hint`, not `kind`. The tool's parameter keeps the clearer
  // name and the mapping happens here, once.
  if (args.kind) form.set("hint", args.kind);

  // Multipart, so this cannot go through chatFetch's JSON body.
  const path = args.feature ? "/api/upload" : "/api/upload/project";
  const url = `${ctx.cfg.chatbotUrl.replace(/\/+$/, "")}${path}`;
  const headers: Record<string, string> = { accept: "application/json" };
  if (ctx.cfg.orchToken) headers.authorization = `Bearer ${ctx.cfg.orchToken}`;

  let res: Response;
  try {
    res = await fetch(url, { method: "POST", headers, body: form });
  } catch (e: any) {
    throw new Error(`cannot reach the Scyne chatbot at ${url}: ${e?.message ?? e}`);
  }
  const text = await res.text();
  let body: any; try { body = text ? JSON.parse(text) : undefined; } catch { body = undefined; }

  if (res.status === 401) throw new Error("not_authenticated: set SCYNE_ORCH_TOKEN");
  if (res.status === 409 && body?.error === "ambiguous_kind") {
    throw new Error(
      `ambiguous_kind: ${basename(abs)} matches neither the SOP nor the transcript ` +
      `pattern. Pass kind: sop | transcripts | notes | ui.`);
  }
  if (!res.ok) throw new Error(`${body?.error ?? `http_${res.status}`}: ${body?.message ?? text.slice(0, 300)}`);

  // Push the converted markdown to blob so the durable copy matches disk.
  // `pushToBlob` is the helper added at the top of this file in Task 11 — it
  // wraps `syncUp(storage, root, project)` and reports a failure rather than
  // throwing one.
  const synced = await pushToBlob(ctx, args.project);

  log.info("workspace.document_attached", {
    project: args.project, feature: args.feature ?? "",
    // The NAME, never the contents.
    filename: String(body?.filename ?? ""),
  });

  return {
    project: args.project,
    feature: args.feature ?? null,
    // The name it BECAME: the route converts on arrival, so a .docx arrives as .md.
    filename: body?.filename ?? basename(abs),
    // Relative to the FEATURE root for a feature document
    // (`requirements/Transcripts/x.md`), to the PROJECT root for a project one
    // (`documents/x.md`).
    storedPath: body?.path ?? null,
    // Which discovery folder it was routed into — the thing that decides which
    // agent treats it as a source of stories.
    subfolder: body?.subfolder ?? null,
    converted: Boolean(body?.converted),
    db: body?.db ?? null,
    dbError: body?.db?.state === "failed" ? (body.db.reason ?? "not recorded in the database") : null,
    synced,
  };
};

/**
 * `GET /api/features` answers `store.available()`:
 *
 *   { "<project>": [ { name: "<feature>", counts: { sop: 2, … } }, … ] }
 *
 * An ARRAY OF OBJECTS, not of strings — reading it as strings is how a listing
 * comes back as a column of `[object Object]`.
 */
const availableTree = (ctx: WsCtx) =>
  chatFetch<Record<string, Array<{ name: string; counts?: Record<string, number> }>>>(
    ctx.cfg, "GET", "/api/features");

export const listProjects = async (ctx: WsCtx) => {
  const raw = await availableTree(ctx);
  return {
    projects: Object.keys(raw ?? {}).sort(),
    // The count is worth carrying: a project with no features is a real state
    // and the next question is always "which of these has anything in it".
    featureCounts: Object.fromEntries(
      Object.entries(raw ?? {}).map(([p, fs]) => [p, fs.length])),
  };
};

export const listFeatures = async (ctx: WsCtx, args: { project: string }) => {
  const raw = await availableTree(ctx);
  const features = raw?.[args.project];
  if (!features) throw new Error(`no such project: ${args.project}`);
  return {
    project: args.project,
    features: features.map((f) => f.name).sort(),
    // Which discovery folders hold documents, per feature — the thing that
    // decides whether a stage will refuse with `no_documents`.
    documentCounts: Object.fromEntries(features.map((f) => [f.name, f.counts ?? {}])),
  };
};

export const listDocuments = async (ctx: WsCtx, args: { project: string; feature?: string }) => {
  const q = new URLSearchParams({ project: args.project });
  if (args.feature) q.set("feature", args.feature);
  const raw = await chatFetch<any>(ctx.cfg, "GET", `/api/documents?${q}`);

  const rows = [...(raw?.documents?.project ?? []), ...(raw?.documents?.feature ?? [])]
    .map((d: any) => ({
      path: d.path, feature: d.feature ?? null, kind: d.kind ?? null,
      sizeBytes: d.sizeBytes ?? d.size ?? null, inDb: Boolean(d.inDb),
    }));

  const notInDb = rows.filter((r) => !r.inDb).length;
  return {
    project: args.project,
    feature: args.feature ?? null,
    documents: rows,
    counts: raw?.counts ?? null,
    // Surfaced with its fix rather than hidden: a document on disk and absent
    // from the database is why `scyne doc list` and the Docs tab once disagreed.
    notInDb,
    fix: notInDb > 0 ? "npm run sync:docs -- --apply" : null,
    stale: raw?.stale ?? [],
  };
};
```

- [ ] **Step 4: Register the four tools in `src/workspace/mcp.ts`**

```ts
  server.registerTool(
    "attach_document",
    {
      title: "Attach a document",
      description:
        "Upload a document from a LOCAL PATH into a project or a feature. It is converted " +
        "to markdown on arrival and the source archived, so the reported filename is often " +
        "not the one you passed. `kind` names the folder for a feature-level document " +
        "(sop · transcripts · notes · ui) and avoids an ambiguous-kind refusal.",
      inputSchema: {
        project: z.string().min(1),
        feature: z.string().optional(),
        path: z.string().min(1),
        kind: z.enum(["sop", "transcripts", "notes", "ui"]).optional(),
      },
    },
    async (args) => jsonResult(await attachDocument(ctx, args as any)),
  );

  server.registerTool(
    "list_projects",
    { title: "List projects", description: "Every project on the workspace.", inputSchema: {} },
    async () => jsonResult(await listProjects(ctx)),
  );

  server.registerTool(
    "list_features",
    {
      title: "List features",
      description: "The features under one project.",
      inputSchema: { project: z.string().min(1) },
    },
    async (args) => jsonResult(await listFeatures(ctx, args as any)),
  );

  server.registerTool(
    "list_documents",
    {
      title: "List documents",
      description:
        "Documents at both levels, each with `inDb`. A row with `inDb: false` is on disk " +
        "and absent from the database — real and fixable, so it is reported rather than " +
        "hidden. Also returns the artefacts that now predate their inputs.",
      inputSchema: { project: z.string().min(1), feature: z.string().optional() },
    },
    async (args) => jsonResult(await listDocuments(ctx, args as any)),
  );
```

- [ ] **Step 5: Run to verify it passes**

Run: `npm --prefix plugins/azure-file-processing run test:integration -- dual-write`
Expected: PASS, 13 tests (7 from Task 11 plus 6).

- [ ] **Step 6: Confirm the document really reached blob**

```bash
node plugins/azure-file-processing/scripts/sync.mjs status --project PLUGIN-DUALWRITE-TEST
```
Expected: `in sync` — the attach pushed the converted markdown up. A row under
"local only" means the `syncUp` inside `attachDocument` reported an error; the
tool's `synced.error` field should name it.

- [ ] **Step 7: Stage**

```bash
git add plugins/azure-file-processing/src/workspace/tools/workspace.ts \
        plugins/azure-file-processing/src/workspace/mcp.ts \
        plugins/azure-file-processing/test/dual-write.int.test.ts
# Repo owner commits. Proposed message:
#   feat(workspace): attach_document and the project/feature/document listings
```

---

## Task 13: Wire it up — `stack.sh`, the skill, and the README

**Files:**
- Modify: `plugins/azure-file-processing/scripts/stack.sh`, `README.md`, `.codex-plugin/plugin.json`
- Create: `plugins/azure-file-processing/skills/scyne-workspace/SKILL.md`
- Test: `plugins/azure-file-processing/test/plugin-manifest.test.ts` (extend)

**Interfaces:**
- Consumes: everything above.
- Produces: no new code interfaces — this is the task that makes the previous
  five reachable by a person who did not write them.

**What a reader has to be told, because none of it is guessable:**

1. **Two servers, two ports.** `scyne` on 8080 is the file plane; `scyne-workspace`
   on 8081 is this one. They are independent — either runs without the other.
2. **`SCYNE_ORCH_TOKEN` is required** for every workspace tool and for nothing in
   the file plane. Without it every call answers `not_authenticated`.
3. **The workspace server needs the Scyne stack running** (`npm run dev` at the
   repo root: orchestrator on 3100, chatbot on 4000). The file plane does not.
4. **Blob is the source of truth for `projects/`.** Local is a cache. Nothing is
   deleted implicitly, in either direction.

- [ ] **Step 1: Write the failing test (extend `plugin-manifest.test.ts`)**

```ts
describe("the workspace plane is declared", () => {
  // `plugin.json` points at a DIRECTORY — `"skills": "./skills/"` — so there is
  // no array to register a name in. Codex discovers a skill by its folder.
  it("ships the skill where the manifest says skills live", () => {
    const manifest = JSON.parse(readFileSync(resolve(here, "../.codex-plugin/plugin.json"), "utf8"));
    expect(manifest.skills).toBe("./skills/");
    expect(existsSync(resolve(here, "../skills/scyne-workspace/SKILL.md"))).toBe(true);
  });

  it("the SKILL.md carries the frontmatter Codex matches on", () => {
    const md = readFileSync(resolve(here, "../skills/scyne-workspace/SKILL.md"), "utf8");
    expect(md.startsWith("---")).toBe(true);
    expect(md).toMatch(/^name: scyne-workspace$/m);
    expect(md).toMatch(/^description: Use when /m);
  });

  it("the manifest describes both planes, not only the file one", () => {
    const manifest = JSON.parse(readFileSync(resolve(here, "../.codex-plugin/plugin.json"), "utf8"));
    expect(manifest.interface.longDescription).toMatch(/workspace|pipeline|stage/i);
  });

  it("stack.sh knows how to start the workspace server", () => {
    const sh = readFileSync(resolve(here, "../scripts/stack.sh"), "utf8");
    expect(sh).toMatch(/src\/workspace\/server\.ts/);
    expect(sh).toMatch(/WORKSPACE_PORT/);
  });

  it("the README names the token every workspace tool needs", () => {
    const readme = readFileSync(resolve(here, "../README.md"), "utf8");
    expect(readme).toMatch(/SCYNE_ORCH_TOKEN/);
    expect(readme).toMatch(/8081/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm --prefix plugins/azure-file-processing test -- plugin-manifest`
Expected: FAIL — five assertions.

- [ ] **Step 3: Add the workspace server to `scripts/stack.sh`**

Mirror the existing native-orchestrator block **exactly** — the file already
has `orch_is_ours` / `orch_running` / `orch_start` / `orch_stop`, a `PORT`
variable, `.orchestrator.log` and `.orchestrator.pid`. Add the parallel four
beside them rather than a differently-shaped helper:

```bash
WS_PORT="${WORKSPACE_PORT:-8081}"
WS_LOG=".workspace.log"
WS_PID=".workspace.pid"

# --- the workspace MCP server ------------------------------------------------
# A front door to the Scyne stack (orchestrator :3100, chatbot :4000), so it is
# only useful when those are up. It is started anyway: /health answers without a
# credential and every tool names what it could not reach, which is a far better
# failure than a server that refused to start.

ws_is_ours() {
  curl -fsS "http://127.0.0.1:$WS_PORT/health" 2>/dev/null | grep -q '"service":"scyne-workspace"'
}

ws_running() { [ -f "$WS_PID" ] && kill -0 "$(cat "$WS_PID")" 2>/dev/null; }

ws_start() {
  if ws_running; then echo "workspace server already running (pid $(cat "$WS_PID"))"; return 0; fi
  : > "$WS_LOG"
  WORKSPACE_PORT="$WS_PORT" ./node_modules/.bin/tsx src/workspace/server.ts >> "$WS_LOG" 2>&1 &
  echo $! > "$WS_PID"
}

ws_stop() {
  [ -f "$WS_PID" ] && { kill "$(cat "$WS_PID")" 2>/dev/null || true; rm -f "$WS_PID"; }
  # Same reasoning as orch_stop: tsx re-execs, so the recorded pid can be a
  # parent whose child still holds the port. Only clear a listener /health has
  # identified as ours.
  if ws_is_ours; then
    for pid in $(lsof -ti "tcp:$WS_PORT" 2>/dev/null || true); do kill "$pid" 2>/dev/null || true; done
  fi
  return 0
}
```

Then: call `ws_start` from `up` after `orch_start`; call `ws_stop` from `down`
beside `orch_stop`; add a line to `status` printing `curl -fsS
"http://127.0.0.1:$WS_PORT/health" || echo "workspace server unreachable"`; and
extend the `up` summary so it names **both** endpoints, since a reader who has
only ever used the file plane will otherwise not know the second one exists:

```
ready:  file plane      MCP at http://127.0.0.1:$PORT/mcp
        workspace plane MCP at http://127.0.0.1:$WS_PORT/mcp
```

`--all-docker` leaves the workspace server native either way: it reaches
127.0.0.1:3100 and 127.0.0.1:4000, neither of which is in Compose.

- [ ] **Step 4: Write `skills/scyne-workspace/SKILL.md`**

````markdown
---
name: scyne-workspace
description: Use when running Scyne pipeline stages (capability map, personas, requirements, UI mockups, data model, architecture, test cases, companion app) or managing Scyne projects, features and documents from Codex.
---

# Scyne workspace

Two MCP servers ship in this plugin and they do different jobs.

| Server | Port | For |
|---|---|---|
| `scyne` | 8080 | large files: upload, extract, chunk, search — the FILE plane |
| `scyne-workspace` | 8081 | projects, features, documents, and running pipeline stages |

This skill is the second one.

## Before anything works

The workspace server is a front door to the Scyne stack, not a replacement for
it. Both must be running:

```bash
npm run dev                                   # repo root: orchestrator :3100, chatbot :4000
./scripts/stack.sh up                         # this plugin: workspace server :8081
```

Every workspace tool needs **`SCYNE_ORCH_TOKEN`** in the root `.env` — the same
Bearer token the CLI uses. Without it every call answers `not_authenticated`.
Nothing in the file plane needs it.

## Running a stage

`start_stage` creates a tracked issue — the same issue the chatbot creates, so
it appears in the console, in Spend and in Actions. It returns immediately with
an id; an agent run averages twenty-five minutes.

```
start_stage { workflow: "capabilities", project: "SAPN" }
→ { issueId: "SCY-12", state: "todo" }

issue_status { issueId: "SCY-12" }
→ { status: "in_review", gate: { id: "…" }, comments: [ … ] }
```

Project-level stages take no feature: `capabilities`, `personas`, `app`,
`baseline`. Feature-level stages require one: `requirements`, `ui`, `datamodel`,
`architecture`, `qa`, `design`.

The order that works: `capabilities` → `personas` (project), then per feature
`requirements` → `ui` → `datamodel` → `architecture` → `qa`, then `app` to
assemble the companion page. Every stage except `capabilities`, `personas` and
`app` needs that feature's product summary, so `requirements` comes first.

## Approving

Each stage parks at a human approval gate, and the stages that publish do so
after it. `issue_status` reports the pending gate; `approve_gate` releases it and
`reject_gate` rewinds to the generating step and regenerates — **a note is
required**, because that note is what the agent is given to fix.

Never approve on the person's behalf. Report what is waiting and what the gate
covers; the decision is theirs.

## Creating things

`create_project` writes the folder tree, the database row, the Azure DevOps
project and the branding in one call. Two results always worth repeating back:

- **`slugged`** — a project name cannot contain spaces, so `SA Power Networks`
  becomes `SA-Power-Networks`. Say which name was actually used.
- **`dbError` / `adoError`** — either can fail while the project is still
  usable. A `dbError` means everything that resolves the project by name stays
  empty until it is fixed; do not report a clean creation when one is present.

`create_feature` takes a name that MAY contain spaces. Reserved names are
refused with the reason.

## Documents

`attach_document` takes a **local path**, never file contents. It is converted to
markdown on arrival and the source archived, so the filename it reports back is
frequently not the one you passed — use the reported one.

For a feature-level document pass `kind`: `sop`, `transcripts`, `notes` or `ui`.
The folder is what the pipeline reads — the BA treats `Transcripts/` as the
source of stories and `SOP/` as context that is explicitly not stories — so
choosing it is a real decision, not a filing convenience.

`list_documents` marks each row `inDb`. A row with `inDb: false` is on disk and
absent from the database: real, and fixed by `npm run sync:docs -- --apply`.
Report it rather than passing over it.

## What this does not do

It does not reduce what a stage costs. The agent still reads every staged
document, so a capability-map run over 92 documents is roughly the same number
of tokens whether it was started from Codex, the chatbot or the CLI. What this
buys is one durable home for the workspace and one place every run is tracked.

For reading a large file WITHOUT paying for it in context, that is the other
server: `search_chunks` and `fetch_chunks` under `scyne`.
````

- [ ] **Step 5: Update `.codex-plugin/plugin.json`**

There is **nothing to register** — `"skills": "./skills/"` names a directory and
Codex discovers `skills/scyne-workspace/SKILL.md` by being there. What does need
changing is the marketplace copy, which currently describes one plane as if it
were the whole plugin:

- `interface.shortDescription` — mention both planes.
- `interface.longDescription` — add a sentence: the plugin also fronts the Scyne
  pipeline, so a stage started from Codex is the same tracked issue the chatbot
  creates, and the workspace lives durably in blob.
- `interface.defaultPrompt` — add a second entry for the workspace plane, e.g.
  *"Run the capability map for my project and tell me when it needs approving."*
- Bump `version`.

Leave `mcpServers` alone: it already points at `.mcp.json`, which Task 8 gave
its second entry.

- [ ] **Step 6: Extend `README.md`**

Add a section after the file plane's, covering the four facts listed at the top
of this task: two servers and their ports, the token, the stack prerequisite, and
blob-as-source-of-truth with nothing deleted implicitly. Include the sync CLI's
three verbs and a worked `start_stage` → `issue_status` → `approve_gate`
sequence.

- [ ] **Step 7: Run to verify it passes**

Run: `npm --prefix plugins/azure-file-processing test -- plugin-manifest`
Expected: PASS.

- [ ] **Step 8: Run the whole suite**

```bash
npm --prefix plugins/azure-file-processing test
npm --prefix plugins/azure-file-processing run test:integration
npm run check:routing        # repo root — the chatbot mapping is untouched, prove it
```
Expected: all green. `check:routing` matters because Task 7 edited
`orchestrator.workflows.ts`.

- [ ] **Step 9: Install the plugin end to end**

```bash
cd plugins/azure-file-processing && ./scripts/stack.sh up
codex plugin add azure-file-processing@scyne-local   # or the reinstall loop in the README
codex
> list the projects on the workspace
> start the capability map for SAPN
```

Expected: `list_projects` answers from the live tree, and `start_stage` returns
an issue id that appears at `http://127.0.0.1:3100/orch#issues`.

- [ ] **Step 10: Stage**

```bash
git add plugins/azure-file-processing/scripts/stack.sh \
        plugins/azure-file-processing/skills/scyne-workspace/SKILL.md \
        plugins/azure-file-processing/.codex-plugin/plugin.json \
        plugins/azure-file-processing/README.md \
        plugins/azure-file-processing/test/plugin-manifest.test.ts
# Repo owner commits. Proposed message:
#   feat(workspace): stack wiring, the scyne-workspace skill and README
```

---

## Done

Thirteen tasks. Phase 2a (1–7) makes blob the durable home of `projects/` with
three hooks and a CLI. Phase 2b (8–13) puts a second MCP server in front of the
orchestrator, so a stage started from Codex is the same tracked issue a stage
started from the chatbot is — and creation writes both stores, which is the one
thing the web wizard got wrong for months.
