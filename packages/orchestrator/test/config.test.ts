import { describe, it, expect } from "vitest";
import { defineOrchestrator, validateConfig, resolveRuntime } from "../src/config.js";

const noopRunner = { run: async () => ({ exitCode: 0, status: "succeeded" as const, usage: null, stderrTail: "" }) };

const base = {
  workspace: "/tmp/ws",
  db: { driver: "pglite" as const, dir: "/tmp/ws/.orchestrator/pgdata" },
  adapters: { claude_local: noopRunner },
  org: [{ key: "ba", name: "BA", model: "claude-sonnet-4-6" }],
  workflows: [{
    key: "requirements", label: "Requirements", assignee: "ba",
    steps: [
      { type: "exec" as const, cmd: "echo {project}" },
      { type: "agent" as const, phase: "generate" },
      { type: "attach" as const, files: ["outputs/product-summary.md"] },
      { type: "gate" as const, title: "Approve Requirements" },
    ],
  }],
};

describe("config", () => {
  it("accepts a valid config", () => {
    expect(validateConfig(defineOrchestrator(base))).toEqual([]);
  });

  it("rejects a workflow whose assignee is not in the org", () => {
    const bad = { ...base, workflows: [{ ...base.workflows[0], assignee: "ghost" }] };
    expect(validateConfig(bad as any)[0]).toMatch(/assignee 'ghost'/);
  });

  it("rejects an agent whose reportsTo is not in the org", () => {
    const bad = { ...base, org: [{ key: "ba", name: "BA", reportsTo: "nobody" }] };
    expect(validateConfig(bad as any)[0]).toMatch(/reportsTo 'nobody'/);
  });

  it("rejects a reads entry that shadows a reserved variable or has no path", () => {
    const bad = { ...base, workflows: [{ ...base.workflows[0], steps: [
      { type: "agent" as const, phase: "revise", reads: { workspace: "a.md", previous: "" } },
    ] }] };
    const problems = validateConfig(bad as any);
    expect(problems.some(p => p.includes("shadows a reserved variable"))).toBe(true);
    expect(problems.some(p => p.includes("empty path"))).toBe(true);
  });

  it("rejects a duplicate agent key", () => {
    const bad = { ...base, org: [{ key: "ba", name: "BA" }, { key: "ba", name: "BA2" }] };
    expect(validateConfig(bad as any)[0]).toMatch(/duplicate agent key 'ba'/);
  });

  it("rejects an unknown step type", () => {
    const bad = { ...base, workflows: [{ ...base.workflows[0], steps: [{ type: "nope" }] }] };
    expect(validateConfig(bad as any)[0]).toMatch(/unknown step type 'nope'/);
  });

  it("reports every problem at once, not just the first", () => {
    const bad = { ...base, org: [{ key: "ba", name: "BA" }, { key: "ba", name: "B2" }],
                  workflows: [{ ...base.workflows[0], assignee: "ghost" }] };
    expect(validateConfig(bad as any).length).toBeGreaterThan(1);
  });

  it("rejects an agent whose adapter is not registered, and names the alternatives", () => {
    const bad = { ...base, org: [{ key: "ba", name: "BA", adapter: "openai_local" }] };
    const p = validateConfig(bad as any)[0];
    expect(p).toMatch(/adapter 'openai_local'/);
    expect(p).toMatch(/available: claude_local/);
  });

  it("rejects an invalid effort level", () => {
    const bad = { ...base, org: [{ key: "ba", name: "BA", effort: "turbo" }] };
    expect(validateConfig(bad as any)[0]).toMatch(/effort 'turbo'/);
  });

  it("rejects a config with no adapters registered", () => {
    const bad = { ...base, adapters: {} };
    expect(validateConfig(bad as any)[0]).toMatch(/no adapters registered/);
  });

  it("rejects a workflow with an empty steps array", () => {
    const bad = { ...base, workflows: [{ ...base.workflows[0], steps: [] }] };
    expect(validateConfig(bad as any)[0]).toMatch(/workflow 'requirements' has no steps/);
  });

  it("rejects a flow step naming a workflow that does not exist", () => {
    const bad = {
      ...base,
      workflows: [{ ...base.workflows[0], steps: [{ type: "flow" as const, workflow: "ghost-workflow" }] }],
    };
    expect(validateConfig(bad as any)[0]).toMatch(/flow 'ghost-workflow' is not a known workflow/);
  });

  it("rejects an attach step with no files", () => {
    const bad = {
      ...base,
      workflows: [{ ...base.workflows[0], steps: [{ type: "attach" as const, files: [] }] }],
    };
    expect(validateConfig(bad as any)[0]).toMatch(/attach has no files/);
  });

  it("rejects a step-level adapter that is not registered", () => {
    const bad = {
      ...base,
      workflows: [{ ...base.workflows[0], steps: [{ type: "agent" as const, phase: "generate", adapter: "openai_local" }] }],
    };
    expect(validateConfig(bad as any)[0]).toMatch(/adapter 'openai_local' is not registered/);
  });

  it("rejects a step-level invalid effort", () => {
    const bad = {
      ...base,
      workflows: [{ ...base.workflows[0], steps: [{ type: "agent" as const, phase: "generate", effort: "turbo" }] }],
    };
    expect(validateConfig(bad as any)[0]).toMatch(/effort 'turbo'/);
  });
});

describe("resolveRuntime", () => {
  const step = { type: "agent" as const, phase: "generate" };

  it("falls back to claude_local when nothing is specified", () => {
    expect(resolveRuntime(step, null, {})).toEqual({ adapter: "claude_local", model: undefined, effort: undefined });
  });

  it("prefers the agent over the defaults", () => {
    expect(resolveRuntime(step, { model: "opus", effort: "high" }, { model: "sonnet", effort: "low" }))
      .toMatchObject({ model: "opus", effort: "high" });
  });

  it("prefers the step over the agent", () => {
    expect(resolveRuntime({ ...step, model: "haiku", effort: "low" }, { model: "opus", effort: "max" }, {}))
      .toMatchObject({ model: "haiku", effort: "low" });
  });

  it("resolves each field independently", () => {
    // step sets only effort; model must still come from the agent
    expect(resolveRuntime({ ...step, effort: "low" }, { model: "opus" }, { model: "sonnet" }))
      .toMatchObject({ model: "opus", effort: "low" });
  });

  it("resolves adapter through the same step > agent > defaults chain as model/effort", () => {
    expect(resolveRuntime(step, { adapter: "agent_adapter" }, { adapter: "default_adapter" }))
      .toMatchObject({ adapter: "agent_adapter" });
    expect(resolveRuntime({ ...step, adapter: "step_adapter" }, { adapter: "agent_adapter" }, { adapter: "default_adapter" }))
      .toMatchObject({ adapter: "step_adapter" });
  });

  it("falls back to defaults for each field independently", () => {
    const step = { type: "agent" as const, phase: "generate" };
    expect(resolveRuntime(step, null, { adapter: "gemini_local", model: "sonnet", effort: "high" }))
      .toEqual({ adapter: "gemini_local", model: "sonnet", effort: "high" });
  });

  it("takes model from defaults while taking effort from the agent", () => {
    const step = { type: "agent" as const, phase: "generate" };
    expect(resolveRuntime(step, { effort: "max" }, { model: "opus", adapter: "claude_local" }))
      .toEqual({ adapter: "claude_local", model: "opus", effort: "max" });
  });
});
