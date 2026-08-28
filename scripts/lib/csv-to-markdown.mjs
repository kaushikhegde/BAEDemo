// A CSV as a markdown table, with no native code in the path.
//
// `.csv` used to be routed to @firecrawl/anydoc, a prebuilt NAPI addon, on the
// grounds that it was "anydoc's own documented table". A CSV is already text,
// so that bought a markdown table and risked the whole conversion on a
// dependency that can be absent, wrong for the platform, or simply never
// return — which is what it did, wedging a client's ingest for twenty minutes
// with no failure anywhere to explain it.
//
// Kept in step with `plugins/*/src/worker/markdown.ts`, which owns the same
// format by the same rule. The two engines must not disagree, or the same file
// converts differently depending on which door it came in by.

export const csvToMarkdown = (text) => {
  const rows = [];
  let row = [], field = "", quoted = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }   // an escaped quote
        else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') { quoted = true; continue; }
    if (c === ",") { row.push(field); field = ""; continue; }
    if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); rows.push(row); row = []; field = "";
      continue;
    }
    field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }

  const real = rows.filter(r => r.some(cell => cell.trim() !== ""));
  if (!real.length) return "";

  // A pipe would end the cell it sits in, and a newline would end the row.
  const cell = (v) => v.replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ").trim();
  // Ragged rows are normal in exported CSVs. Padding to the widest row keeps
  // the table valid rather than dropping the columns that overflow a short
  // header — losing a column silently is how a data model ends up missing a
  // field nobody can trace.
  const width = Math.max(...real.map(r => r.length));
  const line = (r) =>
    `| ${Array.from({ length: width }, (_, i) => cell(r[i] ?? "")).join(" | ")} |`;

  return [
    line(real[0]),
    `| ${Array.from({ length: width }, () => "---").join(" | ")} |`,
    ...real.slice(1).map(line),
  ].join("\n");
};
