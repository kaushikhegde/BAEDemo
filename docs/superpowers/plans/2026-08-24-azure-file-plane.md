# Azure File Plane (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Codex plugin that lets a model upload, process and query files of up to 5 GiB without a single byte of file content ever entering the model's context.

**Architecture:** Two Node processes behind Azurite. An **orchestrator** exposes seven MCP tools over streamable HTTP and touches only job rows and blob paths. A **worker** pool consumes a queue, streams each blob to a temp file, extracts it one page-window at a time, and writes chunked artifacts back to blob storage. The two never talk to each other directly — the queue and the job table are the only coupling.

**Tech Stack:** Node 24 · TypeScript (ESM, strict) · `@modelcontextprotocol/sdk` · `@azure/storage-blob` / `-queue` / `data-tables` · vitest · Docker Compose · Azurite · poppler-utils

**Spec:** `docs/superpowers/specs/2026-08-24-codex-azure-file-processing-design.md`

## Global Constraints

- **Node ≥ 24**, ESM throughout (`"type": "module"`). Relative imports carry a `.js` suffix even in `.ts` files — this matches `packages/orchestrator/`.
- **TypeScript strict**, `moduleResolution: "bundler"`, `target: ES2023`.
- **vitest** for all tests, in `test/*.test.ts`, mirroring `packages/orchestrator/vitest.config.ts`.
- **No npm workspaces in this repo.** Install with `npm --prefix plugins/azure-file-processing install`.
- **No payload ever reaches a log line.** The logger takes an explicit field allowlist. This is asserted by a test, not by convention.
- **Response caps are enforced in code**: `get_result` < 8 KB, `fetch_chunks` ≤ `FETCH_MAX_BYTES` (32768) with an explicit `truncated` flag. No code path returns a whole artifact.
- **The orchestrator never reads file bytes.** If a task's implementation makes it stream a blob body, that task is wrong.
- **Australian English** in user-facing copy (behaviour, authorise, organisation), per repo convention.
- **The repo owner commits their own work.** Every task ends with `git add` of exactly its files plus a proposed commit message as a comment. Do not run `git commit`.
- **Pinned versions** (resolved 2026-08-24): `@modelcontextprotocol/sdk@^1.30.0`, `@azure/storage-blob@^12.33.0`, `@azure/storage-queue@^12.31.0`, `@azure/data-tables@^13.3.2`, `zod@^4.4.3`, `yauzl@^3.4.0`, `sax@^1.6.1`, `typescript@^5.7.2`, `tsx@^4.19.2`, `vitest@^2.1.8`, `@types/node@^22.10.0`, `@types/yauzl@^3.4.0`, `@types/sax@^1.2.7`.
- **Test tiers.** `npm test` runs unit tests with no Docker. `npm run test:integration` and `npm run test:acceptance` require `./scripts/stack.sh up` first and fail loudly (never skip) when Azurite is unreachable — a silently skipped integration suite is a green build that proves nothing.
- **Integration tests need the Compose workers STOPPED**: `./scripts/stack.sh workers 0`. Those tests call `runOnce()` in-process to drive one turn deliberately, and a running Compose worker would dequeue the message first, leaving the test to see `idle` and fail for a reason that looks nothing like the cause. The acceptance suite is the opposite — it needs workers *running* (`./scripts/stack.sh workers 3`), because proving the pool is a pool is one of its assertions.

---

## File Structure

```
.agents/plugins/marketplace.json          repo marketplace (repo root)
plugins/azure-file-processing/
  .codex-plugin/plugin.json               Codex manifest
  .mcp.json                               declares MCP 1
  package.json  tsconfig.json  vitest.config.ts
  Dockerfile                              one image, two commands
  docker-compose.yml
  README.md
  scripts/stack.sh                        up | down | status | logs
  scripts/upload.mjs                      SAS PUT, block-staged above 64 MB
  scripts/make-fixture-pdf.mjs            streaming PDF generator for tests
  skills/azure-file-processing/SKILL.md
  src/shared/
    config.ts        env parsing + defaults
    logger.ts        allowlist logger
    storage.ts       blob/queue/table clients
    ids.ts           jobId minting
    jobs.ts          job row CRUD (Table)
    sas.ts           single-blob write-only SAS
  src/orchestrator/
    server.ts        HTTP + health + MCP transport
    mcp.ts           tool registration
    artifacts.ts     ranged reads + streaming scan
    tools/create-upload-url.ts  start-job.ts  job-status.ts
    tools/get-result.ts  search-chunks.ts  fetch-chunks.ts  delete-job.ts
  src/worker/
    index.ts         queue consume loop + heartbeat + DLQ
    download.ts      blob → temp file, streamed, sha256
    chunk.ts         deterministic chunker (pure)
    artifacts.ts     writes chunks.jsonl + index.json + metadata + result
    extract/pdf.ts   docx.ts  text.ts  index.ts
  test/*.test.ts
```

Files that change together live together: the two services share one package and one `src/shared`, so a change to the job row shape cannot land in one service and not the other. The Docker image is built once and run twice with different commands.

---

## Task 1: Package scaffold, config, and the no-payload logger

**Files:**
- Create: `plugins/azure-file-processing/package.json`, `tsconfig.json`, `vitest.config.ts`
- Create: `plugins/azure-file-processing/src/shared/config.ts`, `src/shared/logger.ts`
- Test: `plugins/azure-file-processing/test/config.test.ts`, `test/logger.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `loadConfig(env?: NodeJS.ProcessEnv): Config` where `Config` has `connectionString: string`, `orchPort: number`, `bearerToken: string | null`, `sasTtlSeconds: number`, `maxUploadBytes: number`, `fetchMaxBytes: number`, `searchMaxScanBytes: number`, `chunkChars: number`, `overlapChars: number`, `pageWindow: number`, `maxDequeueCount: number`, `tempDir: string`, `publicBlobEndpoint: string | null`. Also `log: Logger` with `log.info(event: string, fields?: Record<string, LogValue>)`, `.warn`, `.error`, where `type LogValue = string | number | boolean | null`.

- [ ] **Step 1: Write the failing tests**

`test/config.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/shared/config.js";

describe("loadConfig", () => {
  it("runs correctly with no environment at all", () => {
    const c = loadConfig({});
    expect(c.orchPort).toBe(8080);
    expect(c.bearerToken).toBeNull();
    expect(c.sasTtlSeconds).toBe(900);
    expect(c.fetchMaxBytes).toBe(32768);
    expect(c.chunkChars).toBe(4000);
    expect(c.maxDequeueCount).toBe(3);
    expect(c.publicBlobEndpoint).toBeNull();
    expect(c.connectionString).toContain("devstoreaccount1");
  });

  it("takes overrides from the environment", () => {
    const c = loadConfig({ ORCH_PORT: "9999", MCP_BEARER_TOKEN: "s3cret" });
    expect(c.orchPort).toBe(9999);
    expect(c.bearerToken).toBe("s3cret");
  });

  it("refuses a numeric setting that is not a number", () => {
    expect(() => loadConfig({ ORCH_PORT: "eighty-eighty" }))
      .toThrow(/ORCH_PORT/);
  });
});
```

`test/logger.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { makeLogger } from "../src/shared/logger.js";

const capture = () => {
  const lines: string[] = [];
  const spy = vi.spyOn(process.stdout, "write")
    .mockImplementation((s: any) => { lines.push(String(s)); return true; });
  return { lines, restore: () => spy.mockRestore() };
};

afterEach(() => vi.restoreAllMocks());

