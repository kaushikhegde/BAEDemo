import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { extractUsage, extractCodexUsage } from "../src/core/usage.js";

const fixture = readFileSync(
  new URL("../fixtures/result-event.jsonl", import.meta.url), "utf8");

describe("extractUsage", () => {
  it("pulls token counts from a real captured result event", () => {
    const u = extractUsage(fixture);
    expect(u).not.toBeNull();
    expect(u!.inputTokens).toBeGreaterThan(0);
    expect(u!.outputTokens).toBeGreaterThan(0);
    expect(u!.sessionId).toBeTruthy();
  });

  it("returns null when there is no result event", () => {
    expect(extractUsage(`{"type":"assistant","message":{"content":[]}}\n`)).toBeNull();
  });

  it("survives a truncated final line", () => {
    expect(() => extractUsage(fixture + `{"type":"resu`)).not.toThrow();
  });

  it("takes the LAST result event when several are present", () => {
    const doubled = fixture + fixture.replace(/"output_tokens":\s*\d+/, '"output_tokens": 9999');
    expect(extractUsage(doubled)!.outputTokens).toBe(9999);
  });
});

describe("extractCodexUsage", () => {
  const codexFixture = readFileSync(
    new URL("./fixtures/codex-run.jsonl", import.meta.url), "utf8");

  // MINOR 5 (branch review): this used to claim "off a real captured run",
  // which is not what it tests. Every line in codex-run.jsonl is a real
  // capture from codex-envelope-unauthenticated.jsonl EXCEPT the
  // `turn.completed` usage line these assertions actually read — that one is
  // a synthetic stand-in, and the fixture says so itself in its own
  // `_comment` line: "UNVERIFIED — synthetic turn.completed. ... Replace this
  // one from an authenticated run; see Task 10." The title asserted the
  // opposite of the truth in green test output.
  it("reads token counts off the fixture's synthetic turn.completed line (not yet a real capture — see Task 10)", () => {
    const u = extractCodexUsage(codexFixture);
    expect(u).not.toBeNull();
    expect(u!.inputTokens).toBeGreaterThan(0);
    expect(u!.outputTokens).toBeGreaterThan(0);
  });

  it("reports no cost, because Codex does not price its own runs", () => {
    // null, NOT 0. A run that reads as free is worse than one that admits it
    // does not know: the console renders `—` for null and `$0.0000` for zero.
    expect(extractCodexUsage(codexFixture)!.costUsd).toBeNull();
  });

  it("returns null for a transcript with no usage event", () => {
    expect(extractCodexUsage('{"type":"item.started"}\n')).toBeNull();
  });

  it("skips malformed lines rather than throwing", () => {
    expect(() => extractCodexUsage("not json\n{\n")).not.toThrow();
  });
});
