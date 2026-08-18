import type { DbOptions } from "./core/db.js";
import type { AgentSpec, Effort } from "./core/repo.js";
import type { Runner } from "./core/runner.js";
import { placeholdersIn } from "./core/interpolate.js";

export type Step =
  | { type: "exec";   cmd: string; cwd?: string; timeoutMs?: number }
  | { type: "agent";  agent?: string; phase: string; skill?: string; prompt?: string;
                      adapter?: string; model?: string; effort?: Effort;
                      /**
                       * Variable name → workspace-relative path template. Each
                       * file is read at step time and made available to
                       * `prompt` as `{name}`. Every entry is required: a
                       * missing file blocks the issue rather than silently
                       * handing the agent an empty revision base.
                       */
                      reads?: Record<string, string> }
  | { type: "attach"; files: string[] }
  | { type: "gate";   title: string; summary?: string }
  | { type: "flow";   workflow: string; params?: Record<string, unknown> };

export const STEP_TYPES = ["exec", "agent", "attach", "gate", "flow"] as const;
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

export interface WorkflowDef {
  key: string;
  label: string;
  assignee: string;          // agent key
  /**
   * Issue-title template, interpolated with the issue's params. Optional: the
   * default is `<label> — <project>`, which is wrong for any workflow scoped
   * more finely than a project — a feature workflow needs the feature in its
   * title or every issue for one client looks identical in the console.
   * Consumer-supplied rather than inferred, because the library has no concept
   * of a "feature".
   */
  title?: string;
  steps: Step[];
}

export interface OrchestratorDefaults {
  adapter?: string;          // default "claude_local"
  model?: string;
  effort?: Effort;
}

// Palette + branding for the orchestrator's HTTP UI. Declared here so config
// can express `theme?: Partial<Theme>` without depending on `src/http/`,
// which does not exist yet — a later task's `http/theme.ts` imports this
// interface and supplies the values. Config declares the shape; the
// renderer supplies the palette.
export interface Theme {
  brand: string; brandDeep: string; line: string; accent: string;
  ink50: string; ink100: string; ink200: string; ink500: string; glow: string;
  success: string; warning: string; danger: string; info: string;
  fontFamily: string; logoText: string;
}

export interface OrchestratorConfig {
  workspace: string;
  company?: string;          // default "Scyne"
  db: DbOptions;
  adapters: Record<string, Runner>;   // the adapter registry
  defaults?: OrchestratorDefaults;
  theme?: Partial<Theme>;    // merged over SCYNE_THEME; see src/http/theme.ts
  org: AgentSpec[];
  workflows: WorkflowDef[];
}

export function defineOrchestrator(c: OrchestratorConfig): OrchestratorConfig {
  return {
    company: "Scyne",
    ...c,
    defaults: { adapter: "claude_local", ...c.defaults },
  };
}

/**
 * Resolve adapter / model / effort, most specific wins.
 *   step → agent → defaults → (the CLI's own default, i.e. undefined)
 */
export function resolveRuntime(
  step: Extract<Step, { type: "agent" }>,
  agent: { adapter?: string; model?: string; effort?: string } | null,
  defaults: OrchestratorDefaults = {},
): { adapter: string; model?: string; effort?: string } {
  return {
    adapter: step.adapter ?? agent?.adapter ?? defaults.adapter ?? "claude_local",
    model:   step.model   ?? agent?.model   ?? defaults.model,
    effort:  step.effort  ?? agent?.effort  ?? defaults.effort,
  };
}

