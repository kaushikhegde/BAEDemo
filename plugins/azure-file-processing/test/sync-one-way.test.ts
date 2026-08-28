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
 * The workspace bucket is an OPERATOR tool, and no longer on any tool path.
 *
 * It used to be an export: documents landed in `projects/` on disk and
 * `syncUp` mirrored that tree for durability. Both halves are gone. Documents
 * now go to the orchestrator's store — object storage plus the database row,
 * written together — and a `projects/` tree exists only while a stage runs,
 * materialised for that step and discarded after it.
 *
 * So the invariant tightened rather than disappeared. It used to be "written,
 * never read", which allowed a tool to push. It is now: nothing under `src/`
 * reaches for EITHER direction. A tool that synced would be reintroducing a
 * second opinion about what a project contains, competing with the store —
 * the same class of bug as deciding a project exists by `fs.access` on a
 * folder.
 *
 * `sync.ts` stays, and so do both exports, because `scripts/sync.mjs` is how
 * an operator restores or mirrors a workspace by hand. That is asserted too:
 * an invariant guarding a module nothing can reach is a comment, and a module
 * nothing reaches at all should have been deleted instead.
 */
describe("the workspace bucket is operator-only, on no tool path", () => {
  it("nothing under src/ imports syncUp or syncDown", async () => {
    const files = await walk(SRC);
    expect(files.length).toBeGreaterThan(10);

    const offenders: string[] = [];
    for (const f of files) {
      if (f.endsWith(`workspace${sep}sync.ts`)) continue;
      const text = await readFile(f, "utf8");
      // An import of the symbol, not a mention of the word: the comments in
      // paths.ts, manifest.ts and the document tools discuss sync at length
      // and must not fail.
      if (/^\s*import[^;]*\b(syncUp|syncDown)\b[^;]*;/ms.test(text)) offenders.push(relative(SRC, f));
    }

    expect(
      offenders,
      `these import a sync direction, which would make the bucket a second source of ` +
      `truth beside the document store: ${offenders.join(", ")}`,
    ).toEqual([]);
  });

  it("the operator CLI still reaches both, so the module is not dead code", async () => {
    const cli = await readFile(new URL("../scripts/sync.mjs", import.meta.url), "utf8");
    expect(cli).toMatch(/import\s*\{[^}]*\bsyncUp\b/);
    expect(cli).toMatch(/import\s*\{[^}]*\bsyncDown\b/);
  });
});
