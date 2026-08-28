// A document is not USABLE until it has been extracted, so extraction starts
// when the document ARRIVES — not when a stage runs.
//
// `scyne-chatbot/server/limits.test.ts` asserts this for the three chatbot
// upload routes, and its comment explains why the failure is silent and
// permanent. This is the same invariant for the plugin's own door, which did
// not have it: `ingest_document` stored the bytes and the row and stopped, so
// nine documents ingested here left the project unable to run `capabilities`
// for ever, with nothing anywhere reporting a fault.
//
// Read as SOURCE rather than driven end-to-end on purpose. Exercising the real
// call needs S3, a worker pool and a live orchestrator — the integration tests
// that do are `*.int.test.ts` and they do not run everywhere. What breaks this
// invariant is somebody deleting the call, and reading the source catches that
// wherever the suite runs.

import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const src = (p: string) => readFile(resolve(here, "../src", p), "utf8");

describe("ingest_document starts extraction", () => {
  it("calls it after the document is stored", async () => {
    const s = await src("workspace/tools/ingest-document.ts");
    expect(s).toMatch(/startExtraction\(ctx, args\.project\)/);

    // Order matters: extracting before the row exists would key an extract to
    // a document the store does not have.
    expect(s.indexOf("postDocument(")).toBeLessThan(s.indexOf("startExtraction(ctx,"));
  });

  it("starts the WORKFLOW, never the extractor directly", async () => {
    // `scripts/extract-documents.mjs` enumerates its inputs by walking
    // `projects/<p>/`, which holds nothing where documents live in the store.
    // Only the engine materialises that tree — and harvests the extracts back
    // out of it, which a bare spawn would leave in a temp directory to be
    // deleted. Running the script directly finds nothing and exits 0.
    const s = await src("workspace/tools/ingest-document.ts");
    expect(s).toMatch(/startStage\(ctx, \{\s*workflow: "extract"/);
    expect(s).not.toMatch(/spawn\(|extract-documents\.mjs['"]/);
  });

  it("passes the project's CANONICAL name, not the caller's string", async () => {
    // `resolveProject` matches slug and case; the engine's `createIssue`
    // matches `projects.name` exactly when resolving `issues.project_id`. A
    // caller who typed a slug would otherwise get an issue with no project,
    // and a run against an empty tree rather than a failure naming the cause.
    const s = await src("workspace/tools/ingest-document.ts");
    expect(s).toMatch(/const \{ name \} = await resolveProject\(ctx, project\)/);
    expect(s).toMatch(/startStage\(ctx, \{\s*workflow: "extract", project: name,/);
  });

  it("never fails the ingest when extraction cannot be started", async () => {
    // The document and its row are real either way, and `extract_status`
    // reports what is still missing. Throwing here would turn a stored
    // document into a failed call and invite a duplicate upload.
    const s = await src("workspace/tools/ingest-document.ts");
    const fn = s.slice(s.indexOf("const startExtraction ="), s.indexOf("export const ingestDocument"));
    expect(fn).toMatch(/catch/);
    expect(fn).toMatch(/return \{ started: false/);
    expect(fn).not.toMatch(/throw /);
  });

  it("reports the outcome in the result rather than only logging it", async () => {
    const s = await src("workspace/tools/ingest-document.ts");
    expect(s).toMatch(/extraction: \{ started: boolean; issueId: string \| null; coalesced: boolean; error: string \| null \}/);
    expect(s).toMatch(/^\s*extraction,$/m);
  });

  it("coalesces onto the project's open extract issue", async () => {
    // Extraction starts once per DOCUMENT, and an upload of fifty documents is
    // fifty calls. Without a key that is fifty issues, each materialising its
    // own scratch tree and sweeping the same document set — `claimPartial` is a
    // `wx` lock on local disk and cannot see across trees, so the same document
    // is extracted by several of them and paid for several times. SA-DEMO's
    // three-file upload measured it: 3 issues, 6 agent runs for 3 documents.
    //
    // The key is per PROJECT because `extract` is a project-level stage: one
    // pass sweeps the project's own documents and every feature's discovery
    // folders, so there is exactly one useful unit of work per project.
    const s = await src("workspace/tools/ingest-document.ts");
    const fn = s.slice(s.indexOf("const startExtraction ="), s.indexOf("export const ingestDocument"));
    expect(fn).toMatch(/coalesceKey: `extract:\$\{name\}`/);
  });

  it("keys the coalesce on the CANONICAL name, as it does the project", async () => {
    // A key built from the caller's string would put `sa-demo` and `SA-DEMO` on
    // different keys and coalesce neither onto the other — the same class of
    // bug as the project param itself, and invisible until two doors disagree.
    const s = await src("workspace/tools/ingest-document.ts");
    const fn = s.slice(s.indexOf("const startExtraction ="), s.indexOf("export const ingestDocument"));
    expect(fn).not.toMatch(/extract:\$\{project\}/);
  });

  it("reports whether it joined an existing issue or started one", async () => {
    // Fifty ingests returning the same issueId is the SUCCESS case, and a
    // caller that cannot tell it from fifty separate starts cannot report what
    // happened. This is the plugin-side half of the router's 200-vs-201.
    const s = await src("workspace/tools/ingest-document.ts");
    expect(s).toMatch(/coalesced: boolean/);
  });
});
