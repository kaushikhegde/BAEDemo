#!/usr/bin/env node
// The contract guard between the map phase and every consumer of it.
//
// Mirrors validate-experience.mjs: reports EVERY problem in one run and exits
// non-zero, because being told about one bad extract per agent run is how a
// fifty-document project takes fifty rounds to fix.
//
// Beyond a document's own extraction state (ready / missing / failed /
// extracting), this also verifies every pain-point QUOTE against its source
// document. Measured during the map phase's first real run: two of three
// quotes were not byte-identical to the source, because the agent joined
// sentences the markdown had line-wrapped — the words were exact, the
// whitespace was not. Whitespace is normalised on both sides before the
// substring check, so a genuine paraphrase still fails and a line-wrap does
// not. A pain point is what gets read back to a client in a room; an invented
// one is the worst output this pipeline could produce, so a quote that does
// not match is a HARD failure, not a warning.

import path from "node:path";
import { readFile } from "node:fs/promises";
import { projectState } from "./extract-state.mjs";

const project = process.argv[2];
if (!project) {
  console.error("usage: node scripts/validate-extracts.mjs <project>");
  process.exit(2);
}
const root = path.resolve(process.env.WORKSPACE_PATH || process.cwd());

const st = await projectState(root, project);
const problems = [];

if (st.documents.length === 0) problems.push("no documents found — nothing to extract");

/**
 * Collapse all whitespace runs to a single space and trim, on both sides.
 * Also strips markdown emphasis (`**bold**`, `*em*`) and blockquote (`> `)
 * syntax — a second normalisation gap, found the same way the first one was:
 * measured against SAPN_DEMO's real SOPs, where `**10 business days**` and
 * `> This stage is the longest…` are genuinely verbatim quotes once the
 * decoration used to draw a reader's eye to them is stripped. The words did
 * not change; only the markdown around them did. A genuine paraphrase still
 * fails — this only removes formatting characters, never prose.
 */
const normalise = (s) => String(s ?? "")
  .replace(/^\s*>+\s?/gm, " ")
  .replace(/\*\*?/g, "")
  .replace(/\s+/g, " ")
  .trim();

/** The absolute path a document's docId/scope resolve to, mirroring extract-state.mjs. */
const absPathOf = (d) => d.scope === "project"
  ? path.join(root, "projects", project, d.docId)
  : path.join(root, "projects", project, d.scope, d.docId);

for (const d of st.documents) {
  if (d.state !== "ready") {
    problems.push(`${d.scope}/${d.docId}: ${d.state}${d.reason ? ` — ${d.reason}` : ""}`);
    continue;
  }

  // Anti-fabrication check: every painPoints[].quote must be a verbatim
  // substring of its source document, once whitespace differences from
  // markdown line-wrapping are normalised away.
  let extract;
  try {
    extract = JSON.parse(await readFile(d.extractPath, "utf8"));
  } catch (e) {
    problems.push(`${d.scope}/${d.docId}: extract unreadable — ${e.message}`);
    continue;
  }

  const painPoints = Array.isArray(extract.painPoints) ? extract.painPoints : [];
  if (!painPoints.length) continue;

  let sourceText;
  try {
    sourceText = normalise(await readFile(absPathOf(d), "utf8"));
  } catch (e) {
    problems.push(`${d.scope}/${d.docId}: source document unreadable — ${e.message}`);
    continue;
  }

  painPoints.forEach((item, i) => {
    const quote = normalise(item?.quote);
    if (!quote) return; // shape errors (missing quote) are already caught by validateExtract at extraction time
    if (!sourceText.includes(quote)) {
      const shown = String(item.quote ?? "").slice(0, 80);
      problems.push(
        `${d.scope}/${d.docId}: painPoints[${i}].quote does not match the source document — "${shown}${item.quote && item.quote.length > 80 ? "…" : ""}"`,
      );
    }
  });
}

if (problems.length) {
  console.error(`✗ ${problems.length} problem(s) across ${st.documents.length} document(s):`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`✓ ${st.ready} document(s) extracted and valid`);
