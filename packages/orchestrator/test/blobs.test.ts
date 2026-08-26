import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, migrate, type Db } from "../src/core/db.js";
import { memoryBlobBackend } from "../src/core/blobs.js";

let dir: string, db: Db;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "orch-blobs-"));
  db = await openDb({ driver: "pglite", dir });
  await migrate(db, new URL("../migrations", import.meta.url).pathname);
});
afterEach(async () => { await db.close(); rmSync(dir, { recursive: true, force: true }); });

describe("memoryBlobBackend", () => {
  it("round-trips bytes through the locator it returns", async () => {
    const b = memoryBlobBackend();
    const content = Buffer.from("hello");
    const sha = "a".repeat(64);
    const locator = await b.write(sha, content, "text/plain");
    expect(await b.read(locator)).toEqual(content);
  });

  it("is idempotent — the same hash written twice is not an error", async () => {
    // Content-addressed, so two features uploading the same file concurrently
    // are writing the same bytes. A backend must treat that as a no-op rather
    // than a conflict, which is what makes dedup free.
    const b = memoryBlobBackend();
    const sha = "b".repeat(64);
    const first = await b.write(sha, Buffer.from("x"), null);
    const second = await b.write(sha, Buffer.from("x"), null);
    expect(second).toBe(first);
    expect((await b.read(first))?.toString()).toBe("x");
  });

  it("returns null for a locator nothing was written under", async () => {
    expect(await memoryBlobBackend().read("memory:" + "c".repeat(64))).toBeNull();
  });

  it("prefixes its locator, so one backend cannot answer for another's rows", async () => {
    // `blobs.blob_path` records this string. The prefix is what lets a table
    // holding rows from two backends be read at all — and what let the Azure
    // migration tell a moved row from an unmoved one.
    const b = memoryBlobBackend();
    const sha = "d".repeat(64);
    expect(await b.write(sha, Buffer.from("y"), null)).toBe(`memory:${sha}`);
  });

  it("refuses a locator belonging to another backend rather than guessing", async () => {
    expect(await memoryBlobBackend().read(`azure:documents/ee/ee/${"e".repeat(64)}`)).toBeNull();
  });
});
