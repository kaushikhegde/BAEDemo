// The MAP phase: one agent per document, each seeing only its own document.
//
// This is an `exec` step rather than N `agent` steps because the workflow
// engine has no fan-out primitive — `flow` exists but parent-resume-on-child-
// completion is not implemented, and a workflow is compiled at boot, before any
// document is known.
//
// The cost of that shortcut USED to be that these runs got no `runs` row: no
// transcript, no cost, nothing in /spend, and no way to tell a working pass
// from a wedged one for the twenty minutes it takes. The step now records
// itself — one row per document over POST /issues/{id}/runs — so the only
// thing still missing is the engine's per-agent budget ceiling, which cannot
// apply to a process the engine did not spawn.

import { mkdir, open, rename, rm, stat, writeFile, readFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { execFile, spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { projectState, extractPathFor } from "./extract-state.mjs";
import { validateExtract } from "./lib/extract-schema.mjs";
// The runner's own argv builder and usage parser, imported rather than copied.
// The copy that used to live here is what this fixes — see runClaude below.
import { buildArgs, extractUsage } from "@scyne/orchestrator";

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
// One agent per document, N at a time. Eight rather than three because the
// wall clock is what a person waiting on this experiences and the token cost
// is identical either way — every document is extracted exactly once, so
// raising this trades concurrent processes on the box for a shorter run, not
// spend. Overridable without editing the compiled workflow, which passes no
// flag: `SCYNE_EXTRACT_CONCURRENCY=3` on a small machine.
const concurrency = Math.max(1, Number(
  val("--concurrency", process.env.SCYNE_EXTRACT_CONCURRENCY || "8")));
const onlyFeature = val("--feature", null);

/**
 * How a map pass is invoked.
 *
 * `SCYNE_EXTRACT_CMD` overrides it entirely and keeps the simple positional
 * contract the tests use: `<cmd> <outPath> <docPath>`. That is what lets the
 * suite run without spending money, and how a different adapter gets swapped in.
 *
 * The DEFAULT path is a real Claude Code invocation whose argv comes from
 * `buildArgs` — the runner's own, not a copy of it. There WAS a copy here, and
 * it dropped `--output-format stream-json --verbose` as "streaming output this
 * script has no use for". That output is where the `result` event lives, so
 * every document extracted with no token count, no cost and no transcript.
 * `runner.ts` insists every flag it carries is "confirmed against a real
 * invocation, not assumed"; a second, assumed list is the defect.
 */

/**
 * The model this pass runs on.
 *
 * Pinned here rather than inherited from `orchestrator.config.ts`'s default,
 * because extraction is form-filling from a single document and every other
 * stage is not — they are separate decisions and should stay separately
 * changeable. `--effort low` for the same reason: this is the case low effort
 * exists for, and it is the cost lever that does not trade away accuracy the
 * way a weaker model would.
 */
const EXTRACT_MODEL = process.env.SCYNE_EXTRACT_MODEL || "claude-sonnet-5";

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
 *
 * The argv is `buildArgs`', not a local copy. The copy this replaces omitted
 * `--output-format stream-json --verbose` as "streaming output this script has
 * no use for", which is precisely why a document's extraction had no token
 * count, no cost and no transcript: the `result` event only exists on that
 * output format. stdout is therefore BOTH the transcript and the usage record,
 * so it is written to `logPath` for the console to render and parsed by
 * `extractUsage` for the run row.
 */
const runClaude = (docPath, outPath, meta, logPath) => new Promise((resolve, reject) => {
  const args = buildArgs({
    agent: {
      key: "capArchitect",
      bundlePath: path.join(REPO, "agent-instructions", "extract.thin.md"),
      // No MCP: this agent reads one file and writes one file. Nothing it does
      // needs to reach Jira, Confluence or Azure DevOps.
      mcpEnabled: false,
      extraArgs: [],
    },
    model: EXTRACT_MODEL,
    effort: "low",
    // Claude Code takes its prompt on STDIN, not argv — buildArgs deliberately
    // leaves it out of the flag list, and it is written below.
    prompt: "",
    cwd: REPO,
    logPath: logPath ?? "",
  });

  const child = spawn("claude", args, {
    cwd: REPO, stdio: ["pipe", "pipe", "pipe"],
  });
  // Appended, matching the runner: a retried attempt must not silently
  // overwrite the transcript of the one before it.
  const log = logPath ? createWriteStream(logPath, { flags: "a" }) : null;
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => { stdout += d.toString(); log?.write(d); });
  child.stderr.on("data", (d) => { stderr += d.toString().slice(0, 4000); });
  child.on("error", reject);
  child.on("close", async (code) => {
    log?.end();
    const tail = stderr.trim().slice(-500);
    if (code !== 0) return reject(new Error(`claude exited ${code}: ${tail}`));
    const wroteSomething = await stat(outPath).then((s) => s.size > 0).catch(() => false);
    if (!wroteSomething) {
      return reject(new Error(
        `claude exited 0 without writing an extract` + (tail ? `: ${tail}` : " and said nothing on stderr")));
    }
    // null when the CLI emitted no result event. NOT an error and never fatal:
    // the extract is the work, its price tag is bookkeeping.
    let usage = null;
    try { usage = extractUsage(stdout); } catch { /* bookkeeping never fails the work */ }
    resolve({ usage });
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
    // No run row: no agent was spawned and nothing was spent. A row here would
    // report a $0.00 run that never happened.
    return { doc, docId, ok: true, usage: null, skipped: "extracted by another pass" };
  }

  // Opened only once the claim is WON, so a pass that lost the race leaves no
  // row behind. `run` is null whenever recording is unavailable — run by hand
  // from the CLI, no token, orchestrator down — and everything below tolerates
  // that, because the extract is the work.
  const run = await startRun(docId);

  try {
    // Declared BEFORE the branch, not inside the else: the override path spawns
    // no agent, so there is no usage to record — null, not zero — and a `const`
    // scoped to the else is out of scope by the time this function returns.
    let usage = null;
    const override = process.env.SCYNE_EXTRACT_CMD;
    if (override) {
      // Test/adapter path: positional contract, no shell, no stdin.
      const [cmd, ...base] = override.split(" ");
      await exec(cmd, [...base, partial, doc], { maxBuffer: 64 * 1024 * 1024 });
    } else {
      ({ usage } = await runClaude(path.resolve(doc), path.resolve(partial), {
        docId,
        scope: levelRoot === path.join(root, "projects", project)
          ? "project" : path.basename(levelRoot),
        category: path.basename(path.dirname(doc)),
      }, run?.log_path));
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
    await finishRun(run, { status: "succeeded", usage });
    return { doc, docId, ok: true, usage };
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
    await finishRun(run, { status: "failed", usage: null });
    return { doc, docId, ok: false, usage: null, reason: reason.slice(0, 300) };
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

/**
 * Say what is happening, on the issue whose step this is.
 *
 * The engine narrates STEPS, and cannot narrate inside one: this stage is a
 * single `exec` that spawns N agents itself, so between "step 2 of 5 started"
 * and "step 2 finished" there was twenty minutes of nothing. An `exec` also
 * gets no run rows — only `agent` steps do — so the console showed no runs, no
 * transcripts and no cost either. A healthy run and a wedged one looked
 * identical, and the only way to tell them apart was to wait.
 *
 * Best-effort in every direction. No issue id (a hand-run from the CLI), no
 * token, an unreachable orchestrator or a rejected insert must never fail an
 * extraction that is otherwise working — the comment is commentary, and the
 * extracts are the work.
 */
const ISSUE_ID = process.env.SCYNE_ISSUE_ID || "";
const ORCH = (process.env.ORCHESTRATOR_API_URL || "http://127.0.0.1:3100").replace(/\/+$/, "");
const orchHeaders = () => {
  const h = { "content-type": "application/json" };
  if (process.env.SCYNE_ORCH_TOKEN) h.authorization = `Bearer ${process.env.SCYNE_ORCH_TOKEN}`;
  return h;
};

const narrate = async (body) => {
  if (!ISSUE_ID) return;
  try {
    await fetch(`${ORCH}/issues/${ISSUE_ID}/comments`, {
      method: "POST", headers: orchHeaders(), body: JSON.stringify({ body }),
    });
  } catch { /* commentary, never the work */ }
};

/**
 * Open and close a `runs` row for ONE document's extraction.
 *
 * Nine agent invocations inside a single `exec` step used to leave no trace:
 * no transcript, no cost, nothing in /spend, and no way to tell a working pass
 * from a wedged one during the twenty minutes it takes. The engine narrates
 * STEPS and cannot narrate inside one, so the step records itself — the same
 * narrow seam `SCYNE_ISSUE_ID` already opens for comments, and nothing wider.
 *
 * Best-effort in every direction, exactly as `narrate` is, and for the same
 * reason: no issue id (a hand run from the CLI), no token, an unreachable
 * orchestrator or a rejected insert must never fail an extraction that is
 * otherwise working. A run row is bookkeeping; the extract is the work.
 */
const startRun = async (docId) => {
  if (!ISSUE_ID) return null;
  try {
    const res = await fetch(`${ORCH}/issues/${ISSUE_ID}/runs`, {
      method: "POST", headers: orchHeaders(),
      body: JSON.stringify({
        // Whose spend this is. /spend attributes by agent, and these tokens
        // belong to the Capabilities Process Architect like any other of its runs.
        agentKey: "capArchitect",
        // The docId IS the label: nine rows at one step index are only useful
        // if a reader can tell which document each one is.
        phase: `extract: ${docId}`,
        adapter: "claude_local",
        model: EXTRACT_MODEL,
      }),
    });
    return res.ok ? await res.json() : null;
  } catch { return null; }
};

const finishRun = async (run, { status, usage }) => {
  if (!run?.id) return;
  try {
    await fetch(`${ORCH}/runs/${run.id}`, {
      method: "PATCH", headers: orchHeaders(),
      body: JSON.stringify({
        status,
        exitCode: status === "succeeded" ? 0 : 1,
        sessionId: usage?.sessionId ?? null,
        inputTokens: usage?.inputTokens ?? null,
        outputTokens: usage?.outputTokens ?? null,
        cacheReadTokens: usage?.cacheReadTokens ?? null,
        cacheCreationTokens: usage?.cacheCreationTokens ?? null,
        costUsd: usage?.costUsd ?? null,
        durationMs: usage?.durationMs ?? null,
        numTurns: usage?.numTurns ?? null,
      }),
    });
  } catch { /* bookkeeping never fails the work */ }
};

const absOf = (d) => d.scope === "project"
  ? path.join(root, "projects", project, d.docId)
  : path.join(root, "projects", project, d.scope, d.docId);

/**
 * How many times a pass re-resolves its work list before giving up.
 *
 * The list is a SNAPSHOT, taken once, and uploads keep arriving: extraction
 * starts once per PROJECT now rather than once per document, so a pass
 * routinely begins before the last file has landed. SA-DEMO's SCY-5 is the
 * measured case — it resolved one document, extracted it, and
 * `validate-extracts.mjs` then found nine and blocked the issue, with the
 * extraction step itself having reported success.
 *
 * Bounded rather than "until nothing is left". A document that fails on every
 * attempt would otherwise loop forever, and `attempted` is what makes each
 * sweep strictly smaller: a document is tried at most once per pass, so the
 * loop drains even when every attempt fails.
 */
const MAX_SWEEPS = 3;
const attempted = new Set();
const idOf = (d) => `${d.scope}/${d.docId}`;

const results = [];
let sweep = 0;
let queue = todo;

while (queue.length && sweep < MAX_SWEEPS) {
  sweep++;
  for (const d of queue) attempted.add(idOf(d));
  const lanes = Math.min(concurrency, queue.length);

  if (sweep === 1) {
    // An estimate up front, because "how long will this take" is the question
    // somebody watching a blank panel is actually asking. Deliberately a RANGE
    // and deliberately rough: a document's extraction time is dominated by its
    // length and this knows only how many there are. A wrong-but-honest range
    // beats a spinner, and beats a precise number that is also wrong.
    const waves = Math.ceil(queue.length / Math.max(1, lanes));
    await narrate(
      `Extracting ${queue.length} document(s), ${lanes} at a time — about ` +
      `${waves * 2}–${waves * 5} minutes. One agent reads each document once and ` +
      `fills in a fixed form; a long PDF is the slow one.` +
      (st.ready ? ` ${st.ready} already extracted and skipped.` : ""));
  } else {
    await narrate(
      `${queue.length} more document(s) arrived while that ran — extracting those too.`);
  }

  const lane = [...queue];
  // The denominator counts what is known NOW. It grows between sweeps, which is
  // honest: a total that stayed wrong would be worse than one that moves when
  // more work genuinely appears.
  const total = results.length + lane.length;
  await Promise.all(Array.from({ length: lanes }, async () => {
    while (lane.length) {
      const r = await extractOne(absOf(lane.shift()));
      results.push(r);
      // Per document rather than per wave: a wave boundary tells you nothing
      // while the wave is running, which is the whole interval being reported on.
      await narrate(r.ok
        ? `${results.length}/${total} · extracted \`${r.docId}\`${r.skipped ? ` (${r.skipped})` : ""}`
        : `${results.length}/${total} · FAILED \`${r.docId}\` — ${r.reason}`);
    }
  }));

  // Re-resolve from disk. A document uploaded while the sweep above was running
  // is invisible to the list that sweep started from — which is the entire bug.
  const fresh = await projectState(root, project);
  queue = fresh.documents.filter((d) => d.state !== "ready" && !attempted.has(idOf(d)));
  if (onlyFeature) queue = queue.filter((d) => d.scope === onlyFeature);
  // An aimed retry is one named document, never a sweep for more work.
  if (onlyDoc) queue = [];
}

if (queue.length) {
  // Not any single document's failure, so it does not belong in a failure
  // marker — but it must not be silent either. `validate-extracts.mjs` is what
  // blocks the issue on it; this is what tells a reader why.
  console.error(
    `⚠ ${queue.length} document(s) still unextracted after ${MAX_SWEEPS} sweeps — ` +
    `documents are arriving faster than they extract, or something is wrong:`);
  for (const d of queue) console.error(`  - ${idOf(d)}`);
}

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

await narrate(failures.length
  ? `Extraction finished: ${results.length - failures.length} extracted, ${failures.length} failed. ` +
    `A document that failed the same way more than once will not extract \u2014 replace it rather than retrying.`
  : `Extraction finished: ${results.length} document(s) extracted.`);

process.exit(failures.length === 0 ? 0 : 1);
