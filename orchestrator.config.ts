// The consumer config for @scyne/orchestrator. Everything here is
// workspace-specific data compiled from `scripts/pipeline.mjs`, which stays the
// single source of truth for what a stage requires and produces. Nothing under
// packages/orchestrator/ is touched to make this work.

// FIRST, and for its side effect: loads `.env` before the modules below are
// evaluated. See load-env.ts for why it cannot live in this file's body.
import "./load-env.js";
import { existsSync, accessSync, constants as fsConstants } from "node:fs";
import { resolve, join, delimiter } from "node:path";
import {
  defineOrchestrator, createClaudeRunner, createCodexRunner, createLoopRunner,
  createGeminiProvider, createAzureProvider, type Runner,
} from "./packages/orchestrator/src/index.js";
import { ORG, buildWorkflows } from "./orchestrator.workflows.js";
import { selectBlobBackend, describeBlobConfig } from "./storage/blobs.js";
import { scratchWorkspaces } from "./storage/scratch-workspaces.js";

const installRoot = process.env.SCYNE_INSTALL_ROOT ?? process.cwd();

/**
 * Is a binary on PATH?
 *
 * Codex authenticates through `codex login`, cached in `$CODEX_HOME/auth.json`
 * — there is no environment variable to detect, unlike gemini and
 * azure_foundry below. Presence of the binary is the only honest signal.
 *
 * Walks `PATH` directly with `accessSync` rather than shelling out to
 * `command -v` — a real shell was never needed just to answer "is this file
 * here and executable", and `spawnSync(..., { shell: true })` makes Node
 * print a DEP0190 warning ("can lead to security vulnerabilities") on every
 * boot. The injection that warning is about was never reachable here (the
 * only caller passes the hardcoded literal `"codex"`), but a security-shaped
 * warning on every boot of an operator's console trains people to stop
 * reading warnings.
 */
const binaryExists = (bin: string): boolean =>
  (process.env.PATH ?? "").split(delimiter).some((dir) => {
    if (!dir) return false;
    try {
      accessSync(join(dir, bin), fsConstants.X_OK);
      return true;
    } catch {
      return false;
    }
  });

/**
 * Derive the credential the Azure DevOps MCP actually wants.
 *
 * MEASURED, not read off a page. `@azure-devops/mcp --authentication pat` does
 * NOT take a raw PAT in `PERSONAL_ACCESS_TOKEN`: it wants BASIC CREDENTIALS,
 * base64 of `<anything>:<pat>`. Tried against the live server:
 *
 *   raw PAT              → 401
 *   base64(":" + pat)    → works
 *   base64(pat)          → 401
 *
 * Handing it the raw PAT fails EVERY call with a 401 that looks exactly like a
 * bad token — while the same PAT answers 200 over REST, which sends you looking
 * at scopes and permissions instead of at encoding.
 *
 * Derived here rather than stored, so `.env` keeps ONE credential in the form
 * a human copies out of Azure DevOps, and the REST scripts
 * (`scripts/lib/ado.mjs`) keep using that same raw value. Storing the base64
 * instead would double-encode it there.
 *
 * `??=` so an explicitly-set value always wins — if a future server version
 * changes its mind about the format, it can be set directly without a code
 * change.
 */
const adoPat = process.env.ADO_PAT || process.env.MCP_TOKEN_FOR_AZURE;
if (adoPat) {
  process.env.ADO_MCP_BASIC ??= Buffer.from(`:${adoPat}`).toString("base64");
}

