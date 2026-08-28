// The Docs tab's list, assembled from the STORE with disk as a fault report.
//
// The bug this closes: `GET /api/documents` built its list by walking
// `projects/<p>/documents/` and used the database only to annotate what the
// walk found. Once the plugin's ingest moved documents into the store, that
// directory stopped existing — `projects/SA-DEMO/` was not on disk at all — so
// the walk returned nothing, the nine rows were mapped over an empty array, and
// the tab rendered "0 documents" for a project holding nine.
//
// The route's own comment asserted the opposite ("Disk wins for what exists"),
// which is why the failure read as an empty project rather than a broken list.

import { describe, it, expect } from "vitest";
import {
  entryFromStoreRow, mergeDocumentSources, attachExtractState, isDiscoveryDocument,
  deleteOutcome, type StoreDocument,
} from "./document-list.js";
import type { DocumentEntry } from "./documents.js";

const storeRow = (over: Partial<StoreDocument> & { path: string }): StoreDocument => ({
  feature: null, bytes: 1024, createdAt: "2026-08-28T10:00:00.000Z",
  version: 1, category: null, ...over,
});

const diskEntry = (over: Partial<DocumentEntry> & { path: string }): DocumentEntry => ({
  name: over.path.split("/").pop()!,
  subfolder: "documents", level: "project", feature: null,
  bytes: 10, modifiedAt: "2026-08-01T00:00:00.000Z", kind: "markdown",
  original: null, ...over,
});

describe("entryFromStoreRow", () => {
  it("maps a project document onto the shape the tab already renders", () => {
    const e = entryFromStoreRow(storeRow({
      path: "documents/Introduction.md", bytes: 28567, version: 3,
      createdAt: "2026-08-28T09:48:00.000Z",
    }));

    expect(e).toMatchObject({
      name: "Introduction.md",
      path: "documents/Introduction.md",
      subfolder: "documents",
      level: "project",
      feature: null,
      bytes: 28567,
      // The version's creation IS its last modification — a document is never
      // edited in place in the store, it gets a new version.
      modifiedAt: "2026-08-28T09:48:00.000Z",
      kind: "markdown",
      version: 3,
      inDb: true,
    });
  });

  it("takes the subfolder from the path, so a feature document lands in its own tray", () => {
    // The disk walk knew the subfolder because it was told which folder it was
    // reading. A store row carries only the path, and the tab groups by
    // subfolder — get this wrong and every SOP renders under "Transcripts".
    const e = entryFromStoreRow(storeRow({
      path: "requirements/SOP/Onboarding.md", feature: "interim-benefits",
    }));
    expect(e).toMatchObject({
      subfolder: "SOP", level: "feature", feature: "interim-benefits",
      name: "Onboarding.md",
    });
  });

  it("classifies by extension, exactly as the disk walk does", () => {
    // An unconverted source in the store means the conversion did not happen,
    // and that is precisely why a stage that looks readable is refused with
    // `no_documents`. It has to read the same from either source.
    expect(entryFromStoreRow(storeRow({ path: "documents/a.pdf" })).kind).toBe("unconverted");
    expect(entryFromStoreRow(storeRow({ path: "documents/a.png" })).kind).toBe("image");
    expect(entryFromStoreRow(storeRow({ path: "documents/a.md" })).kind).toBe("markdown");
  });

  it("reports no original, rather than inventing one", () => {
    // The upload source is archived in S3 under the job id, not in
    // `original-files/`. A store row genuinely cannot say what it was converted
    // from, and guessing `Introduction.pdf` from `Introduction.md` would send
    // somebody looking for a file that may never have existed.
    expect(entryFromStoreRow(storeRow({ path: "documents/Introduction.md" })).original).toBeNull();
  });
});

