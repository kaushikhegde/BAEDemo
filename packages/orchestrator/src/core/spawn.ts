// The child-process machinery every subprocess adapter shares.
//
// Extracted from runner.ts when a second whole-agent adapter (Codex) arrived.
// None of what follows is Claude-specific: the separate stdout/stderr line
// buffering, the JSONL envelope log, the bounded budget kill, the idempotent
// resolution, the EPIPE swallow. Each of those exists because of a specific
// incident recorded in the comments below, and a second copy would be a second
// place for those incidents to come back.
//
// What an adapter supplies is a binary, an argv, and a way to read usage out of
// the stdout it produced. Nothing else.

import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { RunRequest, RunResult } from "./runner.js";
import type { RunUsage } from "./usage.js";

export interface SpawnSpec {
  bin: string;
  args: string[];
  /** Extract usage from the child's complete stdout. Null when it reported none. */
  extractUsage: (capturedStdout: string) => RunUsage | null;
}

/** How long to wait after SIGTERM before escalating to SIGKILL on a budget kill. */
const BUDGET_KILL_GRACE_MS = 5_000;

/**
 * Backstop when a caller supplies no `budget.maxDurationMs` at all: 60
 * minutes, not 30 — this is a safety net that must never fire in normal
 * operation, not a policy limit. It exists purely so a hung `claude` process
 * (network stall, waiting on an interactive prompt that will never come, …)
 * cannot hang the orchestrator forever. Callers who care about a real
 * per-run limit should still set their own via `budget.maxDurationMs`.
 */
export const BACKSTOP_DURATION_MS = 60 * 60 * 1000;

/** Cap on how much stderr we keep in memory for the result's `stderrTail`. */
export const STDERR_TAIL_CHARS = 4_000;

/** Splits `buf` into complete (`\n`-terminated) lines and leftover residue. */
function takeCompleteLines(buf: string): { lines: string[]; rest: string } {
  const lines: string[] = [];
  let rest = buf;
  for (;;) {
    const nl = rest.indexOf("\n");
    if (nl < 0) break;
    lines.push(rest.slice(0, nl + 1)); // keep the trailing \n — transcript.ts re-splits on it anyway
    rest = rest.slice(nl + 1);
  }
  return { lines, rest };
}

