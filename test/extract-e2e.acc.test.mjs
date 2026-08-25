import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";

const PROJECT = process.env.E2E_PROJECT || "SAPN_DEMO";

test("every document extracts and validates", () => {
  execFileSync("node", ["scripts/extract-documents.mjs", PROJECT, "--concurrency", "3"],
    { encoding: "utf8" });
  const out = execFileSync("node", ["scripts/validate-extracts.mjs", PROJECT],
    { encoding: "utf8" });
  assert.match(out, /✓ \d+ document\(s\) extracted and valid/);
});

test("the reduce's input is far smaller than the corpus", () => {
  // The claim the whole design rests on, asserted as a number.
  const docBytes = Number(execSync(
    `find projects/${PROJECT} -name '*.md' -not -path '*/solutions/*' -exec cat {} + | wc -c`)
    .toString().trim());
  const extractBytes = Number(execSync(
    `cat projects/${PROJECT}/solutions/Extracts/*.extract.json | wc -c`).toString().trim());
  assert.ok(extractBytes < docBytes / 4,
    `extracts (${extractBytes}) should be far smaller than documents (${docBytes})`);
});

test("the measurement was actually recorded", () => {
  const p = "docs/superpowers/measurements/2026-08-25-extraction.md";
  assert.ok(existsSync(p), "the comparison must exist — spec §7 requires it");
  const md = readFileSync(p, "utf8");
  assert.match(md, /old|baseline/i);
  assert.match(md, /cost/i);
});