describe("makeLogger", () => {
  it("emits the event and its scalar fields", () => {
    const { lines, restore } = capture();
    makeLogger().info("job.queued", { jobId: "j1", sizeBytes: 42 });
    restore();
    const rec = JSON.parse(lines[0]);
    expect(rec.event).toBe("job.queued");
    expect(rec.jobId).toBe("j1");
    expect(rec.sizeBytes).toBe(42);
  });

  it("REFUSES a non-scalar field rather than serialising it", () => {
    // This is the whole guarantee: a caller cannot accidentally hand the logger
    // a buffer, a parsed document, or a request body and have it printed.
    const { restore } = capture();
    expect(() => makeLogger().info("upload", { body: { text: "secret" } as any }))
      .toThrow(/non-scalar/);
    restore();
  });

  it("refuses a string longer than the field cap", () => {
    const { restore } = capture();
    expect(() => makeLogger().info("x", { note: "a".repeat(600) }))
      .toThrow(/too long/);
    restore();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm --prefix plugins/azure-file-processing test`
Expected: FAIL — `Cannot find module '../src/shared/config.js'`

- [ ] **Step 3: Create the package files**

`package.json`:

```json
{
  "name": "@scyne/azure-file-processing",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=24" },
  "scripts": {
    "test": "vitest run test/*.test.ts --exclude 'test/*.int.test.ts' --exclude 'test/*.acc.test.ts'",
    "test:integration": "vitest run test/*.int.test.ts",
    "test:acceptance": "vitest run test/*.acc.test.ts",
    "typecheck": "tsc --noEmit",
    "orchestrator": "tsx src/orchestrator/server.ts",
    "worker": "tsx src/worker/index.ts"
  },
  "dependencies": {
    "@azure/data-tables": "^13.3.2",
    "@azure/storage-blob": "^12.33.0",
    "@azure/storage-queue": "^12.31.0",
    "@modelcontextprotocol/sdk": "^1.30.0",
    "sax": "^1.6.1",
    "yauzl": "^3.4.0",
    "zod": "^4.4.3"
  },
  "devDependencies": {
    "@types/node": "^22.10.0",
    "@types/sax": "^1.2.7",
    "@types/yauzl": "^3.4.0",
    "tsx": "^4.19.2",
    "typescript": "^5.7.2",
    "vitest": "^2.1.8"
  }
}
```

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "types": ["node", "vitest/globals"]
  },
  "include": ["src", "test", "scripts"]
}
```

`vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    testTimeout: 120_000, // large-file fixtures and Azurite cold start
    hookTimeout: 120_000,
  },
});
```

- [ ] **Step 4: Write `src/shared/config.ts`**

```ts
/** Azurite's well-known development account. Not a secret; it is published by
 *  Microsoft and is identical on every machine running Azurite. */
const AZURITE_CONNECTION_STRING =
  "DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;" +
  "AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;" +
  "BlobEndpoint=http://127.0.0.1:10000/devstoreaccount1;" +
  "QueueEndpoint=http://127.0.0.1:10001/devstoreaccount1;" +
  "TableEndpoint=http://127.0.0.1:10002/devstoreaccount1;";

export interface Config {
  connectionString: string;
  orchPort: number;
  bearerToken: string | null;
  sasTtlSeconds: number;
  maxUploadBytes: number;
  fetchMaxBytes: number;
  searchMaxScanBytes: number;
  chunkChars: number;
  overlapChars: number;
  pageWindow: number;
  maxDequeueCount: number;
  tempDir: string;
  /** The blob endpoint a MINTED SAS URL must carry. Inside Compose the
   *  orchestrator reaches Azurite at http://azurite:10000, but the SAS is used
   *  by curl on the HOST, where that name does not resolve. Null means "use the
   *  endpoint from the connection string", which is right when running natively. */
  publicBlobEndpoint: string | null;
}

const num = (env: NodeJS.ProcessEnv, key: string, fallback: number): number => {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${key} must be a number, got ${raw}`);
  return n;
};

export const loadConfig = (env: NodeJS.ProcessEnv = process.env): Config => ({
  connectionString: env.AZURE_STORAGE_CONNECTION_STRING || AZURITE_CONNECTION_STRING,
  orchPort: num(env, "ORCH_PORT", 8080),
  bearerToken: env.MCP_BEARER_TOKEN || null,
  sasTtlSeconds: num(env, "SAS_TTL_SECONDS", 900),
  maxUploadBytes: num(env, "MAX_UPLOAD_BYTES", 5_368_709_120),
  fetchMaxBytes: num(env, "FETCH_MAX_BYTES", 32_768),
  searchMaxScanBytes: num(env, "SEARCH_MAX_SCAN_BYTES", 134_217_728),
  chunkChars: num(env, "DEFAULT_CHUNK_CHARS", 4_000),
  overlapChars: num(env, "DEFAULT_OVERLAP_CHARS", 200),
  pageWindow: num(env, "DEFAULT_PAGE_WINDOW", 25),
  maxDequeueCount: num(env, "MAX_DEQUEUE_COUNT", 3),
  tempDir: env.TEMP_DIR || "/tmp/afp",
  publicBlobEndpoint: env.SAS_PUBLIC_BLOB_ENDPOINT || null,
});

export const UPLOADS_CONTAINER = "uploads";
export const ARTIFACTS_CONTAINER = "artifacts";
export const JOB_QUEUE = "job-queue";
export const POISON_QUEUE = "job-queue-poison";
export const JOBS_TABLE = "jobs";
```

- [ ] **Step 5: Write `src/shared/logger.ts`**

```ts
export type LogValue = string | number | boolean | null;

const MAX_FIELD_CHARS = 512;

export interface Logger {
  info(event: string, fields?: Record<string, LogValue>): void;
  warn(event: string, fields?: Record<string, LogValue>): void;
  error(event: string, fields?: Record<string, LogValue>): void;
}

/** The logger takes an explicit allowlist of SCALARS. A caller cannot hand it a
 *  buffer, a parsed document or a request body and have it serialised: that is
 *  how file content ends up in a log file, and the acceptance suite greps for
 *  exactly that. Refusing is louder than truncating. */
const emit = (level: string, event: string, fields: Record<string, LogValue>) => {
  for (const [k, v] of Object.entries(fields)) {
    const t = typeof v;
    if (v !== null && t !== "string" && t !== "number" && t !== "boolean") {
      throw new Error(`logger: field "${k}" is non-scalar (${t}); log an id, not a payload`);
    }
    if (typeof v === "string" && v.length > MAX_FIELD_CHARS) {
      throw new Error(`logger: field "${k}" is too long (${v.length} chars, max ${MAX_FIELD_CHARS})`);
    }
  }
  process.stdout.write(JSON.stringify({ level, event, ts: new Date().toISOString(), ...fields }) + "\n");
};

export const makeLogger = (): Logger => ({
  info: (event, fields = {}) => emit("info", event, fields),
  warn: (event, fields = {}) => emit("warn", event, fields),
  error: (event, fields = {}) => emit("error", event, fields),
});

export const log = makeLogger();
```

- [ ] **Step 6: Install and run the tests**

Run:
```bash
npm --prefix plugins/azure-file-processing install
npm --prefix plugins/azure-file-processing test
npm --prefix plugins/azure-file-processing run typecheck
```
Expected: all tests PASS, typecheck clean.

- [ ] **Step 7: Stage**

```bash
git add plugins/azure-file-processing/package.json \
        plugins/azure-file-processing/package-lock.json \
        plugins/azure-file-processing/tsconfig.json \
        plugins/azure-file-processing/vitest.config.ts \
        plugins/azure-file-processing/src/shared/config.ts \
        plugins/azure-file-processing/src/shared/logger.ts \
        plugins/azure-file-processing/test/config.test.ts \
        plugins/azure-file-processing/test/logger.test.ts
# Repo owner commits. Proposed message:
#   feat(afp): package scaffold, config defaults and the no-payload logger
```

---

## Task 2: Codex plugin manifest and repo marketplace

**Files:**
- Create: `.agents/plugins/marketplace.json` (repo root)
- Create: `plugins/azure-file-processing/.codex-plugin/plugin.json`
- Create: `plugins/azure-file-processing/.mcp.json`
- Create: `plugins/azure-file-processing/skills/azure-file-processing/SKILL.md` (stub; filled in Task 18)
- Test: `plugins/azure-file-processing/test/plugin-manifest.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: an installable plugin. Later tasks rely on the MCP server name being **`azure-files`** — that is the prefix Codex shows on every tool.

Every field below is copied from the shape Codex's own shipped plugins use (`~/.codex/.tmp/plugins/plugins/ngs-analysis/.codex-plugin/plugin.json`) and the marketplace entry format used by `openai-api-curated`. Do not invent fields: `validate_plugin.py` rejects any key it does not accept.

- [ ] **Step 1: Write the failing test**

`test/plugin-manifest.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const pluginDir = resolve(here, "..");
const repoRoot = resolve(pluginDir, "..", "..");
const validator = resolve(
  process.env.HOME!, ".codex/skills/.system/plugin-creator/scripts/validate_plugin.py");

describe("codex plugin packaging", () => {
  it("passes Codex's own plugin validator", () => {
    // Exits non-zero and prints the offending field when the manifest is wrong.
    const out = execFileSync("python3", [validator, pluginDir], { encoding: "utf8" });
    expect(out).not.toMatch(/error/i);
  });

  it("declares the MCP server under the name the skill refers to", () => {
    const mcp = JSON.parse(readFileSync(resolve(pluginDir, ".mcp.json"), "utf8"));
    expect(Object.keys(mcp.mcpServers)).toEqual(["azure-files"]);
    expect(mcp.mcpServers["azure-files"].type).toBe("http");
    expect(mcp.mcpServers["azure-files"].url).toBe("http://127.0.0.1:8080/mcp");
  });

  it("is registered in the repo marketplace by a relative local path", () => {
    const m = JSON.parse(readFileSync(resolve(repoRoot, ".agents/plugins/marketplace.json"), "utf8"));
    const entry = m.plugins.find((p: any) => p.name === "azure-file-processing");
    expect(entry).toBeDefined();
    expect(entry.source).toEqual({ source: "local", path: "./plugins/azure-file-processing" });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm --prefix plugins/azure-file-processing test -- plugin-manifest`
Expected: FAIL — `ENOENT` on `.codex-plugin/plugin.json`

- [ ] **Step 3: Write `.agents/plugins/marketplace.json` at the repo root**

The marketplace **root** is the directory containing `.agents`, and entry paths are relative to that root — so `./plugins/azure-file-processing` resolves to the folder built in Task 1.

```json
{
  "name": "scyne",
  "interface": { "displayName": "Scyne" },
  "plugins": [
    {
      "name": "azure-file-processing",
      "source": { "source": "local", "path": "./plugins/azure-file-processing" },
      "policy": {
        "installation": "AVAILABLE",
        "authentication": "ON_USE",
        "products": ["CODEX"]
      },
      "category": "Developer Tools"
    }
  ]
}
```

`authentication` is `ON_USE` rather than `ON_INSTALL`: there is nothing to authenticate at install time, because the local stack has no auth until `MCP_BEARER_TOKEN` is set.

- [ ] **Step 4: Write `.codex-plugin/plugin.json`**

```json
{
  "name": "azure-file-processing",
  "version": "0.1.0",
  "description": "Upload, process and query very large documents through Azure Blob Storage without their contents entering the model's context.",
  "author": { "name": "Scyne" },
  "license": "UNLICENSED",
  "keywords": ["azure", "blob", "mcp", "large-files", "pdf", "docx", "chunking"],
  "skills": "./skills/",
  "mcpServers": "./.mcp.json",
  "interface": {
    "displayName": "Azure File Processing",
    "shortDescription": "Process huge files in Azure without filling the context window",
    "longDescription": "Provides an upload-process-retrieve workflow for documents up to 5 GiB. Files travel directly from the machine into Azure Blob Storage using a short-lived, write-only SAS URL and are processed by a worker pool that streams them page by page. The model receives only compact JSON, and reads document text through a keyword search and a byte-capped fetch, so a 2 GB PDF can be questioned while only a few kilobytes ever reach the context window.",
    "developerName": "Scyne",
    "category": "Developer Tools",
    "capabilities": ["Read", "Write"],
    "defaultPrompt": [
      "Upload a large document to Azure, process it into page-mapped chunks, and answer my questions about it using only the passages that matter."
    ],
    "brandColor": "#464E7E",
    "screenshots": []
  }
}
```

- [ ] **Step 5: Write `.mcp.json`**

```json
{
  "mcpServers": {
    "azure-files": {
      "type": "http",
      "url": "http://127.0.0.1:8080/mcp"
    }
  }
}
```

- [ ] **Step 6: Write the skill stub**

`skills/azure-file-processing/SKILL.md` — the full workflow lands in Task 18; this stub exists so the manifest's `skills` path resolves.

```markdown
---
name: azure-file-processing
description: Use when a file is too large to read directly, or when the user asks to upload, process, search or extract text from a PDF, DOCX, TXT or MD document. Keeps file contents out of the context window by processing them in Azure Blob Storage and reading back only the passages that matter.
---

# Azure File Processing

Full workflow is added in Task 18. The rule that never changes: **never read a
large file into the conversation.** Use the `azure-files` MCP tools.
```

- [ ] **Step 7: Run the tests, then install the plugin end to end**

Run:
```bash
npm --prefix plugins/azure-file-processing test -- plugin-manifest
python3 ~/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py plugins/azure-file-processing
codex plugin marketplace add "$(pwd)"
codex plugin add azure-file-processing@scyne
codex plugin list
```
Expected: tests PASS; validator silent; `codex plugin list` shows `azure-file-processing@scyne` as installed.

- [ ] **Step 8: Stage**

```bash
git add .agents/plugins/marketplace.json \
        plugins/azure-file-processing/.codex-plugin/plugin.json \
        plugins/azure-file-processing/.mcp.json \
        plugins/azure-file-processing/skills/azure-file-processing/SKILL.md \
        plugins/azure-file-processing/test/plugin-manifest.test.ts
# Repo owner commits. Proposed message:
#   feat(afp): Codex plugin manifest and repo marketplace entry
```

---

## Task 3: Azurite, Docker Compose, storage bootstrap and `stack.sh`

**Files:**
- Create: `plugins/azure-file-processing/Dockerfile`, `docker-compose.yml`, `scripts/stack.sh`
- Create: `plugins/azure-file-processing/src/shared/storage.ts`
- Test: `plugins/azure-file-processing/test/storage.int.test.ts`

**Interfaces:**
- Consumes: `loadConfig`, `UPLOADS_CONTAINER`, `ARTIFACTS_CONTAINER`, `JOB_QUEUE`, `POISON_QUEUE`, `JOBS_TABLE` from Task 1.
- Produces: `getStorage(cfg: Config): Storage` where `Storage` is `{ blob: BlobServiceClient; queue(name: string): QueueClient; table: TableClient; sharedKey: StorageSharedKeyCredential; accountName: string }`, and `ensureStorage(s: Storage): Promise<void>` which creates every container, queue and table idempotently.

- [ ] **Step 1: Write the failing integration test**

`test/storage.int.test.ts`:

```ts
import { describe, it, expect, beforeAll } from "vitest";
import { loadConfig, UPLOADS_CONTAINER, ARTIFACTS_CONTAINER, JOB_QUEUE } from "../src/shared/config.js";
import { getStorage, ensureStorage } from "../src/shared/storage.js";

const cfg = loadConfig();
const storage = getStorage(cfg);

beforeAll(async () => {
  try {
    await ensureStorage(storage);
  } catch (e) {
    // Loud, not skipped: a silently skipped integration suite is a green build
    // that proves nothing.
    throw new Error(
      "Azurite is not reachable. Run ./scripts/stack.sh up first.\n" + String(e));
  }
});

describe("storage bootstrap", () => {
  it("creates both blob containers", async () => {
    for (const name of [UPLOADS_CONTAINER, ARTIFACTS_CONTAINER]) {
      expect(await storage.blob.getContainerClient(name).exists()).toBe(true);
    }
  });

  it("creates the job queue", async () => {
    expect(await storage.queue(JOB_QUEUE).exists()).toBe(true);
  });

  it("is idempotent — a second run changes nothing and throws nothing", async () => {
    await expect(ensureStorage(storage)).resolves.toBeUndefined();
  });

  it("exposes the shared key, which SAS minting needs", () => {
    expect(storage.accountName).toBe("devstoreaccount1");
    expect(storage.sharedKey).toBeDefined();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm --prefix plugins/azure-file-processing run test:integration`
Expected: FAIL — `Cannot find module '../src/shared/storage.js'`

- [ ] **Step 3: Write `src/shared/storage.ts`**

```ts
import { BlobServiceClient, StorageSharedKeyCredential } from "@azure/storage-blob";
import { QueueServiceClient, QueueClient } from "@azure/storage-queue";
import { TableClient } from "@azure/data-tables";
import {
  type Config, UPLOADS_CONTAINER, ARTIFACTS_CONTAINER,
  JOB_QUEUE, POISON_QUEUE, JOBS_TABLE,
} from "./config.js";

export interface Storage {
  blob: BlobServiceClient;
  queue: (name: string) => QueueClient;
  table: TableClient;
  sharedKey: StorageSharedKeyCredential;
  accountName: string;
}

export const getStorage = (cfg: Config): Storage => {
  const blob = BlobServiceClient.fromConnectionString(cfg.connectionString);
  const queues = QueueServiceClient.fromConnectionString(cfg.connectionString);
  const table = TableClient.fromConnectionString(cfg.connectionString, JOBS_TABLE, {
    allowInsecureConnection: true,
  });
  // Key-based connection strings give a StorageSharedKeyCredential, which is
  // what generateBlobSASQueryParameters needs. In prod this becomes a user
  // delegation key obtained through Managed Identity (spec §12).
  const sharedKey = blob.credential as StorageSharedKeyCredential;
  if (!(sharedKey instanceof StorageSharedKeyCredential)) {
    throw new Error("connection string must be key-based; SAS minting needs the shared key");
  }
  return {
    blob,
    queue: (name: string) => queues.getQueueClient(name),
    table,
    sharedKey,
    accountName: sharedKey.accountName,
  };
};

export const ensureStorage = async (s: Storage): Promise<void> => {
  await Promise.all([
    s.blob.getContainerClient(UPLOADS_CONTAINER).createIfNotExists(),
    s.blob.getContainerClient(ARTIFACTS_CONTAINER).createIfNotExists(),
    s.queue(JOB_QUEUE).createIfNotExists(),
    s.queue(POISON_QUEUE).createIfNotExists(),
    s.table.createTable().catch((e: any) => {
      if (e?.statusCode !== 409) throw e; // 409 = already there
    }),
  ]);
};
```

- [ ] **Step 4: Write the `Dockerfile`**

One image, two commands. `poppler-utils` is what makes page-windowed PDF extraction possible (spec §8.1).

```dockerfile
FROM node:24-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends poppler-utils ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src

ENV TEMP_DIR=/tmp/afp
RUN mkdir -p /tmp/afp

# Overridden per service in docker-compose.yml
CMD ["npx", "tsx", "src/orchestrator/server.ts"]
```

- [ ] **Step 5: Write `docker-compose.yml`**

```yaml
name: azure-file-processing

services:
  azurite:
    image: mcr.microsoft.com/azure-storage/azurite:latest
    command: >
      azurite --blobHost 0.0.0.0 --queueHost 0.0.0.0 --tableHost 0.0.0.0
              --location /data --skipApiVersionCheck
    ports:
      - "10000:10000"
      - "10001:10001"
      - "10002:10002"
    volumes:
      - azurite-data:/data
    healthcheck:
      test: ["CMD", "nc", "-z", "127.0.0.1", "10000"]
      interval: 2s
      timeout: 3s
      retries: 30

  orchestrator:
    build: .
    command: ["npx", "tsx", "src/orchestrator/server.ts"]
    environment:
      AZURE_STORAGE_CONNECTION_STRING: >-
        DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;BlobEndpoint=http://azurite:10000/devstoreaccount1;QueueEndpoint=http://azurite:10001/devstoreaccount1;TableEndpoint=http://azurite:10002/devstoreaccount1;
      ORCH_PORT: "8080"
      SAS_PUBLIC_BLOB_ENDPOINT: "http://127.0.0.1:10000/devstoreaccount1"
    ports:
      - "8080:8080"
    depends_on:
      azurite:
        condition: service_healthy

  worker:
    build: .
    command: ["npx", "tsx", "src/worker/index.ts"]
    environment:
      AZURE_STORAGE_CONNECTION_STRING: >-
        DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;BlobEndpoint=http://azurite:10000/devstoreaccount1;QueueEndpoint=http://azurite:10001/devstoreaccount1;TableEndpoint=http://azurite:10002/devstoreaccount1;
    deploy:
      replicas: 2
    depends_on:
      azurite:
        condition: service_healthy

volumes:
  azurite-data:
```

`SAS_PUBLIC_BLOB_ENDPOINT` matters and is easy to miss: inside Compose the orchestrator reaches Azurite at `http://azurite:10000`, but the SAS URL it hands back is used by `curl` **on the host**, where that name does not resolve. The minted URL must carry the host-visible endpoint. Task 6 consumes this.

- [ ] **Step 6: Write `scripts/stack.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

usage() { echo "usage: stack.sh {up|down|status|logs|workers <n>}"; exit 1; }

case "${1:-}" in
  up)
    docker compose up -d --build
    printf 'waiting for the orchestrator'
    for _ in $(seq 1 60); do
      if curl -fsS http://127.0.0.1:8080/health >/dev/null 2>&1; then
        echo; echo "ready:  MCP at http://127.0.0.1:8080/mcp"; exit 0
      fi
      printf '.'; sleep 1
    done
    echo; echo "orchestrator did not become healthy; try: ./scripts/stack.sh logs" >&2
    exit 1
    ;;
  down)   docker compose down -v ;;
  logs)   docker compose logs -f --tail=100 ;;
  workers)
    # 0 before `npm run test:integration` (those tests drive one turn in-process
    # and a live worker would steal the message); 3 before `npm run test:acceptance`.
    n="${2:-2}"
    docker compose up -d --scale worker="$n" --no-recreate worker 2>/dev/null || true
    [ "$n" = "0" ] && docker compose stop worker >/dev/null 2>&1 || true
    docker compose ps worker
    ;;
  status)
    docker compose ps
    echo "--- health ---"
    curl -fsS http://127.0.0.1:8080/health || echo "orchestrator unreachable"
    ;;
  *) usage ;;
esac
```

Then: `chmod +x plugins/azure-file-processing/scripts/stack.sh`

- [ ] **Step 7: Bring the stack up and run the integration test**

Run:
```bash
cd plugins/azure-file-processing
./scripts/stack.sh up        # the orchestrator does not exist yet — expect the health wait to fail
docker compose up -d azurite # so bring up Azurite alone for now
npm run test:integration -- storage
```
Expected: the storage tests PASS against real Azurite. (`stack.sh up` succeeds fully from Task 5 onward, once the orchestrator serves `/health`.)

- [ ] **Step 8: Pin the Azurite image**

Record the digest Compose actually resolved, so the stack cannot drift under CI:

```bash
docker compose images azurite
# then replace `azurite:latest` in docker-compose.yml with the resolved
# image@sha256:… digest and re-run: docker compose up -d azurite
```

- [ ] **Step 9: Stage**

```bash
git add plugins/azure-file-processing/Dockerfile \
        plugins/azure-file-processing/docker-compose.yml \
        plugins/azure-file-processing/scripts/stack.sh \
        plugins/azure-file-processing/src/shared/storage.ts \
        plugins/azure-file-processing/test/storage.int.test.ts
# Repo owner commits. Proposed message:
#   feat(afp): Azurite compose stack, storage bootstrap and stack.sh
```

---

## Task 4: Job identifiers and the job store

**Files:**
- Create: `plugins/azure-file-processing/src/shared/ids.ts`, `src/shared/jobs.ts`
- Test: `plugins/azure-file-processing/test/ids.test.ts`, `test/jobs.int.test.ts`

**Interfaces:**
- Consumes: `getStorage`, `Storage` (Task 3).
- Produces:
  - `newJobId(now?: number, rand?: Buffer): string`
  - `type JobState = "awaiting_upload" | "queued" | "running" | "succeeded" | "failed" | "deleted"`
  - `type JobPhase = "downloading" | "extracting" | "chunking" | "uploading" | "done"`
  - `interface Job` — every field listed in spec §7
  - `createJob(s: Storage, job: Job): Promise<void>`
  - `getJob(s: Storage, jobId: string): Promise<Job | null>`
  - `updateJob(s: Storage, jobId: string, patch: Partial<Job>): Promise<void>`

- [ ] **Step 1: Write the failing tests**

`test/ids.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { newJobId } from "../src/shared/ids.js";

describe("newJobId", () => {
  it("is safe as an Azure Table RowKey and a blob path segment", () => {
    const id = newJobId();
    expect(id).toMatch(/^j-[0-9a-z]{9}-[0-9a-f]{12}$/);
    expect(id).not.toMatch(/[/\\#?]/); // characters Table Storage rejects in a RowKey
  });

  it("sorts lexicographically in creation order", () => {
    const a = newJobId(1_700_000_000_000, Buffer.alloc(6, 0xff));
    const b = newJobId(1_700_000_001_000, Buffer.alloc(6, 0x00));
    expect([b, a].sort()).toEqual([a, b]);
  });

  it("is unique for two calls in the same millisecond", () => {
    const t = 1_700_000_000_000;
    expect(newJobId(t)).not.toBe(newJobId(t));
  });
});
```

`test/jobs.int.test.ts`:

```ts
import { describe, it, expect, beforeAll } from "vitest";
import { loadConfig } from "../src/shared/config.js";
import { getStorage, ensureStorage } from "../src/shared/storage.js";
import { newJobId } from "../src/shared/ids.js";
import { createJob, getJob, updateJob, type Job } from "../src/shared/jobs.js";

const s = getStorage(loadConfig());
beforeAll(async () => { await ensureStorage(s); });

const sample = (jobId: string): Job => ({
  jobId, state: "awaiting_upload", phase: null,
  pipelineId: "extract-chunks", params: "{}",
  blobPath: `${jobId}/contract.pdf`, filename: "contract.pdf",
  sizeBytes: 5_368_709_120,      // 5 GiB — deliberately larger than Int32
  sha256: null, progressDone: 0, progressTotal: 0, attempts: 0, workerId: null,
  createdAt: new Date().toISOString(), startedAt: null, finishedAt: null, error: null,
});

describe("job store", () => {
  it("round-trips a job, including a size beyond Int32", async () => {
    const id = newJobId();
    await createJob(s, sample(id));
    const got = await getJob(s, id);
    expect(got?.sizeBytes).toBe(5_368_709_120);
    expect(got?.state).toBe("awaiting_upload");
    expect(got?.phase).toBeNull();
  });

  it("patches only the fields given", async () => {
    const id = newJobId();
    await createJob(s, sample(id));
    await updateJob(s, id, { state: "running", phase: "extracting", progressDone: 25 });
    const got = await getJob(s, id);
    expect(got?.state).toBe("running");
    expect(got?.progressDone).toBe(25);
    expect(got?.filename).toBe("contract.pdf"); // untouched
  });

  it("answers null for an id that was never created", async () => {
    expect(await getJob(s, newJobId())).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm --prefix plugins/azure-file-processing test -- ids`
Expected: FAIL — `Cannot find module '../src/shared/ids.js'`

- [ ] **Step 3: Write `src/shared/ids.ts`**

```ts
import { randomBytes } from "node:crypto";

/** Sortable by creation time, and free of every character Azure Table Storage
 *  rejects in a RowKey (`/ \ # ?`). Both arguments are injectable so tests can
 *  assert ordering without sleeping. */
export const newJobId = (now: number = Date.now(), rand: Buffer = randomBytes(6)): string =>
  `j-${now.toString(36).padStart(9, "0")}-${rand.toString("hex")}`;
```

- [ ] **Step 4: Write `src/shared/jobs.ts`**

```ts
import type { Storage } from "./storage.js";

export type JobState =
  | "awaiting_upload" | "queued" | "running" | "succeeded" | "failed" | "deleted";
export type JobPhase = "downloading" | "extracting" | "chunking" | "uploading" | "done";

export interface Job {
  jobId: string;
  state: JobState;
  phase: JobPhase | null;
  pipelineId: string;
  params: string;          // JSON text: Table Storage has no nested types
  blobPath: string;
  filename: string;
  sizeBytes: number;
  sha256: string | null;
  progressDone: number;
  progressTotal: number;
  attempts: number;
  workerId: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
}

const PARTITION = "job";

/** sizeBytes crosses Int32 at 2 GiB and our ceiling is 5 GiB, so it is stored
 *  as a string. The client would otherwise widen it to a float and quietly
 *  lose precision on a large upload. */
const toEntity = (j: Partial<Job> & { jobId: string }) => {
  const e: Record<string, unknown> = { partitionKey: PARTITION, rowKey: j.jobId };
  for (const [k, v] of Object.entries(j)) {
    if (k === "jobId" || v === undefined) continue;
    e[k] = k === "sizeBytes" ? String(v) : v;
  }
  return e;
};

const fromEntity = (e: Record<string, any>): Job => ({
  jobId: e.rowKey,
  state: e.state, phase: e.phase ?? null,
  pipelineId: e.pipelineId, params: e.params,
  blobPath: e.blobPath, filename: e.filename,
  sizeBytes: Number(e.sizeBytes),
  sha256: e.sha256 ?? null,
  progressDone: Number(e.progressDone ?? 0),
  progressTotal: Number(e.progressTotal ?? 0),
  attempts: Number(e.attempts ?? 0),
  workerId: e.workerId ?? null,
  createdAt: e.createdAt,
  startedAt: e.startedAt ?? null,
  finishedAt: e.finishedAt ?? null,
  error: e.error ?? null,
});

export const createJob = async (s: Storage, job: Job): Promise<void> => {
  await s.table.createEntity(toEntity(job) as any);
};

export const getJob = async (s: Storage, jobId: string): Promise<Job | null> => {
  try {
    return fromEntity(await s.table.getEntity(PARTITION, jobId) as any);
  } catch (e: any) {
    if (e?.statusCode === 404) return null;
    throw e;
  }
};

export const updateJob = async (
  s: Storage, jobId: string, patch: Partial<Job>,
): Promise<void> => {
  await s.table.updateEntity(toEntity({ ...patch, jobId }) as any, "Merge");
};
```

- [ ] **Step 5: Run both suites**

Run:
```bash
npm --prefix plugins/azure-file-processing test -- ids
npm --prefix plugins/azure-file-processing run test:integration -- jobs
```
Expected: PASS. The 5 GiB assertion is the one that matters — it fails if `sizeBytes` is ever stored as a number.

- [ ] **Step 6: Stage**

```bash
git add plugins/azure-file-processing/src/shared/ids.ts \
        plugins/azure-file-processing/src/shared/jobs.ts \
        plugins/azure-file-processing/test/ids.test.ts \
        plugins/azure-file-processing/test/jobs.int.test.ts
# Repo owner commits. Proposed message:
#   feat(afp): job identifiers and the Table-backed job store
```

---

## Task 5: MCP server over streamable HTTP

**Files:**
- Create: `plugins/azure-file-processing/src/orchestrator/server.ts`, `src/orchestrator/mcp.ts`
- Test: `plugins/azure-file-processing/test/mcp-server.int.test.ts`

**Interfaces:**
- Consumes: `loadConfig`, `log` (Task 1), `getStorage`, `ensureStorage` (Task 3).
- Produces:
  - `interface Ctx { cfg: Config; storage: Storage }`
  - `buildMcpServer(ctx: Ctx): McpServer` — every later task registers its tool here
  - `startServer(ctx: Ctx, port: number): Promise<http.Server>`
  - `type ToolResult` — tools return plain objects; `jsonResult(value)` wraps one for MCP

The server is **stateless**: a fresh `McpServer` and transport per request, because every piece of state lives in Azurite. That is also what lets `--scale` work later without sticky sessions.

- [ ] **Step 1: Write the failing test**

`test/mcp-server.int.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadConfig } from "../src/shared/config.js";
import { getStorage, ensureStorage } from "../src/shared/storage.js";
import { startServer } from "../src/orchestrator/server.js";

let server: Server;
let port: number;

beforeAll(async () => {
  const cfg = { ...loadConfig(), orchPort: 0 };
  const storage = getStorage(cfg);
  await ensureStorage(storage);
  server = await startServer({ cfg, storage }, 0);
  port = (server.address() as any).port;
});

afterAll(async () => { await new Promise((r) => server.close(r)); });

const connect = async () => {
  const client = new Client({ name: "test", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
  return client;
};

describe("MCP over streamable HTTP", () => {
  it("serves health without a credential", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
    expect((await res.json() as any).ok).toBe(true);
  });

  it("completes an MCP handshake and lists its tools", async () => {
    const client = await connect();
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toContain("create_upload_url");
    await client.close();
  });

  it("404s an unknown path rather than falling through to MCP", async () => {
    expect((await fetch(`http://127.0.0.1:${port}/nope`)).status).toBe(404);
  });
});

describe("bearer auth, when configured", () => {
  it("refuses /mcp without the token and allows /health", async () => {
    const cfg = { ...loadConfig(), bearerToken: "s3cret" };
    const s2 = await startServer({ cfg, storage: getStorage(cfg) }, 0);
    const p2 = (s2.address() as any).port;
    expect((await fetch(`http://127.0.0.1:${p2}/health`)).status).toBe(200);
    const res = await fetch(`http://127.0.0.1:${p2}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(401);
    await new Promise((r) => s2.close(r));
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm --prefix plugins/azure-file-processing run test:integration -- mcp-server`
Expected: FAIL — `Cannot find module '../src/orchestrator/server.js'`

- [ ] **Step 3: Write `src/orchestrator/mcp.ts`**

`create_upload_url` is registered here as a stub so the transport is provable now; Task 6 replaces the body with the real implementation.

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Config } from "../shared/config.js";
import type { Storage } from "../shared/storage.js";

export interface Ctx { cfg: Config; storage: Storage }

/** Every tool answers with compact JSON as text. Nothing returns a stream and
 *  nothing returns an artifact body — spec §10. */
export const jsonResult = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
});

export const buildMcpServer = (ctx: Ctx): McpServer => {
  const server = new McpServer({ name: "azure-files", version: "0.1.0" });

  server.registerTool(
    "create_upload_url",
    {
      title: "Create upload URL",
      description:
        "Mint a short-lived, write-only URL for one blob. Upload the file to it " +
        "directly with scripts/upload.mjs — never read the file into the conversation.",
      inputSchema: {
        filename: z.string().min(1),
        sizeBytes: z.number().int().positive(),
        contentType: z.string().optional(),
        sha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
      },
    },
    async () => jsonResult({ error: "not_implemented" }),
  );

  return server;
};
```

- [ ] **Step 4: Write `src/orchestrator/server.ts`**

```ts
import http from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { loadConfig } from "../shared/config.js";
import { log } from "../shared/logger.js";
import { getStorage, ensureStorage } from "../shared/storage.js";
import { buildMcpServer, type Ctx } from "./mcp.js";

const readBody = (req: http.IncomingMessage): Promise<unknown> =>
  new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    let bytes = 0;
    req.on("data", (c: Buffer) => {
      bytes += c.length;
      // A tool call carries ids and parameters. Anything near a megabyte means a
      // caller is trying to push a payload through the control plane — refuse it.
      if (bytes > 1_048_576) { reject(new Error("request body too large")); req.destroy(); return; }
      parts.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(parts).toString("utf8");
      try { resolve(raw ? JSON.parse(raw) : undefined); } catch (e) { reject(e); }
    });
    req.on("error", reject);
  });

export const startServer = (ctx: Ctx, port: number): Promise<http.Server> => {
  const server = http.createServer(async (req, res) => {
    const path = (req.url ?? "/").split("?")[0];

    if (path === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, service: "azure-files", version: "0.1.0" }));
      return;
    }

    if (path !== "/mcp") { res.writeHead(404).end(); return; }

    if (ctx.cfg.bearerToken) {
      const auth = req.headers.authorization ?? "";
      if (auth !== `Bearer ${ctx.cfg.bearerToken}`) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorised" }));
        return;
      }
    }

    try {
      const body = await readBody(req);
      // Stateless: a fresh server and transport per request. All state lives in
      // Azurite, so there is nothing to keep in memory and nothing to make
      // sticky when the orchestrator is scaled.
      const mcp = buildMcpServer(ctx);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => { void transport.close(); void mcp.close(); });
      await mcp.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (e) {
      log.error("mcp.request_failed", { message: String((e as Error).message).slice(0, 400) });
      if (!res.headersSent) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "bad_request" }));
      }
    }
  });

  return new Promise((resolve) => server.listen(port, "0.0.0.0", () => resolve(server)));
};