export function runChild(req: RunRequest, spec: SpawnSpec): Promise<RunResult> {
  return new Promise<RunResult>((resolve) => {
    const started = Date.now();

    // All mutable run state lives up front, in the Promise executor's own
    // scope — NOT inside the try block below — so that a throw partway
    // through setup (CRITICAL 2) still leaves `resolveOnce`/`finishNormally`
    // able to see whatever timers/streams/buffers already exist and clean
    // them up, rather than referencing not-yet-declared `let`s.
    let settled = false;
    let logStream: ReturnType<typeof createWriteStream> | undefined;
    let captured = "";       // full stdout, byte for byte — what extractUsage reads
    let stderrAll = "";      // full stderr, byte for byte — never mixed into `captured`
    let stdoutLineBuf = "";  // stdout bytes not yet resolved into a complete \n-terminated line
    let stderrLineBuf = "";  // same, for stderr
    let killedForBudget = false;
    let durationTimer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;

    const clearTimers = () => {
      if (durationTimer) clearTimeout(durationTimer);
      if (killTimer) clearTimeout(killTimer);
    };

    const writeEnvelope = (stream: "stdout" | "stderr", chunk: string) => {
      logStream?.write(JSON.stringify({ ts: new Date().toISOString(), stream, chunk }) + "\n");
    };

    // CRITICAL 1 fix. The previous version wrote every raw pipe `data`
    // event straight to the log as its own envelope, regardless of
    // whether it held a complete line. transcript.ts's filterRunLog()
    // reassembles the inner stream-json stream by concatenating every
    // envelope's `chunk` IN FILE ORDER — it has to, since that's the only
    // way a stdout line split across two pipe reads gets rejoined — and it
    // does NOT filter on `stream`. So a stderr write landing between two
    // stdout fragments of one still-open line spliced stderr bytes into
    // the MIDDLE of that line. The corrupted line then fails
    // filterRunLog's JSON.parse and is silently dropped — no error, the
    // message just never appears in the transcript. Reproduced
    // empirically in fix round 1's review (and pinned by
    // runner.test.ts's "interleave" case).
    //
    // Fix: buffer each stream SEPARATELY and only ever write a complete
    // (\n-terminated) line as its own envelope. A stray stderr write can
    // now only ever land BETWEEN two complete stdout lines in the log —
    // never inside one — where it fails to parse as JSON and is harmlessly
    // skipped by filterRunLog's existing `catch { continue }`.
    const onData = (stream: "stdout" | "stderr") => (buf: Buffer) => {
      const text = buf.toString("utf8");
      if (stream === "stdout") captured += text; else stderrAll += text;

      const combined = (stream === "stdout" ? stdoutLineBuf : stderrLineBuf) + text;
      const { lines, rest } = takeCompleteLines(combined);
      if (stream === "stdout") stdoutLineBuf = rest; else stderrLineBuf = rest;
      for (const line of lines) writeEnvelope(stream, line);
    };

    // Whatever's left in either buffer when the run ends (the child's
    // final write had no trailing "\n", or it was killed mid-line) must
    // still be written — otherwise those trailing bytes are silently
    // lost rather than merely delayed. A residue line legitimately has no
    // trailing "\n"; that's fine, filterRunLog treats a non-newline-
    // terminated inner line as "still buffering" rather than dropping it.
    const flushResidue = () => {
      if (stdoutLineBuf) { writeEnvelope("stdout", stdoutLineBuf); stdoutLineBuf = ""; }
      if (stderrLineBuf) { writeEnvelope("stderr", stderrLineBuf); stderrLineBuf = ""; }
    };

    // Idempotent by construction: whichever of {mkdir/spawn/logStream
    // failing, spawn 'error', child 'close'} gets here FIRST wins: an
    // error arriving after a normal close (or a second error source) is a
    // silent no-op rather than a second resolve() call.
    const resolveOnce = (result: RunResult) => {
      if (settled) return;
      settled = true;
      clearTimers();
      resolve(result);
    };

    // The normal completion path (spawn error, or the child actually
    // closing): flush any buffered residue, then — "fold in" from
    // review — wait for the log file to actually finish flushing to disk
    // before resolving, via `.end()`'s callback (which Node fires on the
    // stream's 'finish' event), so a caller reading logPath immediately
    // after `run()` resolves sees the complete file rather than a
    // truncated one.
    const finishNormally = (result: RunResult) => {
      if (settled) return; // an error already resolved via resolveOnce; don't touch a possibly-broken stream further
      flushResidue();
      if (!logStream) { resolveOnce(result); return; }
      logStream.end(() => resolveOnce(result));
    };

    void (async () => {
      try {
        await mkdir(dirname(req.logPath), { recursive: true });
        logStream = createWriteStream(req.logPath, { flags: "a" });

        // CRITICAL 2 (part 2 of 2). A write/flush failure on the log
        // itself (disk full, EMFILE under many concurrent runs, the log
        // directory removed mid-run) must not hang the run forever —
        // route it into the same resolution path used everywhere else.
        logStream.on("error", (err) => {
          resolveOnce({
            exitCode: -1,
            status: "failed",
            usage: null,
            stderrTail: `log stream error: ${String(err)}`.slice(-STDERR_TAIL_CHARS),
          });
        });

        const child = spawn(spec.bin, spec.args, {
          cwd: req.cwd,
          stdio: ["pipe", "pipe", "pipe"],
          env: process.env,
        });

        child.stdout.on("data", onData("stdout"));
        child.stderr.on("data", onData("stderr"));

        // IMPORTANT 3: a caller who omits budget.maxDurationMs still gets
        // a timer — the 60-minute backstop above, not "no timer at all."
        durationTimer = setTimeout(() => {
          killedForBudget = true;
          child.kill("SIGTERM");
          // Bounded kill: escalate if the child ignores SIGTERM, so a
          // budget breach can never leave this promise unresolved.
          killTimer = setTimeout(() => child.kill("SIGKILL"), BUDGET_KILL_GRACE_MS);
        }, req.budget?.maxDurationMs ?? BACKSTOP_DURATION_MS);

        // Spawn itself can fail (bad `bin`, ENOENT, EACCES, ...). Without
        // this handler the promise would hang forever, since only 'close'
        // resolves it below.
        child.on("error", (err) => {
          finishNormally({
            exitCode: -1,
            status: "failed",
            usage: null,
            stderrTail: `spawn error: ${String(err)}`.slice(-STDERR_TAIL_CHARS),
          });
        });

        // CRITICAL 3. A child that exits BEFORE reading its stdin turns
        // this write into EPIPE — and `claude` does exactly that whenever
        // it fail-fasts: a missing --system-prompt-file, an unknown flag, a
        // bad model id. Without a handler, EPIPE is an unhandled 'error'
        // event on a Socket, which by Node's default terminates the ENTIRE
        // orchestrator process — killing every other in-flight run, and the
        // HTTP server with them, to report one bad spawn. Observed live: a
        // revision step against an agent whose bundle file did not exist
        // took down the whole CLI with a bare `write EPIPE` and no issue
        // comment, no run row and no clue.
        //
        // Swallowed rather than surfaced because it carries no information
        // the caller does not already get: the child's exit code and its
        // stderr ("System prompt file not found: …") arrive on 'close'
        // below, which resolves the run as `failed` with the real reason.
        child.stdin.on("error", () => { /* reported via 'close' */ });
        child.stdin.write(req.prompt);
        child.stdin.end();

        child.on("close", (code) => {
          const usage = spec.extractUsage(captured);

          let status: RunResult["status"] = code === 0 ? "succeeded" : "failed";
          if (killedForBudget) status = "over_budget";
          // Token/cost budgets can only be checked post-hoc, once the
          // final `result` event has arrived — unlike maxDurationMs, they
          // are never a live kill, just a status flag on an otherwise-
          // completed run.
          //
          // IMPORTANT 4 (deliberate, reviewed): if a completed run BOTH
          // breaches a post-hoc budget AND exited non-zero, over_budget
          // wins over failed — a budget breach is the more actionable
          // signal for an operator, and the real exit code is still
          // carried on `exitCode` for anyone who needs it.
          if (usage && req.budget) {
            const total = usage.inputTokens + usage.outputTokens;
            if (req.budget.maxTokens && total > req.budget.maxTokens) status = "over_budget";
            if (req.budget.maxCostUsd && (usage.costUsd ?? 0) > req.budget.maxCostUsd) status = "over_budget";
          }

          finishNormally({
            exitCode: code ?? -1,
            status,
            usage: usage ? { ...usage, durationMs: usage.durationMs ?? (Date.now() - started) } : null,
            stderrTail: stderrAll.slice(-STDERR_TAIL_CHARS),
          });
        });
      } catch (err) {
        // CRITICAL 2 (part 1 of 2). Any synchronous throw or rejected
        // await in the setup above (mkdir failing with ENOTDIR,
        // createWriteStream throwing, spawn() itself throwing
        // synchronously for bad options, ...) previously left this
        // promise permanently pending AND surfaced as an unhandled
        // rejection — which kills the whole Node process by default on
        // Node >= 15, not just this one run. `finishNormally` (rather
        // than `resolveOnce` directly) still flushes/closes `logStream`
        // if it was already created before the failure.
        finishNormally({
          exitCode: -1,
          status: "failed",
          usage: null,
          stderrTail: `runner setup error: ${String(err)}`.slice(-STDERR_TAIL_CHARS),
        });
      }
    })();
  });
}
