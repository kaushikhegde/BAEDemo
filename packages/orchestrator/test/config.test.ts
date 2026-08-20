import { describe, it, expect } from "vitest";
import { defineOrchestrator, validateConfig, resolveRuntime, workflowParams } from "../src/config.js";

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

  it("refuses an agent naming an unregistered adapter, and names what is available", () => {
    const problems = validateConfig({
      workspace: "/w",
      db: { driver: "pglite", dir: "/tmp/x" },
      adapters: { claude_local: {} as any },
      org: [{ key: "ba", name: "BA", adapter: "codex" }],
      workflows: [],
    });
    expect(problems.join("\n")).toContain("adapter 'codex', which is not registered");
    expect(problems.join("\n")).toContain("claude_local");
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

  // CRITICAL 1: model/effort/fallbackModel are meaningful only to the adapter
  // that will run them. Before this fix, `resolveRuntime` walked adapter,
  // model and effort INDEPENDENTLY — each doing its own step → agent →
  // scoped → defaults search — so a level that switched only the ADAPTER
  // still inherited a model name that belonged to whatever adapter a LESS
  // specific level had in mind. Concretely: the global default is
  // `claude_local` with `model: "claude-sonnet-4-6"`; pinning one agent (or
  // one project) to codex changed the adapter but not the model, and every
  // such run died on its first request with `--model claude-sonnet-4-6`
  // passed to `codex exec`.
  describe("model/effort/fallbackModel do not outlive the level that picked the adapter", () => {
    const step = { type: "agent" as const, phase: "generate" };
    const globalClaudeDefaults = { adapter: "claude_local", model: "claude-sonnet-4-6", effort: "medium" as const };

    it("(a) an agent pinned to codex gets no model from the global Claude default", () => {
      expect(resolveRuntime(step, { adapter: "codex" }, globalClaudeDefaults))
        .toMatchObject({ adapter: "codex", model: undefined, effort: undefined });
    });

    it("(b) a project-scoped codex setting gets no model from the global Claude default", () => {
      // `scoped` is most-specific-first — this is what scyne adapter set
      // codex --project RTWSA writes: a project-level override, agent
      // untouched.
      const scoped = [{ adapter: "codex" }];
      expect(resolveRuntime(step, null, globalClaudeDefaults, scoped))
        .toMatchObject({ adapter: "codex", model: undefined, effort: undefined });
    });

    it("(c) a step that pins codex AND a model keeps that model", () => {
      const codexStep = { ...step, adapter: "codex", model: "gpt-5-codex" };
      expect(resolveRuntime(codexStep, { adapter: "claude_local" }, globalClaudeDefaults))
        .toMatchObject({ adapter: "codex", model: "gpt-5-codex" });
    });

    it("(d) regression guard: everything on claude_local resolves exactly as before", () => {
      expect(resolveRuntime(step, null, globalClaudeDefaults))
        .toEqual({ adapter: "claude_local", model: "claude-sonnet-4-6", effort: "medium" });
    });

    it("an agent whose adapter is switched to codex does not carry its own Claude fallbackModel along", () => {
      // Mirrors orchestrator.config.ts: every bundled agent is unconditionally
      // given `fallbackModel: ["claude-sonnet-4-5-20250929"]` at the SAME
      // level (the agent row) that `scyne adapter set codex` (agent scope) or
      // the console's per-agent dropdown later overwrites with `adapter:
      // "codex"`. A pure "level" comparison would still allow it through
      // (same level as the adapter decision) — the guard has to be "does the
      // FINAL resolved adapter even understand --fallback-model", which only
      // claude_local does.
      const agent = { adapter: "codex", fallbackModel: ["claude-sonnet-4-5-20250929"] };
      expect(resolveRuntime(step, agent, globalClaudeDefaults).fallbackModel).toBeUndefined();
    });

    it("fallbackModel still reaches a claude_local run", () => {
      const agent = { adapter: "claude_local", fallbackModel: ["claude-sonnet-4-5-20250929"] };
      expect(resolveRuntime(step, agent, globalClaudeDefaults).fallbackModel)
        .toEqual(["claude-sonnet-4-5-20250929"]);
    });
  });
});

