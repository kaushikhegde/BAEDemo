import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { extractPages, pdfPageCount, readMetadata } from "../src/worker/extract/index.js";
import type { PageText } from "../src/worker/chunk.js";

const here = dirname(fileURLToPath(import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "afp-ex-"));
const pdf = join(dir, "doc.pdf");

beforeAll(() => {
  execFileSync("node", [
    resolve(here, "../scripts/make-fixture-pdf.mjs"), pdf, "60",
    "--needle", "NEEDLE_ON_37", "--needle-page", "37",
  ]);
});

const drain = async (gen: AsyncGenerator<PageText>) => {
  const out: PageText[] = [];
  for await (const p of gen) out.push(p);
  return out;
};

describe("PDF extraction", () => {
  it("counts pages without reading the whole document", async () => {
    expect(await pdfPageCount(pdf)).toBe(60);
  });

  it("yields every page exactly once, in order", async () => {
    const pages = await drain(extractPages(pdf, ".pdf", { pageWindow: 25 }));
    expect(pages).toHaveLength(60);
    expect(pages.map((p) => p.page)).toEqual(Array.from({ length: 60 }, (_, i) => i + 1));
  });

  it("keeps text on the page it came from, across a window boundary", () => {
    // Page 37 sits in the SECOND window (26-50). A window off-by-one shows up
    // here and nowhere else.
    return drain(extractPages(pdf, ".pdf", { pageWindow: 25 })).then((pages) => {
      expect(pages[36].page).toBe(37);
      expect(pages[36].text).toContain("NEEDLE_ON_37");
      expect(pages[35].text).not.toContain("NEEDLE_ON_37");
      expect(pages[11].text).toContain("Page 12 of 60");
    });
  });

  it("gives the same pages whatever the window size", async () => {
    const a = await drain(extractPages(pdf, ".pdf", { pageWindow: 7 }));
    const b = await drain(extractPages(pdf, ".pdf", { pageWindow: 1000 }));
    expect(a.map((p) => p.page)).toEqual(b.map((p) => p.page));
    expect(a[36].text).toContain("NEEDLE_ON_37");
    expect(b[36].text).toContain("NEEDLE_ON_37");
  });

  it("reports metadata", async () => {
    expect((await readMetadata(pdf, ".pdf")).pages).toBe(60);
  });
});

describe("plain text extraction", () => {
  it("yields the file as one page", async () => {
    const md = join(dir, "notes.md");
    writeFileSync(md, "# Heading\n\nbody text\n");
    const pages = await drain(extractPages(md, ".md", { pageWindow: 25 }));
    expect(pages).toHaveLength(1);
    expect(pages[0]).toMatchObject({ page: 1 });
    expect(pages[0].text).toContain("body text");
  });
});

describe("dispatch", () => {
  it("refuses an extension it does not handle", async () => {
    await expect(drain(extractPages("/tmp/x.mp4", ".mp4", { pageWindow: 25 })))
      .rejects.toThrow(/unsupported extension/);
  });
});

import { execFileSync as sh } from "node:child_process";
import { mkdirSync, writeFileSync as wf } from "node:fs";

describe("DOCX extraction", () => {
  it("reads paragraph text out of word/document.xml", async () => {
    const src = join(dir, "docx-src");
    mkdirSync(join(src, "word"), { recursive: true });
    wf(join(src, "[Content_Types].xml"),
      '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="xml" ContentType="application/xml"/></Types>');
    wf(join(src, "word", "document.xml"),
      '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      "<w:body><w:p><w:r><w:t>First paragraph.</w:t></w:r></w:p>" +
      "<w:p><w:r><w:t>DOCX_NEEDLE here.</w:t></w:r></w:p></w:body></w:document>");
    const docx = join(dir, "doc.docx");
    sh("zip", ["-r", "-q", docx, "[Content_Types].xml", "word"], { cwd: src });

    const pages = await drain(extractPages(docx, ".docx", { pageWindow: 25 }));
    const all = pages.map((p) => p.text).join("");
    expect(all).toContain("First paragraph.");
    expect(all).toContain("DOCX_NEEDLE here.");
    expect(pages.every((p) => p.page === 1)).toBe(true);
  });
});

