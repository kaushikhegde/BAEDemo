// The MAP phase: one agent per document, each seeing only its own document.
//
// This is an `exec` step rather than N `agent` steps because the workflow
// engine has no fan-out primitive — `flow` exists but parent-resume-on-child-
// completion is not implemented, and a workflow is compiled at boot, before any
// document is known. The cost of that shortcut is that these runs get no `runs`
// row, so they do not appear in /spend and are not covered by the per-agent
// budget ceiling. Each extract records its own token usage so the spend is at
// least recoverable.

import { mkdir, open, rename, rm, stat, writeFile, readFile } from "node:fs/promises";
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
    "[--doc ID] [--concurrency N] [--force] [--dry-run] [--root R]");
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
 * How long a `.partial` is believed to belong to a live pass.
 *
 * The `.partial` is a CLAIM, not just a scratch file. Two passes over one
 * project overlap routinely — the chatbot fires `startExtraction` detached on
 * every upload while the workflow's own `extract` step runs the same script —
 * and two documents with identical bytes hash to one extract path, so even a
 * single pass can collide with itself. Before this, the loser read a `.partial`
 * the winner had already renamed away and recorded
 *
 *     ENOENT: ... <hash>.extract.json.partial
 *
 * as that document's permanent failure reason: a complete, valid extract sat on
 * disk while the marker beside it said the document could not be read.
 *
 * A claim expires because a SIGKILLed pass cannot release its own — the same
 * stale-owner rule `pgdata.lock` uses. The TTL is generous against the 20-minute
 * step timeout; `SCYNE_EXTRACT_CLAIM_TTL_MS` shortens it for tests.
 */
const CLAIM_TTL_MS = Math.max(1000, Number(process.env.SCYNE_EXTRACT_CLAIM_TTL_MS) || 25 * 60 * 1000);
const CLAIM_POLL_MS = Math.min(500, Math.max(50, Math.floor(CLAIM_TTL_MS / 8)));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Take this machine's absolute paths out of anything a person will read.
 *
 * The failure reason now travels — into the marker, onto stderr, through
 * `/api/extract-status` and into an issue's blocking comment — and the workspace
 * root is `/Users/<somebody>/…` on whichever machine happened to run the pass.
 * `extract_status` already drops `extractPath` on exactly this reasoning: a
 * reader can neither open it nor act on it. The reason has to hold to the same
 * rule now that it is the field they actually see.
 */
const scrub = (text) => String(text ?? "").split(root).join("<workspace>").split(REPO).join("<install>");

/**
 * Is there already a usable extract at this path?
 *
 * VALID, not merely present. "Is the file there" is the check that lets a
 * malformed extract be mistaken for finished work — the same distinction
 * `stateOf` draws, and the reason a file that exists but does not validate is
 * `failed` rather than `ready`.
 */
const extractIsReady = async (out) => {
  try { return validateExtract(JSON.parse(await readFile(out, "utf8"))).ok; }
  catch { return false; }
};

/**
 * Take exclusive ownership of a document's `.partial`, or find out that another
 * pass has already done the work.
 *
 * `wx` is the whole mechanism: it CREATES or fails, where the `writeFile` it
 * replaced truncated whatever was there and so quietly stole a live claim.
 * Returns "claimed" (ours, extract it) or "done-by-other" (the extract is on
 * disk already, nothing to spend). `--force` breaks a claim outright, which is
 * the escape hatch for a document wedged at `extracting` by a killed pass that
 * has not yet aged past the TTL.
 */
const claimPartial = async (partial, out, force) => {
  if (force) await rm(partial, { force: true });
  const deadline = Date.now() + CLAIM_TTL_MS;
  for (;;) {
    // Checked at the TOP, so it covers both "somebody got here first" and
    // "somebody finished while we waited". Checking it only on EEXIST is not
    // enough: the owner releases the claim and produces the extract in the same
    // instant, so the very next `wx` succeeds and the work gets paid for twice.
    // `--force` means overwrite, so it deliberately looks past a ready extract.
    if (!force && await extractIsReady(out)) return "done-by-other";
    try {
      await (await open(partial, "wx")).close();
      return "claimed";
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      const s = await stat(partial).catch(() => null);
      // Released by its owner without producing an extract, aged out, or held
      // so long that waiting is itself the failure — take it either way. The
      // deadline is what makes this loop guaranteed to terminate.
      if (!s || Date.now() - s.mtimeMs > CLAIM_TTL_MS || Date.now() > deadline) {
        await rm(partial, { force: true });
        continue;
      }
      await sleep(CLAIM_POLL_MS);
    }
  }
};

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

