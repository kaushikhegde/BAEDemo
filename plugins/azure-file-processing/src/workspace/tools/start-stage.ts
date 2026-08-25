import { orchFetch, type OrchCtx } from "../orchestrator.js";
import { log } from "../../shared/logger.js";

/** Compiled from scripts/pipeline.mjs. `design` is the optional side stage and
 *  is deliberately included — a user can ask for it by name. */
export const WORKFLOW_KEYS = [
  "baseline", "capabilities", "personas", "requirements",
  "ui", "datamodel", "architecture", "qa", "design", "app",
] as const;

/** Which of them run per feature rather than per project. */
const FEATURE_LEVEL = new Set(["requirements", "ui", "datamodel", "architecture", "qa", "design"]);

export interface StartStageArgs { workflow: string; project: string; feature?: string }

export interface StartStageResult {
  issueId: string;
  workflow: string;
  project: string;
  feature: string | null;
  state: string;
}

export const startStage = async (ctx: OrchCtx, args: StartStageArgs): Promise<StartStageResult> => {
  const { workflow, project, feature } = args;

  if (!(WORKFLOW_KEYS as readonly string[]).includes(workflow)) {
    throw new Error(`unknown workflow ${workflow}; expected one of ${WORKFLOW_KEYS.join(", ")}`);
  }
  if (FEATURE_LEVEL.has(workflow) && !feature) {
    throw new Error(`${workflow} runs per feature — pass a feature`);
  }
  if (!FEATURE_LEVEL.has(workflow) && feature) {
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
