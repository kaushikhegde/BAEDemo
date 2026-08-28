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
describe("there is no upload ceiling left to have a source of truth for", () => {
  it("multer no longer caps the file size", async () => {
    // The cap existed because content travelled through this process's memory
    // and then base64 through a JSON body. Bytes go to object storage now,
    // addressed by their own hash, so the three ceilings behind it — 100 MB
    // here, ~384 MB from V8's cap on a base64 string, 1 GB from Postgres
    // bytea — are gone rather than raised. Two of the three were never ours to
    // raise, which is why raising was never the fix.
    const src = await readFile("server/index.ts", "utf8");
    expect(src).not.toMatch(/fileSize:/);
    expect(src).not.toMatch(/UPLOAD_MAX_BYTES/);
    expect(src).not.toMatch(/LIMIT_FILE_SIZE/);
  });

  it("no document is base64'd into a JSON body", async () => {
    const store = await readFile("server/store.ts", "utf8");
    expect(store).not.toMatch(/toString\("base64"\)/);
    // Raw bytes, metadata in the query string, because a request cannot have
    // two bodies.
    expect(store).toMatch(/application\/octet-stream/);
  });

  it("keeps the wrong-field-name handler, which is still a caller error", async () => {
    // Express's default for it is an HTML 500 — a caller error wearing the
    // costume of a server fault.
    const src = await readFile("server/index.ts", "utf8");
    expect(src).toMatch(/LIMIT_UNEXPECTED_FILE/);
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
    // Was a detached `spawn` with `child.unref()`. The mechanism changed and
    // the requirement did not: `void` on the promise is what makes the caller
    // return without awaiting a run that takes minutes.
    expect(fn).toMatch(/void .*startWorkflow\(/);
    expect(fn).not.toMatch(/await .*startWorkflow\(/);
    // Reported, never thrown: the file and its row are real either way, and
    // extraction is idempotent so a later run picks up what it missed.
    expect(fn).toMatch(/return \{ started: false/);
  });

  /**
   * It must start the WORKFLOW, never the extractor.
   *
   * `scripts/extract-documents.mjs` enumerates its inputs by walking
   * `projects/<p>/`, so on an install whose documents live in the store it
   * finds none, extracts none and exits 0 — a silent no-op reported as a
   * successful start. Nine documents in the store, `{"ready":0,"missing":0,
   * "documents":[]}` out, and `capabilities` refusing `documents_not_ready`
   * with nothing on that path able to fix it.
   *
   * Only the engine materialises that tree per step and harvests the extracts
   * back, so only the workflow can do this work correctly.
   */
  it("starts the extract workflow rather than spawning the extractor", async () => {
    const src = await readFile("server/index.ts", "utf8");
    const fn = routeBody(src, "function startExtraction(");
    expect(fn).toMatch(/startWorkflow\("extract"/);
    // Comments stripped first: this function's own documentation names the
    // script it no longer runs, and explaining why is the point of it.
    const code = fn.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/spawn\(|extract-documents\.mjs/);
  });
});

/**
 * "Which documents exist, and are they extracted?" has two answers on this
 * installation and both are real: projects created before ingest moved to the
 * store have their documents on DISK and nowhere else, everything since is in
 * the STORE and nowhere else. Answering from one is what broke this.
 */
describe("extraction state is read from both disk and the store", () => {
  it("merges them rather than picking one", async () => {
    const src = await readFile("server/index.ts", "utf8");
    const fn = src.slice(src.indexOf("async function extractionState("),
                         src.indexOf("function startExtraction("));
    expect(fn).toMatch(/projectState\(WORKSPACE_PATH, project\)/);
    expect(fn).toMatch(/store\.extractState\(/);
  });

  it("never lets an unreachable orchestrator fail a disk-era project", async () => {
    const src = await readFile("server/index.ts", "utf8");
    const fn = src.slice(src.indexOf("async function extractionState("),
                         src.indexOf("function startExtraction("));
    // Both sides catch: the orchestrator can be down while this server is up,
    // and a project that predates the store must still answer.
    expect(fn.match(/\.catch\(\(\) => null\)/g) ?? []).toHaveLength(2);
  });

  it("is what the document gate and the retry planner both read", async () => {
    // The gate is what refuses `no_documents` / `documents_not_ready`. Left on
    // the disk walk it would go on refusing every stage for a project whose
    // documents are all in the store — which is the bug, one layer down.
    const src = await readFile("server/index.ts", "utf8");
    expect(src).toMatch(/const st = await extractionState\(req, project\);\n {2}if \(st\.documents\.length === 0\)/);
    expect(src).toMatch(/const st = await extractionState\(req, project\);\n\s+const plan = planRetry/);
  });
});
