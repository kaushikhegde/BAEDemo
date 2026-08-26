import { describe, it, expect } from "vitest";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../src", import.meta.url));

const walk = async (dir: string): Promise<string[]> => {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...await walk(p));
    else if (e.name.endsWith(".ts")) out.push(p);
  }
  return out;
};

/**
 * Blob is an EXPORT, not a second source of truth.
 *
 * Postgres is the system of record; the project tree is materialised out of it
 * for a run and harvested back, and `syncUp` mirrors the result to the
 * workspace container for durability. Reading that container back would make
 * it a third opinion about what a project contains — competing with the store
 * and with the local disk — which is the same class of bug as `POST
 * /api/projects` deciding a project existed by calling `fs.access` on a folder.
 *
 * `syncDown` stays exported and tested for an operator restoring a lost
 * workspace by hand. This asserts nothing reaches for it AUTOMATICALLY. Written
 * as a guard rather than a deletion because the direction is the invariant, and
 * an invariant nothing checks is a comment.
 */
describe("the workspace blob container is written, never read", () => {
  it("nothing under src/ imports syncDown, except sync.ts which defines it", async () => {
    const files = await walk(SRC);
    expect(files.length).toBeGreaterThan(10);

    const offenders: string[] = [];
    for (const f of files) {
      if (f.endsWith(`workspace${sep}sync.ts`)) continue;
      const text = await readFile(f, "utf8");
      // An import of the symbol, not a mention of the word: the comments in
      // paths.ts and manifest.ts discuss syncDown at length and must not fail.
      if (/^\s*import[^;]*\bsyncDown\b[^;]*;/ms.test(text)) offenders.push(relative(SRC, f));
    }

    expect(
      offenders,
      `these import syncDown, which would make blob a read path: ${offenders.join(", ")}`,
    ).toEqual([]);
  });

  it("syncUp is imported by the tools that write, so the export half is real", async () => {
    const files = await walk(SRC);
    const importers = [];
    for (const f of files) {
      if (f.endsWith("sync.ts")) continue;
      if (/^\s*import[^;]*\bsyncUp\b[^;]*;/ms.test(await readFile(f, "utf8"))) {
        importers.push(relative(SRC, f));
      }
    }
    // Guarding the direction is only meaningful while something pushes.
    expect(importers.length).toBeGreaterThan(0);
  });
});
