import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { STAGES } from "../scripts/pipeline.mjs";

test("the extract stage exists at project level and runs first", () => {
  const s = STAGES.extract;
  assert.ok(s, "no extract stage in the pipeline");
  assert.equal(s.level, "project");
  assert.equal(s.order, 0, "extraction precedes every other stage");
  // NOT `skill` — a stage carrying `skill` compiles to ONE agent step, and one
  // agent reading every document is the exact thing this stage exists to stop.
  // The fan-out lives in the script because the engine has none.
  assert.equal(s.skill, undefined, "extract must not compile to a single agent step");
  assert.match(s.script, /extract-documents\.mjs/);
});

test("capabilities requires the extracts", () => {
  const reqs = STAGES.capabilities.requires ?? [];
  assert.ok(reqs.some((r) => /Extracts/.test(r.path)),
    "capabilities must hard-require the extracts, not read documents");
});

test("the chatbot distinguishes 'no documents' from 'not extracted'", () => {
  const src = readFileSync("scyne-chatbot/server/index.ts", "utf8");
  assert.match(src, /documents_not_ready/,
    "a project with unextracted documents must not be told it has none");
  assert.match(src, /extract-status/, "a status route is required");
});

test("the extract stage produces into solutions/Extracts", () => {
  assert.ok((STAGES.extract.produces ?? []).some((p) => /solutions\/Extracts/.test(p)));
});
