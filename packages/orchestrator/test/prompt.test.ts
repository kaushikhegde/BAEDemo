import { describe, it, expect } from "vitest";
import { buildSystemPrompt } from "../src/core/prompt.js";

describe("buildSystemPrompt", () => {
  it("puts the skill body under a named heading after the bundle", () => {
    const out = buildSystemPrompt("You are the Data Modeler.", {
      name: "salesforce-data-modeler",
      body: "## Method\nStandard objects first.",
    });
    expect(out).toContain("You are the Data Modeler.");
    expect(out).toContain("# Skill: salesforce-data-modeler");
    expect(out).toContain("Standard objects first.");
    expect(out.indexOf("You are the Data Modeler.")).toBeLessThan(out.indexOf("# Skill:"));
  });

  it("omits the skill section entirely when the step names no skill", () => {
    const out = buildSystemPrompt("You are the Developer.", null);
    expect(out).not.toContain("# Skill:");
    expect(out).toContain("You are the Developer.");
  });
});
