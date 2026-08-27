// The rule that decides which system a project publishes to.
//
// It is small, and it is the single most consequential branch in the publishing
// layer: get it wrong and a delivery pack ends up split across Confluence and an
// Azure DevOps wiki, with a client holding links to half of each. The ordering
// below is the whole design — what a project HAS ALREADY PUBLISHED beats what
// this installation is configured for, because links already exist.
//
// Run:  node scripts/lib/publish-shared.test.mjs

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolvePublishTarget, mergePublished, readPublished, parseArgs } from "./publish-shared.mjs";

let dir;
const published = (name) => path.join(dir, `${name}.json`);
const write = async (name, obj) => {
  const f = published(name);
  await fs.writeFile(f, JSON.stringify(obj, null, 2));
  return f;
};

let passed = 0;
const test = async (name, fn) => {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
};

dir = await fs.mkdtemp(path.join(os.tmpdir(), "pubtarget-"));

console.log("resolvePublishTarget");

await test("defaults to atlassian with nothing configured", async () => {
  assert.equal(await resolvePublishTarget({ env: {} }), "atlassian");
});

await test("honours PUBLISH_TARGET for a project that has never published", async () => {
  assert.equal(await resolvePublishTarget({ env: { PUBLISH_TARGET: "ado" } }), "ado");
  assert.equal(await resolvePublishTarget({ env: { PUBLISH_TARGET: "atlassian" } }), "atlassian");
});

await test("a project that has published to ADO stays on ADO under an Atlassian install", async () => {
  // The rule that matters. A client has links to those wiki pages; flipping an
  // environment variable must not strand half a delivery pack.
  const f = await write("ado", { adoTarget: { org: "acme", project: "P" } });
  assert.equal(
    await resolvePublishTarget({ publishedFile: f, env: { PUBLISH_TARGET: "atlassian" } }),
    "ado");
});

await test("a project that has published to Atlassian stays there under an ADO install", async () => {
  const f = await write("atl", { atlassianTarget: { space: "SP" } });
  assert.equal(
    await resolvePublishTarget({ publishedFile: f, env: { PUBLISH_TARGET: "ado" } }),
    "atlassian");
});

await test("an explicit override beats the recorded target", async () => {
  // For a deliberate migration. Nothing else may move a project.
  const f = await write("ado2", { adoTarget: { org: "acme", project: "P" } });
  assert.equal(await resolvePublishTarget({ publishedFile: f, override: "atlassian" }), "atlassian");
});

await test("a missing .published.json falls through to the environment", async () => {
  assert.equal(
    await resolvePublishTarget({
      publishedFile: path.join(dir, "nope.json"), env: { PUBLISH_TARGET: "ado" },
    }),
    "ado");
});

await test("an adoTarget with no project does not count as published", async () => {
  // Half a record is not a target. Treating it as one would pin a project to a
  // system it never reached.
  const f = await write("empty", { adoTarget: {} });
  assert.equal(await resolvePublishTarget({ publishedFile: f, env: {} }), "atlassian");
});

console.log("mergePublished");

await test("preserves the other half of the file", async () => {
  // The failure this prevents: writing a target over the per-artefact page
  // identities makes every later revision create a SECOND page.
  const f = await write("merge", {
    adoTarget: { org: "acme", project: "P" },
    ado: { capabilities: { wikiPath: "/Cap", url: "u" } },
  });
  await mergePublished(f, { atlassian: { capabilities: { pageId: "1" } } });
  const after = await readPublished(f);
  assert.equal(after.adoTarget.org, "acme");
  assert.equal(after.ado.capabilities.wikiPath, "/Cap");
  assert.equal(after.atlassian.capabilities.pageId, "1");
});

await test("merges INTO a nested object rather than replacing it", async () => {
  const f = await write("merge2", { atlassian: { a: { pageId: "1" } } });
  await mergePublished(f, { atlassian: { b: { pageId: "2" } } });
  const after = await readPublished(f);
  assert.equal(after.atlassian.a.pageId, "1");
  assert.equal(after.atlassian.b.pageId, "2");
});

console.log("parseArgs");

await test("reads flags, booleans and positionals", async () => {
  const { flags, positional } = parseArgs(["file.md", "--title", "A B", "--json", "--n", "3"]);
  assert.deepEqual(positional, ["file.md"]);
  assert.equal(flags.title, "A B");
  assert.equal(flags.json, true);
  assert.equal(flags.n, "3");
});

await fs.rm(dir, { recursive: true, force: true });
console.log(`\n${passed} check(s) passed.`);