describe("mergeDocumentSources", () => {
  it("returns the store's documents when disk holds nothing", () => {
    // SA-DEMO exactly: nine rows, no `projects/SA-DEMO/` directory at all.
    const merged = mergeDocumentSources(
      [entryFromStoreRow(storeRow({ path: "documents/a.md" }))], []);

    expect(merged).toHaveLength(1);
    expect(merged[0].inDb).toBe(true);
  });

  it("keeps a disk file that has no row, flagged as a fault", () => {
    // The safety net the old route provided in the other direction: a file that
    // landed outside the upload routes is invisible to every platform surface,
    // and staying silent about it is how 20-documents-on-disk / 2-rows happened.
    const merged = mergeDocumentSources([], [diskEntry({ path: "documents/stray.md" })]);

    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ path: "documents/stray.md", inDb: false });
  });

  it("prefers the store's copy when both have the same document", () => {
    // Disk, inside a materialised tree, can be a stale leftover. The store is
    // the record, so its byte count and version are the ones reported.
    const merged = mergeDocumentSources(
      [entryFromStoreRow(storeRow({ path: "documents/a.md", bytes: 900, version: 4 }))],
      [diskEntry({ path: "documents/a.md", bytes: 10 })]);

    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ bytes: 900, version: 4, inDb: true });
  });

  it("does not confuse a feature document with a project one of the same path", () => {
    // Two features can each hold `requirements/SOP/Onboarding.md`. Keyed on
    // path alone they collapse into one row and a feature silently loses a
    // document.
    const merged = mergeDocumentSources([
      entryFromStoreRow(storeRow({ path: "requirements/SOP/a.md", feature: "one" })),
      entryFromStoreRow(storeRow({ path: "requirements/SOP/a.md", feature: "two" })),
    ], []);

    expect(merged).toHaveLength(2);
    expect(merged.map(d => d.feature).sort()).toEqual(["one", "two"]);
  });

  it("sorts by path, so the tab's order does not depend on which source answered", () => {
    const merged = mergeDocumentSources(
      [entryFromStoreRow(storeRow({ path: "documents/b.md" }))],
      [diskEntry({ path: "documents/a.md" })]);
    expect(merged.map(d => d.path)).toEqual(["documents/a.md", "documents/b.md"]);
  });
});

describe("attachExtractState", () => {
  const states = [
    { docId: "documents/a.md", scope: "project", state: "ready" as const, extractPath: "x" },
    {
      docId: "documents/b.md", scope: "project", state: "failed" as const, extractPath: "y",
      reason: "claude exited 0 without writing an extract", attempts: 2,
      firstFailedAt: "2026-08-28T09:00:00.000Z", lastFailedAt: "2026-08-28T09:30:00.000Z",
    },
    { docId: "requirements/SOP/c.md", scope: "one", state: "extracting" as const, extractPath: "z" },
  ];

  it("puts each document's own progress on its own card", () => {
    const entries = [
      entryFromStoreRow(storeRow({ path: "documents/a.md" })),
      entryFromStoreRow(storeRow({ path: "documents/b.md" })),
    ];
    const out = attachExtractState(entries, states);

    expect(out[0].extract).toMatchObject({ state: "ready" });
    expect(out[1].extract).toMatchObject({ state: "failed" });
  });

  it("carries the reason and the attempt count a failure needs", () => {
    // Without these the card says "failed" and the only way to learn which
    // document and why is a separate extract_status call. `attempts` is what
    // separates "the model had a bad night" from "this will never extract".
    const out = attachExtractState(
      [entryFromStoreRow(storeRow({ path: "documents/b.md" }))], states);

    expect(out[0].extract).toMatchObject({
      state: "failed", attempts: 2,
      reason: "claude exited 0 without writing an extract",
      lastFailedAt: "2026-08-28T09:30:00.000Z",
    });
  });

  it("keys on scope AND path, so a feature's document gets its own state", () => {
    const out = attachExtractState(
      [entryFromStoreRow(storeRow({ path: "requirements/SOP/c.md", feature: "one" }))], states);
    expect(out[0].extract).toMatchObject({ state: "extracting" });
  });

  it("reports a document with no extract state as missing, not as unknown", () => {
    // "Uploaded, not yet extracted" is the NORMAL state for the first minute
    // after an upload, and it is the state `capabilities` refuses on. A card
    // with no badge would read as "nothing to do here".
    const out = attachExtractState(
      [entryFromStoreRow(storeRow({ path: "documents/never-seen.md" }))], states);
    expect(out[0].extract).toMatchObject({ state: "missing" });
  });

  it("leaves a non-markdown document alone", () => {
    // Only markdown is extracted. Badging a PNG "missing" invites a retry that
    // can never succeed.
    const out = attachExtractState(
      [entryFromStoreRow(storeRow({ path: "documents/screen.png" }))], states);
    expect(out[0].extract).toBeUndefined();
  });
});

