import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { ITEM_KINDS } from "../scripts/lib/extract-schema.mjs";

const SKILL = "skills/document-extract/SKILL.md";

test("the skill exists and has frontmatter Claude Code can match on", () => {
  assert.ok(existsSync(SKILL), "SKILL.md missing");
  const md = readFileSync(SKILL, "utf8");
  assert.ok(md.startsWith("---\n"));
  assert.match(md, /^name: document-extract$/m);
  assert.match(md, /^description: Use when /m);
});

test("it names every one of the eight item kinds", () => {
  // If the skill forgets a field, that field is empty in every extract and the
  // reduce never learns it was supposed to exist.
  const md = readFileSync(SKILL, "utf8");
  for (const k of ITEM_KINDS) assert.match(md, new RegExp(k), `skill never mentions ${k}`);
});

test("it forbids reading anything but its own document", () => {
  const md = readFileSync(SKILL, "utf8");
  assert.match(md, /only.{0,40}document|no other document|not read any other/i);
});

test("it requires src on every item and a verbatim quote on pain points", () => {
  const md = readFileSync(SKILL, "utf8");
  assert.match(md, /src/);
  assert.match(md, /verbatim/i);
});

test("it tells the pass to record honest coverage", () => {
  const md = readFileSync(SKILL, "utf8");
  assert.match(md, /truncated/);
});

test("it is registered for symlinking like every other skill", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  assert.ok(pkg.scripts["link-skills"], "link-skills script missing");
});
