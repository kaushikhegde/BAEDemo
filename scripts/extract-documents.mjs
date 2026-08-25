// The MAP phase: one agent per document, each seeing only its own document.
//
// This is an `exec` step rather than N `agent` steps because the workflow
// engine has no fan-out primitive — `flow` exists but parent-resume-on-child-
// completion is not implemented, and a workflow is compiled at boot, before any
// document is known. The cost of that shortcut is that these runs get no `runs`
// row, so they do not appear in /spend and are not covered by the per-agent
// budget ceiling. Each extract records its own token usage so the spend is at
// least recoverable.

import { mkdir, rename, rm, writeFile, readFile } from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { projectState, extractPathFor } from "./extract-state.mjs";
import { validateExtract } from "./lib/extract-schema.mjs";

const exec = promisify(execFile);

/**
 * The REPO root — where this script lives — as distinct from `--root`, the
 * workspace whose projects/ tree is being extracted. They are usually the same
 * directory and were assumed to be, which is why the first real run died with
 * "System prompt file not found": the agent was spawned with cwd set to the
 * workspace, so `agent-instructions/extract.thin.md` resolved under it.
 *
 * Two things must resolve against the REPO: the system prompt file, and
 * `.claude/skills/`, which is how Claude Code discovers `document-extract` at
 * all. Everything about the DOCUMENT resolves against the workspace, so those
 * paths are passed absolute.
 */
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const argv = process.argv.slice(2);
const project = argv[0];
const flag = (f) => argv.includes(f);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

if (!project || project.startsWith("--")) {
  console.error("usage: node scripts/extract-documents.mjs <project> [--feature F] " +
    "[--concurrency N] [--force] [--dry-run] [--root R]");
  process.exit(2);
}

const root = path.resolve(val("--root", process.env.WORKSPACE_PATH || process.cwd()));
const concurrency = Math.max(1, Number(val("--concurrency", "3")));
const onlyFeature = val("--feature", null);

/**
 * How a map pass is invoked.
 *
 * `SCYNE_EXTRACT_CMD` overrides it entirely and keeps the simple positional
 * contract the tests use: `<cmd> <outPath> <docPath>`. That is what lets the
 * suite run without spending money, and how a different adapter gets swapped in.
 *
 * The DEFAULT path is a real Claude Code invocation, and it does not look like
 * the override: Claude Code takes its prompt on **stdin**, not argv
 * (packages/orchestrator/src/core/runner.ts:91 says so explicitly), so passing
 * the paths as positional arguments would hand them over as the prompt itself.
 * The flags mirror `buildArgs` in that same file, minus the streaming output
 * this script has no use for.
 */
const CLAUDE_ARGS = [
  "-p",
  "--permission-mode", "bypassPermissions",
  "--no-session-persistence",
  "--exclude-dynamic-system-prompt-sections",
  "--strict-mcp-config",
  "--system-prompt-file", path.join(REPO, "agent-instructions", "extract.thin.md"),
];

/**
 * The prompt carries the EXACT JSON envelope, pre-filled with the three fields
 * this script already knows. The first real run failed validation because the
 * skill describes the eight lists in prose and the agent invented its own
 * wrapper — prose is enough to say what to look for, and not enough to pin a
 * shape. Anything the caller can fill in, the caller fills in.
 */
const promptFor = (docPath, outPath, meta) => [
  `Read exactly one document and extract it.`,
  ``,
  `Document: ${docPath}`,
  `Write the JSON extract to: ${outPath}`,
  ``,
  `Invoke the document-extract skill and follow it exactly. Read no other`,
  `document.`,
  ``,
  `The output MUST have exactly this shape. The first four fields are given —`,
  `copy them verbatim. Fill in the eight lists and coverage.`,
  ``,
  "```json",
  JSON.stringify({
    version: 1,
    docId: meta.docId,
    scope: meta.scope,
    category: meta.category,
    windows: [{ pageStart: 1, pageEnd: 1 }],
    businessFunctions: [], processSteps: [], actors: [], serviceTiers: [],
    components: [], maturitySignals: [], lifecyclePhases: [], painPoints: [],
    coverage: { pagesRead: 1, pagesTotal: 1, truncated: false },
    usage: { inputTokens: 0, outputTokens: 0 },
  }, null, 2),
  "```",
  ``,
  `No other top-level field is permitted — an unrecognised key is rejected.`,
  `Every item in every list carries "src": {"pageStart": N, "pageEnd": N}.`,
  `painPoints items also carry "quote", copied verbatim from the document.`,
  `A plain markdown document with no page markers is page 1 throughout.`,
  ``,
  `Write the file and stop — no prose in your reply.`,
].join("\n");

