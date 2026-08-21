// The public API surface of @scyne/orchestrator. A consuming project imports
// from here only — everything under src/core/ and src/http/ is an
// implementation detail reached indirectly through this file, including the
// HTTP router below.

export {
  defineOrchestrator, validateConfig, resolveRuntime,
  type Step, type WorkflowDef, type OrchestratorConfig, type OrchestratorDefaults, type Theme,
} from "./config.js";
export { createRouter, ROUTES } from "./http/router.js";
export { openDb, migrate, type Db, type DbOptions } from "./core/db.js";
export {
  resolveRoots, findInstallRoot, hasInstallMarkers, RootResolutionError,
  INSTALL_MARKERS, type Roots, type ResolveRootsOptions,
} from "./core/roots.js";
export {
  createRepo,
  type AgentSpec, type AgentRow, type IssueRow, type RunRow, type GateRow,
  type CommentRow, type WorkProductRow, type Effort,
} from "./core/repo.js";
export { createEngine, type Engine, type ExecFn } from "./core/engine.js";
export { createClaudeRunner, buildArgs, type Runner, type RunRequest, type RunResult } from "./core/runner.js";
export { createCodexRunner, buildCodexArgs } from "./core/codex-runner.js";
export type { CodexProvider } from "./core/codex-runner.js";
export {
  createLoopRunner, MAX_TURNS,
  type ChatProvider, type CompleteRequest, type ProviderTurn, type ProviderToolCall, type LoopMessage,
} from "./core/agent-loop.js";
export {
  createGeminiProvider, createAzureProvider, type GeminiOptions, type AzureOptions,
} from "./core/providers.js";
export {
  runTool, confine, ToolError, TOOL_SCHEMAS, ALLOWED_COMMANDS,
  type ToolCall, type ToolOutcome, type ToolContext,
} from "./core/tools.js";
export {
  createDocumentStore, sha256Of,
  type DocumentStore, type DocumentRef, type PutInput, type ListFilter,
} from "./core/documents.js";
export {
  materialise, harvest, attribute, createWorkRoot, discardWorkRoot,
  LINKED_FROM_INSTALL, HARVESTED_ROOTS,
  type Manifest, type HarvestResult, type MaterialiseInput, type FeatureRef,
} from "./core/materialise.js";
export {
  createPlatformRepo, slugify,
  type PlatformRepo, type CompanyRow, type UserRow, type ProjectRow, type FeatureRow,
  type InstallationRow, type ActionRow, type ConversationRow, type MessageRow,
  type Principal, type SpendRow,
} from "./core/platform.js";
export {
  hashPassword, verifyPassword, mintToken, hashToken, looksLikeToken, bearerFrom,
  atLeast, atLeastGlobal, effectiveProjectRole, isGlobalRole, isProjectRole,
  isSuperadmin, sessionExpiry,
  GLOBAL_ROLES, PROJECT_ROLES, TOKEN_PREFIX,
  type GlobalRole, type ProjectRole, type MintedToken,
} from "./core/auth.js";
export { extractUsage, type RunUsage } from "./core/usage.js";
export { filterRunLog, type TranscriptEvent } from "./core/transcript.js";
export { interpolate } from "./core/interpolate.js";
export {
  loadOverrides, saveOverrides, applyOverrides, withAgentPatch, overridesPath,
  type Overrides,
} from "./core/overrides.js";

import { openDb, migrate, type Db } from "./core/db.js";
import { createRepo } from "./core/repo.js";
import { createEngine } from "./core/engine.js";
import { validateConfig, type OrchestratorConfig } from "./config.js";
import { loadOverrides, applyOverrides } from "./core/overrides.js";

export interface Orchestrator {
  db: Db;
  /** The org as it was actually seeded: config file + console overrides. */
  org: ReturnType<typeof applyOverrides>;
  repo: ReturnType<typeof createRepo>;
  engine: ReturnType<typeof createEngine>;
  /**
   * The organisation named by `config.company`.
   *
   * This is where the AGENT ORG CHART is reconciled on every boot, and the
   * default for an internal caller that has no principal. It is NOT the only
   * organisation: a request acts within `principal.companyId`, which a
   * superadmin can retarget with `X-Scyne-Org`. The rename from `companyId`
   * was the point of the multi-tenancy change — the old name read as "the
   * company", and it was being used as though there were only one.
   */
  homeCompanyId: string;
  config: OrchestratorConfig;
  close: () => Promise<void>;
}

/**
 * Boot the orchestrator against a config file: validate it (throwing with
 * EVERY problem found, not just the first), open + migrate the database,
 * reconcile the org chart to `config.org` (the file is the source of truth —
 * every agent is upserted on every startup, not only at first boot), build
 * the engine, recover any orphaned runs, and hand back the running pieces.
 */
export async function createOrchestrator(config: OrchestratorConfig): Promise<Orchestrator> {
  const problems = validateConfig(config);
  if (problems.length) {
    throw new Error(`orchestrator config is invalid:\n${problems.map(p => `  - ${p}`).join("\n")}`);
  }

  const db = await openDb(config.db);
  await migrate(db, new URL("../migrations", import.meta.url).pathname);
  const repo = createRepo(db);

  // Reconcile the database to the config file: config.org is the source of
  // truth for the org chart, so every agent it declares is upserted here on
  // every startup — not only hired once and left to drift.
  const companyId = await repo.ensureCompany(config.company ?? "Scyne");
  // The config file is the default; `.orchestrator/overrides.json` is what an
  // operator changed through the console. Without this merge every console edit
  // would be reverted by the next boot — which would make the console's own
  // controls a lie. See core/overrides.ts.
  const org = applyOverrides(config.org, await loadOverrides(config.workspace));
  for (const a of org) await repo.upsertAgent(companyId, a);

  // No runner is passed to createEngine — it resolves one per agent step
  // from config.adapters at the moment it is needed (step → agent →
  // defaults, via resolveRuntime).
  const engine = createEngine({ repo, config });

  // recoverOrphans() must be called ONLY here, at process startup, before any
  // advance() traffic is accepted. repo.listUnfinishedRuns() has no age
  // filter — it is `finished_at is null`, full stop — so calling this while
  // a run is genuinely still in flight (a second CLI invocation, an HTTP
  // server that has been up a while and is merely re-entering this
  // function) would mark that LIVE run "orphaned" and re-fire its issue out
  // from under it. Safe here because nothing can legitimately still be
  // running from a previous process at the moment a new one boots.
  await engine.recoverOrphans();

  return {
    db, repo, engine, homeCompanyId: companyId, config, org,
    close: () => db.close(),
  };
}