describe("isDiscoveryDocument", () => {
  it("keeps the folders the pipeline actually reads", () => {
    expect(isDiscoveryDocument("documents/Introduction.md", null)).toBe(true);
    expect(isDiscoveryDocument("requirements/SOP/a.md", "f")).toBe(true);
    expect(isDiscoveryDocument("requirements/Transcripts/a.md", "f")).toBe(true);
    expect(isDiscoveryDocument("requirements/Notes/a.md", "f")).toBe(true);
    expect(isDiscoveryDocument("requirements/UI/a.png", "f")).toBe(true);
  });

  it("drops generated output the disk walk never saw", () => {
    // The disk walk read `documents/` and `requirements/<sub>/` and nothing
    // else. The store holds EVERYTHING the project owns, so listing it whole
    // puts seven `.extract.json` files and every rendered artefact in the tab
    // beside the client's actual documents. SA-DEMO has exactly this: 9
    // documents and 7 extracts under one project.
    expect(isDiscoveryDocument("solutions/Extracts/d441.extract.json", null)).toBe(false);
    expect(isDiscoveryDocument("outputs/product-summary.md", "f")).toBe(false);
    expect(isDiscoveryDocument("solutions/UI/outputs/mockups.json", "f")).toBe(false);
  });

  it("drops the archived upload sources", () => {
    // `original-files/` holds the .pdf a document was converted FROM. Counting
    // those as documents is how a converted document appeared twice.
    expect(isDiscoveryDocument("original-files/requirements/Notes/a.pdf", null)).toBe(false);
  });

  it("does not accept a project folder at feature level, or the reverse", () => {
    // The two levels have different folders and a row carries only a path;
    // without the level the check would pass `documents/x.md` for a feature.
    expect(isDiscoveryDocument("documents/a.md", "f")).toBe(false);
    expect(isDiscoveryDocument("requirements/SOP/a.md", null)).toBe(false);
  });

  it("refuses a lookalike prefix", () => {
    expect(isDiscoveryDocument("documents-old/a.md", null)).toBe(false);
    expect(isDiscoveryDocument("requirements/SOPs/a.md", "f")).toBe(false);
  });
});

describe("deleteOutcome", () => {
  it("removes a document that only exists in the store", () => {
    // The bug: the route 404ed the moment the DISK delete found nothing, which
    // is every document now. SA-DEMO reported "No document at
    // documents/ARC-CX-014_….md" with that document listed one row above.
    expect(deleteOutcome(false, "created")).toMatchObject({ removed: true });
  });

  it("removes a document that only exists on disk", () => {
    // A file with no row — the `inDb: false` case the tab flags. Deleting it is
    // exactly how somebody clears one.
    expect(deleteOutcome(true, "exists")).toMatchObject({ removed: true });
  });

  it("removes a row whose BYTES are gone", () => {
    // The case that matters most here: those are the documents somebody wants
    // rid of, and refusing because the content cannot be fetched strands them.
    // The row retires on its own; content is never read to delete it.
    expect(deleteOutcome(false, "created")).toMatchObject({ removed: true });
  });

  it("refuses when neither store had it, and says nothing more", () => {
    expect(deleteOutcome(false, "exists")).toMatchObject({ removed: false, reason: null });
  });

  it("distinguishes a refusal from an absence", () => {
    // A database that said no and a document that was never there read the same
    // on screen — "No document at …" — and have completely different fixes.
    expect(deleteOutcome(false, "failed").reason).toMatch(/refused/);
    expect(deleteOutcome(false, "skipped").reason).toMatch(/signed in/);
  });

  it("counts a disk delete even when the row write failed", () => {
    // Something WAS removed. Reporting 404 would invite a second delete against
    // a file that is already gone.
    expect(deleteOutcome(true, "failed")).toMatchObject({ removed: true });
  });
});
