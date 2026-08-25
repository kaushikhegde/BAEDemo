import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const SRC = "scyne-chatbot/server/index.ts";

test("both upload routes start extraction", () => {
  const src = readFileSync(SRC, "utf8");
  const calls = src.match(/extract-documents\.mjs/g) ?? [];
  assert.ok(calls.length >= 2,
    `both /api/upload and /api/upload/project must start extraction; found ${calls.length}`);
});

test("the upload response reports the document's extraction state", () => {
  const src = readFileSync(SRC, "utf8");
  assert.match(src, /extraction:\s*\{/);
});

test("a spawn failure is reported, not thrown", () => {
  const src = readFileSync(SRC, "utf8");
  // The same discipline as adoError and dbError: the file is real either way.
  assert.match(src, /extractionError|extraction:\s*\{[^}]*error/);
});
