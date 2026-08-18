import { describe, it, expect } from "vitest";
import { buildArgs, createClaudeRunner } from "../src/core/runner.js";
import { filterRunLog } from "../src/core/transcript.js";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const base = {
  agent: { key: "ba", bundlePath: "/w/agent-instructions/ba.thin.md" },
  model: "claude-sonnet-4-6",
  prompt: "do the thing",
  cwd: "/w",
  logPath: "/tmp/run.jsonl",
};

const fakeClaudeBin = fileURLToPath(new URL("../fixtures/fake-claude.mjs", import.meta.url));

describe("buildArgs", () => {
  it("builds the confirmed 2.1.232 headless invocation", () => {
    const a = buildArgs(base as any);
    expect(a).toContain("-p");
    expect(a).toContain("--verbose"); // 2.1.232 rejects stream-json + --print without it
    expect(a).toEqual(expect.arrayContaining([
      "--output-format", "stream-json",
      "--model", "claude-sonnet-4-6",
      "--system-prompt-file", "/w/agent-instructions/ba.thin.md",
      "--permission-mode", "bypassPermissions",
      "--no-session-persistence",
      "--exclude-dynamic-system-prompt-sections",
    ]));
  });

  it("omits --mcp-config unless the agent publishes", () => {
    expect(buildArgs(base as any)).toContain("--strict-mcp-config");
    expect(buildArgs(base as any)).not.toContain("--mcp-config");
  });

  it("adds --mcp-config when mcpEnabled and a path is supplied", () => {
    const a = buildArgs({ ...base, agent: { ...base.agent, mcpEnabled: true }, mcpConfigPath: "/w/.mcp.json" } as any);
    expect(a).toEqual(expect.arrayContaining(["--mcp-config", "/w/.mcp.json"]));
  });

  it("never passes a --cwd flag (2.1.232 has none)", () => {
    expect(buildArgs(base as any).join(" ")).not.toContain("--cwd");
  });

  it("passes --effort when resolved", () => {
    expect(buildArgs({ ...base, effort: "xhigh" } as any))
      .toEqual(expect.arrayContaining(["--effort", "xhigh"]));
  });

  it("omits --effort when not set, deferring to the CLI default", () => {
    expect(buildArgs(base as any)).not.toContain("--effort");
  });

  it("joins fallback models with commas, in order", () => {
    const a = buildArgs({ ...base, fallbackModel: ["claude-sonnet-4-5-20250929", "claude-haiku-4-5-20251001"] } as any);
    expect(a).toEqual(expect.arrayContaining([
      "--fallback-model", "claude-sonnet-4-5-20250929,claude-haiku-4-5-20251001",
    ]));
  });
});

