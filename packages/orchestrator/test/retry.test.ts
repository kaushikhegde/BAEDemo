import { describe, it, expect } from "vitest";
import { classifyFailure, TRANSIENT_WINDOW_MS } from "../src/core/retry.js";
import type { RunResult } from "../src/core/runner.js";

const result = (over: Partial<RunResult> = {}): RunResult => ({
  exitCode: 1, status: "failed", usage: null, stderrTail: "", ...over,
});

const usage = {
  inputTokens: 120_000, outputTokens: 8_000, cacheReadTokens: 0, cacheCreationTokens: 0,
  costUsd: 2.71, durationMs: 900_000, numTurns: 40, sessionId: "s1",
};

describe("classifyFailure", () => {
  it("retries a run that died instantly having accounted for nothing", () => {
    const v = classifyFailure(result({ stderrTail: "Error: connect ETIMEDOUT" }), 2_400);
    expect(v.retry).toBe(true);
    expect(v.reason).toContain("no tokens");
  });

  it("does NOT retry a run that reached its result event", () => {
    // The expensive mistake: the agent ran for fifteen minutes, spent $2.71 and
    // exited non-zero on its own terms. A second attempt buys another $2.71.
    const v = classifyFailure(result({ usage }), 900_000);
    expect(v.retry).toBe(false);
    expect(v.reason).toContain("full run");
  });

  it("does NOT retry a long run even when its usage was never recorded", () => {
    // Killed before the result event: usage is LOST, not zero. Wall clock is
    // the only evidence left, and it says work happened.
    const v = classifyFailure(result(), TRANSIENT_WINDOW_MS + 1);
    expect(v.retry).toBe(false);
    expect(v.reason).toContain("billable work");
  });

  it("does NOT retry an over-budget run at any duration", () => {
    const v = classifyFailure(result({ status: "over_budget" }), 10);
    expect(v.retry).toBe(false);
    expect(v.reason).toContain("budget");
  });

  it.each([
    ["System prompt file not found: agent-instructions/ba.thin.md"],
    ["<tool_use_error>Unknown skill: requirement-generator</tool_use_error>"],
    ["claude: command not found"],
    ["Error: ENOENT: no such file or directory"],
    ["invalid api key · fix external API key"],
  ])("does NOT retry a configuration error: %s", (stderr) => {
    // Cheap to retry, but it fails identically — and a retry line that means
    // nothing teaches an operator to ignore the ones that do.
    expect(classifyFailure(result({ stderrTail: stderr }), 300).retry).toBe(false);
  });

  it("never retries a success", () => {
    expect(classifyFailure(result({ status: "succeeded", exitCode: 0 }), 10).retry).toBe(false);
  });
});
