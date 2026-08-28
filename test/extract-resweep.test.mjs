// A pass must not be blind to a document that arrives while it is running.
//
// The work list is a SNAPSHOT, resolved once at the top of the pass. Extraction
// now starts once per PROJECT rather than once per document, so a pass
// routinely begins before the last upload has landed — which is exactly what
// happened to SA-DEMO's SCY-5: it resolved one document, extracted it, and
// `validate-extracts.mjs` then found nine and blocked the issue.
//
// No model is called and no money is spent: `SCYNE_EXTRACT_CMD` swaps the agent
// for a stub, which is the same seam the rest of the extraction tests use.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const REPO = path.resolve(import.meta.dirname, "..");

/**
 * Stands in for one `claude` invocation: `<cmd> <outPath> <docPath>`.
 *
 * On its FIRST call only, it drops a second document into the tree — an upload
 * landing mid-pass. Everything after that is an ordinary schema-valid extract.
 */
const STUB = `#!/usr/bin/env node
import { writeFile, stat } from "node:fs/promises";
import path from "node:path";
const [out, doc] = process.argv.slice(2);
const dir = process.env.STUB_DOCS_DIR;
const flag = path.join(dir, ".dropped");
let first = false;
try { await stat(flag); } catch { first = true; }
if (first) {
  await writeFile(flag, "1");
  await writeFile(path.join(dir, "Late.md"), "# Late\\n\\nArrived mid-pass.\\n");
}
await writeFile(out, JSON.stringify({
  version: 1, docId: path.basename(doc), scope: "project", category: "documents",
  windows: [{ pageStart: 1, pageEnd: 1 }],
  businessFunctions: [], processSteps: [], actors: [], serviceTiers: [],
  components: [], maturitySignals: [], lifecyclePhases: [], painPoints: [],
  coverage: { pagesRead: 1, pagesTotal: 1, truncated: false },
  usage: { inputTokens: 0, outputTokens: 0 },
}));
`;

const NEVER_DROPS = STUB.replace(
  'if (first) {\n  await writeFile(flag, "1");\n  await writeFile(path.join(dir, "Late.md"), "# Late\\n\\nArrived mid-pass.\\n");\n}', "");

async function tree(docNames, stubSource) {
  const root = await mkdtemp(path.join(tmpdir(), "resweep-"));
  const docs = path.join(root, "projects", "P", "documents");
  await mkdir(docs, { recursive: true });
  for (const n of docNames) await writeFile(path.join(docs, n), `# ${n}\n\nBody.\n`);
  const stub = path.join(root, "stub.mjs");
  await writeFile(stub, stubSource, { mode: 0o755 });
  return { root, docs, stub };
}

const extractsIn = async (root) =>
  (await readdir(path.join(root, "projects", "P", "solutions", "Extracts")).catch(() => []))
    .filter((f) => f.endsWith(".extract.json"));

const run = (root, stub, docs, extra = []) =>
  exec(path.join(REPO, "node_modules", ".bin", "tsx"), [path.join(REPO, "scripts", "extract-documents.mjs"), "P",
                "--root", root, "--concurrency", "1", ...extra],
       { env: { ...process.env, SCYNE_EXTRACT_CMD: `node ${stub}`, STUB_DOCS_DIR: docs } });

test("a document that lands mid-pass is extracted by a later sweep", async () => {
  const { root, docs, stub } = await tree(["First.md"], STUB);
  await run(root, stub, docs);
  // Two: the original, and the one that appeared while the pass was running.
  // Before the sweep loop this was one, and the validator then blocked the run.
  assert.equal((await extractsIn(root)).length, 2);
});

test("a settled tree still takes exactly one sweep", async () => {
  const { root, docs, stub } = await tree(["A.md", "B.md"], NEVER_DROPS);
  const { stdout } = await run(root, stub, docs);
  assert.equal((await extractsIn(root)).length, 2);
  // The re-sweep must not re-extract what is already ready — every document is
  // extracted exactly once, so `extracted` is 2 and not 4.
  assert.equal(JSON.parse(stdout).extracted, 2);
  assert.equal(JSON.parse(stdout).ok, true);
});
