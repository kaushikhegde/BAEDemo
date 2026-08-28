// The extraction spawn must not carry its own copy of the runner's flags.
//
// `CLAUDE_ARGS` was a hand-copy of `buildArgs` that said so — "the flags mirror
// `buildArgs` in that same file, minus the streaming output this script has no
// use for". That omission is the whole bug: `--output-format stream-json
// --verbose` is what produces the `result` event, and without it a document's
// extraction has no token count, no cost and no transcript. Nine agent runs
// inside one `exec` step left no trace at all.
//
// Source-text assertions only, deliberately: this file must run under plain
// `node --test` alongside the rest of `npm run test:scripts`. `extractUsage`'s
// own behaviour is already covered by the orchestrator's `usage.test.ts` — a
// second copy of those assertions here would be testing somebody else's
// function.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const SRC = readFileSync(
  path.resolve(import.meta.dirname, "..", "scripts", "extract-documents.mjs"), "utf8");

test("the flags come from the runner, not a local copy", () => {
  assert.match(SRC, /import\s*\{[^}]*\bbuildArgs\b[^}]*\}\s*from\s*"@scyne\/orchestrator"/);
  assert.match(SRC, /import\s*\{[^}]*\bextractUsage\b[^}]*\}\s*from\s*"@scyne\/orchestrator"/);
});

test("the hand-maintained copy is gone, not merely unused", () => {
  // Left in place is how it comes back: the next reader edits the const they
  // can see rather than the import they cannot.
  assert.doesNotMatch(SRC, /CLAUDE_ARGS/);
  assert.doesNotMatch(SRC, /"--permission-mode"/,
    "every flag now comes from buildArgs — none should be spelled here");
  assert.doesNotMatch(SRC, /"--system-prompt-file"/);
});

test("the model is pinned and overridable, not inherited", () => {
  // Extraction is form-filling from one document; every other stage is not.
  // They are separate decisions and must stay separately changeable.
  assert.match(SRC, /SCYNE_EXTRACT_MODEL/);
  assert.match(SRC, /claude-sonnet-5/);
});

test("stdout is captured, because it is both the transcript and the usage", () => {
  // The `result` event only exists on --output-format stream-json, and it
  // arrives on stdout. A spawn that discards stdout discards the cost.
  assert.match(SRC, /extractUsage\(/);
  assert.match(SRC, /child\.stdout/);
});
