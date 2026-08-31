// The Confluence space key / Jira project key a project gets when nothing is
// recorded for it.
//
// This is what unblocked SCY-7. Every project made through the MCP plugin has
// no `atlassianTarget` — `create_project` posts to the orchestrator's
// `POST /projects`, which records none — so the pre-publish step refused at
// step 6 of 10 with "has no Confluence space recorded", on a document that was
// already written and about to be approved. Deriving the obvious key is what
// the operator was going to do by hand anyway.
//
// The rules are Atlassian's, not ours, and both key spaces share them:
// uppercase alphanumeric, at least two characters, starting with a LETTER.
//
// Run:  node scripts/lib/atlassian.test.mjs

import assert from "node:assert/strict";
import { atlassianKeyFor } from "./atlassian.mjs";

let passed = 0;
const test = (name, fn) => {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
};

console.log("atlassianKeyFor");

test("passes a name that is already a valid key straight through", () => {
  assert.equal(atlassianKeyFor("SAPN"), "SAPN");
});

test("strips what a key cannot carry", () => {
  // The chatbot's own derivation does the same, and the two must not disagree
  // about what a given project is called.
  assert.equal(atlassianKeyFor("SA-DEMO"), "SADEMO");
  assert.equal(atlassianKeyFor("Review & Verify"), "REVIEWVERI");
  assert.equal(atlassianKeyFor("acme corp"), "ACMECORP");
});

test("prefixes a key that would start with a digit", () => {
  // Jira rejects `1STENERGY` outright, and a client named for a year or a
  // release number is not unusual. The `S` is the difference between a derived
  // key and a 400 on every publish that project ever attempts.
  assert.equal(atlassianKeyFor("1st Energy"), "S1STENERGY");
  assert.equal(atlassianKeyFor("2026 Uplift"), "S2026UPLIF");
});

test("never returns a key shorter than two characters", () => {
  assert.equal(atlassianKeyFor("X"), "XX");
  assert.equal(atlassianKeyFor("7"), "S7");
});

test("caps the length Atlassian caps it at", () => {
  const k = atlassianKeyFor("Very Long Client Name Limited");
  assert.equal(k, "VERYLONGCL");
  assert.ok(k.length <= 10, "a Jira project key is at most 10 characters");
});

test("falls back rather than returning an empty key", () => {
  // A name of nothing but punctuation leaves nothing behind. An empty key is a
  // 400 at publish time; a wrong-but-valid one is a space somebody can rename.
  for (const name of ["", "—", "!!!", null, undefined]) {
    assert.equal(atlassianKeyFor(name), "SCYNE", `for ${JSON.stringify(name)}`);
  }
});

test("is stable — the same name always derives the same key", () => {
  // It is called on every publish, and a key that drifted would publish a
  // second copy of a client's pack into a second space.
  assert.equal(atlassianKeyFor("SAPN"), atlassianKeyFor("SAPN"));
});

test("only ever emits characters both key spaces allow", () => {
  for (const name of ["SAPN", "1st Energy", "Review & Verify", "x", "", "a.b_c-d"]) {
    const k = atlassianKeyFor(name);
    assert.match(k, /^[A-Z][A-Z0-9]{1,9}$/, `${JSON.stringify(name)} -> ${k}`);
  }
});

console.log(`\n${passed} passed`);
