import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { extractUsage } from "../src/core/usage.js";

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
