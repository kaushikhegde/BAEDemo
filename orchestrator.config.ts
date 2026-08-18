// The consumer config for @scyne/orchestrator. Everything here is
// workspace-specific data compiled from `scripts/pipeline.mjs`, which stays the
// single source of truth for what a stage requires and produces. Nothing under
// packages/orchestrator/ is touched to make this work.

import { defineOrchestrator, createClaudeRunner } from "./packages/orchestrator/src/index.js";
import { ORG, buildWorkflows } from "./orchestrator.workflows.js";

export default defineOrchestrator({
  workspace: process.cwd(),
  company: "Scyne",
  db: { driver: "pglite", dir: ".orchestrator/pgdata" },

  // The adapter registry. One entry today; another project registers its own here.
  adapters: { claude_local: createClaudeRunner() },

  defaults: { adapter: "claude_local", model: "claude-sonnet-4-6", effort: "medium" },

  org: ORG.map(a => ({
    ...a,
    // If Sonnet 4.6 is overloaded mid-run the pipeline should degrade, not stop.
    ...(a.bundlePath ? { fallbackModel: ["claude-sonnet-4-5-20250929"] } : {}),
    // A ceiling, not a target. The one measured requirements run took 25
    // minutes and $3.19 (prototype findings); 45 minutes and $15 leaves room
    // for a heavier feature without letting a runaway run all night.
    ...(a.bundlePath ? { budget: { maxTokens: 2_000_000, maxCostUsd: 15, maxDurationMs: 45 * 60_000 } } : {}),
  })),

  workflows: buildWorkflows(),
});
