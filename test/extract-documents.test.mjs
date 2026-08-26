import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { projectState, extractPathFor } from "../scripts/extract-state.mjs";
import { emptyExtract } from "../scripts/lib/extract-schema.mjs";

const execFileAsync = promisify(execFile);

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

// ---------------------------------------------------------------------------
// Failure detail, retry, and the claim that stops two passes racing.
// ---------------------------------------------------------------------------

const projRoot = () => join(root, "projects/P");
const docA = () => join(root, "projects/P/documents/a.md");

/** Run and capture stderr, which execFileSync otherwise forwards to the parent. */
const runFailing = (agent, ...args) => {
  try {
    execFileSync("node", [SCRIPT, "P", "--root", root, "--concurrency", "1", ...args],
      { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, SCYNE_EXTRACT_CMD: agent } });
    assert.fail("expected a non-zero exit");
  } catch (e) {
    if (e.status == null) throw e;
    return { code: e.status, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
};

const BROKEN = "node -e \"process.stderr.write('the model refused');process.exit(3)\"";

test("names the document and the reason on stderr when extraction fails", () => {
  const r = runFailing(BROKEN);
  assert.match(r.stderr, /a\.md/, "stderr must name the document that failed");
  assert.match(r.stderr, /the model refused/, "stderr must carry the underlying reason");
});

test("the failure marker records the document, the attempt count and when", async () => {
  runFailing(BROKEN);
  runFailing(BROKEN);

  const out = await extractPathFor(docA(), projRoot());
  const marker = JSON.parse(readFileSync(out.replace(/\.extract\.json$/, ".extract.failed.json"), "utf8"));

  assert.equal(marker.attempts, 2, "a second failure must increment, not reset to 1");
  assert.match(marker.doc, /a\.md/);
  assert.match(marker.reason, /the model refused/);
  assert.ok(marker.firstFailedAt, "records when it first failed");
  assert.ok(marker.lastFailedAt, "records when it last failed");
  assert.notEqual(marker.firstFailedAt, marker.lastFailedAt);
});

test("a failure reason does not leak absolute paths from this machine", async () => {
  // `extract_status` drops `extractPath` for exactly this reason: an end user
  // cannot open `/Users/<somebody>/…` and cannot act on it. The reason is the
  // field that now reaches them, so it has to hold to the same rule.
  const r = runFailing(BROKEN);
  const out = await extractPathFor(docA(), projRoot());
  const marker = JSON.parse(readFileSync(out.replace(/\.extract\.json$/, ".extract.failed.json"), "utf8"));

  assert.ok(!marker.reason.includes(root), `reason leaks the workspace path: ${marker.reason}`);
  assert.ok(!r.stderr.includes(root), `stderr leaks the workspace path: ${r.stderr}`);
  assert.match(marker.reason, /the model refused/, "the part that matters survives");
});

test("--doc retries one document and leaves the others alone", async () => {
  runFailing(BROKEN);
  assert.equal((await projectState(root, "P")).failed, 2);

  const out = JSON.parse(run("--concurrency", "1", "--doc", "documents/a.md"));
  assert.equal(out.extracted, 1, "only the named document is retried");

  const st = await projectState(root, "P");
  assert.equal(st.ready, 1);
  assert.equal(st.failed, 1, "the document that was not named stays failed");
});

test("takes over an abandoned .partial rather than failing", async () => {
  const out = await extractPathFor(docA(), projRoot());
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(`${out}.partial`, "");
  const old = new Date(Date.now() - 60_000);
  utimesSync(`${out}.partial`, old, old);

  const res = JSON.parse(execFileSync("node",
    [SCRIPT, "P", "--root", root, "--concurrency", "1"],
    { encoding: "utf8",
      env: { ...process.env, SCYNE_EXTRACT_CMD: `node ${STUB}`, SCYNE_EXTRACT_CLAIM_TTL_MS: "5000" } }));

  assert.equal(res.failed, 0, "an abandoned claim is not a failure");
  assert.equal((await projectState(root, "P")).ready, 2);
});

test("waits for a live claim instead of re-extracting what another pass produced", async () => {
  const out = await extractPathFor(docA(), projRoot());
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(`${out}.partial`, "");

  const running = execFileAsync("node",
    [SCRIPT, "P", "--root", root, "--concurrency", "1"],
    { encoding: "utf8",
      env: { ...process.env, SCYNE_EXTRACT_CMD: `node ${STUB}`, SCYNE_EXTRACT_CLAIM_TTL_MS: "60000" } });

  // The pass that owns the claim finishes: extract in place, claim released.
  await new Promise((r) => setTimeout(r, 500));
  const done = emptyExtract({ docId: "a.md", scope: "project", category: "documents" });
  done.windows = [{ pageStart: 1, pageEnd: 1 }];
  done.coverage = { pagesRead: 1, pagesTotal: 1, truncated: false };
  writeFileSync(out, JSON.stringify(done, null, 2));
  rmSync(`${out}.partial`, { force: true });

  const res = JSON.parse((await running).stdout);
  assert.equal(res.failed, 0);
  assert.equal(res.skipped, 1, "the claimed document is skipped, not re-extracted");
  assert.equal(res.extracted, 1, "only the unclaimed document was extracted here");
});

test("--force breaks a live claim instead of waiting for it", async () => {
  const out = await extractPathFor(docA(), projRoot());
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(`${out}.partial`, "");

  const started = Date.now();
  execFileSync("node", [SCRIPT, "P", "--root", root, "--concurrency", "1", "--force"],
    { encoding: "utf8",
      env: { ...process.env, SCYNE_EXTRACT_CMD: `node ${STUB}`, SCYNE_EXTRACT_CLAIM_TTL_MS: "30000" } });

  assert.ok(Date.now() - started < 10_000, "must not wait out the claim's TTL");
  assert.equal((await projectState(root, "P")).ready, 2);
});