// Helper for the drain-loop regression tests below: builds a DOCX zip from a
// caller-supplied word/document.xml body, so each test can hand extractDocx
// exactly the XML shape it needs (well-formed at volume, malformed, or a
// structurally corrupted zip entry) without repeating the zip boilerplate.
function buildDocx(name: string, documentXml: string): string {
  const src = join(dir, `${name}-src`);
  mkdirSync(join(src, "word"), { recursive: true });
  wf(join(src, "[Content_Types].xml"),
    '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="xml" ContentType="application/xml"/></Types>');
  wf(join(src, "word", "document.xml"), documentXml);
  const docx = join(dir, `${name}.docx`);
  sh("zip", ["-r", "-q", docx, "[Content_Types].xml", "word"], { cwd: src });
  return docx;
}

describe("DOCX extraction — drain loop regressions (resolve-on-push wake)", () => {
  it("loses no paragraph and preserves order under heavy volume (20,000 paragraphs)", async () => {
    const N = 20_000;
    const parts: string[] = [];
    for (let i = 1; i <= N; i++) {
      parts.push(`<w:p><w:r><w:t>PARA_${i}_of_${N} lorem ipsum dolor sit amet</w:t></w:r></w:p>`);
    }
    const xml = '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      `<w:body>${parts.join("")}</w:body></w:document>`;
    const docx = buildDocx("stress-20k", xml);

    const pages = await drain(extractPages(docx, ".docx", { pageWindow: 25 }));
    expect(pages.every((p) => p.page === 1)).toBe(true);
    const all = pages.map((p) => p.text).join("");

    // Every paragraph present exactly once, in order — the resolve-on-push
    // wake mechanism is level-triggered and re-drains the whole queue on
    // every wake, but this is the guard that would catch a regression to
    // losing, duplicating or reordering text under volume. A single linear
    // regex scan (rather than an indexOf per paragraph, which would rescan
    // megabytes of text tens of thousands of times) keeps this a check on
    // the EXTRACTOR's speed, not the test's own.
    const found = all.match(new RegExp(`PARA_\\d+_of_${N}`, "g")) ?? [];
    expect(found).toHaveLength(N);
    expect(found).toEqual(Array.from({ length: N }, (_, i) => `PARA_${i + 1}_of_${N}`));
  });

  it("fails fast on malformed XML rather than waiting for the 30s backstop", async () => {
    // Mismatched closing tags: sax (strict mode) raises 'error' on this and
    // does not go on to emit 'end'. Without an explicit signal on parser
    // error, the drain loop would sit until the defensive timeout instead of
    // failing immediately.
    const xml = '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      "<w:body><w:p><w:r><w:t>Unterminated</w:r></w:t></w:p></w:body></w:document>";
    const docx = buildDocx("malformed-xml", xml);

    const t0 = Date.now();
    await expect(drain(extractPages(docx, ".docx", { pageWindow: 25 }))).rejects.toThrow();
    const elapsed = Date.now() - t0;

    // Generous ceiling: proves this failed on the explicit signal, not on
    // the 30,000ms backstop.
    expect(elapsed).toBeLessThan(5_000);
  });

  it("fails cleanly rather than crashing on a corrupted zip entry", async () => {
    // A structurally valid zip whose word/document.xml entry is truncated —
    // the declared compressed size in the central directory is halved, so
    // yauzl feeds zlib an incomplete DEFLATE stream and its AssertByteCountStream
    // emits 'error' on the entry's read stream (rs) once the data runs out.
    // pipe() does not forward a source stream's 'error' to its destination,
    // so without rs.on("error", …) this is an unhandled error that crashes
    // the process rather than failing this one document.
    const filler = Array.from({ length: 400 }, (_, i) => `word ${i} `).join("");
    const xml = '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      `<w:body><w:p><w:r><w:t>${filler}</w:t></w:r></w:p></w:body></w:document>`;
    const docx = buildDocx("corrupt-entry-src", xml);

    const buf = readFileSync(docx);
    const sig = Buffer.from([0x50, 0x4b, 0x01, 0x02]); // central directory file header
    const nameBytes = Buffer.from("word/document.xml", "ascii");
    let found = -1;
    for (let i = 0; i + 46 <= buf.length; i++) {
      if (buf[i] === sig[0] && buf[i + 1] === sig[1] && buf[i + 2] === sig[2] && buf[i + 3] === sig[3]) {
        const nameLen = buf.readUInt16LE(i + 28);
        if (buf.subarray(i + 46, i + 46 + nameLen).equals(nameBytes)) { found = i; break; }
      }
    }
    expect(found, "could not locate the central directory record for word/document.xml").toBeGreaterThan(-1);
    const compSizeOffset = found + 20; // ZIP central directory record layout: compressed size at byte 20
    const compressedSize = buf.readUInt32LE(compSizeOffset);
    buf.writeUInt32LE(Math.floor(compressedSize / 2), compSizeOffset);
    const corrupt = join(dir, "corrupt-entry.docx");
    writeFileSync(corrupt, buf);

    await expect(drain(extractPages(corrupt, ".docx", { pageWindow: 25 }))).rejects.toThrow();
  });
});

