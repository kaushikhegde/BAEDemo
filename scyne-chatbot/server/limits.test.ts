import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";

/**
 * Two ceilings, three orders of magnitude apart, with nothing comparing them.
 *
 * The plugin's file plane accepts `MAX_UPLOAD_BYTES` (5 GiB by default) and
 * streams a source into Azure; the converted MARKDOWN is then posted to the
 * chatbot, whose multer cap is 100 MB. A 300 MB document was uploaded,
 * converted, downloaded and buffered twice before anything refused it — and the
 * refusal arrived as an unexplained 500, because multer's LIMIT_FILE_SIZE had
 * no handler and fell through to Express's default.
 *
 * These assert the two halves that fix cost: one constant behind both the
 * multer limit and `/api/limits`, and an error handler that names both sizes.
 */
describe("the upload ceiling has one source of truth", () => {
  it("multer is configured from UPLOAD_MAX_BYTES, not a literal", async () => {
    const src = await readFile("server/index.ts", "utf8");
    expect(src).toMatch(/limits:\s*\{\s*fileSize:\s*UPLOAD_MAX_BYTES\s*\}/);
    // A second literal would be a second ceiling to drift.
    expect(src).not.toMatch(/fileSize:\s*100\s*\*\s*1024\s*\*\s*1024/);
  });

  it("exposes it so a caller can refuse before doing the work", async () => {
    const src = await readFile("server/index.ts", "utf8");
    expect(src).toMatch(/app\.get\("\/api\/limits"/);
    expect(src).toMatch(/uploadMaxBytes:\s*UPLOAD_MAX_BYTES/);
  });

  it("answers an oversized upload with 413 naming both sizes, not Express's HTML 500", async () => {
    const src = await readFile("server/index.ts", "utf8");
    // Anchored on the BRANCH, not on the first mention of the code — the doc
    // comment above it names LIMIT_FILE_SIZE too, and slicing from there reads
    // the prose instead of the handler.
    const at = src.indexOf('if (err?.code === "LIMIT_FILE_SIZE")');
    expect(at).toBeGreaterThan(-1);
    const handler = src.slice(at, at + 900);
    expect(handler).toMatch(/status\(413\)/);
    // It must carry the ceiling, or the message cannot name it.
    expect(handler).toMatch(/maxBytes:\s*UPLOAD_MAX_BYTES/);
  });

  it("is registered as a four-argument error handler, after the routes", async () => {
    const src = await readFile("server/index.ts", "utf8");
    const handlerAt = src.indexOf('if (err?.code === "LIMIT_FILE_SIZE")');
    // Four arguments is the ONLY thing that makes Express treat it as an error
    // handler rather than ordinary middleware; three would silently never run.
    expect(src).toMatch(/app\.use\(\(err: any, _req: express\.Request, res: express\.Response, _next: express\.NextFunction\)/);
    // After every upload route, or it cannot catch their errors.
    expect(handlerAt).toBeGreaterThan(src.lastIndexOf('upload.single("file")'));
  });
});

/**
 * A document is not usable until it is extracted, so extraction starts when the
 * document ARRIVES — not when a stage runs.
 *
 * Every route that puts new bytes into a project has to do it. `PUT
 * /api/documents` did not, and the failure was silent and permanent: extracts
 * are keyed by the source document's CONTENT HASH, so a replacement does not
 * invalidate the old extract — it asks for one that has never existed. The
 * project drops to `documents_not_ready`, every stage that hard-requires
 * extraction refuses, and nothing on that path was ever going to fix it.
 */
describe("extraction starts when a document arrives", () => {
  const routeBody = (src: string, decl: string) => {
    const at = src.indexOf(decl);
    if (at < 0) throw new Error(`route not found: ${decl}`);
    const end = src.indexOf("\n});", at);
    return src.slice(at, end);
  };

  it("every route that writes new document bytes starts it", async () => {
    const src = await readFile("server/index.ts", "utf8");
    const routes = [
      'app.post("/api/upload/project"',
      'app.post("/api/upload"',
      'app.put("/api/documents"',   // the one that did not
    ];
    const missing = routes.filter(r => !routeBody(src, r).includes("startExtraction("));
    expect(missing, `these accept a document and never extract it: ${missing.join(", ")}`).toEqual([]);
  });

  it("does not start it on DELETE, which removes bytes rather than adding them", async () => {
    const src = await readFile("server/index.ts", "utf8");
    expect(routeBody(src, 'app.delete("/api/documents"')).not.toContain("startExtraction(");
  });

  it("is fire-and-forget — a 300 MB document must not hold an HTTP request open", async () => {
    const src = await readFile("server/index.ts", "utf8");
    const fn = routeBody(src, "function startExtraction(");
    expect(fn).toMatch(/detached:\s*true/);
    expect(fn).toMatch(/child\.unref\(\)/);
    // Reported, never thrown: the file and its row are real either way, and
    // `extract-documents.mjs` is idempotent so the stage picks up what it missed.
    expect(fn).toMatch(/return \{ started: false/);
  });
});
