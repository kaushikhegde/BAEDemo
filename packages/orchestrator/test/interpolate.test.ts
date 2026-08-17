import { describe, it, expect } from "vitest";
import { interpolate } from "../src/core/interpolate.js";

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
});