describe("workflowParams", () => {
  const wf = (steps: any[], title?: string): any => ({ key: "k", label: "L", assignee: "a", title, steps });

  it("scans every step type, in first-appearance order", () => {
    expect(workflowParams(wf([
      { type: "exec", cmd: "node stage.mjs {project} {feature} datamodel" },
      { type: "agent", phase: "generate", prompt: "Design for {feature} in {confluenceSpace}",
        reads: { previous: "projects/{project}/{feature}/outputs/x.md" } },
      { type: "attach", files: ["projects/{project}/{feature}/outputs/x.md"] },
      { type: "gate", title: "Approve {feature}", summary: "for {project}" },
    ]))).toEqual(["project", "feature", "confluenceSpace"]);
  });

  it("includes the issue-title template", () => {
    expect(workflowParams(wf([{ type: "exec", cmd: "true" }], "Data model — {project} / {feature}")))
      .toEqual(["project", "feature"]);
  });

  it("excludes the variables the engine injects on every step", () => {
    // Asking a caller for `workspace` would be asking for something their
    // answer cannot affect — the engine overwrites it.
    expect(workflowParams(wf([{ type: "exec", cmd: "cd {workspace} && run {issueId} for {project}" }])))
      .toEqual(["project"]);
  });

  it("excludes names an agent step's `reads` supplies", () => {
    // Every `revise-*` workflow interpolates `{previous}`, but the engine reads
    // that file off disk and spreads it over the caller's params. Listing it as
    // a parameter puts a field on the New-run form for a value that is
    // overwritten before it is used.
    expect(workflowParams(wf([
      { type: "exec", cmd: "node stage.mjs {project} {feature} datamodel" },
      { type: "agent", phase: "revise", prompt: "Apply {instruction} to:\n{previous}",
        reads: { previous: "projects/{project}/{feature}/outputs/x.md" } },
    ]))).toEqual(["project", "feature", "instruction"]);
  });

  it("excludes a doubled brace, which interpolate treats as a literal", () => {
    expect(workflowParams(wf([
      { type: "agent", phase: "publish", prompt: "replace {{PRODUCT_SUMMARY_URL}} for {project}" },
    ]))).toEqual(["project"]);
  });

  it("returns an empty list for a workflow that interpolates nothing", () => {
    expect(workflowParams(wf([{ type: "exec", cmd: "npm run app" }]))).toEqual([]);
  });

});

describe("workflow variants", () => {
  it("are ordinary workflows — the relationship is presentational only", () => {
    // Nothing in the engine reads `variantOf`. It exists so a console can group
    // ten stages and their modes instead of listing eighteen peers, WITHOUT
    // pattern-matching a `revise-` prefix that belongs to one consumer.
    const c = defineOrchestrator({
      workspace: "/w",
      db: { driver: "pglite", dir: "/w/pg" },
      adapters: { claude_local: { run: async () => ({ exitCode: 0, status: "succeeded" as const, usage: null, stderrTail: "" }) } },
      org: [{ key: "ba", name: "BA" }],
      workflows: [
        { key: "requirements", label: "Requirements", assignee: "ba",
          steps: [{ type: "agent", phase: "generate" }] },
        { key: "revise-requirements", label: "Revise Requirements", assignee: "ba",
          variantOf: "requirements", variant: "revise",
          steps: [{ type: "agent", phase: "revise", reads: { previous: "outputs/x.md" },
                    prompt: "Apply {instruction} to {previous}" }] },
      ],
    });
    expect(validateConfig(c)).toEqual([]);
    // And a variant still declares its own parameters, independently.
    expect(workflowParams(c.workflows[1])).toEqual(["instruction"]);
  });
});
