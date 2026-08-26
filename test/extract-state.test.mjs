import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractPathFor, hashOf, stateOf, projectState } from "../scripts/extract-state.mjs";
import { emptyExtract } from "../scripts/lib/extract-schema.mjs";

let root;
beforeEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = mkdtempSync(join(tmpdir(), "extract-state-"));
  mkdirSync(join(root, "projects/P/documents"), { recursive: true });
  writeFileSync(join(root, "projects/P/documents/a.md"), "# alpha\n");
});

const levelRoot = () => join(root, "projects/P");
const docA = () => join(root, "projects/P/documents/a.md");

test("the extract path is keyed by the document's content hash", async () => {
  const p1 = await extractPathFor(docA(), levelRoot());
  assert.match(p1, /solutions\/Extracts\/[0-9a-f]{16}\.extract\.json$/);
  writeFileSync(docA(), "# alpha changed\n");
  const p2 = await extractPathFor(docA(), levelRoot());
  assert.notEqual(p1, p2, "editing the document must change its extract path");
});

test("a document with no extract is missing", async () => {
  assert.equal((await stateOf(docA(), levelRoot())).state, "missing");
});

test("a valid extract makes it ready", async () => {
  const p = await extractPathFor(docA(), levelRoot());
  mkdirSync(join(levelRoot(), "solutions/Extracts"), { recursive: true });
  const e = emptyExtract({ docId: "documents/a.md", scope: "project", category: "documents" });
  writeFileSync(p, JSON.stringify(e));
  assert.equal((await stateOf(docA(), levelRoot())).state, "ready");
});

test("an INVALID extract is failed, not ready — and says why", async () => {
  // The case that matters: a file exists, so a naive check calls it done.
  const p = await extractPathFor(docA(), levelRoot());
  mkdirSync(join(levelRoot(), "solutions/Extracts"), { recursive: true });
  writeFileSync(p, JSON.stringify({ version: 1, docId: "a.md" }));
  const s = await stateOf(docA(), levelRoot());
  assert.equal(s.state, "failed");
  assert.match(s.reason, /scope|category|coverage/);
});

test("a .partial file means extracting", async () => {
  const p = await extractPathFor(docA(), levelRoot());
  mkdirSync(join(levelRoot(), "solutions/Extracts"), { recursive: true });
  writeFileSync(`${p}.partial`, "{}");
  assert.equal((await stateOf(docA(), levelRoot())).state, "extracting");
});

test("a .failed file carries its reason forward", async () => {
  const p = await extractPathFor(docA(), levelRoot());
  mkdirSync(join(levelRoot(), "solutions/Extracts"), { recursive: true });
  writeFileSync(p.replace(/\.extract\.json$/, ".extract.failed.json"),
    JSON.stringify({ reason: "no text layer in PDF", attempts: 2 }));
  const s = await stateOf(docA(), levelRoot());
  assert.equal(s.state, "failed");
  assert.match(s.reason, /no text layer/);
});

test("a .failed file carries how many times it has failed, and when", async () => {
  // The reason alone cannot separate "the model had a bad night" from "this is
  // a scanned PDF and never will extract" — which is the difference between
  // retrying and removing the document.
  const p = await extractPathFor(docA(), levelRoot());
  mkdirSync(join(levelRoot(), "solutions/Extracts"), { recursive: true });
  writeFileSync(p.replace(/\.extract\.json$/, ".extract.failed.json"),
    JSON.stringify({
      reason: "no text layer in PDF", doc: "documents/a.md", attempts: 4,
      firstFailedAt: "2026-08-20T01:00:00.000Z", lastFailedAt: "2026-08-26T09:00:00.000Z",
    }));
  const s = await stateOf(docA(), levelRoot());
  assert.equal(s.attempts, 4);
  assert.equal(s.lastFailedAt, "2026-08-26T09:00:00.000Z");
  assert.equal(s.firstFailedAt, "2026-08-20T01:00:00.000Z");
});

test("a document that never failed reports no attempt count", async () => {
  const s = await stateOf(docA(), levelRoot());
  assert.equal(s.state, "missing");
  assert.equal(s.attempts, undefined, "absent, not 0 — 0 would read as 'tried and did not fail'");
});

test("editing a ready document returns it to missing", async () => {
  const p = await extractPathFor(docA(), levelRoot());
  mkdirSync(join(levelRoot(), "solutions/Extracts"), { recursive: true });
  writeFileSync(p, JSON.stringify(emptyExtract({ docId: "a.md", scope: "project", category: "documents" })));
  assert.equal((await stateOf(docA(), levelRoot())).state, "ready");
  writeFileSync(docA(), "# alpha, revised by the client\n");
  assert.equal((await stateOf(docA(), levelRoot())).state, "missing",
    "a changed document has no extract for its new hash");
});

test("projectState counts every document at both levels", async () => {
  mkdirSync(join(root, "projects/P/Feature One/requirements/SOP"), { recursive: true });
  writeFileSync(join(root, "projects/P/Feature One/requirements/SOP/policy.md"), "# policy\n");
  const st = await projectState(root, "P");
  assert.equal(st.documents.length, 2);
  assert.equal(st.missing, 2);
  assert.equal(st.ready, 0);
  assert.ok(st.documents.some((d) => d.scope === "project"));
  assert.ok(st.documents.some((d) => d.scope === "Feature One"));
});