// A .env beside the library instead of at the root is a natural guess and
// silently does nothing — the library never reads one. Say so rather than
// letting someone debug a DATABASE_URL that is never picked up.
const strayEnv = resolve(installRoot, "packages", "orchestrator", ".env");
if (existsSync(strayEnv)) {
  console.warn(
    `[config] ignoring ${strayEnv}\n` +
    `         Configuration lives in ONE file at the workspace root: ${resolve(installRoot, ".env")}\n` +
    `         Move your settings there — the chatbot reads that same file, and two would drift.`);
}

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

  // Codex CLI. A whole agent like Claude Code, so it runs the stage itself
  // rather than through the shared loop — see core/codex-runner.ts.
  if (binaryExists("codex")) {
    registry.codex = createCodexRunner({
      installRoot,
      skillsDir: "skills",
      // Where Codex runs actually go.
      //
      // The runner passes `--ignore-user-config`, so `~/.codex/config.toml` —
      // where a proxied or private endpoint is normally declared — reaches no
      // run. An install configured that way therefore worked in a terminal and
      // 401'd in every run, because Codex fell back to api.openai.com with
      // whatever credential auth.json held. Declaring it here is what makes a
      // run reproduce what the terminal does, on any machine rather than the
      // one whose config.toml happens to be right.
      //
      // Unset means Codex's own default endpoint, which is correct for anyone
      // signed in with `codex login` against OpenAI directly.
      ...(process.env.CODEX_BASE_URL
        ? {
            provider: {
              baseUrl: process.env.CODEX_BASE_URL,
              ...(process.env.CODEX_PROVIDER_NAME ? { name: process.env.CODEX_PROVIDER_NAME } : {}),
              ...(process.env.CODEX_WIRE_API ? { wireApi: process.env.CODEX_WIRE_API } : {}),
              // The NAME of the variable, not its value: these become argv,
              // and argv is readable by `ps`. The spawned child inherits this
              // process's environment, so Codex reads the key from there.
              ...(process.env.CODEX_API_KEY ? { envKey: "CODEX_API_KEY" } : {}),
            },
          }
        : {}),
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
    `  codex needs the CLI on PATH and a login: npm i -g @openai/codex && codex login\n` +
    `  gemini needs GEMINI_API_KEY; azure_foundry needs AZURE_AI_PROJECT_ENDPOINT plus\n` +
    `  AZURE_AI_TOKEN (az account get-access-token --scope https://ai.azure.com/.default) or AZURE_AI_API_KEY.`);
}

/**
 * Built once and referenced twice — by `blobs` and by `workspaces`, which must
 * be the same backend or a step would materialise from one store and harvest
 * into another.
 *
 * Awaited at module scope because `selectBlobBackend` reaches its SDK through
 * a dynamic import, so that a Claude/AWS install loads nothing from
 * `@azure/storage-blob` and a Codex/Azure install nothing from the AWS SDK.
 * This module is only ever loaded with `await import()`, so the top-level
 * await costs nothing.
 */
const blobs = await selectBlobBackend();

// Which store, said once at boot. An install with BOTH configured reads from
// both and writes to one, and the one it writes to is worth seeing rather than
// discovering later from a blob in the wrong bucket.
console.error(`[scyne] document store: ${describeBlobConfig()}`);

export default defineOrchestrator({
  workspace: installRoot,
  company: "Scyne",
  db: process.env.DATABASE_URL
    ? { driver: "external", url: process.env.DATABASE_URL }
    : { driver: "pglite", dir: ".orchestrator/pgdata" },

  // Where document BYTES live. S3 for the Claude stack, Azure Blob for the
  // Codex stack, both at once when both are configured — reads span every
  // configured store because a locator names its owner, writes go to one.
  // Undefined when neither is set, which is in-memory and does not survive
  // the process.
  //
  // Absent is the safe default: an install that has not migrated its blobs
  // keeps working exactly as before, and setting this is the one step that
  // changes where content is read from. Run `npm run migrate:blobs -- --apply`
  // FIRST on an install that already holds documents, or every existing
  // document reads back as absent.
  blobs,

  // A scratch tree per STEP, materialised out of the store and harvested back,
  // when bytes live in object storage. Disk is then working space rather than
  // the record: nothing survives a step, so a replica dying mid-run leaves
  // nothing orphaned.
  //
  // Off when blobs are still in Postgres — that install's tree on disk IS the
  // working copy and there is nothing to pull it from.
  workspaces: blobs
    ? ((db) => scratchWorkspaces({ db, installRoot, blobs }))
    : undefined,

  // The SOURCE of truth, not `.claude/skills` — that is a directory of symlinks
  // pointing here, so editing this is what the team maintains and what
  // `npm run link-skills` publishes to Claude Code.
  skillsDir: "skills",

  // A runtime setting may be scoped to a project. The library has no idea what
  // a "project" is — this names the issue param it should key on, so
  // `scyne adapter set gemini --project RTWSA` reaches the engine.
  runtimeScopes: ["project"],

  adapters: registry,

  defaults: {
    adapter: defaultAdapter,
    // Model and effort are Claude Code's vocabulary. A loop-driven adapter
    // carries its own model on the provider, so passing these to one would be
    // naming a model it cannot serve.
    ...(defaultAdapter === "claude_local" ? { model: "claude-sonnet-4-6", effort: "medium" as const } : {}),
    // Codex's own default model unless an operator names one. Naming a model we
    // have not verified it serves is how an entire org's runs die on their
    // first request.
    ...(defaultAdapter === "codex" && process.env.CODEX_MODEL ? { model: process.env.CODEX_MODEL } : {}),
  },

  org: ORG.map(a => ({
    ...a,
    // If Sonnet 4.6 is overloaded mid-run the pipeline should degrade, not stop.
    //
    // claude_local ONLY. `--fallback-model` is Claude Code's flag and no other
    // runner reads it (see core/runner.ts), so on a Codex org this was a Claude
    // model name displayed on every agent's Runtime card that nothing would
    // ever use — advertising a safety net that is not there.
    ...(a.bundlePath && defaultAdapter === "claude_local"
      ? { fallbackModel: ["claude-sonnet-4-5-20250929"] } : {}),
    // A ceiling, not a target. The one measured requirements run took 25
    // minutes and $3.19 (prototype findings); 45 minutes and $15 leaves room
    // for a heavier feature without letting a runaway run all night.
    //
    // The TOKEN ceiling is 10M rather than the 2M it started at, because it
    // does not measure what it reads like. `inputTokens` is the run's total
    // WITH cache reads included (Codex reports it that way, and the check in
    // core/spawn.ts adds it raw), so the figure is really context size times
    // the number of model round-trips — not how much unique material the
    // agent read. Measured: a 14-minute persona run reported 1,995,078 input
    // tokens of which 1,906,560 were cache reads, tripped the 2M ceiling by
    // 2%, and blocked an issue whose outputs were already written and
    // validated. It cost $1.1592 — 8% of the dollar ceiling, because those
    // same cached tokens price at a tenth of fresh ones. So the dollar limit
    // is the guard that actually means something, and the token limit is a
    // runaway backstop that should not fire before it.
    ...(a.bundlePath ? { budget: { maxTokens: 10_000_000, maxCostUsd: 15, maxDurationMs: 45 * 60_000 } } : {}),
  })),

  workflows: buildWorkflows(),
});
