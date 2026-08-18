import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, migrate } from "../src/core/db.js";

let dir: string;
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

describe("db", () => {
  it("opens pglite, applies migrations, and is idempotent", async () => {
    dir = mkdtempSync(join(tmpdir(), "orch-"));
    const db = await openDb({ driver: "pglite", dir });

    const first = await migrate(db, new URL("../migrations", import.meta.url).pathname);
    expect(first.applied).toContain("001_init.sql");

    const second = await migrate(db, new URL("../migrations", import.meta.url).pathname);
    expect(second.applied).toEqual([]); // already applied

    const { rows } = await db.query<{ table_name: string }>(
      `select table_name from information_schema.tables where table_schema='public'`
    );
    const names = rows.map(r => r.table_name);
    for (const t of ["companies","agents","issues","comments","work_products","gates","runs","budgets","skills","agent_skills"]) {
      expect(names).toContain(t);
    }
    await db.close();
  });
});

describe("single-writer lock", () => {
  it("refuses a second open of the same directory", async () => {
    // PGlite itself does NOT lock: measured, not assumed — a second instance
    // opens happily, gets its own view, and the two diverge silently with the
    // last flush winning. There is no error and nothing in the data afterwards
    // records that it happened. The lock is ours.
    const d = mkdtempSync(join(tmpdir(), "orch-lock-"));
    const dir = join(d, "pg");
    const a = await openDb({ driver: "pglite", dir });
    try {
      await expect(openDb({ driver: "pglite", dir })).rejects.toThrow(/already open/);
    } finally {
      await a.close();
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("releases on close, so a restart is not blocked", async () => {
    const d = mkdtempSync(join(tmpdir(), "orch-lock-"));
    const dir = join(d, "pg");
    await (await openDb({ driver: "pglite", dir })).close();
    const again = await openDb({ driver: "pglite", dir });   // must not throw
    expect(again).toBeTruthy();
    await again.close();
    rmSync(d, { recursive: true, force: true });
  });

  it("takes over a lock whose owning process is gone", async () => {
    // A SIGKILL leaves the file behind. Blocking forever on a dead pid would
    // turn a crash into a database nobody can reopen.
    const d = mkdtempSync(join(tmpdir(), "orch-lock-"));
    const dir = join(d, "pg");
    // pid 2^22 is above Linux's default pid_max and macOS's ceiling, so it
    // cannot belong to a live process.
    writeFileSync(dir + ".lock", JSON.stringify({ pid: 4194304, since: "2020-01-01T00:00:00Z" }));
    const db2 = await openDb({ driver: "pglite", dir });
    expect(db2).toBeTruthy();
    await db2.close();
    rmSync(d, { recursive: true, force: true });
  });

  it("is not wedged shut by a corrupt lock file", async () => {
    const d = mkdtempSync(join(tmpdir(), "orch-lock-"));
    const dir = join(d, "pg");
    writeFileSync(dir + ".lock", "not json at all");
    const db2 = await openDb({ driver: "pglite", dir });
    expect(db2).toBeTruthy();
    await db2.close();
    rmSync(d, { recursive: true, force: true });
  });
});