/**
 * Which root a document's extract belongs under.
 * `projects/<p>/documents/...` is project level; `projects/<p>/<feature>/...`
 * belongs to that feature.
 */
const levelRootFor = (doc) => {
  const rel = path.relative(path.join(root, "projects", project), doc);
  const first = rel.split(path.sep)[0];
  return first === "documents"
    ? path.join(root, "projects", project)
    : path.join(root, "projects", project, first);
};

/** Spawn Claude Code with the prompt on stdin, as the orchestrator's runner does. */
const runClaude = (docPath, outPath, meta) => new Promise((resolve, reject) => {
  const child = spawn("claude", CLAUDE_ARGS, {
    cwd: REPO, stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (d) => { stderr += d.toString().slice(0, 4000); });
  child.on("error", reject);
  child.on("close", (code) => code === 0
    ? resolve()
    : reject(new Error(`claude exited ${code}: ${stderr.trim().slice(-500)}`)));
  // EPIPE if the child exits before reading — it is not an error worth failing on,
  // because `close` above carries the real outcome.
  child.stdin.on("error", () => {});
  child.stdin.end(promptFor(docPath, outPath, meta));
});

const extractOne = async (doc) => {
  const levelRoot = levelRootFor(doc);
  const out = await extractPathFor(doc, levelRoot);
  const partial = `${out}.partial`;
  const failed = out.replace(/\.extract\.json$/, ".extract.failed.json");
  await mkdir(path.dirname(out), { recursive: true });
  await rm(failed, { force: true });

  // The .partial exists for the whole run: it is what makes `stateOf` able to
  // say "extracting", and what stops a killed run leaving a half-written file
  // at the real path that would then validate as ready.
  await writeFile(partial, "");

  try {
    const override = process.env.SCYNE_EXTRACT_CMD;
    if (override) {
      // Test/adapter path: positional contract, no shell, no stdin.
      const [cmd, ...base] = override.split(" ");
      await exec(cmd, [...base, partial, doc], { maxBuffer: 64 * 1024 * 1024 });
    } else {
      const rel = path.relative(levelRoot, doc);
      await runClaude(path.resolve(doc), path.resolve(partial), {
        docId: rel,
        scope: levelRoot === path.join(root, "projects", project)
          ? "project" : path.basename(levelRoot),
        category: path.basename(path.dirname(doc)),
      });
    }
    const parsed = JSON.parse(await readFile(partial, "utf8"));
    const v = validateExtract(parsed);
    if (!v.ok) throw new Error(v.errors.slice(0, 5).join("; "));
    await rename(partial, out);
    return { doc, ok: true };
  } catch (e) {
    await rm(partial, { force: true });
    await writeFile(failed, JSON.stringify({
      reason: String(e.message ?? e).slice(0, 600), attempts: 1,
    }, null, 2));
    return { doc, ok: false, reason: String(e.message ?? e).slice(0, 300) };
  }
};

const st = await projectState(root, project);
let todo = st.documents.filter((d) => flag("--force") || d.state !== "ready");
if (onlyFeature) todo = todo.filter((d) => d.scope === onlyFeature);

if (flag("--dry-run")) {
  console.log(JSON.stringify({ ok: true, wouldExtract: todo.length,
    documents: todo.map((d) => d.docId) }, null, 2));
  process.exit(0);
}

const absOf = (d) => d.scope === "project"
  ? path.join(root, "projects", project, d.docId)
  : path.join(root, "projects", project, d.scope, d.docId);

const results = [];
const queue = [...todo];
await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
  while (queue.length) results.push(await extractOne(absOf(queue.shift())));
}));

const failures = results.filter((r) => !r.ok);
console.log(JSON.stringify({
  ok: failures.length === 0,
  extracted: results.filter((r) => r.ok).length,
  alreadyReady: st.ready - (flag("--force") ? st.ready : 0),
  failed: failures.length,
  failures: failures.map((f) => ({ doc: path.basename(f.doc), reason: f.reason })),
}, null, 2));

process.exit(failures.length === 0 ? 0 : 1);
