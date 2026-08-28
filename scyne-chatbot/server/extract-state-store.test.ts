// Extraction state read from the STORE rather than from disk.
//
// The disk version (`scripts/extract-state.mjs`) is still correct and still
// used — it runs inside a materialised tree, where the files really are on
// disk. This is the same question asked of the store, for the two callers that
// are NOT inside a run: `/api/extract-status` and the retry planner.
//
// The bug it exists to close: documents stopped being written to
// `projects/<p>/documents/` when the plugin's ingest moved to the store, so
// walking disk answered "0 documents" for a project holding nine. Every stage
// that hard-requires extraction then refused, and nothing on that path was
// ever going to fix it.

import { describe, it, expect } from "vitest";
import { projectStateFromStore, type StoreDocRow } from "./extract-state-store.js";

/** sha256 of the bytes; the extract is named by its first 16 hex characters. */
const row = (over: Partial<StoreDocRow> & { path: string }): StoreDocRow => ({
  sha256: "a".repeat(64), featureId: null, bytes: 10, ...over,
});

const ready = JSON.stringify({
  version: 1, docId: "documents/a.md", scope: "project", category: "documents",
  windows: [{ pageStart: 1, pageEnd: 1 }],
  businessFunctions: [], processSteps: [], actors: [], serviceTiers: [],
  components: [], maturitySignals: [], lifecyclePhases: [], painPoints: [],
  coverage: { pagesRead: 1, pagesTotal: 1, truncated: false },
});

describe("projectStateFromStore", () => {
  it("finds project documents the disk walk could not see", async () => {
    const rows = [row({ path: "documents/a.md", sha256: "ab".repeat(32) })];
    const st = await projectStateFromStore(rows, new Map(), async () => null);

    expect(st.documents).toHaveLength(1);
    expect(st.documents[0]).toMatchObject({ docId: "documents/a.md", scope: "project", state: "missing" });
    expect(st.missing).toBe(1);
  });

  it("reads a document as ready when its extract is in the store", async () => {
    const sha = "cd".repeat(32);
    const rows = [
      row({ path: "documents/a.md", sha256: sha }),
      row({ path: `solutions/Extracts/${sha.slice(0, 16)}.extract.json` }),
    ];
    const st = await projectStateFromStore(rows, new Map(), async () => ready);

    expect(st.ready).toBe(1);
    expect(st.documents[0].state).toBe("ready");
  });

  it("treats a failure marker as failed, carrying its reason and attempt count", async () => {
    const sha = "ef".repeat(32);
    const rows = [
      row({ path: "documents/a.md", sha256: sha }),
      row({ path: `solutions/Extracts/${sha.slice(0, 16)}.extract.failed.json` }),
    ];
    const st = await projectStateFromStore(rows, new Map(), async () =>
      JSON.stringify({ reason: "no text layer in PDF", attempts: 4 }));

    expect(st.failed).toBe(1);
    expect(st.documents[0]).toMatchObject({
      state: "failed", reason: "no text layer in PDF", attempts: 4,
    });
  });

  // The disk version is explicit that a file which exists but does not validate
  // is FAILED and never ready: "a naive does-the-file-exist check is how a
  // malformed extract silently shrinks the capability map." Presence in the
  // store is no better evidence than presence on disk.
  it("refuses to call a malformed extract ready", async () => {
    const sha = "12".repeat(32);
    const rows = [
      row({ path: "documents/a.md", sha256: sha }),
      row({ path: `solutions/Extracts/${sha.slice(0, 16)}.extract.json` }),
    ];
    const st = await projectStateFromStore(rows, new Map(), async () => "{\"version\":1}");

    expect(st.ready).toBe(0);
    expect(st.documents[0].state).toBe("failed");
  });

  it("scopes a feature's discovery documents to that feature, by name", async () => {
    const rows = [
      row({ path: "requirements/SOP/b.md", featureId: "f1", sha256: "34".repeat(32) }),
      row({ path: "requirements/Transcripts/c.md", featureId: "f1", sha256: "56".repeat(32) }),
    ];
    const st = await projectStateFromStore(rows, new Map([["f1", "Appeals"]]), async () => null);

    expect(st.documents.map(d => d.scope)).toEqual(["Appeals", "Appeals"]);
    expect(st.documents.map(d => d.docId))
      .toEqual(["requirements/SOP/b.md", "requirements/Transcripts/c.md"]);
  });

  // `requirements/project/` is the parent's own artefacts staged DOWN on every
  // run. The disk walk excludes it for a reason its comment spells out: a walk
  // that swept it would feed the capability map its own previous output as if
  // it were client evidence. The store must exclude it on the same grounds.
  it("never treats staged-down project artefacts as discovery documents", async () => {
    const rows = [
      row({ path: "requirements/project/capability-process.md", featureId: "f1" }),
      row({ path: "requirements/templates/house-style.md", featureId: "f1" }),
      row({ path: "outputs/product-summary.md", featureId: "f1" }),
    ];
    const st = await projectStateFromStore(rows, new Map([["f1", "Appeals"]]), async () => null);

    expect(st.documents).toEqual([]);
  });

  it("does not mistake an extract for a document to be extracted", async () => {
    const rows = [row({ path: "solutions/Extracts/00112233aabbccdd.extract.json" })];
    const st = await projectStateFromStore(rows, new Map(), async () => ready);

    expect(st.documents).toEqual([]);
  });
});
