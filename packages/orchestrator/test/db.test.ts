import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
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
