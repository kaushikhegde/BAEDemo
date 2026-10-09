import fs from "node:fs/promises";
import path from "node:path";
import * as pipeline from "../../scripts/pipeline.mjs";

/**
 * What the chat may read to answer a question about a generated artefact.
 *
 * One fixed list of files per artefact, never a path from the model: the model
 * names WHICH artefact, and this table decides which files that is. The `.md`
 * renderings are preferred over the `.json` they come from because they carry
 * the same content at about half the size, in a form the model reads more
 * reliably. The UI mockups are JSON only, so that is what is read for them.
 */
export const ARTEFACTS = {
  capabilities: { level: "project", files: ["solutions/Capabilities/outputs/capability-process.md"] },
  personas: { level: "project", files: ["solutions/Experience/outputs/personas-journeys.md"] },
  requirements: { level: "feature", files: ["outputs/product-summary.md", "outputs/stories.md"] },
  ui: { level: "feature", files: ["solutions/UI/outputs/mockups.json"] },
  datamodel: { level: "feature", files: ["solutions/DataModel/outputs/salesforce-data-model.md"] },
  architecture: { level: "feature", files: ["solutions/Architecture/outputs/solution-architecture.md"] },
  qa: { level: "feature", files: ["solutions/QA/outputs/test-cases.md"] },
  design: { level: "feature", files: ["solutions/Design/outputs/solution-design.md"] },
} as const satisfies Record<string, { level: "project" | "feature"; files: readonly string[] }>;

export type ArtefactKey = keyof typeof ARTEFACTS;

/** Large enough for every artefact measured so far (the biggest is ~70 KB). */
export const MAX_ARTEFACT_BYTES = 200_000;

export type ArtefactRead =
  | { state: "ok"; artefact: ArtefactKey; files: string[]; content: string; truncated: boolean }
  | { state: "not_generated"; artefact: ArtefactKey; files: string[] }
  | { state: "invalid"; reason: string };

export interface ReadScope {
  workspace: string;
  /** The caller's projects and each one's features — `store.available(token)`. */
  visible: Record<string, { name: string }[]>;
  /**
   * One file from the STORE, by its path relative to its own level, or null.
   *
   * The store is the system of record: every step works in a scratch tree
   * that is harvested into it and then deleted, so a project made since has
   * nothing on disk, and an older project's disk copy goes stale the moment a
   * revision is approved. Disk is only the fallback for an install whose
   * outputs predate that.
   */
  readStored?: (project: string, feature: string | null, rel: string) => Promise<string | null>;
}

const isArtefact = (a: string): a is ArtefactKey => Object.prototype.hasOwnProperty.call(ARTEFACTS, a);

/** SAFE_NAME allows dots, so `..` has to be refused on its own. */
const isSafeName = (n: string) => pipeline.SAFE_NAME.test(n) && !n.includes("..") && !n.startsWith(".");

export async function readArtefact(
  args: { project?: unknown; feature?: unknown; artefact?: unknown },
  scope: ReadScope,
): Promise<ArtefactRead> {
  const artefact = String(args.artefact ?? "").trim();
  const project = String(args.project ?? "").trim();
  const feature = String(args.feature ?? "").trim();

  if (!isArtefact(artefact)) {
    return { state: "invalid", reason: `Unknown artefact "${artefact}". Use one of: ${Object.keys(ARTEFACTS).join(", ")}.` };
  }
  // Visibility is checked against the caller's own project list, so a question
  // about another organisation's project reads nothing — the same rule the
  // system prompt's project list already follows.
  if (!project || !isSafeName(project) || !Object.prototype.hasOwnProperty.call(scope.visible, project)) {
    return { state: "invalid", reason: `There is no project called "${project}" that this user can see.` };
  }

  const def = ARTEFACTS[artefact];
  let root = path.join(scope.workspace, "projects", project);
  if (def.level === "feature") {
    if (!feature) {
      return { state: "invalid", reason: `The ${artefact} belong to a feature. Ask the user which feature of ${project} they mean.` };
    }
    if (
      !isSafeName(feature) ||
      pipeline.RESERVED_FEATURE_NAMES.has(feature.toLowerCase()) ||
      !scope.visible[project].some((f) => f.name === feature)
    ) {
      return { state: "invalid", reason: `${project} has no feature called "${feature}".` };
    }
    root = path.join(root, feature);
  }

  const found: string[] = [];
  const bodies: string[] = [];
  for (const rel of def.files) {
    const stored = await scope.readStored?.(project, def.level === "feature" ? feature : null, rel);
    if (stored != null) {
      bodies.push(stored);
      found.push(rel);
      continue;
    }
    try {
      bodies.push(await fs.readFile(path.join(root, rel), "utf8"));
      found.push(rel);
    } catch (e: any) {
      if (e?.code !== "ENOENT") throw e;
    }
  }
  if (found.length === 0) return { state: "not_generated", artefact, files: [...def.files] };

  let content = bodies.join("\n\n---\n\n");
  const truncated = Buffer.byteLength(content) > MAX_ARTEFACT_BYTES;
  if (truncated) content = Buffer.from(content).subarray(0, MAX_ARTEFACT_BYTES).toString("utf8");
  return { state: "ok", artefact, files: found, content, truncated };
}
