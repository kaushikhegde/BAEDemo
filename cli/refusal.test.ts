// What the session prints when a trigger is refused.
//
// The case that motivated this file: three .docx uploaded to a feature, then
// "Create capability and process map", answered with «that feature has no
// documents yet — upload an SOP or a transcript» on every retry. Three things
// were wrong with that sentence and only one of them was the missing files.
// The capability map is a PROJECT stage and takes no feature; `/docs` was
// listing the three documents at the time; and the server had actually sent
// "There are 3 file(s) but none are markdown", which the CLI read the code out
// of and then threw away.

import { test } from "node:test";
import assert from "node:assert/strict";
import { refusalText, GATE_REASONS } from "./repl.ts";

test("the server's own sentence wins over the canned one", () => {
  assert.equal(
    refusalText({
      code: "no_documents",
      detail: "No readable documents for SA Power Networks. There are 3 file(s) but none are markdown — the agents read .md.",
      message: "no_documents",
    }),
    "No readable documents for SA Power Networks. There are 3 file(s) but none are markdown — the agents read .md.");
});

test("a refusal carrying no message falls back to the code's plain words", () => {
  assert.equal(
    refusalText({ code: "no_capability_map", message: "no_capability_map" }),
    "there is no capability map yet — run the capability map first");
});

test("an unrecognised code is printed rather than swallowed", () => {
  assert.equal(refusalText({ code: "teapot", message: "teapot" }), "teapot");
});

test("a whitespace-only message is not a message", () => {
  assert.equal(
    refusalText({ code: "no_artefacts", detail: "   " }),
    "nothing has been generated for this project yet");
});

test("a plain Error still says something", () => {
  assert.equal(refusalText(new Error("connection refused")), "connection refused");
  assert.equal(refusalText(undefined), "the server refused it");
});

test("no gate reason claims a level the stage does not have", () => {
  // `capabilities`, `personas` and `app` are PROJECT stages that take no
  // feature, and they share these codes with the feature stages. A fallback
  // that names a level is wrong for half its callers by construction.
  const reasons = Object.entries(GATE_REASONS);
  assert.ok(reasons.length > 0, "GATE_REASONS is empty — this test would pass vacuously");
  for (const [code, text] of reasons) {
    assert.ok(!/\bfeature\b/.test(text), `${code} names a level: ${text}`);
    assert.ok(!/\bproject\b/.test(text) || code === "no_artefacts",
      `${code} names a level: ${text}`);
  }
});
