#!/usr/bin/env node
// Test double for the real `claude` binary, used by runner.test.ts so the
// runner's spawn/tee/kill/usage-wiring can be exercised without a network
// call. It never talks to Anthropic; it only reacts to a mode word sent on
// stdin, which is exactly what createClaudeRunner() writes the prompt to —
// so a passing test here also proves the runner's stdin plumbing reaches the
// child process.
//
// Modes (read as the trimmed stdin content):
//   "ok"              — emit one valid stream-json `result` event on stdout,
//                        plus unrelated noise on stderr, then exit 0.
//   "usage-mismatch"  — emit a DECOY result (different output_tokens) on
//                        stderr and the real one on stdout, so a test can
//                        confirm only stdout feeds extractUsage().
//   "fail"            — exit 1 with no result event, to exercise the
//                        "failed" (not over_budget) status path.
//   (exit-first)      — the binary exits immediately, WITHOUT reading stdin,
//                        when argv contains --die-immediately. This is what
//                        the real `claude` does when --system-prompt-file
//                        points at a missing file: it fails fast, before any
//                        network call, and the runner's write to its stdin
//                        then raises EPIPE.
//   "fail-with-usage" — emit the same valid result as "ok" on stdout, but
//                        exit 1 — a completed run that ALSO breaches a
//                        caller-supplied budget, for the over_budget-vs-failed
//                        precedence test.
//   "interleave"      — write half of one JSON stdout line, THEN a complete
//                        stderr line, THEN the rest of the stdout line. Fake
//                        binary for the stdout/stderr splicing repro (fix
//                        round 1, Critical 1): a naive line-agnostic tee can
//                        splice the stderr bytes into the middle of the
//                        still-incomplete stdout line. Uses a real wall-clock
//                        delay (see `sleep`, fix round 2) rather than
//                        `setImmediate` between its three writes — a
//                        same-tick `setImmediate` let both stdout writes
//                        drain into a single OS-level read before the stderr
//                        write was even processed, so the race this fixture
//                        exists to force never actually happened.
//   "no-newline"      — write one JSON stdout line with NO trailing "\n",
//                        then exit — the "does the runner still flush
//                        residue instead of losing it" case.
//   "hang"            — never exit on its own; the runner's budget timer must
//                        SIGTERM (or SIGKILL) it.

const RESULT = {
  type: "result",
  session_id: "fake-session",
  total_cost_usd: 0.01,
  duration_ms: 5,
  num_turns: 1,
  usage: { input_tokens: 11, output_tokens: 22, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
};

// A tiny delay between writes on the SAME run so the parent's separate
// 'data' events for stdout/stderr don't get coalesced into one OS-level
// read, which would defeat the interleaving repro this fixture exists for.
const tick = () => new Promise((r) => setImmediate(r));

// fix round 2: `interleave` mode specifically needs a REAL wall-clock gap,
// not just a macrotask yield. `setImmediate` only guarantees "after I/O
// callbacks in this turn of the loop" — it does not guarantee the pipe write
// has actually been flushed and read by the parent before the next write
// happens. On macOS / Node 24 it reliably did not: reviewer testing found
// both stdout writes drained into one parent-side read before the
// interleaved stderr write was even processed, so the corruption this
// fixture exists to force never happened (25/25 false negatives against a
// reverted, pre-fix runner.ts). A real setTimeout(5) between the three
// writes reproduced the failure reliably instead — see task-6-report.md,
// "Fix round 2" for this task's own repeated confirmation. Only `interleave`
// uses this — every other mode keeps `tick()` unchanged.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let input = "";
if (process.argv.includes("--die-immediately")) {
  process.stderr.write("System prompt file not found: /nope/missing.md\n");
  process.exit(1);
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => { input += d; });
process.stdin.on("end", async () => {
  const mode = input.trim();

  if (mode === "hang") {
    setInterval(() => {}, 1000); // keep the event loop alive; default SIGTERM handling kills it
    return;
  }

  if (mode === "fail") {
    process.stderr.write("simulated failure, no result event\n");
    process.exit(1);
  }

  if (mode === "fail-with-usage") {
    process.stdout.write(JSON.stringify(RESULT) + "\n");
    await tick();
    process.exit(1);
  }

  if (mode === "interleave") {
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "hello world" }] },
    }) + "\n";
    const splitAt = line.indexOf("hello ") + "hello ".length; // split mid-value, inside the text string
    process.stdout.write(line.slice(0, splitAt));
    await sleep(5);
    process.stderr.write("status: mcp server ready\n");
    await sleep(5);
    process.stdout.write(line.slice(splitAt));
    await sleep(5);
    process.exit(0);
  }

  if (mode === "no-newline") {
    process.stdout.write(JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "no trailing newline" }] },
    })); // deliberately no + "\n"
    await tick();
    process.exit(0);
  }

  if (mode === "usage-mismatch") {
    const decoy = { ...RESULT, usage: { ...RESULT.usage, output_tokens: 999 } };
    process.stderr.write(JSON.stringify(decoy) + "\n");
  } else {
    process.stderr.write("some unrelated stderr noise\n");
  }

  process.stdout.write(JSON.stringify(RESULT) + "\n");
  process.exit(0);
});
