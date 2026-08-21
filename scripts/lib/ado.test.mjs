/**
 * Unit tests for the pure helpers in `ado.mjs` — the ones that decide WHERE a
 * document is published, which is the part that is expensive to get wrong and
 * impossible to notice from a passing run.
 *
 * Run: npm run test:scripts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readAdoTarget, resolvePagePath } from "./ado.mjs";

async function tmpPublished(contents) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ado-test-"));
  const file = path.join(dir, ".published.json");
  await fs.writeFile(file, JSON.stringify(contents), "utf8");
  return file;
}

test("falls back to the template when nothing has been published", async () => {
  const file = await tmpPublished({});
  assert.equal(await resolvePagePath("/New Page", file, "capabilities"), "/New Page");
});

test("a previously published artefact keeps its recorded path", async () => {
  const file = await tmpPublished({
    ado: { capabilities: { wikiPath: "/Scyne/SAPN/Capability & Process Map" } },
  });
  // This is the whole point: the template moved, the page must not.
  assert.equal(
    await resolvePagePath("/Capability & Process Map", file, "capabilities"),
    "/Scyne/SAPN/Capability & Process Map");
});

test("another artefact's record does not leak", async () => {
  const file = await tmpPublished({ ado: { personas: { wikiPath: "/Old/Personas" } } });
  assert.equal(
    await resolvePagePath("/Capability & Process Map", file, "capabilities"),
    "/Capability & Process Map");
});

test("a malformed record is ignored rather than trusted", async () => {
  const file = await tmpPublished({ ado: { capabilities: { wikiPath: "no-leading-slash" } } });
  assert.equal(await resolvePagePath("/Good", file, "capabilities"), "/Good");
});

test("no published file at all is not an error", async () => {
  assert.equal(
    await resolvePagePath("/Good", "/nonexistent/.published.json", "capabilities"), "/Good");
  assert.equal(await resolvePagePath("/Good", null, null), "/Good");
});

test("reads an adoTarget", async () => {
  const file = await tmpPublished({
    adoTarget: { org: "Scyne-AI-Lab", project: "SAPN", workItemType: "User Story" },
  });
  const t = await readAdoTarget(file);
  assert.equal(t.project, "SAPN");
  assert.equal(t.workItemType, "User Story");
});

test("a target without a project is not a target", async () => {
  const file = await tmpPublished({ adoTarget: { org: "Scyne-AI-Lab" } });
  assert.equal(await readAdoTarget(file), null);
});

test("absent adoTarget and absent file both yield null", async () => {
  assert.equal(await readAdoTarget(await tmpPublished({ ado: {} })), null);
  assert.equal(await readAdoTarget("/nonexistent/.published.json"), null);
  assert.equal(await readAdoTarget(null), null);
});