export function validateConfig(c: OrchestratorConfig): string[] {
  const problems: string[] = [];
  const keys = new Set<string>();

  for (const a of c.org) {
    if (keys.has(a.key)) problems.push(`duplicate agent key '${a.key}'`);
    keys.add(a.key);
  }
  const adapters = new Set(Object.keys(c.adapters ?? {}));
  if (!adapters.size) problems.push(`no adapters registered — config.adapters is empty`);

  for (const a of c.org) {
    if (a.reportsTo && !keys.has(a.reportsTo)) {
      problems.push(`agent '${a.key}' has reportsTo '${a.reportsTo}', which is not in the org`);
    }
    const adapter = a.adapter ?? c.defaults?.adapter ?? "claude_local";
    if (!adapters.has(adapter)) {
      problems.push(
        `agent '${a.key}' uses adapter '${adapter}', which is not registered — ` +
        `available: ${[...adapters].join(", ") || "(none)"}`);
    }
    if (a.effort && !EFFORTS.includes(a.effort)) {
      problems.push(`agent '${a.key}' has effort '${a.effort}' — must be one of ${EFFORTS.join(", ")}`);
    }
  }
  const wfKeys = new Set(c.workflows.map(w => w.key));
  for (const w of c.workflows) {
    if (!keys.has(w.assignee)) {
      problems.push(`workflow '${w.key}' has assignee '${w.assignee}', which is not in the org`);
    }
    if (!w.steps?.length) problems.push(`workflow '${w.key}' has no steps`);
    for (const [i, s] of (w.steps ?? []).entries()) {
      if (!STEP_TYPES.includes(s.type)) {
        problems.push(`workflow '${w.key}' step ${i}: unknown step type '${s.type}'`);
        continue;
      }
      if (s.type === "agent") {
        if (s.agent && !keys.has(s.agent)) {
          problems.push(`workflow '${w.key}' step ${i}: agent '${s.agent}' is not in the org`);
        }
        if (s.adapter && !adapters.has(s.adapter)) {
          problems.push(`workflow '${w.key}' step ${i}: adapter '${s.adapter}' is not registered`);
        }
        if (s.effort && !EFFORTS.includes(s.effort)) {
          problems.push(`workflow '${w.key}' step ${i}: effort '${s.effort}' — must be one of ${EFFORTS.join(", ")}`);
        }
        for (const [name, tpl] of Object.entries(s.reads ?? {})) {
          if (!tpl) problems.push(`workflow '${w.key}' step ${i}: reads['${name}'] has an empty path`);
          // `workspace` and `issueId` are injected by the engine on every step;
          // a reads entry by either name would shadow them silently.
          if (name === "workspace" || name === "issueId") {
            problems.push(`workflow '${w.key}' step ${i}: reads['${name}'] shadows a reserved variable`);
          }
        }
      }
      if (s.type === "flow" && !wfKeys.has(s.workflow)) {
        problems.push(`workflow '${w.key}' step ${i}: flow '${s.workflow}' is not a known workflow`);
      }
      if (s.type === "attach" && !s.files?.length) {
        problems.push(`workflow '${w.key}' step ${i}: attach has no files`);
      }
    }
  }
  return problems;
}

/**
 * Variables the engine injects on EVERY step regardless of the issue's params.
 * `validateConfig` already refuses a `reads` entry that shadows either of
 * them; `workflowParams` excludes them for the same reason — they are supplied
 * by the runtime, so asking a caller for them would be asking for something
 * their answer could not affect.
 */
const RESERVED_VARS = new Set(["workspace", "issueId"]);

/**
 * The parameter names a workflow's steps interpolate, derived by scanning the
 * workflow itself rather than declared alongside it.
 *
 * Derived, not configured, deliberately. A hand-maintained `params: []` on
 * `WorkflowDef` is a second source of truth that drifts the first time someone
 * adds `{confluenceSpace}` to a publish prompt — and `orchestrator.workflows.ts`
 * COMPILES its eighteen workflows out of `scripts/pipeline.mjs`, so there is no
 * hand-written declaration site to put it on anyway. Scanning is always
 * correct by construction.
 *
 * The library still knows nothing about what a "project" or a "feature" is: it
 * returns whatever names the consumer's own templates use, in first-appearance
 * order, so a form built from this asks for exactly what this workflow reads.
 */
export function workflowParams(wf: WorkflowDef): string[] {
  const found = new Set<string>();

  // Same grammar as the engine, via the same module: a `{{literal}}` is not a
  // parameter, because `interpolate` will not substitute one. Re-implementing
  // the regex here is how the two silently disagree.
  const scan = (s: string | undefined): void => {
    if (!s) return;
    for (const name of placeholdersIn(s)) {
      if (!RESERVED_VARS.has(name)) found.add(name);
    }
  };

  scan(wf.title);
  for (const step of wf.steps ?? []) {
    switch (step.type) {
      case "exec":   scan(step.cmd); scan(step.cwd); break;
      case "agent":  scan(step.prompt); Object.values(step.reads ?? {}).forEach(scan); break;
      case "attach": step.files.forEach(scan); break;
      case "gate":   scan(step.title); scan(step.summary); break;
      case "flow":   scan(step.workflow); Object.values(step.params ?? {}).forEach(v => scan(String(v))); break;
    }
  }
  return [...found];
}
