import { orchFetch, type OrchCtx } from "../orchestrator.js";
import { userError, serviceError } from "../../shared/errors.js";

/**
 * The stage catalogue, read from the SERVER rather than shipped in this package.
 *
 * This plugin used to carry its own `WORKFLOW_KEYS` array of ten. The server
 * reports twenty-six — and one it did not carry, `extract`, is a stage the
 * pipeline gained after that array was written, so `start_stage` refused it
 * while the engine ran it perfectly well.
 *
 * That is the same mistake `cli/stages.ts` was written to correct, for the same
 * reason: "what can I run" is a fact about the server being asked, and a client
 * carrying its own copy answers for the version it was published at. A plugin
 * is distributed separately from the engine it drives and upgrades on its own
 * schedule, so this is the failure mode it is MOST exposed to, not least.
 *
 * `level` is derived rather than declared, exactly as the CLI derives it: a
 * workflow that interpolates `{feature}` runs per feature. The engine computes
 * that parameter list by scanning each workflow's own step templates, so it
 * cannot disagree with what the steps actually read.
 */

export interface Stage {
  key: string;
  label: string;
  level: "project" | "feature";
  params: string[];
  /** Set on `revise-<stage>`: the stage this is another mode of. */
  variantOf: string | null;
}

interface ConfigResponse {
  workflows?: Array<{
    key: string;
    label?: string;
    params?: string[];
    variantOf?: string | null;
  }>;
}

/** Cached for the life of the process rather than per call: a server gaining a
 *  stage mid-run is rare, and a round trip in front of every tool call is not.
 *  `stack.sh` restarting this process is the same moment everything else here
 *  picks up a change. */
let cache: Stage[] | null = null;

export const resetStageCache = (): void => { cache = null; };

export const listStages = async (ctx: OrchCtx, force = false): Promise<Stage[]> => {
  if (cache && !force) return cache;
  const cfg = await orchFetch<ConfigResponse>(ctx.cfg, "GET", "/config");
  const rows = cfg.workflows ?? [];
  if (!rows.length) {
    throw serviceError("no_workflows",
      "orchestrator reported no workflows at GET /config — nothing compiled");
  }
  cache = rows.map((w) => ({
    key: w.key,
    label: w.label ?? w.key,
    // Derived, never declared. `params` is the engine's own scan of the
    // workflow's own step templates.
    level: ((w.params ?? []).includes("feature") ? "feature" : "project") as "feature" | "project",
    params: w.params ?? [],
    variantOf: w.variantOf ?? null,
  }));
  return cache;
};

/** Resolves a workflow key against the server, and refuses an unknown one with
 *  the list the SERVER actually offers — not a list this package believes in. */
export const resolveStage = async (ctx: OrchCtx, key: string): Promise<Stage> => {
  let stages = await listStages(ctx);
  let found = stages.find((s) => s.key === key);
  if (found) return found;

  // A MISS is the one moment the cache is worth distrusting. The cache exists
  // so an ordinary call costs no round trip, but refusing a key on the strength
  // of a list fetched when this process booted is the same staleness the whole
  // module exists to avoid — just with a shorter half-life. A stage added to
  // the pipeline while the workspace server happens to be running would be
  // refused until somebody restarted it, and the refusal would name a list that
  // was already out of date. So: miss, refetch once, then decide.
  stages = await listStages(ctx, true);
  found = stages.find((s) => s.key === key);
  if (found) return found;
  // Generation keys first: a caller naming a stage almost always means to run
  // it, and listing thirteen `revise-` variants ahead of them buries the answer.
  const primary = stages.filter((s) => !s.variantOf).map((s) => s.key);
  const variants = stages.filter((s) => s.variantOf).map((s) => s.key);
  throw userError("unknown_workflow",
    `unknown workflow ${key}. Available: ${primary.join(", ")}` +
    (variants.length ? ` (and revision variants: ${variants.join(", ")})` : ""));
};
