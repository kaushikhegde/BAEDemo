import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ITEM_KINDS } from "../scripts/lib/extract-schema.mjs";

const SKILL = "skills/capability-process-map/SKILL.md";

test("Step 1 reads extracts, not every document", () => {
  const md = readFileSync(SKILL, "utf8");
  assert.doesNotMatch(md, /Read \*\*every\*\* `\.md` file/,
    "the read-everything instruction must be gone — it is what does not scale");
  assert.match(md, /extracts?/i);
});

test("it knows the extract's field names", () => {
  const md = readFileSync(SKILL, "utf8");
  for (const k of ["businessFunctions", "processSteps", "painPoints"]) {
    assert.match(md, new RegExp(k), `skill never mentions ${k}`);
  }
});

test("it forbids citations in the delivered document", () => {
  const md = readFileSync(SKILL, "utf8");
  assert.match(md, /no citations|never appear|not cite/i);
});

test("it must reject a claim whose src does not resolve", () => {
  const md = readFileSync(SKILL, "utf8");
  assert.match(md, /resolve|verify/i);
});

test("the output contract is unchanged", () => {
  const md = readFileSync(SKILL, "utf8");
  for (const f of ["capability-map.json", "process-model.json", "capability-process.md"]) {
    assert.match(md, new RegExp(f.replace(".", "\\.")), `output ${f} no longer named`);
  }
});
