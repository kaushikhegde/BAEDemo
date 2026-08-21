// The stage graph's staleness walk: does a changed DOCUMENT flag the artefacts
// built from it?
//
// Every input in the graph used to come `from` another STAGE, so the walk could
// only ever answer "this artefact predates another artefact". A client
// replacing an SOP — the single most common reason a pack goes out of date —
// changed nothing it could see.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { staleness } from "../pipeline.mjs";

const HOUR = 3600_000;

/** Write a file and stamp its mtime, so a test never waits on the clock. */
async function write(file, body, ageHours) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, body, "utf8");
  const at = new Date(Date.now() - ageHours * HOUR);
  await fs.utimes(file, at, at);
}

async function workspace() {
  return fs.mkdtemp(path.join(os.tmpdir(), "scyne-pipeline-"));
}

/** The stage keys reported stale, for terser assertions. */
const keys = (rows) => rows.map((r) => r.key).sort();

/** What superseded one stage, by origin key. */
const supersededBy = (rows, key) =>
  (rows.find((r) => r.key === key)?.supersededBy ?? []).map((s) => s.key).sort();

test("a feature's SOP superseding the product summary flags requirements", async () => {
  const ws = await workspace();
  const feat = path.join(ws, "projects", "P", "F");

  await write(path.join(feat, "outputs", "product-summary.md"), "# summary", 5);
  await write(path.join(feat, "outputs", "stories.json"), "[]", 5);
  // Uploaded AFTER the summary was generated — the artefact is now out of date.
  await write(path.join(feat, "requirements", "SOP", "handling.md"), "# sop", 1);

  const rows = await staleness(ws, "P", "F");
  assert.deepEqual(keys(rows), ["requirements"]);
  assert.deepEqual(supersededBy(rows, "requirements"), ["discovery"]);
});

test("a discovery document OLDER than the artefact flags nothing", async () => {
  const ws = await workspace();
  const feat = path.join(ws, "projects", "P", "F");

  await write(path.join(feat, "requirements", "SOP", "handling.md"), "# sop", 5);
  await write(path.join(feat, "outputs", "product-summary.md"), "# summary", 1);
  await write(path.join(feat, "outputs", "stories.json"), "[]", 1);

  assert.deepEqual(await staleness(ws, "P", "F"), []);
});

test("every requirements subfolder counts, not just SOP", async () => {
  for (const sub of ["SOP", "Transcripts", "Notes", "UI"]) {
    const ws = await workspace();
    const feat = path.join(ws, "projects", "P", "F");
    await write(path.join(feat, "outputs", "product-summary.md"), "# summary", 5);
    await write(path.join(feat, "outputs", "stories.json"), "[]", 5);
    await write(path.join(feat, "requirements", sub, "thing.md"), "x", 1);

    assert.deepEqual(keys(await staleness(ws, "P", "F")), ["requirements"],
      `a change under requirements/${sub}/ should flag the product summary`);
  }
});

test("templates/ is house style, not content, and flags nothing", async () => {
  const ws = await workspace();
  const feat = path.join(ws, "projects", "P", "F");
  await write(path.join(feat, "outputs", "product-summary.md"), "# summary", 5);
  await write(path.join(feat, "outputs", "stories.json"), "[]", 5);
  await write(path.join(feat, "requirements", "templates", "house.md"), "x", 1);

  assert.deepEqual(await staleness(ws, "P", "F"), []);
});

test("a feature's documents flag the PROJECT stages that read every feature", async () => {
  const ws = await workspace();
  const proj = path.join(ws, "projects", "P");
  const feat = path.join(proj, "F");

  const cap = path.join(proj, "solutions", "Capabilities", "outputs");
  await write(path.join(cap, "capability-process.md"), "# cap", 5);
  await write(path.join(cap, "capability-map.json"), "{}", 5);
  await write(path.join(cap, "process-model.json"), "{}", 5);
  // A document uploaded to a FEATURE, after the project's capability map ran.
  // stageAllDocuments() reads every feature's discovery tree, so this is an
  // input to a project-level stage even though it lives under a feature.
  await write(path.join(feat, "requirements", "Transcripts", "workshop.md"), "x", 1);

  const rows = await staleness(ws, "P");
  assert.deepEqual(keys(rows), ["capabilities"]);
  assert.deepEqual(supersededBy(rows, "capabilities"), ["discovery"]);
});

test("a nested document is seen — the walk is not one level deep", async () => {
  const ws = await workspace();
  const proj = path.join(ws, "projects", "P");

  const cap = path.join(proj, "solutions", "Capabilities", "outputs");
  await write(path.join(cap, "capability-process.md"), "# cap", 5);
  await write(path.join(cap, "capability-map.json"), "{}", 5);
  await write(path.join(cap, "process-model.json"), "{}", 5);
  // projects/<p>/documents/ is flat in practice, but nothing enforces that and
  // an upload route may create subfolders. A file two levels down is still a
  // document the capability map read.
  await write(path.join(proj, "documents", "policy", "2026", "outage.md"), "x", 1);

  assert.deepEqual(keys(await staleness(ws, "P")), ["capabilities"]);
});

test("stale rows carry a readable label for a document origin", async () => {
  const ws = await workspace();
  const proj = path.join(ws, "projects", "P");
  const cap = path.join(proj, "solutions", "Capabilities", "outputs");
  await write(path.join(cap, "capability-process.md"), "# cap", 5);
  await write(path.join(cap, "capability-map.json"), "{}", 5);
  await write(path.join(cap, "process-model.json"), "{}", 5);
  await write(path.join(proj, "documents", "policy.md"), "x", 1);

  const [row] = await staleness(ws, "P");
  // "documents" is a key, not something to show a client in a refresh prompt.
  assert.equal(row.supersededBy[0].label, "Project documents");
});
