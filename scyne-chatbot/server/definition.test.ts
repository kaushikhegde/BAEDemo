import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";

/**
 * The project definition never reached an agent.
 *
 * Every skill reads `projects/<p>/description.md` from its cwd, and an agent's
 * cwd is a scratch tree materialised from the DOCUMENT STORE. Both routes that
 * save a definition wrote the file to the install's disk and the text to
 * `projects.description` — neither of which is materialised — so on BAE the
 * capability map reported "No description.md project definition exists" for a
 * project that had one.
 *
 * These assert that each route that writes the file also stores it as a
 * project-level document at `description.md`, which is what lands it in the
 * scratch tree.
 */
const routeBody = (src: string, decl: string) => {
  const at = src.indexOf(decl);
  if (at < 0) throw new Error(`route not found: ${decl}`);
  const end = src.indexOf("\n});", at);
  return src.slice(at, end);
};

describe("a saved project definition reaches the agents", () => {
  for (const route of ['app.post("/api/project-description"', 'app.post("/api/projects"']) {
    it(`${route} stores description.md as a document`, async () => {
      const src = await readFile("server/index.ts", "utf8");
      const body = routeBody(src, route);
      expect(body).toMatch(/createDocumentRow\(tokenFor\(req\),\s*\{[^}]*path:\s*"description\.md"/);
    });
  }
});
