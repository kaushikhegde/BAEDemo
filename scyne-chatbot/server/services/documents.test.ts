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
import { listDocuments, deleteDocument, resolveDocument, readDocument, excerptOf } from "./documents.js";
import { CONVERTIBLE, PLAIN_TEXT } from "../../../scripts/convert-to-md.mjs";

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

  // A PowerPoint used to be classified from a hand-copied list that included
  // .pptx while the converter could not read one — so the deck sat in SA-PN
  // badged "not converted … yet", waiting for a conversion nothing would ever
  // perform. It converts now, through anydoc, and the badge is finally true.
  it("reports a PowerPoint deck as a source awaiting conversion", async () => {
    await write(`projects/${P}/documents/slides.pptx`);
    const [doc] = (await listDocuments(ws, P, F)).project;
    expect(doc.kind).toBe("unconverted");
  });

  // The classification is the converter's own list, not a copy of it. Asserted
  // in BOTH directions, because the copy that was here had drifted both ways:
  // it claimed formats the converter could not read, and missed ones it could.
  it("classifies exactly what the converter can read, and nothing else", async () => {
    for (const ext of [...CONVERTIBLE, ...PLAIN_TEXT]) {
      await write(`projects/${P}/documents/sample${ext}`);
      const doc = (await listDocuments(ws, P, F)).project.find(d => d.name === `sample${ext}`)!;
      const expected = ext === ".md" || ext === ".markdown" ? "markdown" : "unconverted";
      expect([ext, doc.kind]).toEqual([ext, expected]);
    }
    for (const ext of [".key", ".pages", ".zip", ".exe"]) {
      await write(`projects/${P}/documents/other${ext}`);
      const doc = (await listDocuments(ws, P, F)).project.find(d => d.name === `other${ext}`)!;
      expect([ext, doc.kind]).toEqual([ext, "other"]);
    }
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

describe("readDocument", () => {
  it("returns the bytes of a document, with what a header needs to label it", async () => {
    await write(`projects/${P}/${F}/requirements/SOP/handling.md`, "# Handling\n\nStep one.");
    const r = await readDocument(ws, P, F, "requirements/SOP/handling.md");

    expect(r).not.toBeNull();
    expect(r!.content).toBe("# Handling\n\nStep one.");
    expect(r!.name).toBe("handling.md");
    expect(r!.path).toBe("requirements/SOP/handling.md");
    expect(r!.bytes).toBe(21);
  });

  it("reports the converter's banner, which is exact provenance", async () => {
    // `original` is the ARCHIVED file, which exists for anything uploaded —
    // including a .md that was never converted at all. The banner is written by
    // convert-to-md.mjs and by nothing else, so it is the only signal that says
    // "this markdown was MACHINE-GENERATED from another format", which is what
    // decides whether the preview has to preserve its line structure.
    await write(`projects/${P}/${F}/requirements/Notes/report.md`,
      "<!-- Converted from report.pdf by markitdown-ts. Regenerate with scripts/convert-to-md.mjs. -->\n\nBody.");

    const r = await readDocument(ws, P, F, "requirements/Notes/report.md");
    expect(r!.convertedFrom).toBe("report.pdf");
  });

  it("reports no banner as no conversion", async () => {
    await write(`projects/${P}/documents/handwritten.md`, "# Written by a person");
    expect((await readDocument(ws, P, null, "documents/handwritten.md"))!.convertedFrom).toBeNull();
  });

  it("keeps the banner in the content, so a raw view can show the whole file", async () => {
    // Hiding it here would make `Source` a lie. The PREVIEW strips it for the
    // rendered view; the file is the file.
    await write(`projects/${P}/documents/x.md`, "<!-- Converted from x.pdf by markitdown-ts. -->\n\nBody.");
    expect((await readDocument(ws, P, null, "documents/x.md"))!.content).toMatch(/^<!-- Converted from/);
  });

  it("names the archived source, so a preview says what it was converted from", async () => {
    await write(`projects/${P}/${F}/requirements/SOP/handling.md`, "# H");
    await write(`projects/${P}/${F}/original-files/requirements/SOP/handling.docx`, "x");

    const r = await readDocument(ws, P, F, "requirements/SOP/handling.md");
    expect(r!.original).toBe("original-files/requirements/SOP/handling.docx");
  });

  it("reads a project-level document", async () => {
    await write(`projects/${P}/documents/policy.md`, "# Policy");
    expect((await readDocument(ws, P, null, "documents/policy.md"))!.content).toBe("# Policy");
  });

  it("is null for a path that is not there", async () => {
    expect(await readDocument(ws, P, F, "requirements/SOP/ghost.md")).toBeNull();
  });

  it("refuses to read something that is not a document", async () => {
    // The route behind this is reachable with any path a caller invents. A
    // generated product summary is not a document, and `.published.json` holds
    // the wiki identity of every artefact.
    await write(`projects/${P}/${F}/outputs/product-summary.md`, "secret");
    await expect(readDocument(ws, P, F, "outputs/product-summary.md")).rejects.toThrow(/not a document/i);
    await expect(readDocument(ws, P, null, "../.env")).rejects.toThrow(/outside|invalid/i);
  });

  it("refuses a binary file rather than returning mojibake", async () => {
    // requirements/UI holds screenshots. Decoding a PNG as utf8 produces
    // gibberish that renders as a document, which is worse than a refusal.
    await write(`projects/${P}/${F}/requirements/UI/screen.png`, "\x89PNG\r\n");
    await expect(readDocument(ws, P, F, "requirements/UI/screen.png")).rejects.toThrow(/not text/i);
  });

  it("reads a source that never converted, because that is what you want to look at", async () => {
    // A .txt sitting unconverted is exactly the file somebody opens to work out
    // why a stage says it has no documents.
    await write(`projects/${P}/${F}/requirements/Notes/raw.txt`, "plain notes");
    expect((await readDocument(ws, P, F, "requirements/Notes/raw.txt"))!.content).toBe("plain notes");
  });
});

describe("excerptOf", () => {
  it("returns the opening of the document", () => {
    expect(excerptOf("# Title\n\nFirst line of prose.", 200)).toBe("# Title\n\nFirst line of prose.");
  });

  it("cuts at a word boundary and marks the cut", () => {
    const r = excerptOf("alpha beta gamma delta epsilon", 14);
    expect(r).toBe("alpha beta…");
    expect(r.length).toBeLessThanOrEqual(15);
  });

  it("drops YAML front matter, which is metadata and not the document", () => {
    expect(excerptOf("---\ntitle: X\nauthor: Y\n---\n# Real Title\n\nBody.", 200))
      .toBe("# Real Title\n\nBody.");
  });

  it("drops the converter's own banner, which is provenance and not the document", () => {
    // `convert-to-md.mjs` prepends `<!-- Converted from X.pdf by markitdown-ts.
    // Regenerate with scripts/convert-to-md.mjs. -->` to everything it writes —
    // and that is MOST documents here. Measured on SA-Demo: two of three cards
    // showed a build note and no document.
    const banner = "<!-- Converted from Introduction.pdf by markitdown-ts. Regenerate with scripts/convert-to-md.mjs. -->\n\n";
    expect(excerptOf(banner + "# Real Title\n\nBody.", 200)).toBe("# Real Title\n\nBody.");
  });

  it("keeps a comment that is not at the top, which is part of the prose", () => {
    expect(excerptOf("# Title\n\n<!-- a note -->\n\nBody.", 200))
      .toBe("# Title\n\n<!-- a note -->\n\nBody.");
  });

  it("drops front matter and a banner together", () => {
    expect(excerptOf("---\ntitle: X\n---\n<!-- Converted from a.pdf -->\n\n# T", 200)).toBe("# T");
  });

  it("collapses long runs of blank lines, which would spend the whole card", () => {
    expect(excerptOf("# A\n\n\n\n\nB", 200)).toBe("# A\n\nB");
  });

  it("is empty for an empty document rather than throwing", () => {
    expect(excerptOf("", 200)).toBe("");
    expect(excerptOf("   \n\n  ", 200)).toBe("");
  });

  it("does not cut mid-word when there is no space to cut at", () => {
    // A single long token — a URL, a base64 blob — has no boundary. Cutting
    // hard is right; returning nothing is not.
    expect(excerptOf("a".repeat(50), 10)).toBe("aaaaaaaaaa…");
  });
});