// Entry point when run as a service.
if (import.meta.url === `file://${process.argv[1]}`) {
  const cfg = loadConfig();
  const storage = getStorage(cfg);
  await ensureStorage(storage);
  await startServer({ cfg, storage }, cfg.orchPort);
  log.info("orchestrator.listening", { port: cfg.orchPort });
}
```

- [ ] **Step 5: Run the test**

Run: `npm --prefix plugins/azure-file-processing run test:integration -- mcp-server`
Expected: PASS — handshake completes, `create_upload_url` is listed, `/health` is open, `/mcp` is guarded when a token is set.

- [ ] **Step 6: Verify the full stack now comes up, and Codex sees the tool**

Run:
```bash
cd plugins/azure-file-processing && ./scripts/stack.sh up
curl -fsS http://127.0.0.1:8080/health
```
Expected: `stack.sh up` reaches "ready" this time. In a **new** Codex thread, `azure-files` appears with one tool.

- [ ] **Step 7: Stage**

```bash
git add plugins/azure-file-processing/src/orchestrator/server.ts \
        plugins/azure-file-processing/src/orchestrator/mcp.ts \
        plugins/azure-file-processing/test/mcp-server.int.test.ts
# Repo owner commits. Proposed message:
#   feat(afp): stateless MCP server over streamable HTTP, with health and bearer auth
```

---

## Task 6: Write-only single-blob SAS, and `create_upload_url`

**Files:**
- Create: `plugins/azure-file-processing/src/shared/sas.ts`, `src/orchestrator/tools/create-upload-url.ts`
- Modify: `plugins/azure-file-processing/src/orchestrator/mcp.ts` (replace the stub registration)
- Test: `plugins/azure-file-processing/test/sas.int.test.ts`

**Interfaces:**
- Consumes: `Config`, `Storage`, `newJobId`, `createJob`, `UPLOADS_CONTAINER`, `jsonResult`, `Ctx`.
- Produces:
  - `mintUploadSas(s: Storage, cfg: Config, container: string, blobPath: string, now?: Date): { url: string; expiresAt: string }`
  - `SUPPORTED_EXTENSIONS: readonly string[]` = `[".pdf", ".docx", ".txt", ".md"]`
  - `createUploadUrl(ctx: Ctx, args: { filename: string; sizeBytes: number; contentType?: string; sha256?: string }): Promise<{ jobId: string; uploadUrl: string; blobPath: string; container: string; expiresAt: string; maxSinglePutBytes: number }>`

- [ ] **Step 1: Write the failing test**

`test/sas.int.test.ts`. These assertions are spec §11's "SAS is least-privilege" row — each one is a *negative* the SAS must fail.

```ts
import { describe, it, expect, beforeAll } from "vitest";
import { loadConfig, UPLOADS_CONTAINER } from "../src/shared/config.js";
import { getStorage, ensureStorage } from "../src/shared/storage.js";
import { mintUploadSas } from "../src/shared/sas.js";
import { createUploadUrl } from "../src/orchestrator/tools/create-upload-url.js";

const cfg = loadConfig();
const storage = getStorage(cfg);
const ctx = { cfg, storage };
beforeAll(async () => { await ensureStorage(storage); });

const put = (url: string, body: string) =>
  fetch(url, { method: "PUT", headers: { "x-ms-blob-type": "BlockBlob" }, body });

describe("mintUploadSas", () => {
  it("writes the blob it is scoped to", async () => {
    const { url } = mintUploadSas(storage, cfg, UPLOADS_CONTAINER, "sas-test/ok.txt");
    expect((await put(url, "hello")).status).toBe(201);
  });

  it("cannot READ the blob it just wrote", async () => {
    const { url } = mintUploadSas(storage, cfg, UPLOADS_CONTAINER, "sas-test/noread.txt");
    await put(url, "hello");
    expect((await fetch(url)).ok).toBe(false);
  });

  it("cannot write a DIFFERENT blob name", async () => {
    const { url } = mintUploadSas(storage, cfg, UPLOADS_CONTAINER, "sas-test/scoped.txt");
    const other = url.replace("sas-test/scoped.txt", "sas-test/elsewhere.txt");
    expect((await put(other, "nope")).ok).toBe(false);
  });

  it("cannot LIST the container", async () => {
    const { url } = mintUploadSas(storage, cfg, UPLOADS_CONTAINER, "sas-test/nolist.txt");
    const qs = url.split("?")[1];
    const listUrl = `${storage.blob.url}/${UPLOADS_CONTAINER}?restype=container&comp=list&${qs}`;
    expect((await fetch(listUrl)).ok).toBe(false);
  });

  it("is rejected once expired", async () => {
    const past = new Date(Date.now() - (cfg.sasTtlSeconds + 3600) * 1000);
    const { url } = mintUploadSas(storage, cfg, UPLOADS_CONTAINER, "sas-test/expired.txt", past);
    expect((await put(url, "nope")).ok).toBe(false);
  });
});

