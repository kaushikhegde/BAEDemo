import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { extractUsage, extractCodexUsage, priceRun, type ModelPrice } from "../src/core/usage.js";

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

describe("priceRun", () => {
  const usage = (over: Partial<Parameters<typeof priceRun>[0]> = {}) => ({
    inputTokens: 1_000_000, outputTokens: 1_000_000,
    cacheReadTokens: 0, cacheCreationTokens: 0,
    costUsd: null, durationMs: null, numTurns: null, sessionId: null,
    ...over,
  });
  const terra: ModelPrice = {
    inputPerMTok: 2, cachedInputPerMTok: 0.2, outputPerMTok: 12,
  };

  it("charges input and output at their own rates", () => {
    // 1M in at $2 + 1M out at $12
    expect(priceRun(usage(), terra)).toBeCloseTo(14, 6);
  });

  it("bills cached input at the cached rate, and does NOT bill it twice", () => {
    // Codex reports `input_tokens` as the TOTAL, cached included. Billing all
    // of it at the full rate and then adding the cached tokens again
    // over-reports every cached run — which, on a long agent session, is most
    // of them.
    const withCache = usage({ inputTokens: 1_000_000, cacheReadTokens: 800_000 });
    // 200k uncached at $2/M = $0.40; 800k cached at $0.20/M = $0.16; 1M out = $12
    expect(priceRun(withCache, terra)).toBeCloseTo(0.4 + 0.16 + 12, 6);
  });

  it("never goes negative when cached exceeds the reported input", () => {
    // A malformed or differently-shaped transcript could report more cached
    // tokens than input. Clamping is better than issuing a credit.
    const odd = usage({ inputTokens: 100, cacheReadTokens: 5_000 });
    const priced = priceRun(odd, terra);
    expect(priced).not.toBeNull();
    expect(priced!).toBeGreaterThanOrEqual(0);
  });

  it("returns null with no price at all", () => {
    expect(priceRun(usage(), null)).toBeNull();
  });

  it("returns null for an UNPRICED model rather than zero", () => {
    // $0.00 reads as a run that cost nothing. `—` reads as "we do not know",
    // which is the truth.
    expect(priceRun(usage(), { inputPerMTok: null, cachedInputPerMTok: null, outputPerMTok: null }))
      .toBeNull();
  });

  it("prices a run that used only one side of the ledger", () => {
    expect(priceRun(usage({ outputTokens: 0 }), terra)).toBeCloseTo(2, 6);
    expect(priceRun(usage({ inputTokens: 0 }), terra)).toBeCloseTo(12, 6);
  });

  it("is zero for a run that used no tokens at all", () => {
    expect(priceRun(usage({ inputTokens: 0, outputTokens: 0 }), terra)).toBe(0);
  });

  it("treats a missing rate on one side as zero for that side, not as unpriced", () => {
    // gpt-5-pro publishes no cached rate. That must not make the whole model
    // unpriceable — it means there is no cache discount.
    const pro: ModelPrice = { inputPerMTok: 15, cachedInputPerMTok: null, outputPerMTok: 120 };
    expect(priceRun(usage({ cacheReadTokens: 500_000 }), pro)).toBeCloseTo(15 * 0.5 + 120, 6);
  });

  it("never returns a non-finite figure", () => {
    const mad = priceRun(usage({ inputTokens: Number.MAX_VALUE }), terra);
    expect(mad === null || Number.isFinite(mad)).toBe(true);
  });
});
