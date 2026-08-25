import { test } from "node:test";
import assert from "node:assert/strict";
import { validateExtract, emptyExtract, ITEM_KINDS, EXTRACT_VERSION } from "../scripts/lib/extract-schema.mjs";

const good = () => ({
  version: EXTRACT_VERSION,
  docId: "Workshop_Transcript.md",
  scope: "project",
  category: "Transcripts",
  windows: [{ pageStart: 1, pageEnd: 25 }],
  businessFunctions: [
    { name: "Refund Escalation", does: "Escalates refunds over $500 to a team lead",
      actor: "Team Lead", src: { pageStart: 22, pageEnd: 24 } },
  ],
  processSteps: [], actors: [], serviceTiers: [], components: [],
  maturitySignals: [], lifecyclePhases: [], painPoints: [],
  coverage: { pagesRead: 25, pagesTotal: 25, truncated: false },
  usage: { inputTokens: 12000, outputTokens: 900 },
});

test("accepts a well-formed extract", () => {
  assert.deepEqual(validateExtract(good()), { ok: true, errors: [] });
});

test("every item kind is present in an empty extract", () => {
  const e = emptyExtract({ docId: "a.md", scope: "project", category: "Notes" });
  for (const k of ITEM_KINDS) assert.ok(Array.isArray(e[k]), `${k} missing`);
  assert.equal(validateExtract(e).ok, true, "an empty extract is valid");
});

test("refuses an item with no src", () => {
  const e = good();
  delete e.businessFunctions[0].src;
  const v = validateExtract(e);
  assert.equal(v.ok, false);
  assert.match(v.errors.join(" "), /businessFunctions\[0\].*src/);
});

test("refuses a src whose pageEnd precedes pageStart", () => {
  const e = good();
  e.businessFunctions[0].src = { pageStart: 9, pageEnd: 4 };
  assert.match(validateExtract(e).errors.join(" "), /pageEnd/);
});

test("refuses a painPoint with no verbatim quote", () => {
  // Pain points are what a client disputes in a room. A paraphrase is not
  // evidence, so the schema will not accept one.
  const e = good();
  e.painPoints = [{ src: { pageStart: 3, pageEnd: 3 } }];
  assert.match(validateExtract(e).errors.join(" "), /painPoints\[0\].*quote/);
});

test("refuses truncated coverage that claims to have read everything", () => {
  const e = good();
  e.coverage = { pagesRead: 10, pagesTotal: 25, truncated: false };
  assert.match(validateExtract(e).errors.join(" "), /truncated/);
});

test("refuses an unknown top-level field", () => {
  // A typo'd field name is silent data loss: the reduce reads the correct name,
  // finds nothing, and reports a smaller map with no error anywhere.
  const e = good();
  e.buisnessFunctions = [];
  assert.match(validateExtract(e).errors.join(" "), /buisnessFunctions/);
});

test("refuses a version it does not know", () => {
  const e = good();
  e.version = 99;
  assert.match(validateExtract(e).errors.join(" "), /version/);
});

test("reports EVERY problem, not just the first", () => {
  const e = good();
  delete e.docId;
  delete e.coverage;
  e.businessFunctions[0].src = { pageStart: 9, pageEnd: 4 };
  const v = validateExtract(e);
  assert.ok(v.errors.length >= 3, `expected 3+ errors, got ${v.errors.length}`);
});
