// The Claude Code runner: spawns `claude -p ... --output-format stream-json`,
// tees its raw stdout/stderr to a JSONL log file, and extracts aggregate
// token/cost usage from the captured stdout once the process exits.
//
// This is the highest-risk piece of the orchestrator — everything above it
// (engine, repo, transcript filtering) is bookkeeping; this is where the
// orchestrator actually drives an agent process. Every flag below is
// confirmed against a real invocation of Claude Code 2.1.232, not assumed:
// see fixtures/result-event.jsonl (Task 4) and this task's own E2E run.

import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { extractUsage, type RunUsage } from "./usage.js";

export interface RunRequest {
  agent: { key: string; bundlePath?: string; mcpEnabled?: boolean; extraArgs?: string[] };
  /** Already resolved by the engine through step → agent → defaults. */
  model?: string;
  effort?: string;
  fallbackModel?: string[];
  prompt: string;
  cwd: string;
  logPath: string;
  mcpConfigPath?: string;
  budget?: { maxTokens?: number; maxCostUsd?: number; maxDurationMs?: number };
}

export interface RunResult {
  exitCode: number;
  status: "succeeded" | "failed" | "over_budget";
  usage: RunUsage | null;
  stderrTail: string;
}

export interface Runner {
  run(req: RunRequest): Promise<RunResult>;
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
const STDERR_TAIL_CHARS = 4_000;

/**
 * Build the argv for a headless Claude Code invocation. Exported so the
 * flag surface can be tested without spawning a process.
 *
 * Confirmed against Claude Code 2.1.232:
 * - There is no `--cwd` flag; the working directory is set on `spawn()`.
 * - `--print` (`-p`) combined with `--output-format stream-json` REQUIRES
 *   `--verbose`, or the CLI refuses to start
 *   (`Error: When using --print, --output-format=stream-json requires
 *   --verbose` — discovered in Task 4's capture run). Not conditional: this
 *   runner only ever uses stream-json, so `--verbose` is always required.
 * - `--system-prompt-file <path>` IS accepted (verified: pointing it at a
 *   missing file fails fast with `System prompt file not found: <path>`,
 *   before any network call) — no need for `--append-system-prompt-file`.
 * - The prompt itself is deliberately NOT put on argv (avoids shell/arg-length
 *   limits and keeps it out of `ps` listings); the runner writes it to the
 *   child's stdin instead.
 */
export function buildArgs(req: RunRequest): string[] {
  const a = [
    "-p",
    "--output-format", "stream-json",
    "--verbose",
    "--permission-mode", "bypassPermissions",
    "--no-session-persistence",
    "--exclude-dynamic-system-prompt-sections",
    "--strict-mcp-config",
  ];
  if (req.model) a.push("--model", req.model);
  if (req.effort) a.push("--effort", req.effort);
  if (req.fallbackModel?.length) a.push("--fallback-model", req.fallbackModel.join(","));
  if (req.agent.bundlePath) a.push("--system-prompt-file", req.agent.bundlePath);
  if (req.agent.mcpEnabled && req.mcpConfigPath) a.push("--mcp-config", req.mcpConfigPath);
  if (req.agent.extraArgs?.length) a.push(...req.agent.extraArgs);
  return a;
}

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

export function createClaudeRunner(opts: { bin?: string } = {}): Runner {
  const bin = opts.bin ?? "claude";

  return {
    run(req: RunRequest): Promise<RunResult> {
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

            const child = spawn(bin, buildArgs(req), {
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

            child.stdin.write(req.prompt);
            child.stdin.end();

            child.on("close", (code) => {
              const usage = extractUsage(captured);

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
    },
  };
}
