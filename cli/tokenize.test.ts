// The session's argument splitter, which every slash command goes through.
//
// The case that motivated this file: a person pastes a list of quoted file
// paths into `/new`'s document step and one comma is missing between two of
// them. A SHELL would concatenate — `'a''b'` is `ab` in bash — so the two paths
// became a single token and the upload failed with `ENOTDIR: not a directory`,
// naming a path nobody typed, while the other files uploaded fine. A closing
// quote now ends the token.

import { test } from "node:test";
import assert from "node:assert/strict";
import { tokenize } from "./repl.ts";

test("adjacent quoted paths with no separator are two tokens, not one", () => {
  assert.deepEqual(
    tokenize("'/a/1. Intro.docx''/a/3. Landscape.docx'", { commas: true }),
    ["/a/1. Intro.docx", "/a/3. Landscape.docx"]);
});

test("comma-separated quoted paths still work", () => {
  assert.deepEqual(
    tokenize("'/a/1 x.docx','/a/2 y.docx'", { commas: true }),
    ["/a/1 x.docx", "/a/2 y.docx"]);
});

test("ordinary slash-command parsing is unchanged", () => {
  assert.deepEqual(tokenize(`upload "path with spaces.docx" --as sop`),
    ["upload", "path with spaces.docx", "--as", "sop"]);
  assert.deepEqual(tokenize(`use SAPN "Interim Benefit"`), ["use", "SAPN", "Interim Benefit"]);
  assert.deepEqual(tokenize(``), []);
  assert.deepEqual(tokenize(`a  b   c`), ["a", "b", "c"]);
});
