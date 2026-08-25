import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("CLAUDE.md documents the extract stage", () => {
  const md = readFileSync("CLAUDE.md", "utf8");
  assert.match(md, /extract/i);
  assert.match(md, /document-extract/);
});

test("it names the spend gap honestly", () => {
  // Map passes get no `runs` row. Somebody reading /spend must not conclude
  // the extraction was free.
  const md = readFileSync("CLAUDE.md", "utf8");
  assert.match(md, /no `runs` row|not tracked in \/spend|do not appear in/i);
});

test("it names the ready-not-present gate change", () => {
  const md = readFileSync("CLAUDE.md", "utf8");
  assert.match(md, /documents_not_ready/);
});
