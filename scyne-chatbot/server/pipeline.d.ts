// `scripts/pipeline.mjs` is plain JavaScript and deliberately stays that way —
// it is the one file the CLI, the renderer, the stage script and this server
// all import, and four consumers agreeing on ONE definition of the stage graph
// is the point (see CLAUDE.md). Adding a build step to it to satisfy one
// consumer's type checker would undo that.
//
// So the shape is declared here instead. It must stay COMPLETE: a partial
// declaration is worse than none, because it silences the implicit-any and
// then reports every export it forgot as a missing property. Measured while
// writing this — the first draft omitted six exports and produced eight
// errors in code that was correct.
//
// `Stage` therefore keeps an index signature: the graph carries per-stage keys
// (`producesInWorkspace`, `titlePrefix`, `escape`, …) that only some stages
// have, and enumerating them here would be a second source of truth for the
// one thing this repo is careful to keep single.

declare module "*/scripts/pipeline.mjs" {
  export const LEVEL: { PROJECT: "project"; FEATURE: "feature" };
  export const NOT_SOURCE: Set<string>;
  export const SAFE_NAME: RegExp;
  export const RENDER_CMD: string;
  export const RESERVED_FEATURE_NAMES: Set<string>;

  export interface StageInput {
    from: string;
    to: string;
    /** `features` spans every feature under the project — a project stage reads them all. */
    scope?: "project" | "feature" | "features";
    /** A flag that excuses this requirement, e.g. `--from-requirements`. */
    escape?: string;
    [key: string]: unknown;
  }

  export interface Stage {
    order: number;
    level: "project" | "feature";
    // Required, not optional — verified against the graph: all nine stages
    // carry both. Declaring them optional made every call site a null check
    // for a case that cannot happen, which is noise that hides a real one.
    label: string;
    titlePrefix: string;
    skill?: string;
    agent?: string;
    produces?: string[];
    producesInWorkspace?: string[];
    requires?: StageInput[];
    enriches?: StageInput[];
    [key: string]: unknown;
  }

  export const STAGES: Record<string, Stage>;
  export const ORDERED: Array<[string, Stage]>;
  export function ordered(level?: string): Array<[string, Stage]>;
  export function isProjectStage(key: string): boolean;
  export function isFeatureStage(key: string): boolean;

  export const ARTEFACT_ALIASES: Record<string, string>;
  export function stageFor(artefact: string): string | null;
  export function artefactKey(stageKey: string, feature?: string | null): string;

  export function projectDir(workspace: string, project: string): string;
  export function featureDir(workspace: string, project: string, feature: string): string;
  export function levelRoot(
    workspace: string, key: string, project: string, feature?: string | null,
  ): string;
  export function resolveInput(
    workspace: string, input: StageInput, project: string, feature?: string | null,
  ): string;

  /**
   * Every path an input covers. One path for every scope but `features`, which
   * spans each feature under the project.
   */
  export function resolveInputPaths(
    workspace: string, input: StageInput, project: string, feature?: string | null,
  ): Promise<string[]>;

  /** The four folders a client's discovery material lands in, at feature level. */
  export const DISCOVERY_SUBFOLDERS: readonly string[];

  /** Input origins that are not stages, keyed by the `from` they appear under. */
  export const SOURCES: Record<string, { label: string }>;

  export function exists(p: string): Promise<boolean>;
  export function listProjects(workspace: string): Promise<string[]>;
  export function listFeatures(workspace: string, project: string): Promise<string[]>;
  export function listAll(workspace: string): Promise<Record<string, string[]>>;

  /** Epoch millis of the stage's newest output, or null when it has none. */
  export function producedAt(
    workspace: string, key: string, project: string, feature?: string | null,
  ): Promise<number | null>;

  export function stageIsDone(
    workspace: string, key: string, project: string, feature?: string | null,
  ): Promise<boolean>;

  export function unmetRequirements(
    workspace: string, key: string, project: string, feature?: string | null,
    flags?: Set<string>,
  ): Promise<StageInput[]>;

  export interface StaleArtefact {
    key: string;
    artefact: string;
    label?: string;
    level: "project" | "feature";
    generatedAt: string;
    supersededBy: Array<{ key: string; label: string; artefact: string; generatedAt: string }>;
  }

  export function staleness(
    workspace: string, project: string, feature?: string | null,
  ): Promise<StaleArtefact[]>;

  export interface StageStatus {
    key: string;
    def: Stage;
    done: boolean;
    unmet: StageInput[];
  }

  export function status(
    workspace: string, project: string, feature?: string | null,
  ): Promise<StageStatus[]>;
}
