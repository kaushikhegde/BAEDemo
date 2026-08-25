import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectState } from "../scripts/extract-state.mjs";

let root;
const SCRIPT = join(process.cwd(), "scripts/extract-documents.mjs");

// A stub "agent" so the test never spends money. The script must honour
// SCYNE_EXTRACT_CMD, which is also how a different adapter gets wired in.
const STUB = join(process.cwd(), "test/fixtures/stub-extract-agent.mjs");

beforeEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = mkdtempSync(join(tmpdir(), "extract-run-"));
  mkdirSync(join(root, "projects/P/documents"), { recursive: true });
  writeFileSync(join(root, "projects/P/documents/a.md"), "# alpha\n\nWe handle refunds.\n");
  writeFileSync(join(root, "projects/P/documents/b.md"), "# beta\n\nWe assess claims.\n");
});

const run = (...args) =>
  execFileSync("node", [SCRIPT, "P", "--root", root, ...args],
    { encoding: "utf8", env: { ...process.env, SCYNE_EXTRACT_CMD: `node ${STUB}` } });

test("writes one extract per document and reports it", async () => {
  const out = JSON.parse(run("--concurrency", "1"));
  assert.equal(out.ok, true);
  assert.equal(out.extracted, 2);
  const st = await projectState(root, "P");
  assert.equal(st.ready, 2);
  assert.equal(st.missing, 0);
});

test("is idempotent — a second run extracts nothing", async () => {
  run("--concurrency", "1");
  const out = JSON.parse(run("--concurrency", "1"));
  assert.equal(out.extracted, 0);
  assert.equal(out.alreadyReady, 2);
});

test("--force re-extracts a document that is already ready", () => {
  run("--concurrency", "1");
  const out = JSON.parse(run("--concurrency", "1", "--force"));
  assert.equal(out.extracted, 2);
});

test("an edited document is re-extracted without --force", async () => {
  run("--concurrency", "1");
  writeFileSync(join(root, "projects/P/documents/a.md"), "# alpha, revised\n");
  const out = JSON.parse(run("--concurrency", "1"));
  assert.equal(out.extracted, 1, "only the changed document");
});

test("a failing agent leaves the document failed and exits non-zero", () => {
  let code = 0;
  try {
    execFileSync("node", [SCRIPT, "P", "--root", root, "--concurrency", "1"],
      { encoding: "utf8", env: { ...process.env, SCYNE_EXTRACT_CMD: "node -e \"process.exit(3)\"" } });
  } catch (e) { code = e.status; }
  assert.notEqual(code, 0, "must exit non-zero when a document fails");
});

test("an agent that writes an INVALID extract is recorded failed, not ready", async () => {
  const bad = join(root, "bad-agent.mjs");
  writeFileSync(bad, `import {writeFileSync} from "node:fs";
    writeFileSync(process.argv[2], JSON.stringify({version:1,docId:"x"}));`);
  let threw = false;
  try {
    execFileSync("node", [SCRIPT, "P", "--root", root, "--concurrency", "1"],
      { encoding: "utf8", env: { ...process.env, SCYNE_EXTRACT_CMD: `node ${bad}` } });
  } catch { threw = true; }
  assert.ok(threw);
  const st = await projectState(root, "P");
  assert.equal(st.ready, 0);
  assert.equal(st.failed, 2);
});

test("leaves no .partial behind on success", () => {
  run("--concurrency", "1");
  const dir = join(root, "projects/P/solutions/Extracts");
  assert.equal(readdirSync(dir).filter((f) => f.endsWith(".partial")).length, 0);
});
