// What the assistant is told about the currently selected target.
//
// The case that motivated this file: a session pinned to a PROJECT and no
// feature typed "create capabilities & process map" and got back "Which
// project is that for?" — under a prompt reading `SA Demo ›`. The target block
// required BOTH a project and a feature, so a project-only target produced no
// block at all, and a project-only target is the COMPLETE and correct target
// for every project-level stage.

import { describe, expect, it } from "vitest";
import { buildSystemPrompt } from "./llm.ts";

const TREE = JSON.stringify({ "SA Demo": ["Demo Feature"], SAPN: ["MVP"] });
const prompt = (target: { project: string | null; feature: string | null } | null) =>
  buildSystemPrompt(TREE, target, undefined, {}, undefined);

describe("the target block", () => {
  it("is emitted when only a project is pinned", () => {
    const p = prompt({ project: "SA Demo", feature: null });
    expect(p).toContain("Currently selected target");
    expect(p).toContain("Never ask which project they mean");
    expect(p).toContain('project="SA Demo"');
  });

  it("tells the model a project-level stage needs nothing further", () => {
    const p = prompt({ project: "SA Demo", feature: null });
    expect(p).toContain("trigger_capability_map");
    expect(p).toContain("take NO feature");
  });

  it("still names both when a feature is pinned too", () => {
    const p = prompt({ project: "SA Demo", feature: "Demo Feature" });
    expect(p).toContain("**SA Demo / Demo Feature**");
    expect(p).toContain("DO NOT re-ask");
  });

  // The mirror of the case above: a pinned FEATURE is a complete target for a
  // project-level stage too, and no reason to ask whether to change scope.
  it("tells the model a project-level stage ignores a pinned feature", () => {
    const p = prompt({ project: "SA Demo", feature: "Demo Feature" });
    expect(p).toContain("trigger_capability_map");
    expect(p).toContain("trigger_personas");
    expect(p).toContain("take NO feature");
  });

  it("is absent when nothing is pinned", () => {
    expect(prompt(null)).not.toContain("Currently selected target");
    expect(prompt({ project: null, feature: null })).not.toContain("Currently selected target");
  });
});
