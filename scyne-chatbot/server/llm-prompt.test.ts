import { describe, it, expect } from "vitest";
import { buildSystemPrompt } from "./llm.js";

/**
 * The prompt is what makes the model read before it answers. Without these
 * rules it answers from general knowledge, which is how it described a
 * capability map it had never seen.
 */
describe("system prompt — questions about generated artefacts", () => {
  const prompt = buildSystemPrompt("- BAE:\n    (no features)", { project: "BAE", feature: null });

  it("tells the model to read first and answer only from the file", () => {
    expect(prompt).toContain("read_artefact");
    expect(prompt).toMatch(/answer only from what it returns/i);
  });

  it("tells the model not to ask for confirmation of a revision itself", () => {
    expect(prompt).toMatch(/Start change/);
  });
});
