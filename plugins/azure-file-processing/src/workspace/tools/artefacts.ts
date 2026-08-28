import { chatFetch, type WsCtx } from "../chatbot.js";
import { orchFetch } from "../orchestrator.js";
import { resolveProjectId } from "../doc-store.js";
import { log } from "../../shared/logger.js";
import { userError } from "../../shared/errors.js";

/**
 * The artefact-level operations the web chat has and the plugin did not:
 * revising a generated document, republishing it, and the project definition
 * every skill reads before any discovery document.
 *
 * All of them go through the CHATBOT rather than the orchestrator, because
 * that is where the artefact-name → workflow routing lives (`/api/revise`
 * parses an alias into `revise-<stage>` and resolves the owning agent). A
 * second copy of that mapping here is a second thing to keep in step with
 * `scripts/pipeline.mjs`, and `npm run check:routing` would not be checking it.
 */

/** The artefact aliases `/api/revise` accepts. Listed so the tool description
 *  can name them and a wrong one is refused HERE, with the full list, rather
 *  than as a bare `400 unknown_artefact` after a round trip. Kept in the order
 *  the pipeline runs. */
export const ARTEFACTS = [
  "capabilities", "personas", "requirements", "ui",
  "datamodel", "architecture", "qa", "design",
] as const;

export interface ReviseArgs {
  project: string; feature?: string; artefact: string; instruction: string;
}

/**
 * Hands the owning agent its own previous output plus an instruction, and asks
 * for a SMALL DIFF — not a regeneration. The discipline matters: a
 * regenerate-from-scratch produces a diff too large for a reviewer to check,
 * which defeats the approval gate that follows it.
 *
 * On approval the publish step UPDATES the existing wiki page rather than
 * creating a second one, using `.published.json` for page identity. That is
 * the whole reason a revision is not just "run the stage again".
 */
export const reviseArtefact = async (ctx: WsCtx, args: ReviseArgs) => {
  if (!(ARTEFACTS as readonly string[]).includes(args.artefact)) {
    throw userError("unknown_artefact",
      `unknown artefact ${args.artefact}; expected one of ${ARTEFACTS.join(", ")}`);
  }
  if (!args.instruction.trim()) {
    throw userError("instruction_required",
      "instruction is required and is passed to the agent VERBATIM — it is the " +
      "only thing it is given to know what to change");
  }
  const r = await chatFetch<any>(ctx.cfg, "POST", "/api/revise", {
    project: args.project, feature: args.feature,
    artefact: args.artefact, instruction: args.instruction,
  });
  log.info("workspace.artefact_revised", {
    project: args.project, feature: args.feature ?? "", artefact: args.artefact,
  });
  return r;
};

/**
 * Publishes an already-approved artefact again — to the SAME wiki page, by the
 * path recorded in `.published.json`. Used when a publish failed on a bad
 * target (a missing scope, a wrong project) and the document itself is fine:
 * re-running the whole stage would cost another agent run to produce a
 * document that already exists.
 */
export const republishArtefact = async (
  ctx: WsCtx, args: { project: string; feature?: string; artefact: string },
) => {
  if (!(ARTEFACTS as readonly string[]).includes(args.artefact)) {
    throw userError("unknown_artefact",
      `unknown artefact ${args.artefact}; expected one of ${ARTEFACTS.join(", ")}`);
  }
  return chatFetch<any>(ctx.cfg, "POST", "/api/republish", {
    project: args.project, feature: args.feature, artefact: args.artefact,
  });
};

/**
 * The project definition — who the client is, what they are regulated to do,
 * who their customers really are. EVERY skill reads it before any discovery
 * document, so a project without one produces documents written in nobody's
 * terms.
 */
export const getProjectDefinition = async (ctx: WsCtx, args: { project: string }) => {
  // The `description` COLUMN on the project row, not `description.md` on disk.
  // Six skills read the definition, and they read it from a tree materialised
  // for the step — so the record is the row, and the file is derived from it.
  const id = await resolveProjectId(ctx as any, args.project);
  const row: any = await orchFetch<any>(ctx.cfg as any, "GET", `/projects/${id}`);
  return { project: args.project, description: row?.description ?? null };
};

export const saveProjectDefinition = async (
  ctx: WsCtx, args: { project: string; description: string },
) => {
  // Refused here rather than after a round trip: the route's own floor is 40
  // characters, and a one-line description is worse than none — it reads as
  // authoritative and says nothing.
  if (args.description.trim().length < 40) {
    throw userError("description_too_short",
      `description is ${args.description.trim().length} characters; the route requires at ` +
      `least 40. Write who the client is, what they are regulated to do, and who ` +
      `their customers are — every skill reads this before any discovery document.`);
  }
  const id = await resolveProjectId(ctx as any, args.project);
  const row: any = await orchFetch<any>(ctx.cfg as any, "PATCH", `/projects/${id}`,
    { description: args.description });
  return { project: args.project, description: row?.description ?? args.description };
};

/**
 * Artefacts generated BEFORE one of their declared inputs last changed,
 * computed from file mtimes against the shared pipeline graph.
 *
 * Nothing regenerates on its own and nothing is stored. mtime over-reports
 * rather than under-reports, which is the safe direction: a refresh you decline
 * costs nothing, a pack that contradicts itself costs a client meeting.
 */
export const staleness = async (ctx: WsCtx, args: { project: string; feature?: string }) => {
  const path = args.feature
    ? `/api/staleness/${encodeURIComponent(args.project)}/${encodeURIComponent(args.feature)}`
    : `/api/staleness/${encodeURIComponent(args.project)}`;
  return chatFetch<any>(ctx.cfg, "GET", path);
};

/** Palette, wordmark and logo pulled from the client's own website, written to
 *  the PROJECT's theme.json — one project renders one companion app, so it
 *  carries one palette. Re-renders the app if one already exists. */
export const extractBrand = async (ctx: WsCtx, args: { project: string; url: string }) =>
  chatFetch<any>(ctx.cfg, "POST", "/api/brand/extract", {
    project: args.project, url: args.url,
  });
