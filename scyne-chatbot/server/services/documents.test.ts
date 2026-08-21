// The documents a person can see and act on, and what removing one takes with it.
//
// Disk is what the STAGES read: every gate counts `.md` under `projects/<p>/`,
// and every skill reads the folder tree. So a delete that only retired a
// database row would report success and change nothing an agent does.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { listDocuments, deleteDocument, resolveDocument } from "./documents.js";

let ws: string;
const P = "SAPN", F = "MVP";

const write = async (rel: string, body = "x") => {
  const full = path.join(ws, rel);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, body, "utf8");
  return full;
};
const there = (rel: string) => fs.access(path.join(ws, rel)).then(() => true, () => false);

beforeEach(() => { ws = mkdtempSync(path.join(tmpdir(), "scyne-docs-")); });
afterEach(() => rmSync(ws, { recursive: true, force: true }));

describe("listDocuments", () => {
  it("separates the project's own documents from a feature's", async () => {
    await write(`projects/${P}/documents/policy.md`);
    await write(`projects/${P}/${F}/requirements/SOP/handling.md`);

    const r = await listDocuments(ws, P, F);
    expect(r.project.map(d => d.path)).toEqual(["documents/policy.md"]);
    expect(r.feature.map(d => d.path)).toEqual(["requirements/SOP/handling.md"]);
  });

  it("returns the project's documents with no feature asked for", async () => {
    await write(`projects/${P}/documents/policy.md`);
    await write(`projects/${P}/${F}/requirements/SOP/handling.md`);

    const r = await listDocuments(ws, P);
    expect(r.project.map(d => d.path)).toEqual(["documents/policy.md"]);
    expect(r.feature).toEqual([]);
  });

  it("reads every discovery subfolder, and tags which one", async () => {
    for (const sub of ["SOP", "Transcripts", "Notes", "UI"]) {
      await write(`projects/${P}/${F}/requirements/${sub}/thing.md`);
    }
    const r = await listDocuments(ws, P, F);
    expect(r.feature.map(d => d.subfolder).sort()).toEqual(["Notes", "SOP", "Transcripts", "UI"]);
  });

  it("leaves templates/ out — it is house style, not the client's material", async () => {
    await write(`projects/${P}/${F}/requirements/templates/house.md`);
    await write(`projects/${P}/${F}/requirements/SOP/real.md`);

    expect((await listDocuments(ws, P, F)).feature.map(d => d.path))
      .toEqual(["requirements/SOP/real.md"]);
  });

  it("leaves the staged-down project/ copy out — it is not this feature's document", async () => {
    // `requirements/project/` is copied DOWN from the parent on every run.
    // Offering it for deletion would let someone delete a copy that comes back.
    await write(`projects/${P}/${F}/requirements/project/documents/policy.md`);
    expect((await listDocuments(ws, P, F)).feature).toEqual([]);
  });

  it("leaves archived originals out — they are a record, not a live document", async () => {
    await write(`projects/${P}/${F}/original-files/requirements/SOP/handling.docx`);
    expect((await listDocuments(ws, P, F)).feature).toEqual([]);
  });

  it("names the archived source a markdown document was converted from", async () => {
    // What a person recognises is the file they uploaded, which the converter
    // replaced. Without this the row says `handling.md` and they are looking
    // for `handling.docx`.
    await write(`projects/${P}/${F}/requirements/SOP/handling.md`);
    await write(`projects/${P}/${F}/original-files/requirements/SOP/handling.docx`);

    const [doc] = (await listDocuments(ws, P, F)).feature;
    expect(doc.original).toBe("original-files/requirements/SOP/handling.docx");
  });

  it("carries size and mtime, so a listing can be sorted and read", async () => {
    await write(`projects/${P}/documents/policy.md`, "some content");
    const [doc] = (await listDocuments(ws, P)).project;
    expect(doc.bytes).toBe(12);
    expect(Number.isNaN(Date.parse(doc.modifiedAt))).toBe(false);
  });

  it("reports an image as an image rather than pretending it is readable", async () => {
    // requirements/UI holds client-supplied screens. The converter skips them
    // by design, so calling one "not yet converted" would be a lie.
    await write(`projects/${P}/${F}/requirements/UI/screen.png`);
    const [doc] = (await listDocuments(ws, P, F)).feature;
    expect(doc.kind).toBe("image");
  });

  it("reports a source that never converted, which is why a stage says no documents", async () => {
    await write(`projects/${P}/${F}/requirements/SOP/handling.docx`);
    const [doc] = (await listDocuments(ws, P, F)).feature;
    expect(doc.kind).toBe("unconverted");
  });

  it("is empty, not an error, for a project with nothing in it", async () => {
    await write(`projects/${P}/description.md`);
    expect(await listDocuments(ws, P, F)).toEqual({ project: [], feature: [] });
  });
});

