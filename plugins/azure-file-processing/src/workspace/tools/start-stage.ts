import { orchFetch, type OrchCtx } from "../orchestrator.js";
import { resolveStage, listStages } from "./stages.js";
import { log } from "../../shared/logger.js";

export interface StartStageArgs { workflow: string; project: string; feature?: string }

export interface StartStageResult {
  issueId: string;
  workflow: string;
  project: string;
  feature: string | null;
  state: string;
}

/**
 * Start one Scyne pipeline stage as a tracked issue.
 *
 * The workflow key is resolved against the SERVER, not against a list compiled
 * into this package — see `stages.ts` for why that distinction is the whole
 * point of a plugin that ships separately from the engine it drives.
 */
export const startStage = async (ctx: OrchCtx, args: StartStageArgs): Promise<StartStageResult> => {
  const { workflow, project, feature } = args;

  const stage = await resolveStage(ctx, workflow);

  // The level comes from the workflow's own interpolated parameters, so a stage
  // that starts reading `{feature}` becomes feature-level here with no edit.
  if (stage.level === "feature" && !feature) {
    throw new Error(`${workflow} runs per feature — pass a feature`);
  }
  if (stage.level === "project" && feature) {
    throw new Error(`${workflow} is a project-level stage and takes no feature`);
  }

  // POST /issues answers 201 with the issue ROW, then advances in the
  // background — `engine.advance()` is fire-and-forget in the handler.
  // Returning the id rather than waiting is correct: an agent run averages
  // twenty-five minutes.
  const created = await orchFetch<{ id: string; status?: string }>(
    ctx.cfg, "POST", "/issues",
    { workflow, params: feature ? { project, feature } : { project } },
  );

  log.info("workspace.stage_started", { workflow, project, feature: feature ?? "", issueId: created.id });
  return {
    issueId: created.id,
    workflow, project,
    feature: feature ?? null,
    state: created.status ?? "todo",
  };
};

/** Every stage this server offers, with its level and whether it is a revision
 *  variant. The catalogue as a TOOL, so a caller can ask what is runnable
 *  instead of guessing — and so the answer is always the server's. */
export const stages = async (ctx: OrchCtx) => {
  const all = await listStages(ctx, true);
  return {
    stages: all.map((s) => ({
      key: s.key, level: s.level,
      variantOf: s.variantOf,
      params: s.params,
    })),
    note: "Read live from the orchestrator's GET /config. A stage added to the " +
          "pipeline appears here without upgrading this plugin.",
  };
};
