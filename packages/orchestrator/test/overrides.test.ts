import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadOverrides, saveOverrides, applyOverrides, withAgentPatch } from "../src/core/overrides.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "orch-ovr-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const ORG = [
  { key: "ba", name: "BA", adapter: "claude_local", model: "claude-sonnet-4-6" },
  { key: "qa", name: "QA" },
];

describe("overrides", () => {
  it("returns an empty overlay when the file is absent", async () => {
    expect(await loadOverrides(dir)).toEqual({});
  });

  it("round-trips through disk", async () => {
    await saveOverrides(dir, { agents: { ba: { model: "claude-opus-5" } } });
    expect(await loadOverrides(dir)).toEqual({ agents: { ba: { model: "claude-opus-5" } } });
  });

  it("merges over the config's org without losing unpatched fields", () => {
    const out = applyOverrides(ORG, { agents: { ba: { model: "claude-opus-5", effort: "max" } } });
    const ba = out.find(a => a.key === "ba")!;
    expect(ba.model).toBe("claude-opus-5");
    expect(ba.effort).toBe("max");
    expect(ba.adapter).toBe("claude_local");   // untouched by the patch
    expect(ba.name).toBe("BA");
  });

  it("adds console-created agents and drops removed ones", () => {
    const out = applyOverrides(ORG, {
      added: [{ key: "sec", name: "Security Reviewer" }],
      removed: ["qa"],
    });
    expect(out.map(a => a.key)).toEqual(["ba", "sec"]);
  });

  it("never lets an override rewrite the key it is filed under", () => {
    // The key is the address: allowing a patch to change it would orphan the
    // override and silently create a second agent on the next boot.
    const out = applyOverrides(ORG, { agents: { ba: { key: "somethingelse", name: "Renamed" } as never } });
    const ba = out.find(a => a.key === "ba")!;
    expect(ba.name).toBe("Renamed");
    expect(out.map(a => a.key)).toEqual(["ba", "qa"]);
  });

  it("accumulates patches rather than replacing them", () => {
    let o = withAgentPatch({}, "ba", { model: "claude-opus-5" });
    o = withAgentPatch(o, "ba", { effort: "high" });
    expect(o.agents!.ba).toEqual({ model: "claude-opus-5", effort: "high" });
  });
});
