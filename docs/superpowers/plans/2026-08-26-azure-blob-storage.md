# Azure Blob as the Only Place Bytes Live — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move every byte of document content out of Postgres and off durable disk into Azure Blob Storage, leaving Postgres holding only the blob's locator and disk holding only a scratch tree that exists for the length of one run.

**Architecture:** A `BlobBackend` seam is introduced inside `DocumentStore` so the byte store becomes swappable without touching a single caller — which is what `core/documents.ts` was written to allow. Two implementations exist: `postgresBlobBackend` (today's behaviour, kept so every stage is reversible) and an Azure one supplied by the consumer, keeping the orchestrator package's three-dependency discipline intact. Content stays addressed by SHA-256, so dedup and the `changed: false` harvest contract survive the move and a "has this changed" question is answered by a hash comparison rather than a download.

**Tech Stack:** TypeScript, Node 20+, PGlite / node-postgres, `@azure/storage-blob`, vitest, Azurite (local Azure emulator, already run by `plugins/azure-file-processing/scripts/stack.sh`).

**Spec:** [docs/superpowers/specs/2026-08-26-azure-blob-storage-design.md](../specs/2026-08-26-azure-blob-storage-design.md)

## Global Constraints

- **Australian English** in all generated content and user-facing copy.
- **`packages/orchestrator/` must not gain dependencies.** Its `package.json` declares exactly `@electric-sql/pglite`, `express`, `yaml`. The Azure implementation lives in the consumer repo and is injected through config, the way `adapters: Record<string, Runner>` already is. Nothing under `packages/orchestrator/` may import `scripts/pipeline.mjs`, `orchestrator.config.ts`, or anything under `projects/`.
- **`DocumentStore`'s public interface does not change.** `put` / `get` / `read` / `list` / `history` / `remove` keep their exact signatures. Any task that changes them is wrong.
- **Every stage leaves the system working.** No task may leave `npm run typecheck`, `npm test`, or `npm run check:routing` failing.
- **Content addressing is preserved.** A blob's locator is derived from its SHA-256 and blobs are never overwritten — same hash means same bytes.
- **Harvest stays non-destructive.** A file absent from a materialised tree is reported, never deleted from the store.
- **`original-files/` is never materialised.** Enforced by the transport with a test, not by convention.
- **Do not `git commit`** — the user commits their own work. Where a step says "commit", stage the files and report; do not run `git commit`.
- Run the full suite with `npm test` (orchestrator), `cd scyne-chatbot && npx vitest run`, and `cd plugins/azure-file-processing && npm test`.

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/orchestrator/src/core/blobs.ts` | **Create.** The `BlobBackend` interface and `postgresBlobBackend(db)`. The only module that knows where bytes physically live. |
| `packages/orchestrator/src/core/documents.ts` | **Modify.** Takes a `BlobBackend`; stops touching `blobs.content` directly. Public interface unchanged. |
| `packages/orchestrator/migrations/010_blob_locator.sql` | **Create.** `blobs.blob_path`, backfilled; `blobs.content` made nullable. |
| `packages/orchestrator/migrations/011_drop_blob_content.sql` | **Create.** Drops `blobs.content`. Last task, after a verified migration. |
| `packages/orchestrator/src/config.ts` | **Modify.** `blobs?: BlobBackend` on `OrchestratorConfig`. |
| `packages/orchestrator/src/index.ts` | **Modify.** Passes `config.blobs` into `createDocumentStore`; exports the new types. |
| `storage/azure-blobs.ts` | **Create (repo root).** `azureBlobBackend()` — staged-block upload above 8 MiB, single PUT below, streamed reads. The consumer's Azure dependency. |
| `orchestrator.config.ts` | **Modify.** Registers the Azure backend when `AZURE_STORAGE_CONNECTION_STRING` is set. |
| `scripts/migrate-blobs-to-azure.mjs` | **Create.** Plan-then-apply migration of `bytea` rows into Azure. |
| `scyne-chatbot/server/index.ts` | **Modify.** Upload routes stream to the store instead of writing a tree. |
| `packages/orchestrator/src/core/engine.ts` | **Modify.** Wraps agent steps in materialise → run → harvest → discard. |
| `packages/orchestrator/src/core/materialise.ts` | **Modify.** Excludes `original-files/`; enforces a size ceiling. |

---

### Task 1: The `BlobBackend` seam, with today's behaviour behind it

Introduces the swap point. Nothing observable changes: the Postgres backend does exactly what `documents.ts` does today, and every existing test must pass untouched.

**Files:**
- Create: `packages/orchestrator/src/core/blobs.ts`
- Create: `packages/orchestrator/test/blobs.test.ts`
- Modify: `packages/orchestrator/src/core/documents.ts`
- Modify: `packages/orchestrator/src/index.ts`

**Interfaces:**
- Consumes: `Db` from `./db.js` (`query<T>(sql, params?): Promise<{rows: T[]}>`).
- Produces:
  - `interface BlobBackend { write(sha256: string, content: Buffer, contentType: string | null): Promise<string>; read(locator: string): Promise<Buffer | null> }`
  - `postgresBlobBackend(db: Db): BlobBackend`
  - `createDocumentStore(db: Db, blobs?: BlobBackend): DocumentStore` — second parameter optional, defaulting to `postgresBlobBackend(db)`.

- [ ] **Step 1: Write the failing test**

Create `packages/orchestrator/test/blobs.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, migrate, type Db } from "../src/core/db.js";
import { postgresBlobBackend } from "../src/core/blobs.js";

let dir: string, db: Db;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "orch-blobs-"));
  db = await openDb({ driver: "pglite", dir });
  await migrate(db, new URL("../migrations", import.meta.url).pathname);
});
afterEach(async () => { await db.close(); rmSync(dir, { recursive: true, force: true }); });

