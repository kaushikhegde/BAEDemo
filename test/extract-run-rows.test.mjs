// One run row per document, so nine agent invocations inside one `exec` step
// stop being invisible.
//
// A stub orchestrator on a loopback port stands in for the real one: no
// database, no server boot, and the assertions are about what the script SENDS,
// which is the contract that matters. `SCYNE_EXTRACT_CMD` keeps the agent side
// free as everywhere else.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const REPO = path.resolve(import.meta.dirname, "..");
const TSX = path.join(REPO, "node_modules", ".bin", "tsx");
const SCRIPT = path.join(REPO, "scripts", "extract-documents.mjs");

const STUB = `#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import path from "node:path";
const [out, doc] = process.argv.slice(2);
await writeFile(out, JSON.stringify({
  version: 1, docId: path.basename(doc), scope: "project", category: "documents",
  windows: [{ pageStart: 1, pageEnd: 1 }],
  businessFunctions: [], processSteps: [], actors: [], serviceTiers: [],
  components: [], maturitySignals: [], lifecyclePhases: [], painPoints: [],
  coverage: { pagesRead: 1, pagesTotal: 1, truncated: false },
  usage: { inputTokens: 0, outputTokens: 0 },
}));
`;

async function tree(names) {
  const root = await mkdtemp(path.join(tmpdir(), "runrows-"));
  const docs = path.join(root, "projects", "P", "documents");
  await mkdir(docs, { recursive: true });
  for (const n of names) await writeFile(path.join(docs, n), `# ${n}\n\nBody.\n`);
  const stub = path.join(root, "stub.mjs");
  await writeFile(stub, STUB, { mode: 0o755 });
  return { root, stub };
}

/** A stub orchestrator that records what the script asked it to do. */
async function stubOrchestrator() {
  const seen = { started: [], finished: [] };
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      const parsed = body ? JSON.parse(body) : {};
      if (req.method === "POST" && req.url.endsWith("/runs")) {
        seen.started.push(parsed);
        const id = `run-${seen.started.length}`;
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify({ id, log_path: path.join(tmpdir(), `${id}.jsonl`) }));
        return;
      }
      if (req.method === "PATCH" && req.url.startsWith("/runs/")) {
        seen.finished.push({ id: req.url.slice("/runs/".length), ...parsed });
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { seen, server, port: server.address().port };
}

test("one run row is opened and closed per document", async () => {
  const { seen, server, port } = await stubOrchestrator();
  const { root, stub } = await tree(["A.md", "B.md"]);

  await exec(TSX, [SCRIPT, "P", "--root", root, "--concurrency", "1"], {
    env: { ...process.env,
      SCYNE_EXTRACT_CMD: `node ${stub}`,
      SCYNE_ISSUE_ID: "issue-1",
      ORCHESTRATOR_API_URL: `http://127.0.0.1:${port}`,
    },
  });
  server.close();

  assert.equal(seen.started.length, 2, "one run opened per document");
  assert.equal(seen.finished.length, 2, "each one closed");
  // The phase carries the document, so nine rows are nine distinguishable rows
  // rather than nine identical ones.
  assert.deepEqual(seen.started.map((s) => s.phase).sort(),
    ["extract: documents/A.md", "extract: documents/B.md"]);
  // Whose spend it is. /spend attributes by agent.
  assert.ok(seen.started.every((s) => s.agentKey === "capArchitect"));
  assert.ok(seen.started.every((s) => s.model === "claude-sonnet-5"));
  assert.ok(seen.finished.every((f) => f.status === "succeeded"));
});

test("an unreachable orchestrator does not fail the extraction", async () => {
  const { root, stub } = await tree(["A.md"]);
  // Port 1 is closed. Every bookkeeping call fails; the extract must still land
  // and the script must still exit 0 — a run row is bookkeeping, not the work.
  const { stdout } = await exec(TSX, [SCRIPT, "P", "--root", root], {
    env: { ...process.env,
      SCYNE_EXTRACT_CMD: `node ${stub}`,
      SCYNE_ISSUE_ID: "issue-1",
      ORCHESTRATOR_API_URL: "http://127.0.0.1:1",
    },
  });
  assert.equal(JSON.parse(stdout).extracted, 1);
  assert.equal(JSON.parse(stdout).ok, true);
});

test("no issue id means no run rows, and no attempt to make any", async () => {
  const { seen, server, port } = await stubOrchestrator();
  const { root, stub } = await tree(["A.md"]);

  // A hand run from the CLI. There is no issue to record against, and inventing
  // one would file this work under something arbitrary.
  await exec(TSX, [SCRIPT, "P", "--root", root], {
    env: { ...process.env,
      SCYNE_EXTRACT_CMD: `node ${stub}`,
      ORCHESTRATOR_API_URL: `http://127.0.0.1:${port}`,
      SCYNE_ISSUE_ID: "",
    },
  });
  server.close();
  assert.equal(seen.started.length, 0);
});