// These exercise the spawn/tee/kill/usage wiring against a local fixture
// binary (fixtures/fake-claude.mjs) rather than the real `claude` — no
// network call, no cost, and each one targets a path the buildArgs tests
// above cannot reach (log envelope shape, stdout-vs-stderr usage sourcing,
// budget-kill status semantics).
describe("createClaudeRunner (fake binary)", () => {
  function tmpLog() {
    const dir = mkdtempSync(join(tmpdir(), "orch-run-fake-"));
    return { dir, logPath: join(dir, "run.jsonl") };
  }

  it("writes one {ts,stream,chunk} envelope per line, for both stdout and stderr", async () => {
    const { dir, logPath } = tmpLog();
    const runner = createClaudeRunner({ bin: fakeClaudeBin });
    await runner.run({ agent: { key: "probe" }, prompt: "ok", cwd: dir, logPath });

    const lines = readFileSync(logPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) {
      expect(Object.keys(l).sort()).toEqual(["chunk", "stream", "ts"]);
      expect(["stdout", "stderr"]).toContain(l.stream);
      expect(typeof l.ts).toBe("string");
      expect(typeof l.chunk).toBe("string");
    }
    expect(lines.some((l) => l.stream === "stdout")).toBe(true);
    expect(lines.some((l) => l.stream === "stderr")).toBe(true);

    rmSync(dir, { recursive: true, force: true });
  });

  it("extracts usage from stdout only, ignoring a decoy result on stderr", async () => {
    const { dir, logPath } = tmpLog();
    const runner = createClaudeRunner({ bin: fakeClaudeBin });
    const res = await runner.run({ agent: { key: "probe" }, prompt: "usage-mismatch", cwd: dir, logPath });

    expect(res.status).toBe("succeeded");
    // fake-claude.mjs's real stdout result has output_tokens: 22; the decoy
    // on stderr says 999. If stderr ever leaked into extractUsage's input,
    // this would read 999 (stderr's decoy sorts after stdout's real line in
    // the concatenation) instead of 22.
    expect(res.usage!.outputTokens).toBe(22);
    expect(res.usage!.inputTokens).toBe(11);
    expect(res.stderrTail).toContain("999");

    rmSync(dir, { recursive: true, force: true });
  });

  it("reports failed (not over_budget) on a plain non-zero exit with no budget set", async () => {
    const { dir, logPath } = tmpLog();
    const runner = createClaudeRunner({ bin: fakeClaudeBin });
    const res = await runner.run({ agent: { key: "probe" }, prompt: "fail", cwd: dir, logPath });

    expect(res.status).toBe("failed");
    expect(res.exitCode).toBe(1);
    expect(res.usage).toBeNull();
    expect(res.stderrTail).toContain("simulated failure");

    rmSync(dir, { recursive: true, force: true });
  });

  it("kills a hung process on maxDurationMs and reports over_budget, not failed", async () => {
    const { dir, logPath } = tmpLog();
    const runner = createClaudeRunner({ bin: fakeClaudeBin });
    const startedAt = Date.now();
    const res = await runner.run({
      agent: { key: "probe" },
      prompt: "hang",
      cwd: dir,
      logPath,
      budget: { maxDurationMs: 200 },
    });
    const elapsed = Date.now() - startedAt;

    expect(res.status).toBe("over_budget");
    // Bounded: resolves promptly rather than hanging until the test timeout.
    expect(elapsed).toBeLessThan(5_000);

    rmSync(dir, { recursive: true, force: true });
  }, 10_000);

  it("flags over_budget post-hoc when a completed run exceeds maxTokens", async () => {
    const { dir, logPath } = tmpLog();
    const runner = createClaudeRunner({ bin: fakeClaudeBin });
    // fake-claude reports input+output = 11+22 = 33 tokens.
    const res = await runner.run({
      agent: { key: "probe" },
      prompt: "ok",
      cwd: dir,
      logPath,
      budget: { maxTokens: 10 },
    });

    expect(res.exitCode).toBe(0);
    expect(res.status).toBe("over_budget");
    expect(res.usage!.outputTokens).toBe(22);

    rmSync(dir, { recursive: true, force: true });
  });

  it("resolves instead of hanging when the binary does not exist", async () => {
    const { dir, logPath } = tmpLog();
    const runner = createClaudeRunner({ bin: "/definitely/not/a/real/binary-xyz" });
    const res = await runner.run({ agent: { key: "probe" }, prompt: "ok", cwd: dir, logPath });

    expect(res.status).toBe("failed");
    expect(res.usage).toBeNull();

    rmSync(dir, { recursive: true, force: true });
  });
});