describe("postgresBlobBackend", () => {
  it("round-trips bytes through the locator it returns", async () => {
    const b = postgresBlobBackend(db);
    const content = Buffer.from("hello");
    const sha = "a".repeat(64);
    const locator = await b.write(sha, content, "text/plain");
    expect(await b.read(locator)).toEqual(content);
  });

  it("is idempotent — the same hash written twice stores one row", async () => {
    // Two features uploading the same file concurrently must not race each
    // other into a duplicate-key failure.
    const b = postgresBlobBackend(db);
    const sha = "b".repeat(64);
    await b.write(sha, Buffer.from("x"), null);
    await b.write(sha, Buffer.from("x"), null);
    const { rows } = await db.query<{ n: string }>(
      `select count(*)::text as n from blobs where sha256 = $1`, [sha]);
    expect(rows[0].n).toBe("1");
  });

  it("returns null for a locator nothing was written under", async () => {
    expect(await postgresBlobBackend(db).read("pg:" + "c".repeat(64))).toBeNull();
  });

  it("prefixes its locator, so a later backend swap can tell rows apart", async () => {
    // The migration to Azure keys off this prefix: a row still reading `pg:`
    // has not been moved, and one that has been moved must never look like one
    // that has not.
    const b = postgresBlobBackend(db);
    const sha = "d".repeat(64);
    expect(await b.write(sha, Buffer.from("y"), null)).toBe(`pg:${sha}`);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `cd packages/orchestrator && npx vitest run test/blobs.test.ts`
Expected: FAIL — `Cannot find module '../src/core/blobs.js'`

- [ ] **Step 3: Write the backend**

Create `packages/orchestrator/src/core/blobs.ts`:

```ts
import type { Db } from "./db.js";

/**
 * Where bytes physically live.
 *
 * The one seam that makes the byte store swappable. `core/documents.ts` was
 * written expecting this — "Swapping in an object-store backend must not touch
 * a single caller" — and until now there was nothing to swap: `put`, `get` and
 * `read` reached into `blobs.content` themselves.
 *
 * Content is addressed by SHA-256 on both sides of the seam, so a backend never
 * overwrites: the same hash is the same bytes. That is what keeps dedup and the
 * `changed: false` harvest contract intact across the swap, and it is why
 * `write` may be called twice for one blob and must not complain.
 *
 * The LOCATOR is opaque to callers and is what `blobs.blob_path` records. It
 * carries a backend prefix so a half-migrated table is readable: a row still
 * reading `pg:<sha>` has not been moved to Azure, and one that has cannot be
 * mistaken for one that has not.
 */
export interface BlobBackend {
  /** Store bytes under their own hash. Idempotent. Returns the locator to record. */
  write(sha256: string, content: Buffer, contentType: string | null): Promise<string>;
  /** Fetch by a locator `write` returned. Null when nothing is stored there. */
  read(locator: string): Promise<Buffer | null>;
}

/**
 * PGlite hands `bytea` back as a Uint8Array, node-postgres as a Buffer. Both
 * satisfy the same reads, but callers expect a Buffer — normalise once here
 * rather than at every call site.
 */
const toBuffer = (v: unknown): Buffer => {
  if (Buffer.isBuffer(v)) return v;
  if (v instanceof Uint8Array) return Buffer.from(v);
  if (typeof v === "string") return Buffer.from(v, "utf8");
  return Buffer.alloc(0);
};

/** Today's behaviour, unchanged: bytes in the `blobs.content` column. */
export const postgresBlobBackend = (db: Db): BlobBackend => ({
  async write(sha256, content, contentType) {
    await db.query(
      `insert into blobs (sha256, bytes, content, content_type, blob_path)
       values ($1,$2,$3,$4,$5) on conflict (sha256) do nothing`,
      [sha256, content.length, content, contentType, `pg:${sha256}`]);
    return `pg:${sha256}`;
  },

  async read(locator) {
    if (!locator.startsWith("pg:")) return null;
    const { rows } = await db.query<{ content: unknown }>(
      `select content from blobs where sha256 = $1`, [locator.slice(3)]);
    return rows[0]?.content == null ? null : toBuffer(rows[0].content);
  },
});
```

- [ ] **Step 4: Run the test — it still fails, on the missing column**

Run: `cd packages/orchestrator && npx vitest run test/blobs.test.ts`
Expected: FAIL — `column "blob_path" of relation "blobs" does not exist`. Task 2 adds it. Continue to Task 2 and return here.

- [ ] **Step 5: Wire the seam into `documents.ts`**

In `packages/orchestrator/src/core/documents.ts`, change the factory signature and route the three byte-touching sites through the backend.

Replace the `createDocumentStore` line:

```ts
export function createDocumentStore(db: Db, blobs: BlobBackend = postgresBlobBackend(db)): DocumentStore {
```

Add to the imports at the top of the file:

```ts
import { postgresBlobBackend, type BlobBackend } from "./blobs.js";
```

In `put`, replace the direct blob insert:

```ts
      // Content first, and idempotently: two features uploading the same file
      // concurrently must not race each other into a duplicate-key failure.
      // The BACKEND decides where those bytes go; this only records that they
      // were stored and under what locator.
      const locator = await blobs.write(sha, content, input.contentType ?? null);
      await db.query(
        `update blobs set blob_path = $2 where sha256 = $1 and blob_path is null`,
        [sha, locator]);
```

In `get`, replace the `select ${SELECT}, b.content` query and its return:

```ts
      const { rows } = await db.query<DocRow & { blob_path: string | null }>(
        `select ${SELECT}, b.blob_path from documents d join blobs b on b.sha256 = d.sha256
          where d.project_id = $1 and d.${pred} and d.path = $${params.length} and d.is_current`,
        params);
      if (!rows[0]) return null;
      const content = rows[0].blob_path ? await blobs.read(rows[0].blob_path) : null;
      if (content === null) return null;
      return { ref: toRef(rows[0]), content };
```

In `read`, the same substitution:

```ts
    async read(documentId) {
      const { rows } = await db.query<{ blob_path: string | null }>(
        `select b.blob_path from documents d join blobs b on b.sha256 = d.sha256 where d.id = $1`,
        [documentId]);
      if (!rows[0]?.blob_path) return null;
      return blobs.read(rows[0].blob_path);
    },
```

- [ ] **Step 6: Export the new types**

In `packages/orchestrator/src/index.ts`, beside the existing `createDocumentStore` export, add:

```ts
export { postgresBlobBackend, type BlobBackend } from "./core/blobs.js";
```

- [ ] **Step 7: Run the whole orchestrator suite**

Run: `cd packages/orchestrator && npx vitest run`
Expected: PASS, 667 tests + the 4 new ones. **`documents.test.ts` and `materialise.test.ts` must pass unmodified** — if either needed editing, the public interface changed and the task is wrong.

- [ ] **Step 8: Stage the files**

```bash
git add packages/orchestrator/src/core/blobs.ts \
        packages/orchestrator/test/blobs.test.ts \
        packages/orchestrator/src/core/documents.ts \
        packages/orchestrator/src/index.ts
# Do NOT run git commit — the user commits their own work.
```

---

### Task 2: Migration 010 — the locator column

**Files:**
- Create: `packages/orchestrator/migrations/010_blob_locator.sql`
- Modify: `packages/orchestrator/test/platform-schema.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `blobs.blob_path text` (nullable), backfilled to `pg:<sha256>` for every existing row; `blobs.content` made nullable.

- [ ] **Step 1: Write the failing test**

Append to `packages/orchestrator/test/platform-schema.test.ts`:

```ts
describe("blobs carry a locator", () => {
  it("has blob_path, and every existing row is backfilled to the pg: form", async () => {
    // A half-migrated table has to be readable: `pg:` says these bytes are
    // still in the column, an Azure locator says they have moved. A null would
    // mean neither, which is a row nothing can read.
    const { rows } = await db.query<{ column_name: string; is_nullable: string }>(
      `select column_name, is_nullable from information_schema.columns
        where table_name = 'blobs' and column_name in ('blob_path','content')
        order by column_name`);
    expect(rows.map(r => r.column_name)).toEqual(["blob_path", "content"]);
    // `content` must be nullable before Azure rows can exist without bytes.
    expect(rows.find(r => r.column_name === "content")!.is_nullable).toBe("YES");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/orchestrator && npx vitest run test/platform-schema.test.ts`
Expected: FAIL — the result is `["content"]`, missing `blob_path`.

- [ ] **Step 3: Write the migration**

Create `packages/orchestrator/migrations/010_blob_locator.sql`:

```sql
-- Where a blob's bytes actually live, as a locator rather than as the bytes.
--
-- `blobs.content bytea` held every document in the database, which imposed
-- three ceilings nobody chose: Postgres caps a bytea field at 1 GB, V8 caps a
-- string at 512 MB (so ~384 MB once a document is base64'd into a JSON body to
-- reach the API), and the upload route in front of it was capped at 100 MB to
-- match. A 300 MB document was streamed into Azure in 8 MiB blocks, converted
-- there, and then downloaded, buffered twice and refused — because the last leg
-- insisted on carrying bytes that were already stored.
--
-- The locator is OPAQUE and carries a backend prefix. `pg:<sha256>` means the
-- bytes are still in the column below; anything else names a blob in object
-- storage. That prefix is what makes a half-migrated table readable, and it is
-- what `scripts/migrate-blobs-to-azure.mjs` keys off — a row still reading
-- `pg:` has not been moved.
--
-- Backfilled rather than left null for existing rows: a null locator would mean
-- "neither here nor there", which is a row nothing can read. Every row that
-- exists today has its bytes in `content`, so every row gets the `pg:` form.
alter table blobs add column blob_path text;

update blobs set blob_path = 'pg:' || sha256 where blob_path is null;

-- `content` becomes nullable so a blob stored in Azure can exist without it.
-- The column is dropped entirely by 011, after a migration has been run and
-- verified — dropping it here would make this migration irreversible on a
-- database whose bytes have not moved yet.
alter table blobs alter column content drop not null;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/orchestrator && npx vitest run test/platform-schema.test.ts`
Expected: PASS.

- [ ] **Step 5: Return to Task 1 Step 4 and finish it**

Run: `cd packages/orchestrator && npx vitest run`
Expected: PASS — `blobs.test.ts` now passes, and the full suite is green.

- [ ] **Step 6: Stage the files**

```bash
git add packages/orchestrator/migrations/010_blob_locator.sql \
        packages/orchestrator/test/platform-schema.test.ts
```

---

### Task 3: The Azure backend

Lives in the repo root, not in `packages/orchestrator/` — the package declares three dependencies and gains none. It is injected the way `adapters` already are.

**Files:**
- Create: `storage/azure-blobs.ts`
- Create: `storage/azure-blobs.test.ts`

**Interfaces:**
- Consumes: `BlobBackend` from `@scyne/orchestrator` (Task 1).
- Produces: `azureBlobBackend(opts: { connectionString: string; container?: string }): BlobBackend` — container defaults to `"documents"`.

- [ ] **Step 1: Write the failing test**

Create `storage/azure-blobs.test.ts`. It runs against **Azurite**, which `plugins/azure-file-processing/scripts/stack.sh up` already starts; the suite skips itself when Azurite is not reachable so it never fails a machine that has not started it.

```ts
import { describe, it, expect, beforeAll } from "vitest";
import { azureBlobBackend, blobNameFor } from "./azure-blobs.js";

const CONN = process.env.AZURE_STORAGE_CONNECTION_STRING
  ?? "UseDevelopmentStorage=true";

let up = false;
beforeAll(async () => {
  try {
    await azureBlobBackend({ connectionString: CONN, container: "test-blobs" })
      .read("azure:test-blobs/does/not/exist");
    up = true;
  } catch { up = false; }
});

describe("blobNameFor", () => {
  it("fans out on the first four hex characters, so one container is not one flat namespace", () => {
    const sha = "abcd1234" + "0".repeat(56);
    expect(blobNameFor(sha)).toBe(`ab/cd/${sha}`);
  });

  it("refuses anything that is not a sha256, because the name IS the hash", () => {
    // A caller passing a path here would create a blob nothing can find again,
    // and a caller passing "../" would address another container's key space.
    expect(() => blobNameFor("../escape")).toThrow(/sha256/);
    expect(() => blobNameFor("")).toThrow(/sha256/);
  });
});

describe("azureBlobBackend", () => {
  const backend = () => azureBlobBackend({ connectionString: CONN, container: "test-blobs" });

  it.skipIf(!up)("round-trips bytes through the locator it returns", async () => {
    const b = backend();
    const content = Buffer.from("hello azure");
    const sha = "1".repeat(64);
    const locator = await b.write(sha, content, "text/plain");
    expect(locator).toBe(`azure:test-blobs/11/11/${sha}`);
    expect(await b.read(locator)).toEqual(content);
  });

  it.skipIf(!up)("is idempotent — writing the same hash twice is not an error", async () => {
    const b = backend();
    const sha = "2".repeat(64);
    await b.write(sha, Buffer.from("z"), null);
    await expect(b.write(sha, Buffer.from("z"), null)).resolves.toContain(sha);
  });

  it.skipIf(!up)("returns null rather than throwing for a blob that is not there", async () => {
    // A missing blob is a real state — a store restored without its container —
    // and `get()` distinguishes it from an error by the null.
    expect(await backend().read(`azure:test-blobs/33/33/${"3".repeat(64)}`)).toBeNull();
  });

  it.skipIf(!up)("stages a file larger than one block", async () => {
    // 8 MiB is the block size; this crosses it, so it exercises the staged path
    // rather than the single PUT.
    const b = backend();
    const content = Buffer.alloc(9 * 1024 * 1024, 7);
    const sha = "4".repeat(64);
    const locator = await b.write(sha, content, null);
    const back = await b.read(locator);
    expect(back?.length).toBe(content.length);
    expect(back?.equals(content)).toBe(true);
  });

  it("refuses a locator belonging to another backend", async () => {
    expect(await backend().read("pg:" + "5".repeat(64))).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run storage/azure-blobs.test.ts`
Expected: FAIL — `Cannot find module './azure-blobs.js'`

- [ ] **Step 3: Write the backend**

Create `storage/azure-blobs.ts`:

```ts
import { BlobServiceClient } from "@azure/storage-blob";
import type { BlobBackend } from "./../packages/orchestrator/src/index.js";

/** One block. Matches the plugin's own staged upload so the two agree. */
const BLOCK_BYTES = 8 * 1024 * 1024;
const CONCURRENCY = 4;

const SHA256 = /^[0-9a-f]{64}$/;

/**
 * The blob's name IS its content hash, fanned out two levels.
 *
 * Fan-out because a single flat prefix holding millions of keys is slow to list
 * and unpleasant to browse; two levels of two hex characters gives 65,536
 * buckets, which is ample and costs nothing.
 *
 * Validated rather than trusted: the name is derived from caller-supplied text,
 * and a value that is not a hash would either create a blob nothing can find
 * again or — with `../` in it — address a key space this backend does not own.
 */
export const blobNameFor = (sha256: string): string => {
  if (!SHA256.test(sha256)) {
    throw new Error(`blob name must be a lowercase hex sha256, got ${JSON.stringify(sha256)}`);
  }
  return `${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}`;
};

export interface AzureBlobOptions {
  connectionString: string;
  /** Defaults to "documents". Named in the locator so a container rename is visible. */
  container?: string;
}

/**
 * Bytes in Azure Blob Storage, addressed by their own SHA-256.
 *
 * Never overwrites: the same hash is the same bytes, so a second write of a
 * blob that exists is a no-op rather than a conflict. That is what lets two
 * features uploading the same document store one copy, and what lets `put()`
 * answer "unchanged" from a hash comparison without downloading anything.
 */
export const azureBlobBackend = (opts: AzureBlobOptions): BlobBackend => {
  const container = opts.container ?? "documents";
  const service = BlobServiceClient.fromConnectionString(opts.connectionString);
  const client = service.getContainerClient(container);
  let ensured: Promise<unknown> | null = null;
  const ensure = () => (ensured ??= client.createIfNotExists());

  return {
    async write(sha256, content, contentType) {
      await ensure();
      const name = blobNameFor(sha256);
      const locator = `azure:${container}/${name}`;
      const blob = client.getBlockBlobClient(name);

      // Content-addressed, so an existing blob already holds exactly these
      // bytes. Skipping the upload is not an optimisation — re-uploading would
      // burn the egress and time this whole design exists to avoid.
      if (await blob.exists()) return locator;

      const headers = contentType ? { blobContentType: contentType } : undefined;
      if (content.length <= BLOCK_BYTES) {
        await blob.upload(content, content.length, { blobHTTPHeaders: headers });
      } else {
        await blob.uploadData(content, {
          blockSize: BLOCK_BYTES,
          concurrency: CONCURRENCY,
          blobHTTPHeaders: headers,
        });
      }
      return locator;
    },

    async read(locator) {
      // A locator from another backend is not this backend's to answer for.
      if (!locator.startsWith(`azure:${container}/`)) return null;
      const name = locator.slice(`azure:${container}/`.length);
      try {
        return await client.getBlockBlobClient(name).downloadToBuffer();
      } catch (e: any) {
        // A missing blob is a real state, not an error: a store restored
        // without its container, or a locator recorded before a failed write.
        if (e?.statusCode === 404) return null;
        throw e;
      }
    },
  };
};
```

- [ ] **Step 4: Add the dependency at the repo root only**

```bash
npm install @azure/storage-blob
```

Verify `packages/orchestrator/package.json` is untouched:

```bash
node -e 'console.log(Object.keys(require("./packages/orchestrator/package.json").dependencies).join(" "))'
```
Expected: `@electric-sql/pglite express yaml`

- [ ] **Step 5: Run the tests**

```bash
cd plugins/azure-file-processing && ./scripts/stack.sh up   # starts Azurite
cd ../.. && npx vitest run storage/azure-blobs.test.ts
```
Expected: PASS, 6 tests. If Azurite is not running, the four `skipIf` tests skip and the two pure ones still pass.

- [ ] **Step 6: Stage the files**

```bash
git add storage/azure-blobs.ts storage/azure-blobs.test.ts package.json package-lock.json
```

---

### Task 4: Config wiring, defaulting off

**Files:**
- Modify: `packages/orchestrator/src/config.ts`
- Modify: `packages/orchestrator/src/index.ts`
- Modify: `orchestrator.config.ts`
- Modify: `packages/orchestrator/test/config.test.ts`

**Interfaces:**
- Consumes: `BlobBackend` (Task 1), `azureBlobBackend` (Task 3).
- Produces: `OrchestratorConfig.blobs?: BlobBackend`, honoured by `createOrchestrator`.

- [ ] **Step 1: Write the failing test**

Append to `packages/orchestrator/test/config.test.ts`:

```ts
describe("the byte store is injectable", () => {
  it("accepts a blobs backend and validates without one", () => {
    // Optional on purpose: the library must keep working with bytes in
    // Postgres, so every stage of the Azure move stays reversible.
    const withOut = defineOrchestrator({ ...baseConfig });
    expect(withOut.blobs).toBeUndefined();

    const fake = { write: async () => "x:1", read: async () => null };
    const withIt = defineOrchestrator({ ...baseConfig, blobs: fake });
    expect(withIt.blobs).toBe(fake);
  });
});
```

> If `baseConfig` does not already exist in that file, build it from the config
> the other tests in the file use — the point of the test is the `blobs` field,
> not the rest of the object.

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/orchestrator && npx vitest run test/config.test.ts`
Expected: FAIL — TypeScript rejects `blobs` as an unknown property.

- [ ] **Step 3: Add the field**

In `packages/orchestrator/src/config.ts`, beside `db: DbOptions;`:

```ts
  /**
   * Where document BYTES live. Omit for Postgres (`blobs.content`).
   *
   * Injected rather than constructed here for the same reason `adapters` is:
   * this package declares three dependencies and an object-store client is not
   * going to be the fourth. The consumer builds it and hands it over.
   */
  blobs?: BlobBackend;
```

Add the import at the top of `config.ts`:

```ts
import type { BlobBackend } from "./core/blobs.js";
```

- [ ] **Step 4: Honour it**

In `packages/orchestrator/src/index.ts`, find the `createDocumentStore(db)` call and pass the backend:

```ts
  const documents = createDocumentStore(db, config.blobs);
```

- [ ] **Step 5: Register it in the consumer, off by default**

In `orchestrator.config.ts`, add the import at the top:

```ts
import { azureBlobBackend } from "./storage/azure-blobs.js";
```

and inside `defineOrchestrator({...})`, directly under the `db:` entry:

```ts
  // Bytes in Azure when a connection string is present, in Postgres otherwise.
  // Absent is the safe default: an install that has not migrated its blobs
  // keeps working exactly as before, and flipping this is the one step that
  // changes where content is read from.
  blobs: process.env.AZURE_STORAGE_CONNECTION_STRING
    ? azureBlobBackend({
        connectionString: process.env.AZURE_STORAGE_CONNECTION_STRING,
        container: process.env.AZURE_DOCUMENTS_CONTAINER ?? "documents",
      })
    : undefined,
```

- [ ] **Step 6: Document the two keys**

In `.env.example`, under the Database block, add:

```bash
# ─── Where document BYTES live ───────────────────────────────────────────
# Unset → Postgres (blobs.content). Set → Azure Blob Storage.
# Run `npm run migrate:blobs -- --apply` BEFORE setting this on an install
# that already holds documents, or existing documents read back empty.
# AZURE_STORAGE_CONNECTION_STRING=
# AZURE_DOCUMENTS_CONTAINER=documents      # default in orchestrator.config.ts
```

- [ ] **Step 7: Run typecheck and the suites**

```bash
npm run typecheck
cd packages/orchestrator && npx vitest run
```
Expected: PASS both.

- [ ] **Step 8: Stage the files**

```bash
git add packages/orchestrator/src/config.ts packages/orchestrator/src/index.ts \
        packages/orchestrator/test/config.test.ts orchestrator.config.ts .env.example
```

---

### Task 5: The migration script

**Files:**
- Create: `scripts/migrate-blobs-to-azure.mjs`
- Modify: `package.json` (add `migrate:blobs`)

**Interfaces:**
- Consumes: `blobs.blob_path` (Task 2), `azureBlobBackend` (Task 3).
- Produces: `npm run migrate:blobs [-- --apply]`. Every row whose `blob_path` starts `pg:` is uploaded and rewritten to its Azure locator.

- [ ] **Step 1: Write the script**

Create `scripts/migrate-blobs-to-azure.mjs`:

```js
#!/usr/bin/env node
/**
 * Move every blob out of `blobs.content` and into Azure.
 *
 *   npm run migrate:blobs              # a PLAN — reads, writes nothing
 *   npm run migrate:blobs -- --apply   # do it
 *
 * Keyed off the locator prefix 010 introduced: a row reading `pg:<sha>` still
 * has its bytes in the column, and one reading `azure:…` has been moved. So
 * this is idempotent and resumable — a run killed halfway leaves every row it
 * finished already correct, and re-running picks up only what is left.
 *
 * Content-addressed, so an upload is verified by reading the blob back and
 * comparing its hash to the row's own `sha256`. `content` is NOT cleared here:
 * dropping the column is migration 011, run once a full pass has verified, so
 * that a failed migration is recoverable from the database it started in.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "../packages/orchestrator/src/core/db.js";
import { azureBlobBackend } from "../storage/azure-blobs.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");

try {
  const env = await readFile(path.join(ROOT, ".env"), "utf8");
  for (const line of env.split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
} catch { /* exported vars are fine */ }

const conn = process.env.AZURE_STORAGE_CONNECTION_STRING;
if (!conn) {
  console.error("AZURE_STORAGE_CONNECTION_STRING is not set — nothing to migrate into.");
  process.exit(2);
}
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set. This reads the database the orchestrator uses.");
  process.exit(2);
}

const db = await openDb({ driver: "external", url: process.env.DATABASE_URL });
const backend = azureBlobBackend({
  connectionString: conn,
  container: process.env.AZURE_DOCUMENTS_CONTAINER ?? "documents",
});

const { rows } = await db.query(
  `select sha256, bytes, content_type from blobs
    where blob_path like 'pg:%' order by bytes asc`);

if (!rows.length) {
  console.log("Nothing to migrate — every blob already has an object-store locator.");
  await db.close();
  process.exit(0);
}

const total = rows.reduce((n, r) => n + Number(r.bytes), 0);
console.log(`${rows.length} blob(s), ${(total / 1024 / 1024).toFixed(1)} MB, still in Postgres.`);
if (!APPLY) {
  console.log(`\nRe-run with --apply to move them.`);
  await db.close();
  process.exit(0);
}

let moved = 0;
const failed = [];
for (const r of rows) {
  try {
    const got = await db.query(`select content from blobs where sha256 = $1`, [r.sha256]);
    const raw = got.rows[0]?.content;
    const content = Buffer.isBuffer(raw) ? raw : Buffer.from(raw ?? []);

    // The row claims a hash. If the bytes in the column do not match it, the
    // row is already corrupt and moving it would carry the corruption forward
    // under a name that asserts it is fine.
    const actual = createHash("sha256").update(content).digest("hex");
    if (actual !== r.sha256) {
      failed.push(`${r.sha256}: column holds bytes hashing to ${actual}`);
      continue;
    }

    const locator = await backend.write(r.sha256, content, r.content_type ?? null);

    // Verified by reading back, because a locator recorded for a blob that is
    // not there is exactly the state that reads as an empty document later.
    const back = await backend.read(locator);
    if (!back || createHash("sha256").update(back).digest("hex") !== r.sha256) {
      failed.push(`${r.sha256}: wrote to ${locator} but it did not read back`);
      continue;
    }

    await db.query(`update blobs set blob_path = $2 where sha256 = $1`, [r.sha256, locator]);
    moved++;
    if (moved % 25 === 0) console.log(`  ${moved}/${rows.length}`);
  } catch (e) {
    failed.push(`${r.sha256}: ${e.message}`);
  }
}

console.log(`\n${moved}/${rows.length} moved.`);
for (const f of failed) console.error(`  ✗ ${f}`);
await db.close();
process.exit(failed.length ? 1 : 0);
```

- [ ] **Step 2: Register the script**

In the root `package.json`, beside `"backfill:ado"`:

```json
    "migrate:blobs": "node scripts/migrate-blobs-to-azure.mjs",
```

- [ ] **Step 3: Check it parses and refuses cleanly**

```bash
node --check scripts/migrate-blobs-to-azure.mjs && echo "syntax ok"
AZURE_STORAGE_CONNECTION_STRING= npm run migrate:blobs
```
Expected: `syntax ok`, then exit 2 with `AZURE_STORAGE_CONNECTION_STRING is not set`.

- [ ] **Step 4: Run the plan against the real database**

```bash
npm run migrate:blobs
```
Expected: a count and byte total, and `Re-run with --apply to move them.` Nothing written.

- [ ] **Step 5: Apply, then verify no `pg:` rows remain**

```bash
npm run migrate:blobs -- --apply
psql "$(grep '^DATABASE_URL=' .env | cut -d= -f2-)" -At \
  -c "select count(*) from blobs where blob_path like 'pg:%';"
```
Expected: `0`.

- [ ] **Step 6: Stage the files**

```bash
git add scripts/migrate-blobs-to-azure.mjs package.json
```

---

### Task 6: Upload routes stream to the store

**Files:**
- Modify: `scyne-chatbot/server/index.ts`
- Modify: `scyne-chatbot/server/store.ts`
- Modify: `scyne-chatbot/server/limits.test.ts`

**Interfaces:**
- Consumes: `POST /projects/{id}/documents` on the orchestrator (existing).
- Produces: uploads no longer base64 content into a JSON body; `UPLOAD_MAX_BYTES` is removed along with the multer `fileSize` limit.

- [ ] **Step 1: Write the failing test**

Replace the `"the upload ceiling has one source of truth"` describe block in `scyne-chatbot/server/limits.test.ts` with:

```ts
describe("there is no upload ceiling to have a source of truth for", () => {
  it("multer no longer caps the file size", async () => {
    // The cap existed because content travelled through memory and then
    // base64 through a JSON body. Bytes stream to object storage now, so the
    // three ceilings that produced it — 100 MB multer, ~384 MB V8 string,
    // 1 GB Postgres bytea — are all gone rather than raised.
    const src = await readFile("server/index.ts", "utf8");
    expect(src).not.toMatch(/fileSize:/);
    expect(src).not.toMatch(/UPLOAD_MAX_BYTES/);
  });

  it("no document is base64'd into a JSON body", async () => {
    const store = await readFile("server/store.ts", "utf8");
    expect(store).not.toMatch(/toString\("base64"\)/);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd scyne-chatbot && npx vitest run server/limits.test.ts`
Expected: FAIL on all three assertions — the current code has each of them.

- [ ] **Step 3: Post the bytes as a stream**

In `scyne-chatbot/server/store.ts`, replace the body of `createDocumentRow`'s `send` call with a binary POST:

```ts
    const r = await sendBinary(token, `/projects/${row.id}/documents`, input.content, {
      ...(input.feature ? { feature: input.feature } : {}),
      path: input.path,
      category: categoryFor(input.path) ?? "",
    });
```

and add, beside `send`:

```ts
/**
 * POST raw bytes with the metadata in the query string.
 *
 * A document used to travel base64'd inside a JSON body, which inflated it by a
 * third and put it under two ceilings: the orchestrator's 100 MB JSON limit and
 * V8's 512 MB cap on a single string. A 100 MB document base64s to 133 MB, so
 * anything over roughly 75 MB failed its row while landing on disk perfectly —
 * silently, because this write is best-effort.
 */
async function sendBinary(
  token: string, path: string, content: Buffer, query: Record<string, string>,
): Promise<{ ok: boolean; status: number; json: unknown }> {
  const qs = new URLSearchParams(query).toString();
  const res = await fetch(`${BASE}${path}?${qs}`, {
    method: "POST",
    headers: {
      "content-type": "application/octet-stream",
      accept: "application/json",
      authorization: `Bearer ${token}`,
    },
    body: new Uint8Array(content),
  });
  const json = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, json };
}
```

- [ ] **Step 4: Accept it on the orchestrator**

In `packages/orchestrator/src/http/platform-router.ts`, in the `r.post("/projects/:id/documents", …)` handler, accept an octet-stream body ahead of the existing JSON path:

```ts
    // Raw bytes with metadata in the query string. The JSON+base64 form below
    // is kept for callers that still use it, but it is not how a document of
    // any size should arrive.
    if (req.headers["content-type"] === "application/octet-stream") {
      const q = req.query as Record<string, string>;
      const doc = await documents.put({
        projectId: row.id,
        featureId: q.feature ? (await platform.getFeatureByName(row.id, q.feature))?.id ?? null : null,
        path: String(q.path),
        content: req.body as Buffer,
        category: q.category || null,
        uploadedBy: req.principal!.user.id,
      });
      return created(res, doc);
    }
```

and register the raw body parser in `packages/orchestrator/src/cli.ts`, beside `express.json`:

```ts
    app.use(express.raw({ type: "application/octet-stream", limit: "5gb" }));
```

- [ ] **Step 5: Remove the cap**

In `scyne-chatbot/server/index.ts`, delete the `UPLOAD_MAX_BYTES` constant and the `GET /api/limits` route, and reduce the multer options to:

```ts
const upload = multer({ storage: multer.memoryStorage() });
```

Keep the `LIMIT_UNEXPECTED_FILE` branch of the error handler and delete the `LIMIT_FILE_SIZE` branch — there is no size limit left for it to report.

- [ ] **Step 6: Drop the plugin's now-dead pre-check**

In `plugins/azure-file-processing/src/workspace/tools/ingest-document.ts`, delete `uploadLimit`, `cachedLimit`, `PASSTHROUGH`, both `file_too_large` checks and the `mb` helper. They existed to predict a ceiling that no longer exists.

- [ ] **Step 7: Run every suite**

```bash
npm run typecheck
cd packages/orchestrator && npx vitest run
cd ../scyne-chatbot && npx vitest run
cd ../plugins/azure-file-processing && npm test
```
Expected: PASS all four.

- [ ] **Step 8: Stage the files**

```bash
git add scyne-chatbot/server/index.ts scyne-chatbot/server/store.ts \
        scyne-chatbot/server/limits.test.ts \
        packages/orchestrator/src/http/platform-router.ts \
        packages/orchestrator/src/cli.ts \
        plugins/azure-file-processing/src/workspace/tools/ingest-document.ts
```

---

### Task 7: `original-files/` is never materialised, and a ceiling is enforced

Must land **before** Task 8 wires materialise into the engine, so the first run that uses a scratch tree already has both guards.

**Files:**
- Modify: `packages/orchestrator/src/core/materialise.ts`
- Modify: `packages/orchestrator/test/materialise.test.ts`

**Interfaces:**
- Consumes: `MaterialiseInput` (existing).
- Produces: `MaterialiseInput.maxBytes?: number` (default `512 * 1024 * 1024`); `EXCLUDED_FROM_MATERIALISE = ["original-files"]`.

- [ ] **Step 1: Write the failing test**

Append to `packages/orchestrator/test/materialise.test.ts`:

```ts
describe("what a scratch tree refuses to hold", () => {
  it("never places anything under original-files/", async () => {
    // That directory is the archive of raw uploads and the only thing in a
    // project that reaches gigabytes. It lives in object storage and nothing
    // pulls it down — a container would fill on the first restore.
    const store = await seedStore([
      { path: "documents/policy.md", content: "kept" },
      { path: "original-files/documents/policy.docx", content: "not kept" },
    ]);
    const workRoot = await createWorkRoot();
    const manifest = await materialise({ ...baseInput, store, workRoot });
    expect(Object.keys(manifest.files)).toContain("projects/P/documents/policy.md");
    expect(Object.keys(manifest.files).some(f => f.includes("original-files"))).toBe(false);
    await discardWorkRoot(workRoot);
  });

  it("refuses above the ceiling, naming what it was asked to place", async () => {
    // A loud refusal, because the alternative is a container filling up and a
    // run dying on ENOSPC with nothing saying why.
    const store = await seedStore([{ path: "documents/big.md", content: "x".repeat(2048) }]);
    const workRoot = await createWorkRoot();
    await expect(materialise({ ...baseInput, store, workRoot, maxBytes: 1024 }))
      .rejects.toThrow(/2048 bytes.*ceiling of 1024/s);
    await discardWorkRoot(workRoot);
  });
});
```

> `seedStore` and `baseInput` follow whatever the existing tests in that file
> already use to build a store and a `MaterialiseInput`; reuse them rather than
> writing new helpers.

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/orchestrator && npx vitest run test/materialise.test.ts`
Expected: FAIL — `original-files` is placed, and `maxBytes` is not a known property.

- [ ] **Step 3: Implement both guards**

In `packages/orchestrator/src/core/materialise.ts`, add beside `HARVESTED_ROOTS`:

```ts
/**
 * Never pulled into a scratch tree.
 *
 * `original-files/` is the archive of raw uploads — the one part of a project
 * that reaches gigabytes, and the reason a scratch tree is viable at all on a
 * container with 1–2 GB of ephemeral disk. A measured project's working set is
 * ~8 MB; its archive is unbounded. It lives in object storage and nothing pulls
 * it down.
 *
 * Enforced here rather than left to convention, because the failure is a
 * container filling and a run dying on ENOSPC with nothing naming the cause.
 */
export const EXCLUDED_FROM_MATERIALISE = ["original-files"] as const;

/** Default scratch-tree ceiling. Generous against a measured 8 MB working set. */
export const DEFAULT_MAX_MATERIALISE_BYTES = 512 * 1024 * 1024;
```

Add to `MaterialiseInput`:

```ts
  /** Refuse rather than fill the disk. Defaults to DEFAULT_MAX_MATERIALISE_BYTES. */
  maxBytes?: number;
```

Inside `materialise`, in the loop over `store.list(...)`, skip excluded paths and accumulate:

```ts
    if (EXCLUDED_FROM_MATERIALISE.some(d => ref.path === d || ref.path.startsWith(`${d}/`))) continue;

    placedBytes += ref.bytes;
    if (placedBytes > (input.maxBytes ?? DEFAULT_MAX_MATERIALISE_BYTES)) {
      throw new Error(
        `materialising ${projectName} needs at least ${placedBytes} bytes, over the ceiling of ` +
        `${input.maxBytes ?? DEFAULT_MAX_MATERIALISE_BYTES}. Raise maxBytes, or find the document ` +
        `that does not belong in a working tree — the last one counted was ${ref.path}.`);
    }
```

declaring `let placedBytes = 0;` above the loop.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/orchestrator && npx vitest run test/materialise.test.ts`
Expected: PASS.

- [ ] **Step 5: Stage the files**

```bash
git add packages/orchestrator/src/core/materialise.ts packages/orchestrator/test/materialise.test.ts
```

---

### Task 8: Wire materialise / harvest into agent steps

The change that makes disk scratch. Do it last of the behavioural tasks: everything before it is reversible by a config flag, and this is not.

**Files:**
- Modify: `packages/orchestrator/src/core/engine.ts`
- Modify: `packages/orchestrator/test/engine.test.ts`

**Interfaces:**
- Consumes: `createWorkRoot()`, `materialise(input)`, `harvest(input)`, `discardWorkRoot(root)` from `./materialise.js`; `EXCLUDED_FROM_MATERIALISE` (Task 7).
- Produces: an agent step whose `cwd` is a per-run scratch root, harvested on success and discarded either way.

- [ ] **Step 1: Write the failing test**

Append to `packages/orchestrator/test/engine.test.ts`:

```ts
describe("a run works in a scratch tree, not in the workspace", () => {
  it("materialises before the agent and discards afterwards", async () => {
    const roots: string[] = [];
    const issue = await seedIssueWithAgentStep({ onSpawn: (opts) => { roots.push(opts.cwd); } });
    await engine.advance(issue.id);
    expect(roots).toHaveLength(1);
    // The agent must not have been pointed at the installation's own tree.
    expect(roots[0]).not.toBe(config.workspace);
    // And nothing may survive the run.
    await expect(stat(roots[0])).rejects.toThrow();
  });

  it("harvests what the agent wrote back into the store", async () => {
    const issue = await seedIssueWithAgentStep({
      onSpawn: async (opts) => {
        await writeFile(join(opts.cwd, "projects", "P", "outputs", "made.md"), "by the agent");
      },
    });
    await engine.advance(issue.id);
    const doc = await documents.get(projectId, null, "outputs/made.md");
    expect(doc?.content.toString()).toBe("by the agent");
  });

  it("discards the tree even when the agent fails, and does not harvest", async () => {
    // A crashed agent's half-written tree must not become the record.
    const roots: string[] = [];
    const issue = await seedIssueWithAgentStep({
      onSpawn: (opts) => { roots.push(opts.cwd); throw new Error("boom"); },
    });
    await engine.advance(issue.id);
    await expect(stat(roots[0])).rejects.toThrow();
    expect(await documents.list(projectId)).toEqual([]);
  });
});
```

> `seedIssueWithAgentStep` follows the existing helpers in `engine.test.ts` for
> creating an issue with one `agent` step and a stubbed runner; reuse them.

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/orchestrator && npx vitest run test/engine.test.ts`
Expected: FAIL — the agent's `cwd` is `config.workspace` and nothing is harvested.

- [ ] **Step 3: Wrap the agent step**

In `packages/orchestrator/src/core/engine.ts`, around the `agent` branch of `advance()`:

```ts
      // Agents work on files, so a tree is materialised out of the store for
      // the length of the run and discarded afterwards. The store is the only
      // durable copy: nothing here writes to the installation's own workspace.
      const workRoot = await createWorkRoot();
      let manifest;
      try {
        manifest = await materialise({
          store: documents,
          projectId, projectName, features,
          installRoot: config.workspace,
          workRoot,
        });

        const outcome = await runAgent({ ...spawnOpts, cwd: workRoot });

        // Harvest ONLY on success. A crashed agent's half-written tree must not
        // become the record — harvest is non-destructive, so a file that
        // vanished is reported rather than deleted, but a file that was written
        // wrong would be recorded as the new truth.
        if (outcome.ok) {
          const harvested = await harvest({ store: documents, workRoot, manifest, stage: step.phase });
          await comment(issue.id, `Recorded ${harvested.written.length} changed file(s).`);
        }
        return outcome;
      } finally {
        // Always. A container has finite disk and an abandoned tree is a leak
        // that survives the run that made it.
        await discardWorkRoot(workRoot);
      }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/orchestrator && npx vitest run test/engine.test.ts`
Expected: PASS.

- [ ] **Step 5: Run every suite and a real stage end to end**

```bash
npm run typecheck && npm test && npm run check:routing
npm run orch -- run extract --project SA-DEMO-1
```
Expected: suites pass; the run completes and `$scyne extracts` reports both documents ready.

- [ ] **Step 6: Stage the files**

```bash
git add packages/orchestrator/src/core/engine.ts packages/orchestrator/test/engine.test.ts
```

---

### Task 9: Serve the companion app from the store

Spec §5. Without this the UI tab breaks the moment Task 8 lands: harvest puts
`generated-apps/<project>/index.html` into the store, and `sendCompanionFile`
goes on reading a directory that a discarded scratch tree no longer leaves
behind.

**Files:**
- Modify: `scyne-chatbot/server/index.ts` (`sendCompanionFile`, ~line 3030)
- Modify: `scyne-chatbot/server/store.ts`
- Create: `scyne-chatbot/server/companion.test.ts`

**Interfaces:**
- Consumes: harvest's attribution — a generated-app file is stored at PROJECT
  level with `path` equal to its work-root-relative path, e.g.
  `generated-apps/SA-DEMO-1/index.html`, category `artefact`
  (`attribute()` in `core/materialise.ts`).
- Produces: `store.readDocumentByPath(token, project, path): Promise<Buffer | null>`.

- [ ] **Step 1: Write the failing test**

Create `scyne-chatbot/server/companion.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readDocumentByPath } from "./store.js";

const calls: Array<{ url: string }> = [];
const realFetch = globalThis.fetch;

const stub = (routes: Record<string, { status: number; body?: unknown }>) => {
  globalThis.fetch = vi.fn(async (url: any) => {
    const u = String(url);
    calls.push({ url: u });
    const hit = Object.entries(routes)
      .filter(([k]) => u.includes(k))
      .sort((a, b) => b[0].length - a[0].length)[0]?.[1];
    if (!hit) return { ok: false, status: 404, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) } as any;
    return {
      ok: hit.status >= 200 && hit.status < 300,
      status: hit.status,
      json: async () => hit.body ?? {},
      arrayBuffer: async () => new TextEncoder().encode(String(hit.body ?? "")).buffer,
    } as any;
  }) as any;
};

beforeEach(() => { calls.length = 0; });
afterEach(() => { globalThis.fetch = realFetch; });

describe("readDocumentByPath", () => {
  it("resolves a project by name, finds the document by path, and returns its bytes", async () => {
    stub({
      "GET /projects": { status: 200, body: [{ id: "p1", name: "SA-DEMO-1" }] },
      "/projects/p1/documents": { status: 200, body: [{ id: "d1", path: "generated-apps/SA-DEMO-1/index.html" }] },
      "/projects/p1/documents/d1": { status: 200, body: "<html>rendered</html>" },
    });
    const out = await readDocumentByPath("t", "SA-DEMO-1", "generated-apps/SA-DEMO-1/index.html");
    expect(out?.toString()).toBe("<html>rendered</html>");
  });

  it("returns null for a project that is not there, rather than throwing", async () => {
    // The companion-app route turns null into `not_generated`, which is a real
    // state — a project whose app has never been rendered.
    stub({ "GET /projects": { status: 200, body: [] } });
    expect(await readDocumentByPath("t", "Nope", "generated-apps/Nope/index.html")).toBeNull();
  });

  it("returns null for a path the project does not hold", async () => {
    stub({
      "GET /projects": { status: 200, body: [{ id: "p1", name: "SA-DEMO-1" }] },
      "/projects/p1/documents": { status: 200, body: [] },
    });
    expect(await readDocumentByPath("t", "SA-DEMO-1", "generated-apps/SA-DEMO-1/index.html")).toBeNull();
  });

  it("does nothing without a session", async () => {
    stub({});
    expect(await readDocumentByPath(null, "SA-DEMO-1", "x")).toBeNull();
    expect(calls).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd scyne-chatbot && npx vitest run server/companion.test.ts`
Expected: FAIL — `readDocumentByPath` is not exported from `./store.js`.

- [ ] **Step 3: Implement the reader**

Append to `scyne-chatbot/server/store.ts`:

```ts
/**
 * One document's bytes, by its path within a project.
 *
 * The companion app used to be read straight off disk with `fs.readFile` from
 * `generated-apps/<project>/`. Once an agent step works in a scratch tree that
 * is discarded when the run ends, that directory is not there afterwards — the
 * rendered page is in the store, attributed by `attribute()` at PROJECT level
 * with its work-root-relative path.
 *
 * Two calls because the platform API addresses a document by id: list with a
 * path filter, then read the id. Null rather than a throw for "not there",
 * because a project whose app has never been rendered is an ordinary state the
 * route reports as `not_generated`.
 */
export async function readDocumentByPath(
  token: string | null, project: string, docPath: string,
): Promise<Buffer | null> {
  if (!token) return null;
  try {
    const row = (await listProjects(token)).find(p => p.name === project);
    if (!row) return null;

    const q = new URLSearchParams({ prefix: docPath });
    const listed = await get<Array<{ id: string; path: string }>>(
      token, `/projects/${row.id}/documents?${q}`, []);
    const hit = listed.find(d => d.path === docPath);
    if (!hit) return null;

    const res = await fetch(`${BASE}/projects/${row.id}/documents/${hit.id}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd scyne-chatbot && npx vitest run server/companion.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Point the route at it**

In `scyne-chatbot/server/index.ts`, replace the body of `sendCompanionFile`:

```ts
async function sendCompanionFile(
  res: express.Response, project: string, relPath: string, token: string | null,
) {
  // Stored at PROJECT level under its work-root-relative path — the same shape
  // `attribute()` gives it when a run is harvested.
  const html = await store.readDocumentByPath(token, project, `generated-apps/${project}/${relPath}`);
  if (html === null) {
    return res.status(404).json({
      error: "not_generated",
      message: relPath === "index.html"
        ? `No companion app for ${project} yet. Run the app stage to build it.`
        : `${relPath} is not part of ${project}'s companion app.`,
    });
  }
  res.type(relPath.endsWith(".html") ? "html" : "text/plain").send(html);
}
```

Update all three call sites to pass `tokenFor(req)`:

```ts
    await sendCompanionFile(res, project, "index.html", tokenFor(req));
```

Note the message no longer names `node scripts/render-companion-app.mjs` — that
is a repository command an end user cannot run, and
`plugins/azure-file-processing/test/user-facing-errors.test.ts` enforces the
same rule on the plugin side.

- [ ] **Step 6: Run every suite**

```bash
npm run typecheck
cd scyne-chatbot && npx vitest run
```
Expected: PASS both.

- [ ] **Step 7: Verify in a browser**

Open `http://127.0.0.1:5173`, sign in, pick a project with a rendered app, and
open the **UI** tab. The page must render from the store with
`generated-apps/` absent from disk.

- [ ] **Step 8: Stage the files**

```bash
git add scyne-chatbot/server/index.ts scyne-chatbot/server/store.ts \
        scyne-chatbot/server/companion.test.ts
```

---

### Task 10: Retire the second copy, and drop the column

**Files:**
- Create: `packages/orchestrator/migrations/011_drop_blob_content.sql`
- Delete: `plugins/azure-file-processing/test/sync-one-way.test.ts`
- Modify: `plugins/azure-file-processing/src/workspace/sync.ts`
- Modify: `plugins/azure-file-processing/src/workspace/tools/workspace.ts`, `.../attach-document.ts`, `.../ingest-document.ts`
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: a verified migration (Task 5) and a working scratch-tree run (Task 8).
- Produces: `blobs` with no `content` column; no `syncUp` calls in the plugin.

- [ ] **Step 1: Confirm nothing still reads the column**

```bash
grep -rn "b\.content\|blobs.*content" --include="*.ts" packages/orchestrator/src | grep -v content_type
psql "$(grep '^DATABASE_URL=' .env | cut -d= -f2-)" -At \
  -c "select count(*) from blobs where blob_path like 'pg:%';"
```
Expected: no matches, and `0`. **If either fails, stop** — dropping the column would destroy the only copy of those bytes.

- [ ] **Step 2: Write the migration**

Create `packages/orchestrator/migrations/011_drop_blob_content.sql`:

```sql
-- The bytes are in object storage. This column is the second copy.
--
-- Deliberately separate from 010, and deliberately last. 010 added the locator
-- and made this nullable so a database could be migrated incrementally and
-- rolled back; this is the point of no return, and it is only safe once
-- `scripts/migrate-blobs-to-azure.mjs` has completed a verified pass and no row
-- still carries a `pg:` locator.
--
-- After this, `blobs` is metadata about content it does not hold: the hash that
-- names it, its size, its type, and where it actually is.
alter table blobs drop column content;
```

- [ ] **Step 3: Run the migration and the suite**

```bash
cd packages/orchestrator && npx vitest run
```
Expected: PASS. The migration applies on the next boot; the tests apply it against a fresh PGlite database each run.

- [ ] **Step 4: Retire the plugin's mirror**

Delete `plugins/azure-file-processing/test/sync-one-way.test.ts`. Remove `syncUp` calls and the `synced` result fields from `workspace.ts`, `attach-document.ts` and `ingest-document.ts`, and delete `syncUp` / `syncDown` / `ensureWorkspaceContainer` from `sync.ts`.

The guard test goes with them: it existed to stop the blob mirror becoming a second opinion about a project's contents, and after this change object storage is the only opinion. Leaving a test asserting a rule that no longer applies is worse than deleting it.

- [ ] **Step 5: Update CLAUDE.md**

Replace the **Storage** paragraph with:

```markdown
**Storage** is Postgres for metadata and **Azure Blob Storage for every byte of
document content**, addressed by SHA-256 (`blobs.blob_path`). Raw run logs stay
as JSONL at `.orchestrator/runs/<issueId>-<stepIndex>.jsonl`.

Disk is a SCRATCH surface. An agent step materialises a tree out of the store
into a temporary directory, runs against it, harvests what changed back, and
deletes it. `original-files/` is never materialised — it is the archive, the one
part of a project that reaches gigabytes, and a scratch tree is only viable on a
container because it holds a working set (measured: 8 MB for SAPN_DEMO) rather
than an archive.
```

- [ ] **Step 6: Run everything**

```bash
npm run typecheck && npm test && npm run check:routing
cd scyne-chatbot && npx vitest run
cd ../plugins/azure-file-processing && npm test
```
Expected: PASS all.

- [ ] **Step 7: Stage the files**

```bash
git add packages/orchestrator/migrations/011_drop_blob_content.sql \
        plugins/azure-file-processing/src/workspace/sync.ts \
        plugins/azure-file-processing/src/workspace/tools/ \
        CLAUDE.md
git rm plugins/azure-file-processing/test/sync-one-way.test.ts
```

---

## Self-review notes

**Spec coverage.** §1 byte store → Tasks 1, 2, 3. §2 uploads stream → Task 6. §3 DB holds the path → Tasks 2, 5. §4 scratch tree → Tasks 7, 8. §5 generated apps → Tasks 8 and 9. Harvest already covers the WRITE (`generated-apps` is in `HARVESTED_ROOTS`, attributed at project level by `attribute()`), but the READ does not: `sendCompanionFile` calls `fs.readFile` against `generated-apps/<project>/` and would 404 on every project the moment a scratch tree is discarded. That gap was found in this review and Task 9 closes it. §6 retire the `workspace` container → Task 10. §7 migration → Task 5.

**Ordering constraint.** Task 2 must be applied before Task 1's tests pass — Task 1 Step 4 says so explicitly and Task 2 Step 5 returns to it. Task 7 must precede Task 8 so the first scratch-tree run already has both guards. Task 9 must land with Task 8 or the UI tab breaks. Task 10 must be last and its Step 1 is a hard stop.

**Reversibility.** Tasks 1–5 change nothing observable until `AZURE_STORAGE_CONNECTION_STRING` is set. Task 10 is the point of no return.

**Known gap, deliberately out of scope:** blob reclamation. `remove()` never deletes bytes because other paths and versions may share them, so orphaned blobs accumulate in Azure. That needs a reference-counted sweep, and it is not in this plan.