describe("resolveDocument", () => {
  it("refuses a path that climbs out of the project", async () => {
    for (const p of ["../../../etc/passwd", "documents/../../secrets.md", "../description.md"]) {
      expect(() => resolveDocument(ws, P, null, p)).toThrow(/outside|invalid/i);
    }
  });

  it("refuses a path outside the folders documents live in", async () => {
    // outputs/ and solutions/ are generated artefacts. A delete route that
    // accepted them would let someone remove a published product summary from
    // a screen labelled Documents.
    for (const p of ["outputs/product-summary.md", "solutions/UI/outputs/mockups.json", ".published.json"]) {
      expect(() => resolveDocument(ws, P, F, p)).toThrow(/not a document/i);
    }
  });

  it("refuses an absolute path", () => {
    expect(() => resolveDocument(ws, P, null, "/etc/passwd")).toThrow();
  });

  it("accepts the two shapes a document actually has", () => {
    expect(resolveDocument(ws, P, null, "documents/policy.md"))
      .toBe(path.join(ws, "projects", P, "documents", "policy.md"));
    expect(resolveDocument(ws, P, F, "requirements/SOP/handling.md"))
      .toBe(path.join(ws, "projects", P, F, "requirements", "SOP", "handling.md"));
  });
});

describe("deleteDocument", () => {
  it("removes the file the stages read", async () => {
    await write(`projects/${P}/${F}/requirements/SOP/handling.md`);
    const r = await deleteDocument(ws, P, F, "requirements/SOP/handling.md");

    expect(r.removed).toContain("requirements/SOP/handling.md");
    expect(await there(`projects/${P}/${F}/requirements/SOP/handling.md`)).toBe(false);
  });

  it("takes the archived original with it", async () => {
    // Left behind, the next conversion pass resurrects a document that was
    // deliberately deleted — and the person who deleted it is not watching.
    await write(`projects/${P}/${F}/requirements/SOP/handling.md`);
    await write(`projects/${P}/${F}/original-files/requirements/SOP/handling.docx`);

    const r = await deleteDocument(ws, P, F, "requirements/SOP/handling.md");

    expect(r.removed).toContain("original-files/requirements/SOP/handling.docx");
    expect(await there(`projects/${P}/${F}/original-files/requirements/SOP/handling.docx`)).toBe(false);
  });

  it("takes the disambiguated form too", async () => {
    // convert-to-md writes `foo.docx.md` when a foreign `foo.md` was already
    // there, so the archived source's stem is the WHOLE of `foo.docx`.
    await write(`projects/${P}/${F}/requirements/Notes/report.docx.md`);
    await write(`projects/${P}/${F}/original-files/requirements/Notes/report.docx`);

    const r = await deleteDocument(ws, P, F, "requirements/Notes/report.docx.md");
    expect(await there(`projects/${P}/${F}/original-files/requirements/Notes/report.docx`)).toBe(false);
    expect(r.removed).toHaveLength(2);
  });

  it("does not take an unrelated file that merely shares a prefix", async () => {
    await write(`projects/${P}/${F}/requirements/SOP/handling.md`);
    await write(`projects/${P}/${F}/original-files/requirements/SOP/handling-appendix.docx`);

    await deleteDocument(ws, P, F, "requirements/SOP/handling.md");
    expect(await there(`projects/${P}/${F}/original-files/requirements/SOP/handling-appendix.docx`)).toBe(true);
  });

  it("removes a project document from the project's own archive", async () => {
    await write(`projects/${P}/documents/policy.md`);
    await write(`projects/${P}/original-files/documents/policy.pdf`);

    await deleteDocument(ws, P, null, "documents/policy.md");
    expect(await there(`projects/${P}/documents/policy.md`)).toBe(false);
    expect(await there(`projects/${P}/original-files/documents/policy.pdf`)).toBe(false);
  });

  it("reports a path that is not there rather than claiming a delete", async () => {
    const r = await deleteDocument(ws, P, F, "requirements/SOP/ghost.md");
    expect(r.found).toBe(false);
    expect(r.removed).toEqual([]);
  });

  it("does not touch the same-named document at the other level", async () => {
    await write(`projects/${P}/documents/notes.md`);
    await write(`projects/${P}/${F}/requirements/Notes/notes.md`);

    await deleteDocument(ws, P, F, "requirements/Notes/notes.md");
    expect(await there(`projects/${P}/documents/notes.md`)).toBe(true);
  });

  it("refuses to delete something that is not a document", async () => {
    await write(`projects/${P}/${F}/outputs/product-summary.md`);
    await expect(deleteDocument(ws, P, F, "outputs/product-summary.md")).rejects.toThrow(/not a document/i);
    expect(await there(`projects/${P}/${F}/outputs/product-summary.md`)).toBe(true);
  });
});
