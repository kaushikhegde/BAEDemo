#!/usr/bin/env node
// Writes a valid, uncompressed PDF as a STREAM, so a multi-gigabyte fixture can
// be produced without holding it in memory.
//
//   node scripts/make-fixture-pdf.mjs <out.pdf> <pages> [--needle T] [--needle-page N] [--lines-per-page N]
import { createWriteStream } from "node:fs";
import { once } from "node:events";

const argv = process.argv.slice(2);
const [out, pagesArg] = argv;
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};

if (!out || !pagesArg) {
  console.error("usage: make-fixture-pdf.mjs <out.pdf> <pages> [--needle T] [--needle-page N] [--lines-per-page N]");
  process.exit(2);
}

const pages = Number(pagesArg);
const needle = flag("needle", null);
const needlePageRaw = flag("needle-page", "1");
const needlePage = Number(needlePageRaw);
const linesPerPageRaw = flag("lines-per-page", "40");
const linesPerPage = Number(linesPerPageRaw);

// Input validation only — refuse loudly rather than silently write a PDF that
// doesn't match what was asked for (an invalid page count, a needle placed
// somewhere other than where --needle-page said, or a needle mangled by
// latin1 truncation). No behaviour changes for any input that was already
// legal: the object numbering, xref arithmetic, esc() and the streaming loop
// below are untouched.
if (!Number.isInteger(pages) || pages < 1) {
  console.error(`invalid pages "${pagesArg}": must be an integer >= 1`);
  process.exit(2);
}
if (!Number.isInteger(linesPerPage) || linesPerPage < 1) {
  console.error(`invalid --lines-per-page "${linesPerPageRaw}": must be an integer >= 1`);
  process.exit(2);
}
if (needle !== null) {
  if (!Number.isInteger(needlePage) || needlePage < 1 || needlePage > pages) {
    console.error(`invalid --needle-page "${needlePageRaw}": must be an integer within 1..${pages} ` +
      `(this document has ${pages} page(s))`);
    process.exit(2);
  }
  if (linesPerPage < 4) {
    console.error(`--lines-per-page ${linesPerPage} is too small for --needle: the needle is written ` +
      `to line 3 of its page, so --lines-per-page must be >= 4`);
    process.exit(2);
  }
  for (let i = 0; i < needle.length; i++) {
    if (needle.charCodeAt(i) > 0xFF) {
      console.error(`--needle "${needle}" contains a character outside Latin-1 (code unit > 0xFF, ` +
        `at position ${i}): the content stream is latin1-encoded, so the needle must be Latin-1 text only`);
      process.exit(2);
    }
  }
}

const stream = createWriteStream(out);
let offset = 0;
const offsets = [];          // offsets[objNumber] = byte offset

const write = async (s) => {
  const buf = Buffer.from(s, "latin1");
  offset += buf.length;
  if (!stream.write(buf)) await once(stream, "drain");
};
const beginObj = async (n, body) => { offsets[n] = offset; await write(`${n} 0 obj\n${body}\nendobj\n`); };
const esc = (s) => s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");

// Object numbering is fixed up front, so /Kids can be written before any page
// exists: page i is object 4+2i and its content stream is 5+2i.
const pageObj = (i) => 4 + 2 * i;
const contentObj = (i) => 5 + 2 * i;
const kids = Array.from({ length: pages }, (_, i) => `${pageObj(i)} 0 R`).join(" ");

await write("%PDF-1.4\n");
await beginObj(1, "<< /Type /Catalog /Pages 2 0 R >>");
await beginObj(2, `<< /Type /Pages /Kids [${kids}] /Count ${pages} >>`);
await beginObj(3, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");

for (let i = 0; i < pages; i++) {
  const n = i + 1;
  const lines = [`Page ${n} of ${pages}`];
  for (let l = 1; l < linesPerPage; l++) {
    lines.push(n === needlePage && needle && l === 3
      ? needle
      : `p${n} line ${l} lorem ipsum dolor sit amet consectetur adipiscing elit`);
  }
  const body =
    "BT /F1 11 Tf 1 0 0 1 54 738 Tm 14 TL\n" +
    lines.map((t) => `(${esc(t)}) Tj T*\n`).join("") +
    "ET";
  await beginObj(pageObj(i),
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
    `/Resources << /Font << /F1 3 0 R >> >> /Contents ${contentObj(i)} 0 R >>`);
  await beginObj(contentObj(i), `<< /Length ${Buffer.byteLength(body, "latin1")} >>\nstream\n${body}\nendstream`);
}

const total = 4 + 2 * pages;             // objects 0..total-1, where 0 is the free head
const xrefAt = offset;
let xref = `xref\n0 ${total}\n0000000000 65535 f \n`;
for (let n = 1; n < total; n++) {
  xref += `${String(offsets[n]).padStart(10, "0")} 00000 n \n`;
}
await write(xref);
await write(`trailer\n<< /Size ${total} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`);

stream.end();
await once(stream, "finish");
console.log(JSON.stringify({ ok: true, pages, bytes: offset, needlePage: needle ? needlePage : null }));