describe("createUploadUrl", () => {
  it("mints a job whose blob path is namespaced by the jobId", async () => {
    const out = await createUploadUrl(ctx, { filename: "contract.pdf", sizeBytes: 1024 });
    expect(out.blobPath).toBe(`${out.jobId}/contract.pdf`);
    expect(out.container).toBe(UPLOADS_CONTAINER);
    expect(new Date(out.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it("refuses a filename that tries to climb out of its prefix", async () => {
    await expect(createUploadUrl(ctx, { filename: "../../etc/passwd", sizeBytes: 10 }))
      .rejects.toThrow(/filename/);
    await expect(createUploadUrl(ctx, { filename: "a/b.pdf", sizeBytes: 10 }))
      .rejects.toThrow(/filename/);
  });

  it("refuses an unsupported extension", async () => {
    await expect(createUploadUrl(ctx, { filename: "movie.mp4", sizeBytes: 10 }))
      .rejects.toThrow(/extension/);
  });

  it("refuses a size above the ceiling", async () => {
    await expect(createUploadUrl(ctx, { filename: "big.pdf", sizeBytes: cfg.maxUploadBytes + 1 }))
      .rejects.toThrow(/too large/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm --prefix plugins/azure-file-processing run test:integration -- sas`
Expected: FAIL — `Cannot find module '../src/shared/sas.js'`

- [ ] **Step 3: Write `src/shared/sas.ts`**

```ts
import {
  BlobSASPermissions, SASProtocol, generateBlobSASQueryParameters,
} from "@azure/storage-blob";
import type { Config } from "./config.js";
import type { Storage } from "./storage.js";

export interface MintedSas { url: string; expiresAt: string }

/** A SERVICE SAS scoped to exactly one blob, permissions create+write only.
 *  It cannot read, cannot list, and cannot address any other blob name — the
 *  blob name is inside the signed string, so altering the path invalidates it.
 *  In prod this becomes a user-delegation SAS via Managed Identity (spec §12);
 *  only this function changes. */
export const mintUploadSas = (
  s: Storage, cfg: Config, container: string, blobPath: string, now: Date = new Date(),
): MintedSas => {
  const expiresOn = new Date(now.getTime() + cfg.sasTtlSeconds * 1000);
  const qs = generateBlobSASQueryParameters(
    {
      containerName: container,
      blobName: blobPath,
      permissions: BlobSASPermissions.parse("cw"),
      startsOn: new Date(now.getTime() - 60_000), // tolerate clock skew
      expiresOn,
      protocol: SASProtocol.HttpsAndHttp,          // http, because Azurite is http
    },
    s.sharedKey,
  ).toString();

  const base = (cfg.publicBlobEndpoint ?? s.blob.url).replace(/\/+$/, "");
  return {
    url: `${base}/${container}/${blobPath}?${qs}`,
    expiresAt: expiresOn.toISOString(),
  };
};
```

- [ ] **Step 4: Write `src/orchestrator/tools/create-upload-url.ts`**

```ts
import { extname } from "node:path";
import { UPLOADS_CONTAINER } from "../../shared/config.js";
import { newJobId } from "../../shared/ids.js";
import { createJob } from "../../shared/jobs.js";
import { mintUploadSas } from "../../shared/sas.js";
import { log } from "../../shared/logger.js";
import type { Ctx } from "../mcp.js";

export const SUPPORTED_EXTENSIONS = [".pdf", ".docx", ".txt", ".md"] as const;

/** Azure caps a single Put Blob at 5000 MiB, and a request that large is fragile
 *  regardless. scripts/upload.mjs stages blocks above this. */
export const MAX_SINGLE_PUT_BYTES = 67_108_864; // 64 MiB

export interface CreateUploadUrlArgs {
  filename: string; sizeBytes: number; contentType?: string; sha256?: string;
}

export const createUploadUrl = async (ctx: Ctx, args: CreateUploadUrlArgs) => {
  const { filename, sizeBytes } = args;

  // The filename becomes a blob path segment. A separator or a climb would let a
  // caller write outside its own jobId prefix, which is the only thing keeping
  // one job's bytes away from another's.
  if (/[/\\]/.test(filename) || filename.includes("..") || filename.startsWith(".")) {
    throw new Error(`filename must be a plain name with no path separators: ${filename}`);
  }
  const ext = extname(filename).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.includes(ext as any)) {
    throw new Error(`unsupported extension ${ext || "(none)"}; expected one of ${SUPPORTED_EXTENSIONS.join(", ")}`);
  }
  if (sizeBytes > ctx.cfg.maxUploadBytes) {
    throw new Error(`file too large: ${sizeBytes} bytes exceeds the ${ctx.cfg.maxUploadBytes} byte ceiling`);
  }

  const jobId = newJobId();
  const blobPath = `${jobId}/${filename}`;
  const { url, expiresAt } = mintUploadSas(ctx.storage, ctx.cfg, UPLOADS_CONTAINER, blobPath);

  await createJob(ctx.storage, {
    jobId, state: "awaiting_upload", phase: null,
    pipelineId: "extract-chunks", params: "{}",
    blobPath, filename, sizeBytes,
    sha256: args.sha256 ?? null,
    progressDone: 0, progressTotal: 0, attempts: 0, workerId: null,
    createdAt: new Date().toISOString(), startedAt: null, finishedAt: null, error: null,
  });

  // The URL carries a signature; it is deliberately NOT logged.
  log.info("upload.url_minted", { jobId, filename, sizeBytes, ext });

  return {
    jobId, uploadUrl: url, blobPath,
    container: UPLOADS_CONTAINER, expiresAt,
    maxSinglePutBytes: MAX_SINGLE_PUT_BYTES,
  };
};
```

- [ ] **Step 5: Replace the stub in `src/orchestrator/mcp.ts`**

Swap the `async () => jsonResult({ error: "not_implemented" })` handler for the real one, and add the import:

```ts
import { createUploadUrl } from "./tools/create-upload-url.js";
```

```ts
    async (args) => jsonResult(await createUploadUrl(ctx, args)),
```

- [ ] **Step 6: Run the tests**

Run: `npm --prefix plugins/azure-file-processing run test:integration -- sas`
Expected: PASS, including all four negative SAS assertions. If "cannot READ" passes only because the URL 404s rather than 403s, tighten the assertion to check the status code is 403 — a 404 would mean the test proved nothing.

- [ ] **Step 7: Stage**

```bash
git add plugins/azure-file-processing/src/shared/sas.ts \
        plugins/azure-file-processing/src/orchestrator/tools/create-upload-url.ts \
        plugins/azure-file-processing/src/orchestrator/mcp.ts \
        plugins/azure-file-processing/test/sas.int.test.ts
# Repo owner commits. Proposed message:
#   feat(afp): single-blob write-only SAS and create_upload_url
```

---

## Task 7: `scripts/upload.mjs` — bytes from disk to blob, never through the model

**Files:**
- Create: `plugins/azure-file-processing/scripts/upload.mjs`
- Test: `plugins/azure-file-processing/test/upload.int.test.ts`

**Interfaces:**
- Consumes: a SAS URL from `create_upload_url`.
- Produces: a CLI — `node scripts/upload.mjs <file> <uploadUrl>` — printing one JSON line to stdout: `{ ok: true, bytes: number, sha256: string, blocks: number }`. This is the command the skill tells Codex to run; it is a **plain `.mjs`** with no imports beyond `node:` builtins so it runs from an installed plugin folder with no `npm install`.

- [ ] **Step 1: Write the failing test**

`test/upload.int.test.ts`:

```ts
import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { loadConfig, UPLOADS_CONTAINER } from "../src/shared/config.js";
import { getStorage, ensureStorage } from "../src/shared/storage.js";
import { createUploadUrl } from "../src/orchestrator/tools/create-upload-url.js";

const cfg = loadConfig();
const storage = getStorage(cfg);
const ctx = { cfg, storage };
const script = resolve(dirname(fileURLToPath(import.meta.url)), "../scripts/upload.mjs");
const dir = mkdtempSync(join(tmpdir(), "afp-up-"));

beforeAll(async () => { await ensureStorage(storage); });

const upload = (file: string, url: string) =>
  JSON.parse(execFileSync("node", [script, file, url], { encoding: "utf8" }).trim());

const committed = async (blobPath: string) =>
  (await storage.blob.getContainerClient(UPLOADS_CONTAINER)
     .getBlockBlobClient(blobPath).getProperties()).contentLength;

describe("upload.mjs", () => {
  it("uploads a small file in a single PUT", async () => {
    const file = join(dir, "small.md");
    const body = "# hello\n".repeat(1000);
    writeFileSync(file, body);
    const { uploadUrl, blobPath } = await createUploadUrl(ctx, {
      filename: "small.md", sizeBytes: Buffer.byteLength(body) });
    const out = upload(file, uploadUrl);
    expect(out.ok).toBe(true);
    expect(out.blocks).toBe(1);
    expect(out.sha256).toBe(createHash("sha256").update(body).digest("hex"));
    expect(await committed(blobPath)).toBe(Buffer.byteLength(body));
  });

  it("stages blocks for a file past the single-PUT ceiling", async () => {
    // 80 MiB of repeated text: over the 64 MiB threshold, so it must take the
    // block-staging path and still commit to exactly the right length.
    const file = join(dir, "big.txt");
    const chunk = Buffer.alloc(1024 * 1024, 0x61);
    writeFileSync(file, Buffer.concat(Array(80).fill(chunk)));
    const size = 80 * 1024 * 1024;
    const { uploadUrl, blobPath } = await createUploadUrl(ctx, {
      filename: "big.txt", sizeBytes: size });
    const out = upload(file, uploadUrl);
    expect(out.ok).toBe(true);
    expect(out.blocks).toBeGreaterThan(1);
    expect(out.bytes).toBe(size);
    expect(await committed(blobPath)).toBe(size);
  });

  it("prints no file content on failure", () => {
    const file = join(dir, "small.md");
    let stderr = "";
    try {
      execFileSync("node", [script, file, "http://127.0.0.1:10000/nope"], { encoding: "utf8" });
    } catch (e: any) { stderr = String(e.stderr ?? "") + String(e.stdout ?? ""); }
    expect(stderr).not.toContain("# hello");
    expect(stderr).toMatch(/upload failed/i);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm --prefix plugins/azure-file-processing run test:integration -- upload`
Expected: FAIL — `Cannot find module .../scripts/upload.mjs`

- [ ] **Step 3: Write `scripts/upload.mjs`**

```js
#!/usr/bin/env node
// Sends a local file to a SAS URL. Bytes go from disk to storage; they never
// pass through the model, and this script never prints file content.
//
//   node scripts/upload.mjs <file> <uploadUrl>
import { createReadStream, statSync } from "node:fs";
import { createHash } from "node:crypto";

const SINGLE_PUT_LIMIT = 64 * 1024 * 1024; // matches MAX_SINGLE_PUT_BYTES
const BLOCK_SIZE = 32 * 1024 * 1024;

const [, , file, uploadUrl] = process.argv;
if (!file || !uploadUrl) {
  console.error("usage: upload.mjs <file> <uploadUrl>");
  process.exit(2);
}

const fail = (why, extra = "") => {
  // Deliberately never includes the body, and never the signed URL.
  console.error(`upload failed: ${why}${extra ? ` (${extra})` : ""}`);
  process.exit(1);
};

const sha256OfFile = (path) =>
  new Promise((resolve, reject) => {
    const h = createHash("sha256");
    createReadStream(path)
      .on("data", (c) => h.update(c))
      .on("end", () => resolve(h.digest("hex")))
      .on("error", reject);
  });

const readRange = (path, start, end) =>
  new Promise((resolve, reject) => {
    const parts = [];
    createReadStream(path, { start, end })
      .on("data", (c) => parts.push(c))
      .on("end", () => resolve(Buffer.concat(parts)))
      .on("error", reject);
  });

const { size } = statSync(file);
const digest = await sha256OfFile(file);
const sep = uploadUrl.includes("?") ? "&" : "?";

if (size <= SINGLE_PUT_LIMIT) {
  const res = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "x-ms-blob-type": "BlockBlob", "content-length": String(size) },
    body: createReadStream(file),
    duplex: "half",
  }).catch((e) => fail("could not reach storage", e.message));
  if (!res.ok) fail(`storage answered ${res.status}`);
  console.log(JSON.stringify({ ok: true, bytes: size, sha256: digest, blocks: 1 }));
  process.exit(0);
}

// Block staging. Each block is uploaded independently, then one commit call
// makes the blob appear at full length — so a 2 GiB file never needs a 2 GiB
// request, and a failed block retries alone.
const blockIds = [];
let offset = 0;
let n = 0;
while (offset < size) {
  const end = Math.min(offset + BLOCK_SIZE, size) - 1;
  const id = Buffer.from(String(n).padStart(8, "0")).toString("base64");
  const body = await readRange(file, offset, end);
  const res = await fetch(`${uploadUrl}${sep}comp=block&blockid=${encodeURIComponent(id)}`, {
    method: "PUT",
    headers: { "content-length": String(body.length) },
    body,
  }).catch((e) => fail("could not reach storage", e.message));
  if (!res.ok) fail(`block ${n} rejected with ${res.status}`);
  blockIds.push(id);
  offset = end + 1;
  n += 1;
  process.stderr.write(`\rstaged ${n} block(s), ${offset}/${size} bytes`);
}
process.stderr.write("\n");

const list =
  `<?xml version="1.0" encoding="utf-8"?><BlockList>` +
  blockIds.map((id) => `<Latest>${id}</Latest>`).join("") +
  `</BlockList>`;
const commit = await fetch(`${uploadUrl}${sep}comp=blocklist`, {
  method: "PUT",
  headers: { "content-type": "application/xml" },
  body: list,
}).catch((e) => fail("could not reach storage", e.message));
if (!commit.ok) fail(`commit rejected with ${commit.status}`);

console.log(JSON.stringify({ ok: true, bytes: size, sha256: digest, blocks: blockIds.length }));
```

- [ ] **Step 4: Run the tests**

Run: `npm --prefix plugins/azure-file-processing run test:integration -- upload`
Expected: PASS. The 80 MiB case is the one that matters — `blocks > 1` and the committed length exactly equal to the file size.

- [ ] **Step 5: Confirm bounded memory in the staging path**

Run:
```bash
cd plugins/azure-file-processing
node --max-old-space-size=256 scripts/upload.mjs /tmp/afp-big.txt "<a fresh SAS url>"
```
Expected: completes. Only one 32 MiB block is resident at a time; a whole-file read would exceed the heap and abort.

- [ ] **Step 6: Stage**

```bash
git add plugins/azure-file-processing/scripts/upload.mjs \
        plugins/azure-file-processing/test/upload.int.test.ts
# Repo owner commits. Proposed message:
#   feat(afp): upload.mjs with single-PUT and block-staged paths
```

---

## Task 8: `start_job` — verify, enqueue, and refuse to double-process

**Files:**
- Create: `plugins/azure-file-processing/src/orchestrator/tools/start-job.ts`
- Modify: `plugins/azure-file-processing/src/orchestrator/mcp.ts` (register the tool)
- Test: `plugins/azure-file-processing/test/start-job.int.test.ts`

**Interfaces:**
- Consumes: `getJob`, `updateJob`, `JOB_QUEUE`, `UPLOADS_CONTAINER`, `Ctx`, `jsonResult`.
- Produces: `startJob(ctx: Ctx, args: { jobId: string; pipeline?: { id: string; params?: Record<string, number> } }): Promise<{ jobId: string; state: JobState; queuedAt: string; alreadyStarted: boolean }>`
- Queue message body is the **plain JSON text** `{"jobId":"…"}`. Both producer and consumer are ours, so base64 framing would only make the queue harder to inspect while debugging.

- [ ] **Step 1: Write the failing test**

`test/start-job.int.test.ts`:

```ts
import { describe, it, expect, beforeAll } from "vitest";
import { loadConfig, UPLOADS_CONTAINER, JOB_QUEUE } from "../src/shared/config.js";
import { getStorage, ensureStorage } from "../src/shared/storage.js";
import { getJob } from "../src/shared/jobs.js";
import { createUploadUrl } from "../src/orchestrator/tools/create-upload-url.js";
import { startJob } from "../src/orchestrator/tools/start-job.js";

const cfg = loadConfig();
const storage = getStorage(cfg);
const ctx = { cfg, storage };
beforeAll(async () => { await ensureStorage(storage); });

const uploadedJob = async (body = "hello world\n") => {
  const sizeBytes = Buffer.byteLength(body);
  const out = await createUploadUrl(ctx, { filename: "doc.md", sizeBytes });
  await fetch(out.uploadUrl, {
    method: "PUT", headers: { "x-ms-blob-type": "BlockBlob" }, body,
  });
  return out;
};

describe("startJob", () => {
  it("queues an uploaded job and records the parameters", async () => {
    const { jobId } = await uploadedJob();
    const out = await startJob(ctx, {
      jobId, pipeline: { id: "extract-chunks", params: { chunkChars: 1500 } } });
    expect(out.state).toBe("queued");
    expect(out.alreadyStarted).toBe(false);
    const job = await getJob(storage, jobId);
    expect(job?.state).toBe("queued");
    expect(JSON.parse(job!.params).chunkChars).toBe(1500);
  });

  it("is idempotent — a second call enqueues nothing more", async () => {
    // A model that retries on a slow response must not be able to make a 2 GB
    // file process twice.
    const { jobId } = await uploadedJob();
    await startJob(ctx, { jobId });
    const before = (await storage.queue(JOB_QUEUE).getProperties()).approximateMessagesCount ?? 0;
    const second = await startJob(ctx, { jobId });
    const after = (await storage.queue(JOB_QUEUE).getProperties()).approximateMessagesCount ?? 0;
    expect(second.alreadyStarted).toBe(true);
    expect(after).toBe(before);
  });

  it("refuses a job whose blob was never uploaded", async () => {
    const out = await createUploadUrl(ctx, { filename: "missing.md", sizeBytes: 10 });
    await expect(startJob(ctx, { jobId: out.jobId })).rejects.toThrow(/not uploaded/);
  });

  it("refuses when the committed size disagrees with what was declared", async () => {
    const out = await createUploadUrl(ctx, { filename: "short.md", sizeBytes: 9999 });
    await fetch(out.uploadUrl, {
      method: "PUT", headers: { "x-ms-blob-type": "BlockBlob" }, body: "tiny" });
    await expect(startJob(ctx, { jobId: out.jobId })).rejects.toThrow(/size/);
  });

  it("refuses an unknown jobId", async () => {
    await expect(startJob(ctx, { jobId: "j-000000000-aaaaaaaaaaaa" }))
      .rejects.toThrow(/unknown job/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm --prefix plugins/azure-file-processing run test:integration -- start-job`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/orchestrator/tools/start-job.ts`**

```ts
import { UPLOADS_CONTAINER, JOB_QUEUE } from "../../shared/config.js";
import { getJob, updateJob, type JobState } from "../../shared/jobs.js";
import { log } from "../../shared/logger.js";
import type { Ctx } from "../mcp.js";

export interface StartJobArgs {
  jobId: string;
  pipeline?: { id: string; params?: Record<string, number> };
}

const ALLOWED_PARAMS = ["chunkChars", "overlapChars", "pageWindow"] as const;

export const startJob = async (ctx: Ctx, args: StartJobArgs): Promise<{
  jobId: string; state: JobState; queuedAt: string; alreadyStarted: boolean;
}> => {
  const job = await getJob(ctx.storage, args.jobId);
  if (!job) throw new Error(`unknown job ${args.jobId}`);
  if (job.state === "deleted") throw new Error(`job ${args.jobId} was deleted`);

  // Idempotent: report the current state rather than enqueueing a duplicate.
  if (job.state !== "awaiting_upload") {
    return { jobId: job.jobId, state: job.state, queuedAt: job.createdAt, alreadyStarted: true };
  }

  const blob = ctx.storage.blob
    .getContainerClient(UPLOADS_CONTAINER).getBlockBlobClient(job.blobPath);
  let contentLength: number | undefined;
  try {
    contentLength = (await blob.getProperties()).contentLength;
  } catch (e: any) {
    if (e?.statusCode === 404) throw new Error(`job ${job.jobId} was not uploaded`);
    throw e;
  }
  if (contentLength !== job.sizeBytes) {
    throw new Error(
      `size mismatch: declared ${job.sizeBytes} bytes, storage holds ${contentLength}`);
  }
  // sha256 is NOT verified here: hashing means reading every byte, and this is
  // the control plane. The worker checks it while streaming (spec §6.2).

  const params: Record<string, number> = {};
  for (const k of ALLOWED_PARAMS) {
    const v = args.pipeline?.params?.[k];
    if (typeof v === "number" && Number.isFinite(v) && v > 0) params[k] = v;
  }

  await ctx.storage.queue(JOB_QUEUE).sendMessage(JSON.stringify({ jobId: job.jobId }));
  const queuedAt = new Date().toISOString();
  await updateJob(ctx.storage, job.jobId, {
    state: "queued",
    pipelineId: args.pipeline?.id ?? "extract-chunks",
    params: JSON.stringify(params),
  });

  log.info("job.queued", { jobId: job.jobId, sizeBytes: job.sizeBytes });
  return { jobId: job.jobId, state: "queued", queuedAt, alreadyStarted: false };
};
```

- [ ] **Step 4: Register it in `src/orchestrator/mcp.ts`**

```ts
import { startJob } from "./tools/start-job.js";
```

```ts
  server.registerTool(
    "start_job",
    {
      title: "Start job",
      description: "Queue processing for an already-uploaded file. Returns immediately; poll job_status.",
      inputSchema: {
        jobId: z.string(),
        pipeline: z.object({
          id: z.string().default("extract-chunks"),
          params: z.record(z.string(), z.number()).optional(),
        }).optional(),
      },
    },
    async (args) => jsonResult(await startJob(ctx, args as any)),
  );
```

- [ ] **Step 5: Run the tests**

Run: `npm --prefix plugins/azure-file-processing run test:integration -- start-job`
Expected: PASS, in particular the idempotency case.

- [ ] **Step 6: Stage**

```bash
git add plugins/azure-file-processing/src/orchestrator/tools/start-job.ts \
        plugins/azure-file-processing/src/orchestrator/mcp.ts \
        plugins/azure-file-processing/test/start-job.int.test.ts
# Repo owner commits. Proposed message:
#   feat(afp): start_job with upload verification and idempotent enqueue
```

---

## Task 9: The chunker — pure, deterministic, exactly page-mapped

**Files:**
- Create: `plugins/azure-file-processing/src/worker/chunk.ts`
- Test: `plugins/azure-file-processing/test/chunk.test.ts`

This task touches no storage and no Docker: it is a pure function, and it runs in `npm test`. Determinism here is what lets every later test assert exact chunk ids and offsets.

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface PageText { page: number; text: string }`
  - `interface Chunk { chunkId: string; page: number; charStart: number; charEnd: number; text: string }`
  - `chunkPages(pages: AsyncIterable<PageText> | Iterable<PageText>, opts: { chunkChars: number; overlapChars: number }): AsyncGenerator<Chunk>` — async because extraction produces pages over time; `for await` accepts a plain array unchanged, so tests can pass one
  - `chunkIdFor(n: number): string` → `c-000000` (six digits, zero-padded, document order)

- [ ] **Step 1: Write the failing test**

`test/chunk.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { chunkPages, chunkIdFor, type PageText } from "../src/worker/chunk.js";

const collect = async (pages: PageText[], chunkChars = 100, overlapChars = 20) => {
  const out = [];
  for await (const c of chunkPages(pages, { chunkChars, overlapChars })) out.push(c);
  return out;
};

describe("chunkIdFor", () => {
  it("zero-pads so ids sort into reading order", () => {
    expect(chunkIdFor(0)).toBe("c-000000");
    expect(chunkIdFor(412)).toBe("c-000412");
    expect(["c-000010", "c-000002"].sort()).toEqual(["c-000002", "c-000010"]);
  });
});

describe("chunkPages", () => {
  it("returns one chunk when the text is shorter than the window", async () => {
    const out = await collect([{ page: 1, text: "short text" }]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ chunkId: "c-000000", page: 1, charStart: 0, charEnd: 10 });
  });

  it("is deterministic — identical input yields identical output", async () => {
    const pages = [{ page: 1, text: "alpha beta gamma. ".repeat(40) }];
    expect(await collect(pages)).toEqual(await collect(pages));
  });

  it("overlaps consecutive chunks by the requested amount", async () => {
    const out = await collect([{ page: 1, text: "x".repeat(500) }], 100, 20);
    expect(out.length).toBeGreaterThan(1);
    for (let i = 1; i < out.length; i++) {
      expect(out[i].charStart).toBe(out[i - 1].charEnd - 20);
    }
  });

  it("prefers a paragraph boundary over a hard cut", async () => {
    const text = "a".repeat(80) + "\n\n" + "b".repeat(80);
    const [first] = await collect([{ page: 1, text }], 100, 0);
    expect(first.text).toBe("a".repeat(80) + "\n\n");
  });

  it("maps every chunk to the page its first character came from", async () => {
    // 60 chars per page, 100-char window: chunk 0 starts on page 1, and a later
    // chunk must report the page it actually begins on, not the page in flight.
    const pages = Array.from({ length: 10 }, (_, i) => ({ page: i + 1, text: "z".repeat(60) }));
    const out = await collect(pages, 100, 0);
    expect(out[0].page).toBe(1);
    expect(out[1].page).toBe(2);   // chars 100..199 begin inside page 2 (60..119)
    expect(out[2].page).toBe(4);   // chars 200..299 begin inside page 4 (180..239)
  });

  it("emits a final short chunk rather than dropping the tail", async () => {
    const out = await collect([{ page: 1, text: "y".repeat(230) }], 100, 0);
    expect(out).toHaveLength(3);
    expect(out[2].text).toHaveLength(30);
  });

  it("drops a trailing chunk that is only whitespace", async () => {
    const out = await collect([{ page: 1, text: "y".repeat(200) + "   \n  " }], 100, 0);
    expect(out).toHaveLength(2);
  });

  it("refuses an overlap that would never make progress", async () => {
    await expect(collect([{ page: 1, text: "abc" }], 100, 100)).rejects.toThrow(/overlap/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm --prefix plugins/azure-file-processing test -- chunk`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/worker/chunk.ts`**

```ts
export interface PageText { page: number; text: string }

export interface Chunk {
  chunkId: string;
  page: number;        // the page the chunk's FIRST character came from
  charStart: number;   // global character offset in the extracted document
  charEnd: number;
  text: string;
}

export const chunkIdFor = (n: number): string => `c-${String(n).padStart(6, "0")}`;

/** Where to cut a buffer that has reached the window size. Paragraph, then line,
 *  then sentence, then a hard cut — a hard cut only when the window contains no
 *  boundary at all, which is what makes the output stable for any input. */
const splitPoint = (buf: string, limit: number): number => {
  const window = buf.slice(0, limit);
  const floor = Math.floor(limit * 0.5); // never cut so early the chunk is tiny
  for (const sep of ["\n\n", "\n", ". "]) {
    const at = window.lastIndexOf(sep);
    if (at >= floor) return at + sep.length;
  }
  return limit;
};

/** Async because extraction yields pages over time (a PDF window at a time).
 *  `for await` consumes a plain array just as happily, so callers with all the
 *  pages in hand pass one directly. */
export async function* chunkPages(
  pages: AsyncIterable<PageText> | Iterable<PageText>,
  opts: { chunkChars: number; overlapChars: number },
): AsyncGenerator<Chunk> {
  const { chunkChars, overlapChars } = opts;
  if (chunkChars <= 0) throw new Error("chunkChars must be positive");
  if (overlapChars < 0 || overlapChars >= chunkChars) {
    throw new Error("overlapChars must be non-negative and smaller than chunkChars");
  }

  // Page boundaries as global offsets, so a chunk's page is looked up exactly
  // rather than approximated from whichever page happened to be in flight.
  const marks: Array<{ at: number; page: number }> = [];
  const pageAt = (offset: number): number => {
    let page = marks.length ? marks[0].page : 1;
    for (const m of marks) { if (m.at <= offset) page = m.page; else break; }
    return page;
  };

  let buf = "";
  let bufStart = 0;   // global offset of buf[0]
  let consumed = 0;   // global offset just past the end of buf
  let n = 0;

  const flush = function* (limit: number): Generator<Chunk> {
    while (buf.length >= limit) {
      const cut = splitPoint(buf, chunkChars);
      const text = buf.slice(0, cut);
      yield {
        chunkId: chunkIdFor(n++), page: pageAt(bufStart),
        charStart: bufStart, charEnd: bufStart + cut, text,
      };
      const keep = Math.min(overlapChars, cut);
      buf = buf.slice(cut - keep);
      bufStart += cut - keep;
      while (marks.length > 1 && marks[1].at <= bufStart) marks.shift();
    }
  };

  for await (const p of pages as AsyncIterable<PageText>) {
    marks.push({ at: consumed, page: p.page });
    buf += p.text;
    consumed += p.text.length;
    yield* flush(chunkChars);
  }

  if (buf.trim().length > 0) {
    yield {
      chunkId: chunkIdFor(n++), page: pageAt(bufStart),
      charStart: bufStart, charEnd: bufStart + buf.length, text: buf,
    };
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `npm --prefix plugins/azure-file-processing test -- chunk`
Expected: PASS. If the page-mapping case fails, the bug is in `marks` pruning — a mark must only be dropped once the *next* mark is at or before `bufStart`.

- [ ] **Step 5: Stage**

```bash
git add plugins/azure-file-processing/src/worker/chunk.ts \
        plugins/azure-file-processing/test/chunk.test.ts
# Repo owner commits. Proposed message:
#   feat(afp): deterministic, page-mapped chunker
```

---

## Task 10: A streaming PDF fixture generator

**Files:**
- Create: `plugins/azure-file-processing/scripts/make-fixture-pdf.mjs`
- Test: `plugins/azure-file-processing/test/fixture-pdf.test.ts`

Test fixtures are **generated, never committed**: the acceptance suite needs a file large enough to disprove a whole-file memory load, and a multi-hundred-megabyte binary has no business in git. Writing the PDF as a stream (rather than with a library that builds it in memory) is also the only way to produce one of that size on a laptop.

**Interfaces:**
- Consumes: nothing (`node:` builtins only).
- Produces: a CLI — `node scripts/make-fixture-pdf.mjs <out.pdf> <pages> [--needle <text>] [--needle-page <n>] [--lines-per-page <n>]` — printing `{ ok, pages, bytes, needlePage }` as one JSON line. Every page carries a `Page <n> of <total>` marker so extraction can be checked page by page.

- [ ] **Step 1: Write the failing test**

`test/fixture-pdf.test.ts` (runs in `npm test` — needs `pdftotext` on PATH, which the repo already has via poppler, and which the worker image installs):

```ts
import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const script = resolve(dirname(fileURLToPath(import.meta.url)), "../scripts/make-fixture-pdf.mjs");
const dir = mkdtempSync(join(tmpdir(), "afp-fx-"));
const pdf = join(dir, "fixture.pdf");
let made: any;

beforeAll(() => {
  made = JSON.parse(execFileSync("node",
    [script, pdf, "40", "--needle", "TERMINATION_CLAUSE_NEEDLE", "--needle-page", "37"],
    { encoding: "utf8" }).trim());
});

describe("make-fixture-pdf", () => {
  it("reports what it wrote", () => {
    expect(made.ok).toBe(true);
    expect(made.pages).toBe(40);
    expect(statSync(pdf).size).toBe(made.bytes);
  });

  it("produces a PDF poppler agrees has the right page count", () => {
    const info = execFileSync("pdfinfo", [pdf], { encoding: "utf8" });
    expect(info).toMatch(/^Pages:\s+40$/m);
  });

  it("puts the needle on the requested page and nowhere else", () => {
    const p37 = execFileSync("pdftotext", ["-f", "37", "-l", "37", pdf, "-"], { encoding: "utf8" });
    const p36 = execFileSync("pdftotext", ["-f", "36", "-l", "36", pdf, "-"], { encoding: "utf8" });
    expect(p37).toContain("TERMINATION_CLAUSE_NEEDLE");
    expect(p36).not.toContain("TERMINATION_CLAUSE_NEEDLE");
  });

  it("marks every page so extraction can be checked page by page", () => {
    const p12 = execFileSync("pdftotext", ["-f", "12", "-l", "12", pdf, "-"], { encoding: "utf8" });
    expect(p12).toContain("Page 12 of 40");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm --prefix plugins/azure-file-processing test -- fixture-pdf`
Expected: FAIL — script not found.

- [ ] **Step 3: Write `scripts/make-fixture-pdf.mjs`**

```js
#!/usr/bin/env node
// Writes a valid, uncompressed PDF as a STREAM, so a multi-gigabyte fixture can
// be produced without holding it in memory.
//
//   node scripts/make-fixture-pdf.mjs <out.pdf> <pages> [--needle T] [--needle-page N] [--lines-per-page N]
import { createWriteStream } from "node:fs";
import { once } from "node:events";

const argv = process.argv.slice(2);
const [out, pagesArg] = argv;
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};

if (!out || !pagesArg) {
  console.error("usage: make-fixture-pdf.mjs <out.pdf> <pages> [--needle T] [--needle-page N] [--lines-per-page N]");
  process.exit(2);
}

const pages = Number(pagesArg);
const needle = flag("needle", null);
const needlePage = Number(flag("needle-page", 1));
const linesPerPage = Number(flag("lines-per-page", 40));

const stream = createWriteStream(out);
let offset = 0;
const offsets = [];          // offsets[objNumber] = byte offset

const write = async (s) => {
  const buf = Buffer.from(s, "latin1");
  offset += buf.length;
  if (!stream.write(buf)) await once(stream, "drain");
};
const beginObj = async (n, body) => { offsets[n] = offset; await write(`${n} 0 obj\n${body}\nendobj\n`); };
const esc = (s) => s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");

// Object numbering is fixed up front, so /Kids can be written before any page
// exists: page i is object 4+2i and its content stream is 5+2i.
const pageObj = (i) => 4 + 2 * i;
const contentObj = (i) => 5 + 2 * i;
const kids = Array.from({ length: pages }, (_, i) => `${pageObj(i)} 0 R`).join(" ");

await write("%PDF-1.4\n");
await beginObj(1, "<< /Type /Catalog /Pages 2 0 R >>");
await beginObj(2, `<< /Type /Pages /Kids [${kids}] /Count ${pages} >>`);
await beginObj(3, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");

for (let i = 0; i < pages; i++) {
  const n = i + 1;
  const lines = [`Page ${n} of ${pages}`];
  for (let l = 1; l < linesPerPage; l++) {
    lines.push(n === needlePage && needle && l === 3
      ? needle
      : `p${n} line ${l} lorem ipsum dolor sit amet consectetur adipiscing elit`);
  }
  const body =
    "BT /F1 11 Tf 1 0 0 1 54 738 Tm 14 TL\n" +
    lines.map((t) => `(${esc(t)}) Tj T*\n`).join("") +
    "ET";
  await beginObj(pageObj(i),
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
    `/Resources << /Font << /F1 3 0 R >> >> /Contents ${contentObj(i)} 0 R >>`);
  await beginObj(contentObj(i), `<< /Length ${Buffer.byteLength(body, "latin1")} >>\nstream\n${body}\nendstream`);
}

const total = 4 + 2 * pages;             // objects 0..total-1, where 0 is the free head
const xrefAt = offset;
let xref = `xref\n0 ${total}\n0000000000 65535 f \n`;
for (let n = 1; n < total; n++) {
  xref += `${String(offsets[n]).padStart(10, "0")} 00000 n \n`;
}
await write(xref);
await write(`trailer\n<< /Size ${total} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`);

stream.end();
await once(stream, "finish");
console.log(JSON.stringify({ ok: true, pages, bytes: offset, needlePage: needle ? needlePage : null }));
```

- [ ] **Step 4: Run the tests**

Run: `npm --prefix plugins/azure-file-processing test -- fixture-pdf`
Expected: PASS, including `pdfinfo` agreeing on 40 pages. If `pdfinfo` reports a damaged file, the xref offsets are wrong — every offset must be the byte position of the `N 0 obj` token itself.

- [ ] **Step 5: Confirm it scales without memory growth**

Run:
```bash
cd plugins/azure-file-processing
node --max-old-space-size=256 scripts/make-fixture-pdf.mjs /tmp/afp-large.pdf 20000
ls -lh /tmp/afp-large.pdf
```
Expected: completes under a 256 MB heap. MEASURED at ~63 MB for 20k pages at the
default 40 lines/page — the point of this check is that peak memory does NOT scale
with output size (500 pages ≈ 16.7 MB peak, 20k pages ≈ 41 MB), not the file size
itself. Task 19 raises `--lines-per-page` to reach a fixture larger than the heap. This is the input the acceptance suite uses.

- [ ] **Step 6: Stage**

```bash
git add plugins/azure-file-processing/scripts/make-fixture-pdf.mjs \
        plugins/azure-file-processing/test/fixture-pdf.test.ts
# Repo owner commits. Proposed message:
#   feat(afp): streaming PDF fixture generator for large-file tests
```

---

## Task 11: Extractors — PDF by page window, DOCX and text by stream

**Files:**
- Create: `plugins/azure-file-processing/src/worker/extract/pdf.ts`, `extract/docx.ts`, `extract/text.ts`, `extract/index.ts`
- Test: `plugins/azure-file-processing/test/extract.test.ts`

**Interfaces:**
- Consumes: `PageText` (Task 9), `Config`.
- Produces:
  - `pdfPageCount(path: string): Promise<number>`
  - `extractPdf(path: string, opts: { pageWindow: number }): AsyncGenerator<PageText>`
  - `extractDocx(path: string): AsyncGenerator<PageText>` — one synthetic page, `page: 1`
  - `extractText(path: string): AsyncGenerator<PageText>` — one synthetic page, `page: 1`
  - `extractPages(path: string, ext: string, opts: { pageWindow: number }): AsyncGenerator<PageText>` — dispatches on extension, throws `unsupported extension` otherwise
  - `interface DocMetadata { pages: number; title: string | null; producer: string | null }` and `readMetadata(path: string, ext: string): Promise<DocMetadata>`

A PDF **cannot be stream-parsed** — its cross-reference table is at the end of the file, so a parser must seek. Bounded memory comes from asking `pdftotext` for one page window at a time (spec §8.1), never from pretending the format streams.

- [ ] **Step 1: Write the failing test**

`test/extract.test.ts`:

```ts
import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { extractPages, pdfPageCount, readMetadata } from "../src/worker/extract/index.js";
import type { PageText } from "../src/worker/chunk.js";

const here = dirname(fileURLToPath(import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "afp-ex-"));
const pdf = join(dir, "doc.pdf");

beforeAll(() => {
  execFileSync("node", [
    resolve(here, "../scripts/make-fixture-pdf.mjs"), pdf, "60",
    "--needle", "NEEDLE_ON_37", "--needle-page", "37",
  ]);
});

const drain = async (gen: AsyncGenerator<PageText>) => {
  const out: PageText[] = [];
  for await (const p of gen) out.push(p);
  return out;
};

describe("PDF extraction", () => {
  it("counts pages without reading the whole document", async () => {
    expect(await pdfPageCount(pdf)).toBe(60);
  });

  it("yields every page exactly once, in order", async () => {
    const pages = await drain(extractPages(pdf, ".pdf", { pageWindow: 25 }));
    expect(pages).toHaveLength(60);
    expect(pages.map((p) => p.page)).toEqual(Array.from({ length: 60 }, (_, i) => i + 1));
  });

  it("keeps text on the page it came from, across a window boundary", () => {
    // Page 37 sits in the SECOND window (26-50). A window off-by-one shows up
    // here and nowhere else.
    return drain(extractPages(pdf, ".pdf", { pageWindow: 25 })).then((pages) => {
      expect(pages[36].page).toBe(37);
      expect(pages[36].text).toContain("NEEDLE_ON_37");
      expect(pages[35].text).not.toContain("NEEDLE_ON_37");
      expect(pages[11].text).toContain("Page 12 of 60");
    });
  });

  it("gives the same pages whatever the window size", async () => {
    const a = await drain(extractPages(pdf, ".pdf", { pageWindow: 7 }));
    const b = await drain(extractPages(pdf, ".pdf", { pageWindow: 1000 }));
    expect(a.map((p) => p.page)).toEqual(b.map((p) => p.page));
    expect(a[36].text).toContain("NEEDLE_ON_37");
    expect(b[36].text).toContain("NEEDLE_ON_37");
  });

  it("reports metadata", async () => {
    expect((await readMetadata(pdf, ".pdf")).pages).toBe(60);
  });
});

describe("plain text extraction", () => {
  it("yields the file as one page", async () => {
    const md = join(dir, "notes.md");
    writeFileSync(md, "# Heading\n\nbody text\n");
    const pages = await drain(extractPages(md, ".md", { pageWindow: 25 }));
    expect(pages).toHaveLength(1);
    expect(pages[0]).toMatchObject({ page: 1 });
    expect(pages[0].text).toContain("body text");
  });
});

describe("dispatch", () => {
  it("refuses an extension it does not handle", async () => {
    await expect(drain(extractPages("/tmp/x.mp4", ".mp4", { pageWindow: 25 })))
      .rejects.toThrow(/unsupported extension/);
  });
});
```

A DOCX case is added in Step 6 below, once a fixture exists.

- [ ] **Step 2: Run to verify it fails**

Run: `npm --prefix plugins/azure-file-processing test -- extract`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/worker/extract/pdf.ts`**

```ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { PageText } from "../chunk.js";

const run = promisify(execFile);

/** poppler prints "Pages:  412". Reading the trailer only — it does not load
 *  the document. */
export const pdfPageCount = async (path: string): Promise<number> => {
  const { stdout } = await run("pdfinfo", [path], { maxBuffer: 1 << 20 });
  const m = stdout.match(/^Pages:\s+(\d+)$/m);
  if (!m) throw new Error("pdfinfo did not report a page count; is the file a PDF?");
  return Number(m[1]);
};

export const pdfMetadata = async (path: string) => {
  const { stdout } = await run("pdfinfo", [path], { maxBuffer: 1 << 20 });
  const field = (name: string) => stdout.match(new RegExp(`^${name}:\\s+(.*)$`, "m"))?.[1]?.trim() || null;
  return {
    pages: Number(stdout.match(/^Pages:\s+(\d+)$/m)?.[1] ?? 0),
    title: field("Title"),
    producer: field("Producer"),
  };
};

/** One page at a time, in windows. Only a window's worth of text is ever
 *  resident, so peak memory is independent of the document's size. pdftotext
 *  separates pages with a form feed (\f). */
export async function* extractPdf(
  path: string, opts: { pageWindow: number },
): AsyncGenerator<PageText> {
  const total = await pdfPageCount(path);
  const window = Math.max(1, opts.pageWindow);

  for (let first = 1; first <= total; first += window) {
    const last = Math.min(first + window - 1, total);
    const { stdout } = await run(
      "pdftotext", ["-f", String(first), "-l", String(last), "-layout", path, "-"],
      { maxBuffer: 256 * 1024 * 1024, encoding: "utf8" },
    );
    // A window of N pages yields N form-feed-separated sections. pdftotext
    // appends a trailing \f, so the final empty section is dropped rather than
    // becoming a phantom page.
    const sections = stdout.split("\f");
    if (sections.length > 1 && sections[sections.length - 1] === "") sections.pop();
    for (let i = 0; i < last - first + 1; i++) {
      yield { page: first + i, text: sections[i] ?? "" };
    }
  }
}
```

- [ ] **Step 4: Write `src/worker/extract/text.ts` and `extract/docx.ts`**

`text.ts`:

```ts
import { createReadStream } from "node:fs";
import type { PageText } from "../chunk.js";

/** Plain text has no pages. It is emitted in fixed slices so the chunker still
 *  receives it incrementally rather than as one enormous string, and every
 *  slice reports page 1. */
export async function* extractText(path: string): AsyncGenerator<PageText> {
  const stream = createReadStream(path, { encoding: "utf8", highWaterMark: 1 << 20 });
  for await (const slice of stream) yield { page: 1, text: slice as string };
}
```

`docx.ts`:

```ts
import yauzl from "yauzl";
import sax from "sax";
import type { PageText } from "../chunk.js";

/** DOCX genuinely streams: it is a zip, so word/document.xml is unzipped and
 *  SAX-parsed without materialising the document. Word has no page concept in
 *  the XML — pagination is a rendering decision — so every slice is page 1. */
export async function* extractDocx(path: string): AsyncGenerator<PageText> {
  const queue: string[] = [];
  let done = false;
  let failure: Error | null = null;

  const start = new Promise<void>((resolve, reject) => {
    yauzl.open(path, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return reject(err ?? new Error("not a zip archive"));
      zip.on("entry", (entry) => {
        if (entry.fileName !== "word/document.xml") return zip.readEntry();
        zip.openReadStream(entry, (e2, rs) => {
          if (e2 || !rs) return reject(e2 ?? new Error("could not read word/document.xml"));
          const parser = sax.createStream(true, {});
          let inText = false;
          parser.on("opentag", (t) => { if (t.name === "w:t") inText = true; });
          parser.on("closetag", (name) => {
            if (name === "w:t") inText = false;
            if (name === "w:p") queue.push("\n\n");
          });
          parser.on("text", (t) => { if (inText) queue.push(t); });
          parser.on("error", (e) => { failure = e as Error; });
          parser.on("end", () => { done = true; resolve(); });
          rs.pipe(parser);
        });
      });
      zip.on("end", () => { if (!done) { done = true; resolve(); } });
      zip.on("error", reject);
      zip.readEntry();
    });
  });

  // Drain as the parser produces, so a large document does not accumulate.
  while (!done || queue.length) {
    if (failure) throw failure;
    if (!queue.length) { await Promise.race([start, new Promise((r) => setTimeout(r, 5))]); continue; }
    const text = queue.splice(0, queue.length).join("");
    if (text) yield { page: 1, text };
  }
  await start;
  if (failure) throw failure;
}
```

- [ ] **Step 5: Write `src/worker/extract/index.ts`**

```ts
import { stat } from "node:fs/promises";
import type { PageText } from "../chunk.js";
import { extractPdf, pdfMetadata, pdfPageCount } from "./pdf.js";
import { extractDocx } from "./docx.js";
import { extractText } from "./text.js";

export { pdfPageCount };

export interface DocMetadata { pages: number; title: string | null; producer: string | null }

export function extractPages(
  path: string, ext: string, opts: { pageWindow: number },
): AsyncGenerator<PageText> {
  switch (ext.toLowerCase()) {
    case ".pdf":  return extractPdf(path, opts);
    case ".docx": return extractDocx(path);
    case ".txt":
    case ".md":   return extractText(path);
    default:
      return (async function* () {
        throw new Error(`unsupported extension ${ext}`);
      })();
  }
}

export const readMetadata = async (path: string, ext: string): Promise<DocMetadata> => {
  if (ext.toLowerCase() === ".pdf") return pdfMetadata(path);
  await stat(path);
  return { pages: 1, title: null, producer: null };
};
```

- [ ] **Step 6: Add the DOCX case**

Generate a minimal DOCX in the test's `beforeAll` — a zip with the two entries Word requires — then assert extraction. Append to `test/extract.test.ts`:

```ts
import { execFileSync as sh } from "node:child_process";
import { mkdirSync, writeFileSync as wf } from "node:fs";

describe("DOCX extraction", () => {
  it("reads paragraph text out of word/document.xml", async () => {
    const src = join(dir, "docx-src");
    mkdirSync(join(src, "word"), { recursive: true });
    wf(join(src, "[Content_Types].xml"),
      '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="xml" ContentType="application/xml"/></Types>');
    wf(join(src, "word", "document.xml"),
      '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      "<w:body><w:p><w:r><w:t>First paragraph.</w:t></w:r></w:p>" +
      "<w:p><w:r><w:t>DOCX_NEEDLE here.</w:t></w:r></w:p></w:body></w:document>");
    const docx = join(dir, "doc.docx");
    sh("zip", ["-r", "-q", docx, "[Content_Types].xml", "word"], { cwd: src });

    const pages = await drain(extractPages(docx, ".docx", { pageWindow: 25 }));
    const all = pages.map((p) => p.text).join("");
    expect(all).toContain("First paragraph.");
    expect(all).toContain("DOCX_NEEDLE here.");
    expect(pages.every((p) => p.page === 1)).toBe(true);
  });
});
```

- [ ] **Step 7: Run the tests**

Run: `npm --prefix plugins/azure-file-processing test -- extract`
Expected: PASS. The window-boundary case is the one that catches an off-by-one in the form-feed split, which would silently shift every citation by a page.

- [ ] **Step 8: Stage**

```bash
git add plugins/azure-file-processing/src/worker/extract/ \
        plugins/azure-file-processing/test/extract.test.ts
# Repo owner commits. Proposed message:
#   feat(afp): page-windowed PDF, streaming DOCX and text extractors
```

---

## Task 12: Download to temp disk, hashing as it goes

**Files:**
- Create: `plugins/azure-file-processing/src/worker/download.ts`
- Test: `plugins/azure-file-processing/test/download.int.test.ts`

**Interfaces:**
- Consumes: `Storage`, `Config`, `UPLOADS_CONTAINER`.
- Produces: `downloadToTemp(s: Storage, cfg: Config, blobPath: string, opts?: { expectSha256?: string | null }): Promise<{ path: string; bytes: number; sha256: string }>` — throws `checksum_mismatch` and removes the temp file when the digest disagrees.

This is where spec §6.2's deferred integrity check lands: the worker is already holding every byte, so hashing costs nothing extra.

- [ ] **Step 1: Write the failing test**

`test/download.int.test.ts`:

```ts
import { describe, it, expect, beforeAll } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { loadConfig } from "../src/shared/config.js";
import { getStorage, ensureStorage } from "../src/shared/storage.js";
import { createUploadUrl } from "../src/orchestrator/tools/create-upload-url.js";
import { downloadToTemp } from "../src/worker/download.js";

const cfg = loadConfig();
const storage = getStorage(cfg);
const ctx = { cfg, storage };
beforeAll(async () => { await ensureStorage(storage); });

const put = async (body: string) => {
  const out = await createUploadUrl(ctx, { filename: "d.md", sizeBytes: Buffer.byteLength(body) });
  await fetch(out.uploadUrl, { method: "PUT", headers: { "x-ms-blob-type": "BlockBlob" }, body });
  return out;
};

describe("downloadToTemp", () => {
  it("writes the blob to disk and reports its digest", async () => {
    const body = "contract text\n".repeat(500);
    const { blobPath } = await put(body);
    const got = await downloadToTemp(storage, cfg, blobPath);
    expect(got.bytes).toBe(Buffer.byteLength(body));
    expect(got.sha256).toBe(createHash("sha256").update(body).digest("hex"));
    expect(statSync(got.path).size).toBe(got.bytes);
  });

  it("accepts a digest that matches", async () => {
    const body = "matching\n";
    const { blobPath } = await put(body);
    const sha = createHash("sha256").update(body).digest("hex");
    await expect(downloadToTemp(storage, cfg, blobPath, { expectSha256: sha }))
      .resolves.toBeDefined();
  });

  it("rejects a digest that does not match, and leaves no temp file behind", async () => {
    const { blobPath } = await put("real content\n");
    let leaked: string | null = null;
    await expect(
      downloadToTemp(storage, cfg, blobPath, { expectSha256: "0".repeat(64) })
        .catch((e) => { leaked = e.tempPath ?? null; throw e; }),
    ).rejects.toThrow(/checksum_mismatch/);
    if (leaked) expect(existsSync(leaked)).toBe(false);
  });

  it("gives each download its own path, so two workers cannot collide", async () => {
    const { blobPath } = await put("shared\n");
    const [a, b] = await Promise.all([
      downloadToTemp(storage, cfg, blobPath),
      downloadToTemp(storage, cfg, blobPath),
    ]);
    expect(a.path).not.toBe(b.path);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm --prefix plugins/azure-file-processing run test:integration -- download`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/worker/download.ts`**

```ts
import { createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { basename, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { UPLOADS_CONTAINER, type Config } from "../shared/config.js";
import type { Storage } from "../shared/storage.js";

export interface Downloaded { path: string; bytes: number; sha256: string }

export const downloadToTemp = async (
  s: Storage, cfg: Config, blobPath: string,
  opts: { expectSha256?: string | null } = {},
): Promise<Downloaded> => {
  await mkdir(cfg.tempDir, { recursive: true });
  // A unique prefix: two workers may hold the same blob at the same time, and a
  // shared path would have one truncate the other's file mid-read.
  const dest = join(cfg.tempDir, `${randomUUID()}-${basename(blobPath)}`);

  const blob = s.blob.getContainerClient(UPLOADS_CONTAINER).getBlockBlobClient(blobPath);
  const dl = await blob.download();
  if (!dl.readableStreamBody) throw new Error(`blob ${blobPath} returned no body`);

  const hash = createHash("sha256");
  let bytes = 0;
  const tap = new Transform({
    transform(chunk, _enc, cb) { hash.update(chunk); bytes += chunk.length; cb(null, chunk); },
  });

  // Streamed with default 64 KiB buffers: peak memory is a buffer, not a file.
  await pipeline(dl.readableStreamBody, tap, createWriteStream(dest));

  const sha256 = hash.digest("hex");
  if (opts.expectSha256 && opts.expectSha256 !== sha256) {
    await rm(dest, { force: true });
    const err = new Error(
      `checksum_mismatch: declared ${opts.expectSha256}, downloaded ${sha256}`) as Error & { tempPath?: string };
    err.tempPath = dest;
    throw err;
  }
  return { path: dest, bytes, sha256 };
};
```

- [ ] **Step 4: Run the tests**

Run: `npm --prefix plugins/azure-file-processing run test:integration -- download`
Expected: PASS.

- [ ] **Step 5: Stage**

```bash
git add plugins/azure-file-processing/src/worker/download.ts \
        plugins/azure-file-processing/test/download.int.test.ts
# Repo owner commits. Proposed message:
#   feat(afp): streamed blob download with in-flight sha256 verification
```

---

## Task 13: The artifact writer

**Files:**
- Create: `plugins/azure-file-processing/src/worker/artifacts.ts`
- Test: `plugins/azure-file-processing/test/artifacts.int.test.ts`

**Interfaces:**
- Consumes: `chunkPages`, `Chunk`, `PageText`, `DocMetadata`, `Storage`, `Config`, `ARTIFACTS_CONTAINER`.
- Produces:
  - `interface ChunkIndexEntry { byteOffset: number; byteLength: number; page: number }`
  - `interface JobResult { pages: number; words: number; chunks: number; language: string; headings: string[]; tables: number; durationMs: number }`
  - `writeArtifacts(s, cfg, jobId, input: { pages: AsyncIterable<PageText>; meta: DocMetadata; chunkChars: number; overlapChars: number; onProgress?: (done: number) => void }): Promise<JobResult>`

`chunks.jsonl` is written to a temp file first and then uploaded with `uploadFile`, which streams from disk. Building it in memory would reintroduce exactly the whole-file load the design exists to avoid. The index is held in memory — about 80 bytes per chunk, so a 2 GB document's index is tens of megabytes, comfortably inside the 256 MB heap the acceptance test enforces.

- [ ] **Step 1: Write the failing test**

`test/artifacts.int.test.ts`:

```ts
import { describe, it, expect, beforeAll } from "vitest";
import { loadConfig, ARTIFACTS_CONTAINER } from "../src/shared/config.js";
import { getStorage, ensureStorage } from "../src/shared/storage.js";
import { writeArtifacts } from "../src/worker/artifacts.js";
import { newJobId } from "../src/shared/ids.js";
import type { PageText } from "../src/worker/chunk.js";

const cfg = loadConfig();
const storage = getStorage(cfg);
beforeAll(async () => { await ensureStorage(storage); });

const pages = async function* (): AsyncGenerator<PageText> {
  for (let p = 1; p <= 12; p++) {
    yield { page: p, text: `Page ${p} of 12\n1. Scope\nlorem ipsum dolor sit amet\n`.repeat(6) };
  }
};

const text = async (jobId: string, name: string) => {
  const c = storage.blob.getContainerClient(ARTIFACTS_CONTAINER)
    .getBlockBlobClient(`${jobId}/${name}`);
  return (await c.downloadToBuffer()).toString("utf8");
};

describe("writeArtifacts", () => {
  let jobId: string;
  let result: any;

  beforeAll(async () => {
    jobId = newJobId();
    result = await writeArtifacts(storage, cfg, jobId, {
      pages: pages(),
      meta: { pages: 12, title: "Fixture", producer: null },
      chunkChars: 300, overlapChars: 50,
    });
  });

  it("reports computed facts and nothing prose-like", () => {
    expect(result.pages).toBe(12);
    expect(result.chunks).toBeGreaterThan(1);
    expect(result.words).toBeGreaterThan(0);
    expect(result.headings).toContain("1. Scope");
    expect(typeof result.durationMs).toBe("number");
  });

  it("writes all four artifacts", async () => {
    for (const name of ["chunks.jsonl", "index.json", "metadata.json", "result.json"]) {
      const c = storage.blob.getContainerClient(ARTIFACTS_CONTAINER)
        .getBlockBlobClient(`${jobId}/${name}`);
      expect(await c.exists()).toBe(true);
    }
  });

  it("writes one JSON object per line, in document order", async () => {
    const lines = (await text(jobId, "chunks.jsonl")).trimEnd().split("\n");
    expect(lines).toHaveLength(result.chunks);
    const ids = lines.map((l) => JSON.parse(l).chunkId);
    expect(ids).toEqual([...ids].sort());
  });

  it("indexes every chunk at a byte range that decodes back to that chunk", async () => {
    // This is the contract fetch_chunks depends on: a ranged read of exactly
    // these bytes must yield exactly this chunk.
    const raw = Buffer.from(await text(jobId, "chunks.jsonl"), "utf8");
    const index = JSON.parse(await text(jobId, "index.json"));
    expect(Object.keys(index)).toHaveLength(result.chunks);
    for (const [chunkId, entry] of Object.entries<any>(index)) {
      const slice = raw.subarray(entry.byteOffset, entry.byteOffset + entry.byteLength);
      const parsed = JSON.parse(slice.toString("utf8"));
      expect(parsed.chunkId).toBe(chunkId);
      expect(parsed.page).toBe(entry.page);
    }
  });

  it("indexes correctly when the text contains multi-byte characters", async () => {
    // Byte offsets and character offsets diverge the moment a document is not
    // ASCII, and every citation would then be wrong.
    const id = newJobId();
    const r = await writeArtifacts(storage, cfg, id, {
      pages: (async function* () { yield { page: 1, text: "café — naïve résumé\n".repeat(200) }; })(),
      meta: { pages: 1, title: null, producer: null },
      chunkChars: 200, overlapChars: 0,
    });
    const raw = Buffer.from(await text(id, "chunks.jsonl"), "utf8");
    const index = JSON.parse(await text(id, "index.json"));
    const [firstId, first] = Object.entries<any>(index)[0];
    const parsed = JSON.parse(raw.subarray(first.byteOffset, first.byteOffset + first.byteLength).toString("utf8"));
    expect(parsed.chunkId).toBe(firstId);
    expect(r.chunks).toBeGreaterThan(1);
  });

  it("reports progress as pages are consumed", async () => {
    const seen: number[] = [];
    await writeArtifacts(storage, cfg, newJobId(), {
      pages: pages(), meta: { pages: 12, title: null, producer: null },
      chunkChars: 300, overlapChars: 50,
      onProgress: (done) => seen.push(done),
    });
    expect(seen[seen.length - 1]).toBe(12);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm --prefix plugins/azure-file-processing run test:integration -- artifacts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/worker/artifacts.ts`**

```ts
import { createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { once } from "node:events";
import { ARTIFACTS_CONTAINER, type Config } from "../shared/config.js";
import type { Storage } from "../shared/storage.js";
import { chunkPages, type PageText } from "./chunk.js";
import type { DocMetadata } from "./extract/index.js";

export interface ChunkIndexEntry { byteOffset: number; byteLength: number; page: number }

export interface JobResult {
  pages: number; words: number; chunks: number;
  language: string; headings: string[]; tables: number; durationMs: number;
}

const HEADING = /^(?:#{1,6}\s+\S|\d+(?:\.\d+)*[.)]?\s+[A-Z])/;
const MAX_HEADINGS = 50;
const EN_STOPWORDS = new Set(["the", "of", "and", "to", "in", "is", "that", "for", "it", "as"]);

export const writeArtifacts = async (
  s: Storage, cfg: Config, jobId: string,
  input: {
    pages: AsyncIterable<PageText>;
    meta: DocMetadata;
    chunkChars: number;
    overlapChars: number;
    onProgress?: (pagesDone: number) => void;
  },
): Promise<JobResult> => {
  const startedAt = Date.now();
  await mkdir(cfg.tempDir, { recursive: true });
  const scratch = join(cfg.tempDir, `${randomUUID()}-chunks.jsonl`);

  const index: Record<string, ChunkIndexEntry> = {};
  const headings: string[] = [];
  let byteOffset = 0, words = 0, chunks = 0, tables = 0, stopwordHits = 0, pagesSeen = 0;

  // Facts are gathered on the way past, so nothing is buffered beyond the one
  // page the extractor just produced.
  const counted = async function* (): AsyncGenerator<PageText> {
    for await (const p of input.pages) {
      pagesSeen = Math.max(pagesSeen, p.page);
      for (const line of p.text.split("\n")) {
        const t = line.trim();
        if (t && headings.length < MAX_HEADINGS && t.length < 80 && HEADING.test(t)) headings.push(t);
        // "tables" is a heuristic: a line with three or more columnar gaps,
        // which pdftotext -layout preserves. Nothing short of rendering the
        // page identifies a table properly, and this is a computed fact, not a
        // claim about the document.
        if ((line.match(/ {2,}/g) ?? []).length >= 3) tables++;
      }
      for (const w of p.text.split(/\s+/)) {
        if (!w) continue;
        words++;
        if (EN_STOPWORDS.has(w.toLowerCase())) stopwordHits++;
      }
      input.onProgress?.(pagesSeen);
      yield p;
    }
  };

  const out = createWriteStream(scratch);
  for await (const chunk of chunkPages(counted(), {
    chunkChars: input.chunkChars, overlapChars: input.overlapChars,
  })) {
    const line = JSON.stringify(chunk) + "\n";
    // Byte length, not string length. The index is consumed as a BYTE range by
    // fetch_chunks, and the two diverge the moment a document is not ASCII —
    // which would silently corrupt every citation.
    const byteLength = Buffer.byteLength(line, "utf8");
    index[chunk.chunkId] = { byteOffset, byteLength, page: chunk.page };
    byteOffset += byteLength;
    chunks++;
    if (!out.write(line)) await once(out, "drain");
  }
  out.end();
  await once(out, "finish");

  const container = s.blob.getContainerClient(ARTIFACTS_CONTAINER);
  const put = (name: string, body: string) =>
    container.getBlockBlobClient(`${jobId}/${name}`)
      .upload(body, Buffer.byteLength(body), {
        blobHTTPHeaders: { blobContentType: "application/json" },
      });

  const result: JobResult = {
    pages: Math.max(input.meta.pages, pagesSeen),
    words, chunks,
    language: words > 0 && stopwordHits / words > 0.02 ? "en" : "unknown",
    headings, tables,
    durationMs: Date.now() - startedAt,
  };

  // uploadFile streams from disk, so chunks.jsonl is never held in memory —
  // building it as a string would reintroduce the whole-file load this design
  // exists to avoid.
  await container.getBlockBlobClient(`${jobId}/chunks.jsonl`).uploadFile(scratch, {
    blobHTTPHeaders: { blobContentType: "application/x-ndjson" },
  });
  await put("index.json", JSON.stringify(index));
  await put("metadata.json", JSON.stringify(input.meta));
  await put("result.json", JSON.stringify(result));
  await rm(scratch, { force: true });

  return result;
};
```

- [ ] **Step 4: Run the tests**

Run:
```bash
npm --prefix plugins/azure-file-processing test -- chunk
npm --prefix plugins/azure-file-processing run test:integration -- artifacts
```
Expected: both PASS. The multi-byte case is the one that catches a `line.length` where `Buffer.byteLength` was needed — a bug that silently corrupts every citation in a non-ASCII document.

- [ ] **Step 5: Stage**

```bash
git add plugins/azure-file-processing/src/worker/artifacts.ts \
        plugins/azure-file-processing/test/artifacts.int.test.ts
# Repo owner commits. Proposed message:
#   feat(afp): artifact writer with byte-accurate chunk index
```

---

## Task 14: The worker loop — consume, heartbeat, process, dead-letter

**Files:**
- Create: `plugins/azure-file-processing/src/worker/index.ts`
- Test: `plugins/azure-file-processing/test/worker.int.test.ts`

**Interfaces:**
- Consumes: `downloadToTemp`, `writeArtifacts`, `extractPages`, `readMetadata`, `getJob`, `updateJob`, `JOB_QUEUE`, `POISON_QUEUE`.
- Produces:
  - `runOnce(ctx: { cfg: Config; storage: Storage }): Promise<"idle" | "processed" | "failed" | "dead-lettered">` — one turn of the loop, exported so tests drive it without an infinite process
  - `WORKER_ID: string`

The loop is exported as a single turn deliberately: an infinite `while (true)` is untestable, and every reliability property below needs to be asserted rather than assumed.

- [ ] **Step 1: Write the failing test**

`test/worker.int.test.ts`:

```ts
import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, JOB_QUEUE, POISON_QUEUE, ARTIFACTS_CONTAINER } from "../src/shared/config.js";
import { getStorage, ensureStorage } from "../src/shared/storage.js";
import { getJob } from "../src/shared/jobs.js";
import { createUploadUrl } from "../src/orchestrator/tools/create-upload-url.js";
import { startJob } from "../src/orchestrator/tools/start-job.js";
import { runOnce } from "../src/worker/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const cfg = loadConfig();
const storage = getStorage(cfg);
const ctx = { cfg, storage };
const dir = mkdtempSync(join(tmpdir(), "afp-wk-"));

beforeAll(async () => { await ensureStorage(storage); });

const drainQueue = async (name: string) => {
  const q = storage.queue(name);
  for (;;) {
    const r = await q.receiveMessages({ numberOfMessages: 32 });
    if (!r.receivedMessageItems.length) return;
    for (const m of r.receivedMessageItems) await q.deleteMessage(m.messageId, m.popReceipt);
  }
};

const submit = async (filename: string, bytes: Buffer) => {
  const out = await createUploadUrl(ctx, { filename, sizeBytes: bytes.length });
  await fetch(out.uploadUrl, { method: "PUT", headers: { "x-ms-blob-type": "BlockBlob" }, body: bytes });
  await startJob(ctx, { jobId: out.jobId });
  return out.jobId;
};

describe("runOnce", () => {
  beforeAll(async () => { await drainQueue(JOB_QUEUE); await drainQueue(POISON_QUEUE); });

  it("reports idle on an empty queue", async () => {
    expect(await runOnce(ctx)).toBe("idle");
  });

  it("processes a PDF end to end and records the worker that did it", async () => {
    const pdf = join(dir, "doc.pdf");
    execFileSync("node", [resolve(here, "../scripts/make-fixture-pdf.mjs"), pdf, "30",
      "--needle", "WORKER_NEEDLE", "--needle-page", "22"]);
    const jobId = await submit("doc.pdf", readFileSync(pdf));

    expect(await runOnce(ctx)).toBe("processed");

    const job = await getJob(storage, jobId);
    expect(job?.state).toBe("succeeded");
    expect(job?.phase).toBe("done");
    expect(job?.progressDone).toBe(30);
    expect(job?.workerId).toBeTruthy();
    expect(job?.finishedAt).toBeTruthy();

    const c = storage.blob.getContainerClient(ARTIFACTS_CONTAINER);
    const result = JSON.parse(
      (await c.getBlockBlobClient(`${jobId}/result.json`).downloadToBuffer()).toString("utf8"));
    expect(result.pages).toBe(30);
    expect(result.chunks).toBeGreaterThan(0);

    const lines = (await c.getBlockBlobClient(`${jobId}/chunks.jsonl`).downloadToBuffer())
      .toString("utf8").trimEnd().split("\n").map((l) => JSON.parse(l));
    const hit = lines.find((l) => l.text.includes("WORKER_NEEDLE"));
    expect(hit?.page).toBe(22);
  });

  it("removes the message once the job succeeds", async () => {
    const props = await storage.queue(JOB_QUEUE).getProperties();
    expect(props.approximateMessagesCount ?? 0).toBe(0);
  });

  it("leaves a failed job's message for another attempt rather than losing it", async () => {
    const jobId = await submit("broken.pdf", Buffer.from("%PDF-1.4 this is not a pdf\n"));
    expect(await runOnce(ctx)).toBe("failed");
    const job = await getJob(storage, jobId);
    expect(job?.state).toBe("queued");   // still queued: it will be retried
    expect(job?.attempts).toBe(1);
    expect(job?.error).toBeTruthy();
  });

  it("dead-letters after the attempt ceiling and marks the job failed", async () => {
    // maxDequeueCount is 3, so attempts 1-3 process and the 4th receive dead-letters.
    let last = "";
    for (let i = 0; i < 5; i++) {
      last = await runOnce({ ...ctx, cfg: { ...cfg, tempDir: cfg.tempDir } });
      if (last === "dead-lettered") break;
    }
    expect(last).toBe("dead-lettered");
    const poison = await storage.queue(POISON_QUEUE).peekMessages({ numberOfMessages: 8 });
    expect(poison.peekedMessageItems.length).toBeGreaterThan(0);
  });

  it("verifies the declared digest and fails the job when it disagrees", async () => {
    const body = Buffer.from("# real content\n");
    const out = await createUploadUrl(ctx, {
      filename: "hashed.md", sizeBytes: body.length, sha256: "0".repeat(64) });
    await fetch(out.uploadUrl, { method: "PUT", headers: { "x-ms-blob-type": "BlockBlob" }, body });
    await startJob(ctx, { jobId: out.jobId });
    expect(await runOnce(ctx)).toBe("failed");
    expect((await getJob(storage, out.jobId))?.error).toMatch(/checksum_mismatch/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm --prefix plugins/azure-file-processing run test:integration -- worker`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/worker/index.ts`**

```ts
import { rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { extname } from "node:path";
import {
  loadConfig, JOB_QUEUE, POISON_QUEUE, type Config,
} from "../shared/config.js";
import { getStorage, ensureStorage, type Storage } from "../shared/storage.js";
import { getJob, updateJob } from "../shared/jobs.js";
import { log } from "../shared/logger.js";
import { downloadToTemp } from "./download.js";
import { writeArtifacts } from "./artifacts.js";
import { extractPages, readMetadata } from "./extract/index.js";

export const WORKER_ID = `w-${randomUUID().slice(0, 8)}`;

const VISIBILITY_SECONDS = 300;   // longer than any single page window
const HEARTBEAT_MS = 120_000;     // renewed well inside the visibility window
const PROGRESS_EVERY_MS = 2_000;

interface Ctx { cfg: Config; storage: Storage }
export type Turn = "idle" | "processed" | "failed" | "dead-lettered";

const process1 = async (ctx: Ctx, jobId: string, attempt: number): Promise<void> => {
  const job = await getJob(ctx.storage, jobId);
  if (!job) throw new Error(`unknown job ${jobId}`);

  await updateJob(ctx.storage, jobId, {
    state: "running", phase: "downloading", workerId: WORKER_ID,
    attempts: attempt, startedAt: new Date().toISOString(), error: null,
  });

  const downloaded = await downloadToTemp(ctx.storage, ctx.cfg, job.blobPath, {
    expectSha256: job.sha256,
  });

  try {
    const ext = extname(job.filename).toLowerCase();
    const params = JSON.parse(job.params || "{}") as Record<string, number>;
    const chunkChars = params.chunkChars ?? ctx.cfg.chunkChars;
    const overlapChars = params.overlapChars ?? ctx.cfg.overlapChars;
    const pageWindow = params.pageWindow ?? ctx.cfg.pageWindow;

    await updateJob(ctx.storage, jobId, { phase: "extracting" });
    const meta = await readMetadata(downloaded.path, ext);
    await updateJob(ctx.storage, jobId, { progressTotal: meta.pages, phase: "chunking" });

    // Progress is throttled: a page-per-write would put thousands of round
    // trips on the job table for a large document and tell a reader nothing
    // more than one every couple of seconds does.
    let lastWrite = 0;
    const result = await writeArtifacts(ctx.storage, ctx.cfg, jobId, {
      pages: extractPages(downloaded.path, ext, { pageWindow }),
      meta, chunkChars, overlapChars,
      onProgress: (done) => {
        const now = Date.now();
        if (now - lastWrite < PROGRESS_EVERY_MS) return;
        lastWrite = now;
        void updateJob(ctx.storage, jobId, { progressDone: done }).catch(() => {});
      },
    });

    await updateJob(ctx.storage, jobId, {
      state: "succeeded", phase: "done",
      progressDone: result.pages, progressTotal: result.pages,
      finishedAt: new Date().toISOString(),
    });
    log.info("job.succeeded", {
      jobId, workerId: WORKER_ID, pages: result.pages,
      chunks: result.chunks, durationMs: result.durationMs,
    });
  } finally {
    await rm(downloaded.path, { force: true });
  }
};

export const runOnce = async (ctx: Ctx): Promise<Turn> => {
  const queue = ctx.storage.queue(JOB_QUEUE);
  const received = await queue.receiveMessages({
    numberOfMessages: 1, visibilityTimeout: VISIBILITY_SECONDS,
  });
  const msg = received.receivedMessageItems[0];
  if (!msg) return "idle";

  let jobId = "";
  try {
    jobId = JSON.parse(msg.messageText).jobId;
  } catch {
    // Unparseable message: nothing will ever make it valid, so retiring it is
    // the only outcome that does not wedge the queue forever.
    await ctx.storage.queue(POISON_QUEUE).sendMessage(msg.messageText);
    await queue.deleteMessage(msg.messageId, msg.popReceipt);
    log.error("queue.unreadable_message", { messageId: msg.messageId });
    return "dead-lettered";
  }

  if (msg.dequeueCount > ctx.cfg.maxDequeueCount) {
    await ctx.storage.queue(POISON_QUEUE).sendMessage(msg.messageText);
    await queue.deleteMessage(msg.messageId, msg.popReceipt);
    await updateJob(ctx.storage, jobId, {
      state: "failed", phase: null, finishedAt: new Date().toISOString(),
      error: `dead-lettered after ${msg.dequeueCount - 1} attempts`,
    });
    log.error("job.dead_lettered", { jobId, attempts: msg.dequeueCount - 1 });
    return "dead-lettered";
  }

  // Keep the message invisible while work is in flight. A crashed worker simply
  // stops renewing, and the message reappears for someone else — which is the
  // whole reason the queue owns retry rather than a hand-rolled lease.
  let popReceipt = msg.popReceipt;
  const heartbeat = setInterval(() => {
    void queue.updateMessage(msg.messageId, popReceipt, undefined, VISIBILITY_SECONDS)
      .then((r) => { if (r.popReceipt) popReceipt = r.popReceipt; })
      .catch((e) => log.warn("queue.heartbeat_failed", { jobId, message: String(e.message).slice(0, 200) }));
  }, HEARTBEAT_MS);

  try {
    await process1(ctx, jobId, msg.dequeueCount);
    clearInterval(heartbeat);
    await queue.deleteMessage(msg.messageId, popReceipt);
    return "processed";
  } catch (e) {
    clearInterval(heartbeat);
    // The message is NOT deleted: it becomes visible again when the visibility
    // timeout lapses, and dequeueCount decides when to give up.
    const message = String((e as Error).message).slice(0, 400);
    await updateJob(ctx.storage, jobId, {
      state: "queued", phase: null, attempts: msg.dequeueCount, error: message,
    }).catch(() => {});
    log.error("job.attempt_failed", { jobId, attempt: msg.dequeueCount, message });
    return "failed";
  }
};

// Entry point when run as a service.
if (import.meta.url === `file://${process.argv[1]}`) {
  const cfg = loadConfig();
  const storage = getStorage(cfg);
  await ensureStorage(storage);
  log.info("worker.started", { workerId: WORKER_ID });
  for (;;) {
    const turn = await runOnce({ cfg, storage });
    if (turn === "idle") await new Promise((r) => setTimeout(r, 1_000));
  }
}
```

- [ ] **Step 4: Make the failed-attempt test deterministic**

A failed attempt leaves the message invisible for `VISIBILITY_SECONDS`, so the dead-letter test would otherwise wait five minutes. Add to the test file, before the dead-letter case, a helper that makes the message visible immediately:

```ts
const makeVisible = async () => {
  const q = storage.queue(JOB_QUEUE);
  const r = await q.receiveMessages({ numberOfMessages: 1, visibilityTimeout: 1 });
  const m = r.receivedMessageItems[0];
  if (m) await q.updateMessage(m.messageId, m.popReceipt, undefined, 0);
};
```

and call `await makeVisible()` between iterations of the dead-letter loop.

- [ ] **Step 5: Run the tests**

Run:
```bash
cd plugins/azure-file-processing && ./scripts/stack.sh workers 0
npm run test:integration -- worker
```
Expected: PASS. Stopping the Compose workers first is not optional here — this suite drives one turn at a time in-process, and a live worker would take the message first. The needle-on-page-22 assertion is the end-to-end proof that page mapping survives download, window extraction, chunking and the index.

- [ ] **Step 6: Confirm the pool is a pool**

Run:
```bash
cd plugins/azure-file-processing && ./scripts/stack.sh up
docker compose ps          # two worker replicas
docker compose logs worker | grep worker.started   # two distinct workerIds
```
Expected: two `worker.started` lines with different `workerId` values.

- [ ] **Step 7: Stage**

```bash
git add plugins/azure-file-processing/src/worker/index.ts \
        plugins/azure-file-processing/test/worker.int.test.ts
# Repo owner commits. Proposed message:
#   feat(afp): worker loop with visibility heartbeat, retry and dead-lettering
```

---

## Task 15: `job_status` and `get_result`

**Files:**
- Create: `plugins/azure-file-processing/src/orchestrator/artifacts.ts`, `src/orchestrator/tools/job-status.ts`, `src/orchestrator/tools/get-result.ts`
- Modify: `plugins/azure-file-processing/src/orchestrator/mcp.ts`
- Test: `plugins/azure-file-processing/test/results.int.test.ts`

**Interfaces:**
- Consumes: `getJob`, `ARTIFACTS_CONTAINER`, `Ctx`, `jsonResult`, `JobResult`, `ChunkIndexEntry`.
- Produces:
  - `readArtifactJson<T>(s: Storage, jobId: string, name: string): Promise<T>`
  - `readArtifactRange(s: Storage, jobId: string, name: string, offset: number, count: number): Promise<string>`
  - `jobStatus(ctx, { jobId }): Promise<{ jobId; state; phase; progress: { done; total; unit }; attempts; createdAt; startedAt; finishedAt; error }>`
  - `getResult(ctx, { jobId }): Promise<{ jobId; result: JobResult; artifacts: Array<{ type; blobPath; contentType }> }>`

- [ ] **Step 1: Write the failing test**

`test/results.int.test.ts`:

```ts
import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/shared/config.js";
import { getStorage, ensureStorage } from "../src/shared/storage.js";
import { createUploadUrl } from "../src/orchestrator/tools/create-upload-url.js";
import { startJob } from "../src/orchestrator/tools/start-job.js";
import { jobStatus } from "../src/orchestrator/tools/job-status.js";
import { getResult } from "../src/orchestrator/tools/get-result.js";
import { runOnce } from "../src/worker/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const cfg = loadConfig();
const storage = getStorage(cfg);
const ctx = { cfg, storage };
const dir = mkdtempSync(join(tmpdir(), "afp-res-"));
let jobId = "";

beforeAll(async () => {
  await ensureStorage(storage);
  const pdf = join(dir, "r.pdf");
  execFileSync("node", [resolve(here, "../scripts/make-fixture-pdf.mjs"), pdf, "45",
    "--needle", "RESULT_NEEDLE", "--needle-page", "31"]);
  const bytes = readFileSync(pdf);
  const out = await createUploadUrl(ctx, { filename: "r.pdf", sizeBytes: bytes.length });
  await fetch(out.uploadUrl, { method: "PUT", headers: { "x-ms-blob-type": "BlockBlob" }, body: bytes });
  await startJob(ctx, { jobId: out.jobId });
  jobId = out.jobId;
  expect(await runOnce(ctx)).toBe("processed");
});

describe("jobStatus", () => {
  it("reports a finished job with its progress", async () => {
    const s = await jobStatus(ctx, { jobId });
    expect(s.state).toBe("succeeded");
    expect(s.phase).toBe("done");
    expect(s.progress).toEqual({ done: 45, total: 45, unit: "pages" });
    expect(s.error).toBeNull();
  });

  it("does not leak the worker id, which is an operational detail", async () => {
    expect(Object.keys(await jobStatus(ctx, { jobId }))).not.toContain("workerId");
  });

  it("refuses an unknown job", async () => {
    await expect(jobStatus(ctx, { jobId: "j-000000000-ffffffffffff" }))
      .rejects.toThrow(/unknown job/);
  });
});

describe("getResult", () => {
  it("returns computed facts and artifact paths", async () => {
    const r = await getResult(ctx, { jobId });
    expect(r.result.pages).toBe(45);
    expect(r.result.chunks).toBeGreaterThan(0);
    expect(r.artifacts.map((a) => a.type).sort())
      .toEqual(["chunks", "index", "metadata", "result"]);
  });

  it("stays under 8 KB — the response is a summary, never a payload", async () => {
    const bytes = Buffer.byteLength(JSON.stringify(await getResult(ctx, { jobId })), "utf8");
    expect(bytes).toBeLessThan(8192);
  });

  it("returns no document text at all", async () => {
    const body = JSON.stringify(await getResult(ctx, { jobId }));
    expect(body).not.toContain("RESULT_NEEDLE");
    expect(body).not.toContain("lorem ipsum");
  });

  it("refuses a job that has not succeeded", async () => {
    const out = await createUploadUrl(ctx, { filename: "pending.md", sizeBytes: 5 });
    await expect(getResult(ctx, { jobId: out.jobId })).rejects.toThrow(/not ready/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm --prefix plugins/azure-file-processing run test:integration -- results`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/orchestrator/artifacts.ts`**

```ts
import { ARTIFACTS_CONTAINER } from "../shared/config.js";
import type { Storage } from "../shared/storage.js";

const blob = (s: Storage, jobId: string, name: string) =>
  s.blob.getContainerClient(ARTIFACTS_CONTAINER).getBlockBlobClient(`${jobId}/${name}`);

export const readArtifactJson = async <T>(
  s: Storage, jobId: string, name: string,
): Promise<T> => {
  try {
    return JSON.parse((await blob(s, jobId, name).downloadToBuffer()).toString("utf8")) as T;
  } catch (e: any) {
    if (e?.statusCode === 404) throw new Error(`artifact ${name} not found for job ${jobId}`);
    throw e;
  }
};

/** A RANGED read: only the requested bytes leave storage. This is what keeps
 *  fetch_chunks constant-cost against a 100 MB chunk file. */
export const readArtifactRange = async (
  s: Storage, jobId: string, name: string, offset: number, count: number,
): Promise<string> =>
  (await blob(s, jobId, name).downloadToBuffer(offset, count)).toString("utf8");

export const artifactStream = async (s: Storage, jobId: string, name: string) => {
  const dl = await blob(s, jobId, name).download();
  if (!dl.readableStreamBody) throw new Error(`artifact ${name} returned no body`);
  return dl.readableStreamBody;
};
```

- [ ] **Step 4: Write `src/orchestrator/tools/job-status.ts`**

```ts
import { getJob } from "../../shared/jobs.js";
import type { Ctx } from "../mcp.js";

export const jobStatus = async (ctx: Ctx, args: { jobId: string }) => {
  const job = await getJob(ctx.storage, args.jobId);
  if (!job) throw new Error(`unknown job ${args.jobId}`);
  // workerId is deliberately absent: it is how an operator proves two jobs ran
  // on two workers, not something a model should reason about.
  return {
    jobId: job.jobId,
    state: job.state,
    phase: job.phase,
    progress: { done: job.progressDone, total: job.progressTotal, unit: "pages" as const },
    attempts: job.attempts,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    error: job.error,
  };
};
```

- [ ] **Step 5: Write `src/orchestrator/tools/get-result.ts`**

```ts
import { getJob } from "../../shared/jobs.js";
import { readArtifactJson } from "../artifacts.js";
import type { JobResult } from "../../worker/artifacts.js";
import type { Ctx } from "../mcp.js";

const MAX_RESPONSE_BYTES = 8192;

const ARTIFACTS = [
  { type: "chunks",   name: "chunks.jsonl",  contentType: "application/x-ndjson" },
  { type: "index",    name: "index.json",    contentType: "application/json" },
  { type: "metadata", name: "metadata.json", contentType: "application/json" },
  { type: "result",   name: "result.json",   contentType: "application/json" },
] as const;

export const getResult = async (ctx: Ctx, args: { jobId: string }) => {
  const job = await getJob(ctx.storage, args.jobId);
  if (!job) throw new Error(`unknown job ${args.jobId}`);
  if (job.state !== "succeeded") {
    throw new Error(`job ${args.jobId} is not ready: state is ${job.state}`);
  }

  const result = await readArtifactJson<JobResult>(ctx.storage, args.jobId, "result.json");
  const artifacts = ARTIFACTS.map((a) => ({
    type: a.type, blobPath: `${args.jobId}/${a.name}`, contentType: a.contentType,
  }));

  // The cap is structural, not aspirational: a document with fifty long headings
  // would otherwise push the response past 8 KB, and "compact" would become a
  // claim rather than a property.
  const payload = { jobId: args.jobId, result, artifacts };
  if (Buffer.byteLength(JSON.stringify(payload), "utf8") > MAX_RESPONSE_BYTES) {
    payload.result = { ...result, headings: result.headings.slice(0, 10) };
  }
  return payload;
};
```

- [ ] **Step 6: Register both in `src/orchestrator/mcp.ts`**

```ts
import { jobStatus } from "./tools/job-status.js";
import { getResult } from "./tools/get-result.js";
```

```ts
  server.registerTool(
    "job_status",
    {
      title: "Job status",
      description: "Poll a job's state and progress. States: awaiting_upload, queued, running, succeeded, failed, deleted.",
      inputSchema: { jobId: z.string() },
    },
    async (args) => jsonResult(await jobStatus(ctx, args)),
  );

  server.registerTool(
    "get_result",
    {
      title: "Get result",
      description:
        "Computed facts about a finished document plus its artifact paths. Never returns document text — " +
        "use search_chunks and fetch_chunks to read passages.",
      inputSchema: { jobId: z.string() },
    },
    async (args) => jsonResult(await getResult(ctx, args)),
  );
```

- [ ] **Step 7: Run the tests**

Run: `npm --prefix plugins/azure-file-processing run test:integration -- results`
Expected: PASS, including the "returns no document text at all" assertion.

- [ ] **Step 8: Stage**

```bash
git add plugins/azure-file-processing/src/orchestrator/artifacts.ts \
        plugins/azure-file-processing/src/orchestrator/tools/job-status.ts \
        plugins/azure-file-processing/src/orchestrator/tools/get-result.ts \
        plugins/azure-file-processing/src/orchestrator/mcp.ts \
        plugins/azure-file-processing/test/results.int.test.ts
# Repo owner commits. Proposed message:
#   feat(afp): job_status and get_result, both size-capped
```

---

## Task 16: `fetch_chunks` — a byte-capped ranged read

**Files:**
- Create: `plugins/azure-file-processing/src/orchestrator/tools/fetch-chunks.ts`
- Modify: `plugins/azure-file-processing/src/orchestrator/mcp.ts`
- Test: `plugins/azure-file-processing/test/fetch-chunks.int.test.ts`

**Interfaces:**
- Consumes: `readArtifactJson`, `readArtifactRange`, `getJob`, `ChunkIndexEntry`.
- Produces: `fetchChunks(ctx, { jobId, chunkIds }): Promise<{ jobId; chunks: Array<{ chunkId; pageStart; pageEnd; text }>; bytes; truncated; requested; returned }>`
- **A chunk spans a page RANGE, not a page.** With the default 4000-char window against a dense page, most chunks cross a boundary, so a single `page` field is wrong for any text past the first page's content. Cite `pageStart`–`pageEnd`.

- [ ] **Step 1: Write the failing test**

`test/fetch-chunks.int.test.ts`:

```ts
import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/shared/config.js";
import { getStorage, ensureStorage } from "../src/shared/storage.js";
import { readArtifactJson } from "../src/orchestrator/artifacts.js";
import { createUploadUrl } from "../src/orchestrator/tools/create-upload-url.js";
import { startJob } from "../src/orchestrator/tools/start-job.js";
import { fetchChunks } from "../src/orchestrator/tools/fetch-chunks.js";
import { runOnce } from "../src/worker/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const cfg = loadConfig();
const storage = getStorage(cfg);
const ctx = { cfg, storage };
const dir = mkdtempSync(join(tmpdir(), "afp-fc-"));
let jobId = "";
let ids: string[] = [];

beforeAll(async () => {
  await ensureStorage(storage);
  const pdf = join(dir, "f.pdf");
  execFileSync("node", [resolve(here, "../scripts/make-fixture-pdf.mjs"), pdf, "50",
    "--needle", "FETCH_NEEDLE", "--needle-page", "41"]);
  const bytes = readFileSync(pdf);
  const out = await createUploadUrl(ctx, { filename: "f.pdf", sizeBytes: bytes.length });
  await fetch(out.uploadUrl, { method: "PUT", headers: { "x-ms-blob-type": "BlockBlob" }, body: bytes });
  await startJob(ctx, { jobId: out.jobId });
  jobId = out.jobId;
  await runOnce(ctx);
  ids = Object.keys(await readArtifactJson<Record<string, unknown>>(storage, jobId, "index.json"));
});

describe("fetchChunks", () => {
  it("returns exactly the chunks asked for, with their pages", async () => {
    const r = await fetchChunks(ctx, { jobId, chunkIds: [ids[0], ids[2]] });
    expect(r.chunks.map((c) => c.chunkId)).toEqual([ids[0], ids[2]]);
    expect(r.chunks[0].pageStart).toBeGreaterThan(0);
    expect(r.chunks[0].pageEnd).toBeGreaterThanOrEqual(r.chunks[0].pageStart);
    expect(r.truncated).toBe(false);
  });

  it("returns the text the ranged read actually points at", async () => {
    const index = await readArtifactJson<Record<string, any>>(storage, jobId, "index.json");
    // The needle is on page 41; the chunk containing it may START earlier and END
    // later, so assert the RANGE contains 41 rather than a single page equalling it.
    const needleId = Object.entries(index)
      .find(([, v]) => v.pageStart <= 41 && v.pageEnd >= 41)![0];
    const r = await fetchChunks(ctx, { jobId, chunkIds: [needleId] });
    expect(r.chunks[0].pageStart).toBeLessThanOrEqual(41);
    expect(r.chunks[0].pageEnd).toBeGreaterThanOrEqual(41);
    expect(r.chunks[0].text.length).toBeGreaterThan(0);
  });

  it("caps the response and SAYS it capped it", async () => {
    // Ten chunks of 4000 chars is ~40 KB, past the 32 KB ceiling.
    const r = await fetchChunks(ctx, { jobId, chunkIds: ids.slice(0, 10) });
    expect(r.bytes).toBeLessThanOrEqual(cfg.fetchMaxBytes);
    if (r.returned < r.requested) expect(r.truncated).toBe(true);
  });

  it("refuses more than ten chunk ids", async () => {
    await expect(fetchChunks(ctx, { jobId, chunkIds: ids.slice(0, 11) }))
      .rejects.toThrow(/at most 10/);
  });

  it("refuses an unknown chunk id rather than returning silence", async () => {
    await expect(fetchChunks(ctx, { jobId, chunkIds: ["c-999999"] }))
      .rejects.toThrow(/unknown chunk/);
  });

  it("refuses a job that has not succeeded", async () => {
    const out = await createUploadUrl(ctx, { filename: "np.md", sizeBytes: 4 });
    await expect(fetchChunks(ctx, { jobId: out.jobId, chunkIds: ["c-000000"] }))
      .rejects.toThrow(/not ready/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm --prefix plugins/azure-file-processing run test:integration -- fetch-chunks`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/orchestrator/tools/fetch-chunks.ts`**

```ts
import { getJob } from "../../shared/jobs.js";
import { readArtifactJson, readArtifactRange } from "../artifacts.js";
import type { ChunkIndexEntry } from "../../worker/artifacts.js";
import type { Ctx } from "../mcp.js";

const MAX_IDS = 10;

export const fetchChunks = async (
  ctx: Ctx, args: { jobId: string; chunkIds: string[] },
) => {
  if (args.chunkIds.length > MAX_IDS) {
    throw new Error(`at most ${MAX_IDS} chunk ids per call, got ${args.chunkIds.length}`);
  }
  const job = await getJob(ctx.storage, args.jobId);
  if (!job) throw new Error(`unknown job ${args.jobId}`);
  if (job.state !== "succeeded") throw new Error(`job ${args.jobId} is not ready: state is ${job.state}`);

  const index = await readArtifactJson<Record<string, ChunkIndexEntry>>(
    ctx.storage, args.jobId, "index.json");

  const chunks: Array<{ chunkId: string; pageStart: number; pageEnd: number; text: string }> = [];
  let bytes = 0;
  let truncated = false;

  for (const chunkId of args.chunkIds) {
    const entry = index[chunkId];
    if (!entry) throw new Error(`unknown chunk ${chunkId} in job ${args.jobId}`);
    if (bytes + entry.byteLength > ctx.cfg.fetchMaxBytes) { truncated = true; break; }

    // Only these bytes leave storage — the chunk file itself is never read.
    const line = await readArtifactRange(
      ctx.storage, args.jobId, "chunks.jsonl", entry.byteOffset, entry.byteLength);
    const parsed = JSON.parse(line) as
      { chunkId: string; pageStart: number; pageEnd: number; text: string };
    chunks.push({
      chunkId: parsed.chunkId, pageStart: parsed.pageStart,
      pageEnd: parsed.pageEnd, text: parsed.text,
    });
    bytes += entry.byteLength;
  }

  return {
    jobId: args.jobId, chunks, bytes, truncated,
    requested: args.chunkIds.length, returned: chunks.length,
  };
};
```

- [ ] **Step 4: Register it in `src/orchestrator/mcp.ts`**

```ts
import { fetchChunks } from "./tools/fetch-chunks.js";
```

```ts
  server.registerTool(
    "fetch_chunks",
    {
      title: "Fetch chunks",
      description:
        "Read the full text of specific chunks, by id, from search_chunks results. " +
        "Capped at 32 KB per call; ask for the few chunks you need, never a whole document.",
      inputSchema: { jobId: z.string(), chunkIds: z.array(z.string()).min(1).max(10) },
    },
    async (args) => jsonResult(await fetchChunks(ctx, args)),
  );
```

- [ ] **Step 5: Run the tests**

Run: `npm --prefix plugins/azure-file-processing run test:integration -- fetch-chunks`
Expected: PASS.

- [ ] **Step 6: Note the known scaling limit**

`index.json` is downloaded whole on each call. For a 2 GB document that is tens of megabytes per call — server-side, so it never reaches the model, but it is real latency. Record it in the plugin `README.md` under a **Known limits** heading, with the upgrade path: a fixed-width sorted index read by ranged binary search. Do not build it now — it is not needed for correctness and no measurement yet says it matters.

- [ ] **Step 7: Stage**

```bash
git add plugins/azure-file-processing/src/orchestrator/tools/fetch-chunks.ts \
        plugins/azure-file-processing/src/orchestrator/mcp.ts \
        plugins/azure-file-processing/test/fetch-chunks.int.test.ts
# Repo owner commits. Proposed message:
#   feat(afp): fetch_chunks via ranged blob reads with a hard byte cap
```

---

## Task 17: `search_chunks` — a bounded streaming scan

**Files:**
- Create: `plugins/azure-file-processing/src/orchestrator/tools/search-chunks.ts`
- Modify: `plugins/azure-file-processing/src/orchestrator/mcp.ts`
- Test: `plugins/azure-file-processing/test/search-chunks.int.test.ts`

**Interfaces:**
- Consumes: `artifactStream`, `getJob`.
- Produces: `searchChunks(ctx, { jobId, query, topK? }): Promise<{ jobId; hits: Array<{ chunkId; pageStart; pageEnd; snippet; score }>; scannedBytes; scannedChunks; truncated }>`
- **Hits cite a page RANGE.** A chunk routinely spans a boundary, so reporting one page would be wrong for matches past the first page. A range is the honest bounded answer; resolving a specific match to a specific page needs the match offset against the page table and is deliberately out of scope here.

**One deliberate deviation from the spec.** Spec §6.5 allows stopping as soon as `topK` matches are found. That returns the *first* K matches rather than the *best* K, which biases every answer toward the front of the document. This scans to `SEARCH_MAX_SCAN_BYTES` and keeps the highest-scoring K instead. Memory is still bounded — only K hits are ever held — and the cost is bounded by the same byte ceiling.

- [ ] **Step 1: Write the failing test**

`test/search-chunks.int.test.ts`:

```ts
import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/shared/config.js";
import { getStorage, ensureStorage } from "../src/shared/storage.js";
import { createUploadUrl } from "../src/orchestrator/tools/create-upload-url.js";
import { startJob } from "../src/orchestrator/tools/start-job.js";
import { searchChunks } from "../src/orchestrator/tools/search-chunks.js";
import { fetchChunks } from "../src/orchestrator/tools/fetch-chunks.js";
import { runOnce } from "../src/worker/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const cfg = loadConfig();
const storage = getStorage(cfg);
const ctx = { cfg, storage };
const dir = mkdtempSync(join(tmpdir(), "afp-sc-"));
let jobId = "";

beforeAll(async () => {
  await ensureStorage(storage);
  const pdf = join(dir, "s.pdf");
  execFileSync("node", [resolve(here, "../scripts/make-fixture-pdf.mjs"), pdf, "80",
    "--needle", "ZANZIBAR termination clause applies", "--needle-page", "63"]);
  const bytes = readFileSync(pdf);
  const out = await createUploadUrl(ctx, { filename: "s.pdf", sizeBytes: bytes.length });
  await fetch(out.uploadUrl, { method: "PUT", headers: { "x-ms-blob-type": "BlockBlob" }, body: bytes });
  await startJob(ctx, { jobId: out.jobId });
  jobId = out.jobId;
  await runOnce(ctx);
});

describe("searchChunks", () => {
  it("finds a rare term deep in the document and cites its page", async () => {
    const r = await searchChunks(ctx, { jobId, query: "ZANZIBAR" });
    expect(r.hits.length).toBeGreaterThan(0);
    expect(r.hits[0].pageStart).toBeLessThanOrEqual(63);
    expect(r.hits[0].pageEnd).toBeGreaterThanOrEqual(63);
    expect(r.hits[0].snippet).toContain("ZANZIBAR");
  });

  it("keeps snippets short enough to be quoted, not read", async () => {
    const r = await searchChunks(ctx, { jobId, query: "termination" });
    for (const h of r.hits) expect(h.snippet.length).toBeLessThanOrEqual(300);
  });

  it("ranks by how often the terms occur, not by position", async () => {
    const r = await searchChunks(ctx, { jobId, query: "ZANZIBAR termination clause", topK: 5 });
    expect(r.hits[0].pageStart).toBeLessThanOrEqual(63);
    expect(r.hits[0].pageEnd).toBeGreaterThanOrEqual(63);
    for (let i = 1; i < r.hits.length; i++) {
      expect(r.hits[i - 1].score).toBeGreaterThanOrEqual(r.hits[i].score);
    }
  });

  it("returns no hits rather than an error for a term that is absent", async () => {
    const r = await searchChunks(ctx, { jobId, query: "quokka" });
    expect(r.hits).toEqual([]);
    expect(r.scannedChunks).toBeGreaterThan(0);
  });

  it("honours topK", async () => {
    expect((await searchChunks(ctx, { jobId, query: "lorem", topK: 3 })).hits).toHaveLength(3);
  });

  it("hands back ids that fetch_chunks accepts", async () => {
    // The two tools are only useful as a pair; this is the seam between them.
    const r = await searchChunks(ctx, { jobId, query: "ZANZIBAR" });
    const f = await fetchChunks(ctx, { jobId, chunkIds: [r.hits[0].chunkId] });
    expect(f.chunks[0].text).toContain("ZANZIBAR");
  });

  it("stops at the scan ceiling and says so", async () => {
    const r = await searchChunks(
      { ...ctx, cfg: { ...cfg, searchMaxScanBytes: 2_000 } },
      { jobId, query: "lorem" });
    expect(r.truncated).toBe(true);
    expect(r.scannedBytes).toBeLessThanOrEqual(2_000 + 8_192);
  });

  it("refuses an empty query", async () => {
    await expect(searchChunks(ctx, { jobId, query: "   " })).rejects.toThrow(/query/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm --prefix plugins/azure-file-processing run test:integration -- search-chunks`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/orchestrator/tools/search-chunks.ts`**

```ts
import { createInterface } from "node:readline";
import { getJob } from "../../shared/jobs.js";
import { artifactStream } from "../artifacts.js";
import type { Ctx } from "../mcp.js";

const MAX_TOPK = 20;
const SNIPPET_MAX = 300;
const SNIPPET_PAD = 120;

interface Hit { chunkId: string; pageStart: number; pageEnd: number; snippet: string; score: number }

const snippetAround = (text: string, at: number, termLength: number): string => {
  const start = Math.max(0, at - SNIPPET_PAD);
  const end = Math.min(text.length, at + termLength + SNIPPET_PAD);
  const raw = text.slice(start, end).replace(/\s+/g, " ").trim();
  return raw.length > SNIPPET_MAX ? raw.slice(0, SNIPPET_MAX - 1) + "…" : raw;
};

export const searchChunks = async (
  ctx: Ctx, args: { jobId: string; query: string; topK?: number },
) => {
  const terms = args.query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) throw new Error("query must contain at least one term");
  const topK = Math.min(Math.max(1, args.topK ?? 5), MAX_TOPK);

  const job = await getJob(ctx.storage, args.jobId);
  if (!job) throw new Error(`unknown job ${args.jobId}`);
  if (job.state !== "succeeded") throw new Error(`job ${args.jobId} is not ready: state is ${job.state}`);

  const stream = await artifactStream(ctx.storage, args.jobId, "chunks.jsonl");
  const lines = createInterface({ input: stream, crlfDelay: Infinity });

  // Only `topK` hits are ever held, so memory is bounded no matter how large
  // the chunk file is. Scanning to the ceiling rather than stopping at the
  // first K matches is what keeps ranking honest.
  const hits: Hit[] = [];
  let scannedBytes = 0, scannedChunks = 0, truncated = false;

  for await (const line of lines) {
    scannedBytes += Buffer.byteLength(line, "utf8") + 1;
    if (!line.trim()) continue;
    scannedChunks++;

    let chunk: { chunkId: string; pageStart: number; pageEnd: number; text: string };
    try { chunk = JSON.parse(line); } catch { continue; }

    const haystack = chunk.text.toLowerCase();
    let score = 0, firstAt = -1, firstLen = 0;
    for (const term of terms) {
      let from = 0, at = haystack.indexOf(term, from);
      while (at !== -1) {
        score++;
        if (firstAt === -1 || at < firstAt) { firstAt = at; firstLen = term.length; }
        from = at + term.length;
        at = haystack.indexOf(term, from);
      }
    }

    if (score > 0) {
      hits.push({
        chunkId: chunk.chunkId, pageStart: chunk.pageStart, pageEnd: chunk.pageEnd, score,
        snippet: snippetAround(chunk.text, firstAt, firstLen),
      });
      hits.sort((a, b) => b.score - a.score || a.chunkId.localeCompare(b.chunkId));
      if (hits.length > topK) hits.length = topK;
    }

    if (scannedBytes >= ctx.cfg.searchMaxScanBytes) { truncated = true; break; }
  }
  lines.close();
  stream.destroy();

  return { jobId: args.jobId, hits, scannedBytes, scannedChunks, truncated };
};
```

- [ ] **Step 4: Register it in `src/orchestrator/mcp.ts`**

```ts
import { searchChunks } from "./tools/search-chunks.js";
```

```ts
  server.registerTool(
    "search_chunks",
    {
      title: "Search chunks",
      description:
        "Find the passages of a processed document that mention your terms. Returns short snippets " +
        "with page citations and chunk ids; pass those ids to fetch_chunks to read them in full.",
      inputSchema: {
        jobId: z.string(),
        query: z.string().min(1),
        topK: z.number().int().min(1).max(20).optional(),
      },
    },
    async (args) => jsonResult(await searchChunks(ctx, args)),
  );
```

- [ ] **Step 5: Run the tests**

Run: `npm --prefix plugins/azure-file-processing run test:integration -- search-chunks`
Expected: PASS. The "hands back ids that fetch_chunks accepts" case is the important one — the two tools are only useful as a pair.

- [ ] **Step 6: Stage**

```bash
git add plugins/azure-file-processing/src/orchestrator/tools/search-chunks.ts \
        plugins/azure-file-processing/src/orchestrator/mcp.ts \
        plugins/azure-file-processing/test/search-chunks.int.test.ts
# Repo owner commits. Proposed message:
#   feat(afp): search_chunks with a bounded streaming scan and page citations
```

---

## Task 18: `delete_job`

**Files:**
- Create: `plugins/azure-file-processing/src/orchestrator/tools/delete-job.ts`
- Modify: `plugins/azure-file-processing/src/orchestrator/mcp.ts`
- Test: `plugins/azure-file-processing/test/delete-job.int.test.ts`

**Interfaces:**
- Consumes: `getJob`, `updateJob`, `UPLOADS_CONTAINER`, `ARTIFACTS_CONTAINER`.
- Produces: `deleteJob(ctx, { jobId }): Promise<{ jobId; deleted: true; blobsRemoved: number }>`

The job row is marked `deleted` rather than dropped: a user still holding the id in their transcript gets an explanation from `job_status` instead of a bare "unknown job".

- [ ] **Step 1: Write the failing test**

`test/delete-job.int.test.ts`:

```ts
import { describe, it, expect, beforeAll } from "vitest";
import { loadConfig, UPLOADS_CONTAINER, ARTIFACTS_CONTAINER } from "../src/shared/config.js";
import { getStorage, ensureStorage } from "../src/shared/storage.js";
import { getJob } from "../src/shared/jobs.js";
import { createUploadUrl } from "../src/orchestrator/tools/create-upload-url.js";
import { startJob } from "../src/orchestrator/tools/start-job.js";
import { jobStatus } from "../src/orchestrator/tools/job-status.js";
import { deleteJob } from "../src/orchestrator/tools/delete-job.js";
import { runOnce } from "../src/worker/index.js";

const cfg = loadConfig();
const storage = getStorage(cfg);
const ctx = { cfg, storage };
beforeAll(async () => { await ensureStorage(storage); });

const countUnder = async (container: string, prefix: string) => {
  let n = 0;
  for await (const _ of storage.blob.getContainerClient(container).listBlobsFlat({ prefix })) n++;
  return n;
};

const processedJob = async () => {
  const body = Buffer.from("# doc\n\nsome content to chunk\n".repeat(50));
  const out = await createUploadUrl(ctx, { filename: "d.md", sizeBytes: body.length });
  await fetch(out.uploadUrl, { method: "PUT", headers: { "x-ms-blob-type": "BlockBlob" }, body });
  await startJob(ctx, { jobId: out.jobId });
  await runOnce(ctx);
  return out.jobId;
};

describe("deleteJob", () => {
  it("removes every blob in both containers", async () => {
    const jobId = await processedJob();
    expect(await countUnder(UPLOADS_CONTAINER, `${jobId}/`)).toBeGreaterThan(0);
    expect(await countUnder(ARTIFACTS_CONTAINER, `${jobId}/`)).toBe(4);

    const r = await deleteJob(ctx, { jobId });
    expect(r.deleted).toBe(true);
    expect(r.blobsRemoved).toBe(5);
    expect(await countUnder(UPLOADS_CONTAINER, `${jobId}/`)).toBe(0);
    expect(await countUnder(ARTIFACTS_CONTAINER, `${jobId}/`)).toBe(0);
  });

  it("keeps the row so the id still explains itself", async () => {
    const jobId = await processedJob();
    await deleteJob(ctx, { jobId });
    expect((await getJob(storage, jobId))?.state).toBe("deleted");
    expect((await jobStatus(ctx, { jobId })).state).toBe("deleted");
  });

  it("is idempotent — deleting twice is not an error", async () => {
    const jobId = await processedJob();
    await deleteJob(ctx, { jobId });
    const again = await deleteJob(ctx, { jobId });
    expect(again.deleted).toBe(true);
    expect(again.blobsRemoved).toBe(0);
  });

  it("refuses an unknown job", async () => {
    await expect(deleteJob(ctx, { jobId: "j-000000000-aaaaaaaaaaaa" }))
      .rejects.toThrow(/unknown job/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm --prefix plugins/azure-file-processing run test:integration -- delete-job`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/orchestrator/tools/delete-job.ts`**

```ts
import { UPLOADS_CONTAINER, ARTIFACTS_CONTAINER } from "../../shared/config.js";
import { getJob, updateJob } from "../../shared/jobs.js";
import { log } from "../../shared/logger.js";
import type { Ctx } from "../mcp.js";
import type { Storage } from "../../shared/storage.js";

const purge = async (s: Storage, container: string, prefix: string): Promise<number> => {
  const client = s.blob.getContainerClient(container);
  let removed = 0;
  for await (const blob of client.listBlobsFlat({ prefix })) {
    await client.getBlockBlobClient(blob.name).deleteIfExists();
    removed++;
  }
  return removed;
};

export const deleteJob = async (ctx: Ctx, args: { jobId: string }) => {
  const job = await getJob(ctx.storage, args.jobId);
  if (!job) throw new Error(`unknown job ${args.jobId}`);

  const prefix = `${args.jobId}/`;
  const blobsRemoved =
    (await purge(ctx.storage, UPLOADS_CONTAINER, prefix)) +
    (await purge(ctx.storage, ARTIFACTS_CONTAINER, prefix));

  // The row is retained, not dropped: an id a user still holds should explain
  // itself rather than answer "unknown job".
  await updateJob(ctx.storage, args.jobId, {
    state: "deleted", phase: null, finishedAt: new Date().toISOString(),
  });

  log.info("job.deleted", { jobId: args.jobId, blobsRemoved });
  return { jobId: args.jobId, deleted: true as const, blobsRemoved };
};
```

- [ ] **Step 4: Register it in `src/orchestrator/mcp.ts`**

```ts
import { deleteJob } from "./tools/delete-job.js";
```

```ts
  server.registerTool(
    "delete_job",
    {
      title: "Delete job",
      description: "Permanently remove a job's uploaded file and all of its artifacts.",
      inputSchema: { jobId: z.string() },
    },
    async (args) => jsonResult(await deleteJob(ctx, args)),
  );
```

- [ ] **Step 5: Run the tests and confirm all seven tools are registered**

Run:
```bash
npm --prefix plugins/azure-file-processing run test:integration -- delete-job
npm --prefix plugins/azure-file-processing run test:integration -- mcp-server
```

Then extend the `lists its tools` case in `test/mcp-server.int.test.ts` to assert the full set:

```ts
    expect(names).toEqual([
      "create_upload_url", "delete_job", "fetch_chunks",
      "get_result", "job_status", "search_chunks", "start_job",
    ]);
```

Expected: PASS with exactly seven tools — no more, no fewer.

- [ ] **Step 6: Stage**

```bash
git add plugins/azure-file-processing/src/orchestrator/tools/delete-job.ts \
        plugins/azure-file-processing/src/orchestrator/mcp.ts \
        plugins/azure-file-processing/test/delete-job.int.test.ts \
        plugins/azure-file-processing/test/mcp-server.int.test.ts
# Repo owner commits. Proposed message:
#   feat(afp): delete_job, completing the seven-tool contract
```

---

## Task 19: The acceptance suite

**Files:**
- Create: `plugins/azure-file-processing/test/acceptance.acc.test.ts`
- Modify: `plugins/azure-file-processing/README.md` (add the **Acceptance** section)
- Test: itself

This file is the one a reviewer or the client reads. Each block names the spec §11 row it proves, and the whole suite requires a running stack: `./scripts/stack.sh up` with `--scale worker=3`.

**Interfaces:**
- Consumes: every tool built so far.
- Produces: nothing new — it asserts properties, it does not add behaviour.

- [ ] **Step 1: Write the suite**

`test/acceptance.acc.test.ts`:

```ts
import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/shared/config.js";
import { getStorage, ensureStorage } from "../src/shared/storage.js";
import { getJob } from "../src/shared/jobs.js";
import { createUploadUrl } from "../src/orchestrator/tools/create-upload-url.js";
import { startJob } from "../src/orchestrator/tools/start-job.js";
import { getResult } from "../src/orchestrator/tools/get-result.js";
import { searchChunks } from "../src/orchestrator/tools/search-chunks.js";
import { fetchChunks } from "../src/orchestrator/tools/fetch-chunks.js";

const here = dirname(fileURLToPath(import.meta.url));
const pluginDir = resolve(here, "..");
const cfg = loadConfig();
const storage = getStorage(cfg);
const ctx = { cfg, storage };
const dir = mkdtempSync(join(tmpdir(), "afp-acc-"));

const NEEDLE = "PLUTONIUM_ARTICHOKE_7731";  // appears nowhere else on earth

beforeAll(async () => {
  await ensureStorage(storage);
  const res = await fetch("http://127.0.0.1:8080/health").catch(() => null);
  if (!res?.ok) throw new Error("Stack is not up. Run ./scripts/stack.sh up first.");
});

const makePdf = (name: string, pages: number, needlePage: number, linesPerPage = 40) => {
  const path = join(dir, name);
  execFileSync("node", [
    resolve(pluginDir, "scripts/make-fixture-pdf.mjs"), path, String(pages),
    "--needle", NEEDLE, "--needle-page", String(needlePage),
    "--lines-per-page", String(linesPerPage),
  ], { maxBuffer: 1 << 20 });
  return path;
};

const uploadAndStart = async (path: string, filename: string) => {
  const sizeBytes = statSync(path).size;
  const { jobId, uploadUrl } = await createUploadUrl(ctx, { filename, sizeBytes });
  // Bytes go disk → storage via the helper. They never enter this process, and
  // never enter a model's context.
  execFileSync("node", [resolve(pluginDir, "scripts/upload.mjs"), path, uploadUrl],
    { encoding: "utf8" });
  await startJob(ctx, { jobId });
  return jobId;
};

const waitFor = async (jobId: string, ms = 600_000) => {
  const deadline = Date.now() + ms;
  for (;;) {
    const job = await getJob(storage, jobId);
    if (job?.state === "succeeded") return job;
    if (job?.state === "failed") throw new Error(`job failed: ${job.error}`);
    if (Date.now() > deadline) throw new Error(`job ${jobId} did not finish in ${ms}ms`);
    await new Promise((r) => setTimeout(r, 1_000));
  }
};

describe("§11 · no bytes traverse MCP", () => {
  it("no tool response and no log line ever contains the document's text", async () => {
    const jobId = await uploadAndStart(makePdf("a.pdf", 60, 44), "a.pdf");
    await waitFor(jobId);

    const responses = JSON.stringify([
      await getResult(ctx, { jobId }),
      await searchChunks(ctx, { jobId, query: "lorem" }),   // deliberately NOT the needle
    ]);
    expect(responses).not.toContain(NEEDLE);

    // The orchestrator and workers log ids and counts, never content.
    const logs = execFileSync("docker",
      ["compose", "logs", "--no-color", "--tail", "2000"],
      { cwd: pluginDir, encoding: "utf8", maxBuffer: 64 << 20 });
    expect(logs).not.toContain(NEEDLE);
    expect(logs).not.toContain("lorem ipsum");
  });

  it("returns the needle ONLY when the model explicitly asks for that passage", async () => {
    const jobId = await uploadAndStart(makePdf("b.pdf", 60, 44), "b.pdf");
    await waitFor(jobId);
    const hits = await searchChunks(ctx, { jobId, query: NEEDLE });
    expect(hits.hits[0].pageStart).toBeLessThanOrEqual(44);
    expect(hits.hits[0].pageEnd).toBeGreaterThanOrEqual(44);
    const fetched = await fetchChunks(ctx, { jobId, chunkIds: [hits.hits[0].chunkId] });
    expect(fetched.chunks[0].text).toContain(NEEDLE);
    expect(fetched.bytes).toBeLessThanOrEqual(cfg.fetchMaxBytes);
  });
});

describe("§11 · bounded memory", () => {
  it("processes a large document under a 256 MB heap", async () => {
    // MEASURED: 20k pages at the default 40 lines/page is only ~63 MB, which fits
    // inside a 256 MB heap and would prove nothing. 40k pages at 200 lines/page is
    // ~640 MB — comfortably larger than the heap, so a whole-file load aborts with
    // "JavaScript heap out of memory" while page-windowed extraction does not.
    const big = makePdf("large.pdf", 40_000, 39_997, 200);
    const jobId = await uploadAndStart(big, "large.pdf");

    const worker = spawn("npx", ["tsx", "src/worker/index.ts"], {
      cwd: pluginDir,
      env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=256" },
    });
    let stderr = "";
    worker.stderr.on("data", (d) => { stderr += String(d); });

    try {
      const job = await waitFor(jobId);
      expect(job.state).toBe("succeeded");
      expect(stderr).not.toMatch(/heap out of memory/i);
    } finally {
      worker.kill("SIGTERM");
    }

    const r = await getResult(ctx, { jobId });
    expect(r.result.pages).toBe(40_000);
    const hits = await searchChunks(ctx, { jobId, query: NEEDLE });
    expect(hits.hits[0].pageStart).toBeLessThanOrEqual(39_997);
    expect(hits.hits[0].pageEnd).toBeGreaterThanOrEqual(39_997);
  }, 1_800_000);
});

describe("§11 · results stay compact", () => {
  it("get_result is under 8 KB and fetch_chunks is capped", async () => {
    const jobId = await uploadAndStart(makePdf("c.pdf", 120, 7), "c.pdf");
    await waitFor(jobId);
    expect(Buffer.byteLength(JSON.stringify(await getResult(ctx, { jobId })), "utf8"))
      .toBeLessThan(8192);

    const hits = await searchChunks(ctx, { jobId, query: "lorem", topK: 20 });
    const f = await fetchChunks(ctx, { jobId, chunkIds: hits.hits.slice(0, 10).map((h) => h.chunkId) });
    expect(f.bytes).toBeLessThanOrEqual(cfg.fetchMaxBytes);
    if (f.returned < f.requested) expect(f.truncated).toBe(true);
  });
});

describe("§11 · the pool is a pool", () => {
  it("three jobs submitted together are processed by more than one worker", async () => {
    // Requires: ./scripts/stack.sh up  with  docker compose up -d --scale worker=3
    const ids = await Promise.all([1, 2, 3].map((n) =>
      uploadAndStart(makePdf(`p${n}.pdf`, 200, 5), `p${n}.pdf`)));
    const jobs = await Promise.all(ids.map((id) => waitFor(id)));
    const workers = new Set(jobs.map((j) => j.workerId));
    expect(workers.size).toBeGreaterThan(1);
  }, 900_000);
});
```

- [ ] **Step 2: Bring up a three-worker stack and run it**

Run:
```bash
cd plugins/azure-file-processing
./scripts/stack.sh up
./scripts/stack.sh workers 3
npm run test:acceptance
```
Expected: every block PASSES. The bounded-memory case takes several minutes — it generates and processes a real multi-hundred-megabyte PDF, which is the point.

- [ ] **Step 3: Record what was measured**

Add an **Acceptance** section to `plugins/azure-file-processing/README.md` with the *actual* numbers from that run — file size, page count, wall-clock, and the heap ceiling the worker completed under. A claim of "bounded memory" with no measured figure beside it is the kind of statement this suite exists to replace.

- [ ] **Step 4: Note which rows are proven elsewhere**

Three spec §11 rows are asserted in earlier tasks rather than duplicated here. Add this to the README's Acceptance section so nobody concludes they were skipped:

| Row | Proven in |
|---|---|
| SAS is least-privilege | `test/sas.int.test.ts` (Task 6) — five negative assertions |
| `delete_job` really deletes | `test/delete-job.int.test.ts` (Task 18) |
| Failures dead-letter | `test/worker.int.test.ts` (Task 14) |

- [ ] **Step 5: Stage**

```bash
git add plugins/azure-file-processing/test/acceptance.acc.test.ts \
        plugins/azure-file-processing/README.md
# Repo owner commits. Proposed message:
#   test(afp): acceptance suite proving the spec's §11 claims
```

---

## Task 20: The skill, the README, and the install path

**Files:**
- Modify: `plugins/azure-file-processing/skills/azure-file-processing/SKILL.md` (replace the Task 2 stub)
- Modify: `plugins/azure-file-processing/README.md`
- Test: `plugins/azure-file-processing/test/skill.test.ts`

The skill is what makes the difference between seven tools sitting there and a model that uses them correctly. Its single most important job is stopping Codex from reading the file itself — the tools are useless if the model just opens the PDF.

**Interfaces:**
- Consumes: the seven tool names.
- Produces: the installed, documented plugin.

- [ ] **Step 1: Write the failing test**

`test/skill.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const skill = readFileSync(resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../skills/azure-file-processing/SKILL.md"), "utf8");

describe("SKILL.md", () => {
  it("has frontmatter naming the skill and when to use it", () => {
    expect(skill).toMatch(/^---\nname: azure-file-processing\ndescription: /);
  });

  it("names every tool the model needs, in the order they are called", () => {
    const order = ["create_upload_url", "upload.mjs", "start_job", "job_status",
                   "get_result", "search_chunks", "fetch_chunks"];
    let at = -1;
    for (const token of order) {
      const found = skill.indexOf(token, at + 1);
      expect(found, `${token} missing or out of order`).toBeGreaterThan(at);
      at = found;
    }
  });

  it("tells the model never to read the file itself", () => {
    expect(skill.toLowerCase()).toMatch(/never (read|open).{0,40}(file|document)/);
  });

  it("tells the model what to do when the stack is down", () => {
    expect(skill).toContain("stack.sh up");
    expect(skill).toContain("/health");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm --prefix plugins/azure-file-processing test -- skill`
Expected: FAIL — the Task 2 stub has none of this.

- [ ] **Step 3: Write the full `SKILL.md`**

````markdown
---
name: azure-file-processing
description: Use when a document is too large to read directly, or when asked to upload, process, search, summarise or extract text from a PDF, DOCX, TXT or MD file. Keeps file contents out of the context window by processing them in Azure Blob Storage and reading back only the passages that matter. Trigger on "this PDF", "large file", "search this document", "what does the contract say", or any file over a few hundred kilobytes.
---

# Azure File Processing

## The rule

**Never read the file yourself.** Do not open it, do not cat it, do not pass it
to any other tool. A large document read into the conversation is the exact
failure this plugin exists to prevent: it fills the context window, costs a
fortune, and for anything over a few tens of megabytes it simply will not fit.

You will only ever see: counts and headings, short search snippets, and the
handful of passages you explicitly ask for.

## Before anything else

Check the backend is running:

```bash
curl -fsS http://127.0.0.1:8080/health
```

If that fails, the `azure-files` tools will not work. Tell the user to run
`./scripts/stack.sh up` from the plugin directory and start a **new** thread —
tools are bound when a thread begins.

## The sequence

**1 · Mint an upload URL.** Give the real filename and its size in bytes.

```
create_upload_url({ filename: "contract.pdf", sizeBytes: 84213760 })
→ { jobId, uploadUrl, blobPath, expiresAt }
```

**2 · Send the bytes — from the shell, not through yourself.**

```bash
node scripts/upload.mjs /path/to/contract.pdf "<uploadUrl>"
```

The URL is write-only, scoped to that one blob, and expires in fifteen minutes.
Never paste file contents into a tool call.

**3 · Start the job.**

```
start_job({ jobId })
```

Optional tuning: `pipeline: { id: "extract-chunks", params: { chunkChars, overlapChars, pageWindow } }`.

**4 · Poll until it finishes.** Every few seconds; a large document takes minutes.

```
job_status({ jobId })
→ { state, phase, progress: { done, total, unit } }
```

`state` moves `queued → running → succeeded`. Report progress to the user rather
than sitting silent. On `failed`, read `error` and say what it says.

**5 · Get the facts.**

```
get_result({ jobId })
→ { result: { pages, words, chunks, language, headings, tables }, artifacts }
```

This never contains document text. Use `headings` to orient yourself.

**6 · Read only what you need.**

```
search_chunks({ jobId, query: "termination", topK: 5 })
→ [{ chunkId, page, snippet, score }]

fetch_chunks({ jobId, chunkIds: ["c-000412"] })
→ [{ chunkId, page, text }]
```

Search first, fetch second. Fetch at most ten chunks and expect a 32 KB ceiling;
if `truncated` is true, you asked for too much — narrow the query instead.

**7 · Clean up, when the user asks.**

```
delete_job({ jobId })
```

## Answering questions about a document

Search for the terms the question actually uses, fetch the two or three best
chunks, and answer **from those**, citing the page from the chunk's `page`
field. If the snippets do not answer it, search again with different terms —
never fetch more and more chunks hoping to stumble on it.

Say "page 37 of contract.pdf" rather than "the document says". Every chunk
carries its page, so a citation costs nothing and an uncited claim is
unverifiable.

## When it goes wrong

| What you see | What it means |
|---|---|
| `unknown job` | Wrong `jobId`, or the stack was reset. Start again from `create_upload_url`. |
| `not uploaded` | `start_job` ran before the upload finished. Re-run `upload.mjs`, then retry. |
| `size mismatch` | The upload was truncated. Re-run `upload.mjs`. |
| `checksum_mismatch` | The file changed between hashing and upload. Start again. |
| `unsupported extension` | Only `.pdf`, `.docx`, `.txt`, `.md`. Scanned PDFs with no text layer will process but yield almost nothing — say so rather than guessing. |
| `state: failed` | Read `error`. A corrupt PDF fails three times and is then dead-lettered. |
| SAS expired | The URL lasts fifteen minutes. Call `create_upload_url` again. |
````

- [ ] **Step 4: Write the `README.md`**

It must cover: what the plugin is, the three install commands, `stack.sh` (including the `workers` verb and which test tier needs which count), the seven tools in a table, the environment variables from spec §14, the **Known limits** heading from Task 16 Step 6, the **Acceptance** section from Task 19, and the development loop (cachebuster → reinstall → new thread) from spec §5.

It must also carry a **Moving to Azure** section reproducing spec §12's delta table — which pieces are configuration (connection string, endpoint URL, auth middleware) and which are the two that are genuinely code: the queue client and `mintUploadSas`, both already isolated in a module of their own for exactly this reason. Include the open question spec §12 records: the Codex shell sandbox permits outbound network to **loopback only**, so `upload.mjs` reaching a public Azure endpoint needs an answer that phase 1 does not have to solve.

- [ ] **Step 5: Reinstall and drive the whole thing from Codex**

Run:
```bash
python3 ~/.codex/skills/.system/plugin-creator/scripts/update_plugin_cachebuster.py \
  plugins/azure-file-processing
codex plugin add azure-file-processing@scyne
```

Then, in a **new** Codex thread, with a real PDF of your own:

> Process ~/Downloads/<some-large>.pdf and tell me what section 4 says.

Expected: Codex calls `create_upload_url`, shells out to `upload.mjs`, calls
`start_job`, polls `job_status`, then `search_chunks` and `fetch_chunks`, and
answers with a page citation — **without ever reading the PDF itself.** Confirm
that last part by checking its tool calls; it is the whole deliverable.

- [ ] **Step 6: Run every suite one final time**

Run:
```bash
cd plugins/azure-file-processing
npm run typecheck
npm test
./scripts/stack.sh workers 0 && npm run test:integration
./scripts/stack.sh workers 3 && npm run test:acceptance
```
Expected: all green. Record any failure here rather than reporting completion.

- [ ] **Step 7: Stage**

```bash
git add plugins/azure-file-processing/skills/azure-file-processing/SKILL.md \
        plugins/azure-file-processing/README.md \
        plugins/azure-file-processing/test/skill.test.ts \
        plugins/azure-file-processing/.codex-plugin/plugin.json
# Repo owner commits. Proposed message:
#   feat(afp): the skill, the README, and the verified install path
```

---

## Done means

Phase 1 is complete when all of these are true, each demonstrated rather than asserted:

- `codex plugin marketplace add` + `codex plugin add` + `./scripts/stack.sh up` gets a **new machine** working.
- All seven tools appear in a fresh Codex thread and answer.
- A real PDF of a few hundred megabytes is processed, searched and cited **without Codex reading it**.
- `npm test`, `npm run test:integration` and `npm run test:acceptance` are green.
- The README's Acceptance section carries the **measured** figures, not adjectives.

Phase 2 — the workspace plane (MCP 2) and porting the eight existing skills — is specified in §9 of the design document and is not part of this plan.
