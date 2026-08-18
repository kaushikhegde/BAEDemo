import { describe, it, expect } from "vitest";
import { interpolate, placeholdersIn } from "../src/core/interpolate.js";

describe("interpolate", () => {
  it("substitutes known placeholders", () => {
    expect(interpolate("stage {project} {feature} qa", { project: "RTWSA", feature: "Appeals" }))
      .toBe("stage RTWSA Appeals qa");
  });

  it("throws on an unknown placeholder rather than emitting it literally", () => {
    expect(() => interpolate("run {nope}", { project: "P" }))
      .toThrow(/unknown placeholder.*nope/i);
  });

  it("leaves a string with no placeholders untouched", () => {
    expect(interpolate("no vars here", {})).toBe("no vars here");
  });

  it("leaves a doubled brace alone instead of throwing on its inner name", () => {
    // The regression this escape exists for: the requirements workflow's
    // publish prompt says «replace `{{PRODUCT_SUMMARY_URL}}` in the
    // description», the inner {PRODUCT_SUMMARY_URL} matched, missed, and threw
    // — so every requirements run blocked at publish immediately AFTER a human
    // had approved its gate.
    const tpl = "replace {{PRODUCT_SUMMARY_URL}} in {feature}";
    expect(interpolate(tpl, { feature: "Appeals" }))
      .toBe("replace {{PRODUCT_SUMMARY_URL}} in Appeals");
  });

  it("still substitutes a single brace sitting beside a doubled one", () => {
    expect(interpolate("{{keep}} {take} {{keep}}", { take: "x" })).toBe("{{keep}} x {{keep}}");
  });
});

describe("placeholdersIn", () => {
  it("reports what interpolate would substitute, in first-appearance order", () => {
    expect(placeholdersIn("stage {project} {feature} then {project} again"))
      .toEqual(["project", "feature"]);
  });

  it("excludes doubled braces, exactly as interpolate does", () => {
    // The two MUST agree: a form built from placeholdersIn that asked for
    // PRODUCT_SUMMARY_URL would be asking for a variable the engine never reads.
    expect(placeholdersIn("replace {{PRODUCT_SUMMARY_URL}} in {feature}")).toEqual(["feature"]);
  });

  it("finds nothing in a plain string", () => {
    expect(placeholdersIn("no placeholders here")).toEqual([]);
  });
});
