// The consumer config for @scyne/orchestrator. Everything here is
// workspace-specific data compiled from `scripts/pipeline.mjs`, which stays the
// single source of truth for what a stage requires and produces. Nothing under
// packages/orchestrator/ is touched to make this work.

import {
  defineOrchestrator, createClaudeRunner, createLoopRunner,
  createGeminiProvider, createAzureProvider, type Runner,
} from "./packages/orchestrator/src/index.js";
import { ORG, buildWorkflows } from "./orchestrator.workflows.js";

const installRoot = process.env.SCYNE_INSTALL_ROOT ?? process.cwd();

/**
 * The adapter registry.
 *
 * Every entry here runs a WHOLE stage. Selecting `gemini` does not mean
 * "Claude, assisted by Gemini" — it means no `claude` process is spawned at
 * all: the shared agent loop (packages/orchestrator/src/core/agent-loop.ts)
 * does the reading, writing and skill-loading that Claude Code would
 * otherwise have done for itself, and Gemini supplies only the thinking.
 *
 * Registered only when configured. An adapter whose credentials are absent is
 * left out rather than added and left to fail at run time, because
 * `validateConfig` refuses an agent naming an unregistered adapter — which
 * turns a missing API key into a clear boot-time error instead of a
 * twenty-five-minute run that dies on its first request.
 */
function adapters(): Record<string, Runner> {
  const registry: Record<string, Runner> = { claude_local: createClaudeRunner() };

  if (process.env.GEMINI_API_KEY) {
    registry.gemini = createLoopRunner({
      installRoot,
      provider: createGeminiProvider({
        apiKey: process.env.GEMINI_API_KEY,
        model: process.env.GEMINI_MODEL ?? "gemini-2.5-pro",
      }),
    });
  }

  if (process.env.AZURE_AI_PROJECT_ENDPOINT && (process.env.AZURE_AI_TOKEN || process.env.AZURE_AI_API_KEY)) {
    registry.azure_foundry = createLoopRunner({
      installRoot,
      provider: createAzureProvider({
        endpoint: process.env.AZURE_AI_PROJECT_ENDPOINT,
        token: process.env.AZURE_AI_TOKEN,
        apiKey: process.env.AZURE_AI_API_KEY,
        model: process.env.AZURE_AI_MODEL ?? "gpt-4.1",
      }),
    });
  }

  return registry;
}

const registry = adapters();

/**
 * One switch for the whole org. `SCYNE_ADAPTER=gemini` moves every agent onto
 * Gemini; unset, everything runs on Claude Code exactly as before. An
 * unregistered name fails loudly here rather than at the first run.
 */
const defaultAdapter = process.env.SCYNE_ADAPTER ?? "claude_local";
if (!registry[defaultAdapter]) {
  throw new Error(
    `SCYNE_ADAPTER='${defaultAdapter}' is not registered — available: ${Object.keys(registry).join(", ")}.\n` +
    `  gemini needs GEMINI_API_KEY; azure_foundry needs AZURE_AI_PROJECT_ENDPOINT plus\n` +
    `  AZURE_AI_TOKEN (az account get-access-token --scope https://ai.azure.com/.default) or AZURE_AI_API_KEY.`);
}

export default defineOrchestrator({
  workspace: installRoot,
  company: "Scyne",
  db: process.env.DATABASE_URL
    ? { driver: "external", url: process.env.DATABASE_URL }
    : { driver: "pglite", dir: ".orchestrator/pgdata" },

  // The SOURCE of truth, not `.claude/skills` — that is a directory of symlinks
  // pointing here, so editing this is what the team maintains and what
  // `npm run link-skills` publishes to Claude Code.
  skillsDir: "skills",

  adapters: registry,

  defaults: {
    adapter: defaultAdapter,
    // Model and effort are Claude Code's vocabulary. A loop-driven adapter
    // carries its own model on the provider, so passing these to one would be
    // naming a model it cannot serve.
    ...(defaultAdapter === "claude_local" ? { model: "claude-sonnet-4-6", effort: "medium" as const } : {}),
  },

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
