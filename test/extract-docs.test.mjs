import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("CLAUDE.md documents the extract stage", () => {
  const md = readFileSync("CLAUDE.md", "utf8");
  assert.match(md, /extract/i);
  assert.match(md, /document-extract/);
});

test("it names the spend gap honestly", () => {
  // The gap MOVED rather than closing. Map passes now record one run row per
  // document, so /spend and the transcripts are right — but the engine's
  // per-agent budget ceiling still cannot apply to a process it did not spawn,
  // and somebody reading the budgets tab must not believe extraction is capped.
  const md = readFileSync("CLAUDE.md", "utf8");
  assert.match(md, /budget ceiling does not apply|cannot cap a process it did not spawn/i);
  assert.doesNotMatch(md, /extraction[^.]*no `runs` row/i,
    "that has not been true since the map pass started recording its own runs");
});

test("it names the ready-not-present gate change", () => {
  const md = readFileSync("CLAUDE.md", "utf8");
  assert.match(md, /documents_not_ready/);
});

test("it says how a failed extraction is retried", () => {
  // The troubleshooting table used to say there was no way out of a document
  // stuck at `failed` other than removing it. Somebody reading that stops
  // looking, so it has to change in step with the thing that fixed it.
  const md = readFileSync("CLAUDE.md", "utf8");
  assert.match(md, /extract-retry|retry_extraction/,
    "the retry has to be discoverable from CLAUDE.md");
  assert.doesNotMatch(md, /There is currently no "proceed without it" escape hatch/,
    "that sentence is no longer true");
});

test("it says where an extraction failure's reason surfaces", () => {
  const md = readFileSync("CLAUDE.md", "utf8");
  assert.match(md, /\.extract\.failed\.json/);
  assert.match(md, /attempts/i, "the attempt count is what says whether retrying is worth it");
});