// Fix round 1 (post-review). Both bugs below were reproduced by the reviewer
// against the round-1 implementation and are fixed in runner.ts; these tests
// pin the fixes down. All against the fake binary — no real `claude`, no cost.
describe("createClaudeRunner (fix round 1: log integrity + error handling)", () => {
  function tmpLog(prefix = "orch-run-fix1-") {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    return { dir, logPath: join(dir, "run.jsonl") };
  }

  // CRITICAL 1. The round-1 tee wrote every raw `data` event straight to the
  // log as its own {ts,stream,chunk} envelope, regardless of whether it held
  // a complete line. transcript.ts's filterRunLog() reassembles the inner
  // stream by concatenating every envelope's `chunk` IN FILE ORDER, without
  // filtering on `stream` (it has to — that's how a stdout line split across
  // two pipe reads gets rejoined). So a stderr write landing between two
  // stdout fragments of one still-open line spliced stderr bytes into the
  // MIDDLE of that line, corrupting it — and the corrupted line then fails
  // JSON.parse inside filterRunLog and is silently dropped. No error, no
  // warning: the message just never appears in the transcript.
  //
  // fake-claude's "interleave" mode reproduces exactly that: half of one
  // stdout JSON line, then a complete stderr line, then the rest of the
  // stdout line.
  it("keeps a stdout line intact through the log even when a stderr write lands mid-line", async () => {
    const { dir, logPath } = tmpLog();
    const runner = createClaudeRunner({ bin: fakeClaudeBin });
    const res = await runner.run({ agent: { key: "probe" }, prompt: "interleave", cwd: dir, logPath });

    expect(res.exitCode).toBe(0);

    const rawLog = readFileSync(logPath, "utf8");
    const { events } = filterRunLog(rawLog);
    expect(events).toContainEqual(
      expect.objectContaining({ kind: "assistant", text: "hello world" }),
    );

    rmSync(dir, { recursive: true, force: true });
  });

  // Companion case for the same fix: the child can exit with the very last
  // stdout write still short of a trailing "\n" (e.g. killed, or just an odd
  // final flush). The runner buffers per stream and only emits COMPLETE
  // lines as they arrive — so on close it must explicitly flush whatever's
  // left in each buffer, or those trailing bytes are silently lost rather
  // than merely delayed. This asserts no bytes are lost, independent of
  // whether transcript.ts itself can turn a non-newline-terminated residue
  // into a display event (it can't, and that's correct — a genuinely
  // incomplete line SHOULD stay unparsed there).
  it("flushes stdout residue with no trailing newline at close, losing no bytes", async () => {
    const { dir, logPath } = tmpLog();
    const runner = createClaudeRunner({ bin: fakeClaudeBin });
    const res = await runner.run({ agent: { key: "probe" }, prompt: "no-newline", cwd: dir, logPath });

    expect(res.exitCode).toBe(0);

    const lines = readFileSync(logPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const stdoutBytes = lines.filter((l) => l.stream === "stdout").map((l) => l.chunk).join("");
    const expected = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "no trailing newline" }] },
    });
    expect(stdoutBytes).toBe(expected);

    rmSync(dir, { recursive: true, force: true });
  });

  // CRITICAL 2. mkdir(dirname(logPath), {recursive:true}) (and anything else
  // in the async setup) previously had no try/catch around it, so a failure
  // there left run()'s promise permanently pending AND threw an unhandled
  // rejection — which kills the whole Node process on Node >= 15, not just
  // this one run. Force the same failure the reviewer used: dirname(logPath)
  // has a plain FILE as a path component, so mkdir(..., {recursive:true})
  // fails with ENOTDIR.
  it("resolves status:failed (not hanging, not crashing) when the log directory cannot be created", async () => {
    const dir = mkdtempSync(join(tmpdir(), "orch-run-fix1-badlog-"));
    const blockerFile = join(dir, "blocker");
    writeFileSync(blockerFile, "not a directory");
    const logPath = join(blockerFile, "subdir", "run.jsonl"); // dirname is UNDER a file → ENOTDIR

    const runner = createClaudeRunner({ bin: fakeClaudeBin });
    const res = await runner.run({ agent: { key: "probe" }, prompt: "ok", cwd: dir, logPath });

    expect(res.status).toBe("failed");
    expect(res.exitCode).toBe(-1);
    expect(res.usage).toBeNull();
    expect(res.stderrTail.length).toBeGreaterThan(0);

    rmSync(dir, { recursive: true, force: true });
  }, 5_000); // explicit: a regression here should show as a TIMEOUT, not a hung suite

  // IMPORTANT 4. Deliberate precedence, not an accident: when a completed run
  // BOTH breaches a post-hoc budget AND exited non-zero, over_budget wins.
  // Rationale (per runner.ts's own comment): a budget breach is the more
  // actionable operator signal, and the real exit code is still on the
  // result (and ultimately the run row) for anyone who needs it.
  it("prefers over_budget over failed when a completed run both breaches budget and exits non-zero", async () => {
    const { dir, logPath } = tmpLog();
    const runner = createClaudeRunner({ bin: fakeClaudeBin });
    const res = await runner.run({
      agent: { key: "probe" },
      prompt: "fail-with-usage",
      cwd: dir,
      logPath,
      budget: { maxTokens: 10 }, // fake-claude reports 11+22=33 total tokens — breaches this
    });

    expect(res.exitCode).toBe(1);
    expect(res.status).toBe("over_budget");
    expect(res.usage).not.toBeNull();

    rmSync(dir, { recursive: true, force: true });
  });

  // IMPORTANT 3. A caller who never sets budget.maxDurationMs still gets a
  // 60-minute backstop timer rather than no timer at all. Using the real
  // 60-minute value would make this test itself hang for an hour, so this
  // only asserts the documented constant directly — the actual kill
  // mechanics (SIGTERM, SIGKILL escalation, over_budget status) are already
  // covered by the explicit-maxDurationMs "hang" test above, which exercises
  // the identical code path with a short duration.
  it("exposes a 60-minute backstop duration for callers who set no budget", async () => {
    const { BACKSTOP_DURATION_MS } = await import("../src/core/runner.js");
    expect(BACKSTOP_DURATION_MS).toBe(60 * 60 * 1000);
  });
});