/**
 * Spawn Claude Code with the prompt on stdin, as the orchestrator's runner does.
 *
 * An exit code says a model stopped talking; it has never said the work
 * happened — the same lesson the requirements publish learned when 45 stories
 * produced zero work items and the run recorded `succeeded`. Here it produced
 * a document whose extraction was reported as
 *
 *     Unexpected end of JSON input
 *
 * which is not what went wrong: it is `JSON.parse("")` on the EMPTY `.partial`
 * placeholder, read after a `claude` that exited 0 having written nothing. The
 * stderr that would have said why was captured and then discarded, because it
 * was only surfaced on a non-zero exit.
 *
 * So a zero exit is now checked against the artefact, and stderr is carried
 * either way. `wroteSomething` deliberately tests for a NON-EMPTY file rather
 * than for existence — the placeholder always exists, which is exactly how the
 * empty case slipped through as a parse error.
 */
const runClaude = (docPath, outPath, meta) => new Promise((resolve, reject) => {
  const child = spawn("claude", CLAUDE_ARGS, {
    cwd: REPO, stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (d) => { stderr += d.toString().slice(0, 4000); });
  child.on("error", reject);
  child.on("close", async (code) => {
    const tail = stderr.trim().slice(-500);
    if (code !== 0) return reject(new Error(`claude exited ${code}: ${tail}`));
    const wroteSomething = await stat(outPath).then((s) => s.size > 0).catch(() => false);
    if (!wroteSomething) {
      return reject(new Error(
        `claude exited 0 without writing an extract` + (tail ? `: ${tail}` : " and said nothing on stderr")));
    }
    resolve();
  });
  // EPIPE if the child exits before reading — it is not an error worth failing on,
  // because `close` above carries the real outcome.
  child.stdin.on("error", () => {});
  child.stdin.end(promptFor(docPath, outPath, meta));
});

const extractOne = async (doc) => {
  const levelRoot = levelRootFor(doc);
  const out = await extractPathFor(doc, levelRoot);
  const docId = path.relative(levelRoot, doc);
  const partial = `${out}.partial`;
  const failed = out.replace(/\.extract\.json$/, ".extract.failed.json");
  await mkdir(path.dirname(out), { recursive: true });

  // READ before clearing. The marker is the only record of how many times this
  // document has been tried; clearing it first is what made `attempts` say 1 on
  // the fifth attempt, so nothing could tell a document that failed once from
  // one that will never succeed.
  const prior = await readFile(failed, "utf8").then(JSON.parse).catch(() => null);
  await rm(failed, { force: true });

  // The .partial exists for the whole run: it is what makes `stateOf` able to
  // say "extracting", what stops a killed run leaving a half-written file at
  // the real path that would then validate as ready, and — since it is taken
  // with `wx` — the claim that keeps two passes from colliding.
  if (await claimPartial(partial, out, flag("--force")) === "done-by-other") {
    await rm(failed, { force: true });
    return { doc, docId, ok: true, skipped: "extracted by another pass" };
  }

  try {
    const override = process.env.SCYNE_EXTRACT_CMD;
    if (override) {
      // Test/adapter path: positional contract, no shell, no stdin.
      const [cmd, ...base] = override.split(" ");
      await exec(cmd, [...base, partial, doc], { maxBuffer: 64 * 1024 * 1024 });
    } else {
      await runClaude(path.resolve(doc), path.resolve(partial), {
        docId,
        scope: levelRoot === path.join(root, "projects", project)
          ? "project" : path.basename(levelRoot),
        category: path.basename(path.dirname(doc)),
      });
    }
    const parsed = JSON.parse(await readFile(partial, "utf8"));
    const v = validateExtract(parsed);
    if (!v.ok) throw new Error(v.errors.slice(0, 5).join("; "));
    await rename(partial, out);
    // Cleared again, AFTER the extract is in place. Clearing it only at the
    // start of an attempt is not enough: two attempts against one document
    // race, and a loser writing its marker after the winner renamed left a
    // COMPLETE, schema-valid extract permanently reported as failed — which is
    // what blocked SA-DEMO-1's capability map behind a 40 KB extract that was
    // never actually broken. `stateOf` reads the marker before the extract, so
    // a stale one wins every time.
    await rm(failed, { force: true });
    return { doc, docId, ok: true };
  } catch (e) {
    await rm(partial, { force: true });
    const reason = scrub(e.message ?? e);
    const now = new Date().toISOString();
    // Everything a person needs to decide whether to retry: which document,
    // why, how many times it has now failed, and over what period. `attempts`
    // is the field that separates "the model had a bad night" from "this is a
    // scanned PDF with no text layer and never will extract".
    await writeFile(failed, JSON.stringify({
      reason: reason.slice(0, 600),
      doc: docId,
      attempts: (Number(prior?.attempts) || 0) + 1,
      firstFailedAt: prior?.firstFailedAt ?? now,
      lastFailedAt: now,
      ...(e.stderr ? { stderrTail: scrub(e.stderr).trim().slice(-500) } : {}),
    }, null, 2));
    return { doc, docId, ok: false, reason: reason.slice(0, 300) };
  }
};

const st = await projectState(root, project);
let todo = st.documents.filter((d) => flag("--force") || d.state !== "ready");
if (onlyFeature) todo = todo.filter((d) => d.scope === onlyFeature);

// `--doc` is the aimed retry: one document, by the id `extract_status` reports
// (`documents/a.md`, or `<feature>/requirements/SOP/x.md`). Accepted with or
// without the scope prefix, because that is how the two surfaces name it.
const onlyDoc = val("--doc", null);
if (onlyDoc) {
  const wanted = onlyDoc.replace(/^\.\//, "");
  todo = todo.filter((d) => d.docId === wanted || `${d.scope}/${d.docId}` === wanted);
  if (!todo.length) {
    console.error(`no such document in ${project}: ${onlyDoc}`);
    // Scoped, because a bare docId is not unique: two features can each hold
    // `requirements/SOP/Onboarding.md`, and listing that string twice tells
    // somebody nothing about which one they meant.
    console.error(`known: ${st.documents.map((d) => `${d.scope}/${d.docId}`).join(", ") || "(none)"}`);
    process.exit(2);
  }
}

// Two documents with identical bytes hash to ONE extract path. Left in, they
// would race each other for the same claim inside a single pass — one waiting
// out the other for no reason, since whatever the winner writes is byte-for-byte
// what the loser would have written.
const seenPath = new Set();
todo = todo.filter((d) => !d.extractPath || !seenPath.has(d.extractPath) && seenPath.add(d.extractPath));

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
const skipped = results.filter((r) => r.ok && r.skipped);

// The failures go to STDERR as well as into the JSON below.
//
// Not belt and braces — this is the only copy that reaches a human. This script
// runs as an `exec` step, and the engine builds its blocking comment from the
// step's stderr; the JSON summary on stdout is discarded. So an extraction that
// failed for a nameable reason arrived as "the extraction script exited with
// code 1 and returned no error details", with the reason sitting in a file on a
// machine the person reading that comment has no access to.
if (failures.length) {
  console.error(`\u2717 ${failures.length} of ${results.length} document(s) failed to extract:`);
  for (const f of failures) console.error(`  - ${f.docId}: ${f.reason}`);
}

console.log(JSON.stringify({
  ok: failures.length === 0,
  extracted: results.filter((r) => r.ok && !r.skipped).length,
  alreadyReady: st.ready - (flag("--force") ? st.ready : 0),
  skipped: skipped.length,
  skippedDocuments: skipped.map((r) => ({ doc: r.docId, why: r.skipped })),
  failed: failures.length,
  failures: failures.map((f) => ({ doc: f.docId, reason: f.reason })),
}, null, 2));

process.exit(failures.length === 0 ? 0 : 1);