describe("DOCX extraction — resource cleanup (I1)", () => {
  it("does not leak file descriptors across repeated extractions", async () => {
    // yauzl opens the zip with fs.open() and only releases that fd from
    // zipfile.close() — which the pre-fix code never called on the success
    // path, because lazyEntries stops calling readEntry() the moment
    // word/document.xml is found, so yauzl's own 'end' event (the only place
    // close() was ever considered) never fires. Five sequential extractions
    // measurably grew the process's fd count with the bug present; this
    // proves it does not.
    const xml = '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      "<w:body><w:p><w:r><w:t>fd leak check</w:t></w:r></w:p></w:body></w:document>";
    const N = 6;
    // Built up front so fd measurement below brackets only extractDocx's own
    // behaviour, not the `zip` subprocess buildDocx shells out to.
    const files = Array.from({ length: N }, (_, i) => buildDocx(`fd-leak-${i}`, xml));

    const fdCount = () => readdirSync("/dev/fd").length;
    const before = fdCount();
    for (const f of files) {
      await drain(extractPages(f, ".docx", { pageWindow: 25 }));
    }
    const after = fdCount();

    // A leak here is monotonic — one fd per call, never reclaimed — so any
    // growth at all across N repeated extractions is the bug, not noise.
    expect(after).toBeLessThanOrEqual(before);
  });
});

describe("DOCX extraction — missing main document part (I5)", () => {
  it("fails loudly rather than succeeding with zero chunks when word/document.xml is absent", async () => {
    // A structurally valid zip — it opens, it has entries — but none of them
    // is word/document.xml: e.g. a corrupted export, or an archive that is a
    // zip but not actually a Word document. The pre-fix code walked every
    // entry, matched nothing, and completed with `failure` still null: an
    // empty chunks.jsonl and a job that reports "succeeded" on a document
    // that was never read.
    const src = join(dir, "no-doc-xml-src");
    mkdirSync(join(src, "word"), { recursive: true });
    wf(join(src, "[Content_Types].xml"),
      '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="xml" ContentType="application/xml"/></Types>');
    wf(join(src, "word", "styles.xml"), '<?xml version="1.0"?><w:styles/>');
    const docx = join(dir, "no-doc-xml.docx");
    sh("zip", ["-r", "-q", docx, "[Content_Types].xml", "word"], { cwd: src });

    await expect(drain(extractPages(docx, ".docx", { pageWindow: 25 })))
      .rejects.toThrow(/word\/document\.xml/);
  });
});