describe.skipIf(!process.env.ORCH_E2E)("createClaudeRunner (real claude, costs money)", () => {
  it("runs a trivial prompt, writes a log, and captures usage", async () => {
    const dir = mkdtempSync(join(tmpdir(), "orch-run-"));
    const logPath = join(dir, "run.jsonl");
    const runner = createClaudeRunner();
    const res = await runner.run({
      agent: { key: "probe" },
      model: "claude-sonnet-4-6",
      effort: "low",
      prompt: "Reply with exactly the word: ok",
      cwd: dir,
      logPath,
    });
    expect(res.status).toBe("succeeded");
    expect(res.usage!.outputTokens).toBeGreaterThan(0);
    const log = readFileSync(logPath, "utf8");
    expect(log).toContain('"stream"');   // the {ts,stream,chunk} envelope
    rmSync(dir, { recursive: true, force: true });
  }, 120_000);
});

describe("runner: a child that dies before reading stdin", () => {
  it("resolves as failed instead of crashing the process with EPIPE", async () => {
    // The real failure this pins: `claude` fail-fasts on a missing
    // --system-prompt-file, exits before reading stdin, and the runner's
    // `child.stdin.write(prompt)` then raises EPIPE on a Socket with no error
    // handler — which, being an unhandled 'error' event, took down the WHOLE
    // orchestrator process rather than failing one run. Reproduced live
    // against a real missing bundle before this test was written.
    const dir = mkdtempSync(join(tmpdir(), "orch-epipe-"));
    try {
      const runner = createClaudeRunner({ bin: fakeClaudeBin });
      const res = await runner.run({
        ...base,
        // A large prompt makes the write far more likely to still be in flight
        // when the child goes away, which is what triggers EPIPE rather than a
        // silently-discarded write.
        prompt: "x".repeat(200_000),
        cwd: dir,
        logPath: join(dir, "run.jsonl"),
        agent: { key: "ba", extraArgs: ["--die-immediately"] },
      });

      expect(res.status).toBe("failed");
      expect(res.exitCode).toBe(1);
      expect(res.stderrTail).toContain("System prompt file not found");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
