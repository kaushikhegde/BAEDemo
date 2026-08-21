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
    // Codex's wording, captured verbatim from a real failing run. It matched
    // none of the patterns above, so a misconfigured endpoint was retried on
    // every advance — five duplicate runs, with the cause buried under them.
    ["failed to connect to websocket: HTTP error: 401 Unauthorized, url: wss://api.openai.com/v1/responses"],
    ["401 Unauthorized: Incorrect API key provided: 6E7Z****cim1"],
    ["Request failed: 403 Forbidden"],
  ])("does NOT retry a configuration error: %s", (stderr) => {
    // Cheap to retry, but it fails identically — and a retry line that means
    // nothing teaches an operator to ignore the ones that do.
    expect(classifyFailure(result({ stderrTail: stderr }), 300).retry).toBe(false);
  });

  it("never retries a success", () => {
    expect(classifyFailure(result({ status: "succeeded", exitCode: 0 }), 10).retry).toBe(false);
  });
});

describe("a run somebody stopped is never retried", () => {
  it("does not retry a cancel INSIDE the transient window with no usage recorded", () => {
    // This is the whole point. Without an explicit branch, a cancel two
    // seconds in with no `result` event matches the "died cheaply, retry it"
    // rule exactly — so pressing Cancel would spawn the agent again, which is
    // the opposite of what was asked for and costs money to discover.
    const verdict = classifyFailure(
      { status: "cancelled", exitCode: -1, usage: null, stderrTail: "" }, 2_000);
    expect(verdict.retry).toBe(false);
    expect(verdict.reason).toMatch(/stopped|cancel/i);
  });

  it("does not retry a cancel that had already done billable work", () => {
    const verdict = classifyFailure(
      { status: "cancelled", exitCode: -1, usage: null, stderrTail: "" }, 300_000);
    expect(verdict.retry).toBe(false);
  });

  it("still retries an ordinary cheap failure, so the rule was not widened", () => {
    const verdict = classifyFailure(
      { status: "failed", exitCode: 1, usage: null, stderrTail: "socket hang up" }, 2_000);
    expect(verdict.retry).toBe(true);
  });
});
