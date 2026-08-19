// Two roots, because one value was doing two jobs.
//
// `config.workspace` used to answer both "where does the code and its library
// of skills live" and "where does this project's material live". On a single
// machine those are the same directory, so nothing ever forced them apart. A
// plugin forces them apart immediately: the skills, agent instructions,
// examples and reference catalogues ship WITH the plugin, while the project
// being worked on is materialised per run from the database into a temporary
// tree. Handing a script the wrong one of those two is not a subtle failure —
// `convert-to-md.mjs` resolves its markdown converter through
// `createRequire(<root>/scyne-chatbot/package.json)` and simply throws.
//
// So:
//
//   installRoot   the plugin payload. skills/, agent-instructions/, examples/,
//                 datamodel-reference/, scripts/, scyne-chatbot/, .mcp.json.
//                 Read-only as far as a run is concerned.
//
//   workRoot      this run's project tree. projects/, generated-apps/.
//                 Written by agents, harvested back into the database.
//
// Today `workRoot` defaults to `installRoot`, which is exactly the current
// behaviour: one checkout holding both. Materialisation changes what it
// resolves to without touching a single caller, because every consumer already
// takes its root as a parameter — `projectDir(workspace, project)`,
// `featureDir(workspace, …)`, `levelRoot(workspace, …)` and
// `resolveInput(workspace, …)` in scripts/pipeline.mjs all do.

import { existsSync, statSync, accessSync, constants } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

export interface Roots {
  /** The plugin payload: skills, agent instructions, examples, scripts. */
  installRoot: string;
  /** This run's project tree: projects/, generated-apps/. */
  workRoot: string;
}

/**
 * Directories that identify an install root. Both must be present — either one
 * alone is too common a name to be evidence. These are the same two markers
 * the chatbot has always used, kept identical so a directory that worked for
 * one resolver works for the other.
 */
export const INSTALL_MARKERS = ["agent-instructions", "skills"] as const;

/** How far up the tree to walk looking for the markers before giving up. */
const MAX_WALK_UP = 8;

export interface ResolveRootsOptions {
  /** Explicit install root — a `--root` flag or a config value. Wins over everything. */
  installRoot?: string;
  /** Explicit work root. Defaults to the install root; materialisation supplies one per run. */
  workRoot?: string;
  /** Where the marker walk-up starts. Defaults to the process's cwd. */
  from?: string;
  /** Environment to read. Injectable so tests need not mutate `process.env`. */
  env?: NodeJS.ProcessEnv;
}

/** One attempted source, kept so a failure can report what it actually tried. */
interface Attempt {
  label: string;
  value: string | null;
  outcome: string;
}

function isDir(p: string): boolean {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

/** Does this directory carry every install marker? */
export function hasInstallMarkers(dir: string): boolean {
  return INSTALL_MARKERS.every(m => existsSync(resolve(dir, m)));
}

/**
 * Walk up from `from` looking for a directory carrying the install markers.
 * Bounded rather than unbounded: an unbounded walk from a stray cwd can reach
 * `/` and match nothing slowly, and on a developer machine it can plausibly
 * match a DIFFERENT checkout further up, which is worse than not matching.
 */
export function findInstallRoot(from: string): string | null {
  let dir = resolve(from);
  for (let i = 0; i < MAX_WALK_UP; i++) {
    if (hasInstallMarkers(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * A resolved root has to be usable, not merely named. A path copied from
 * another machine's `.env` is the common case — it exists in the file and
 * nowhere else — and the failure it causes without this check is an EACCES or
 * ENOENT thrown much later, from whichever write happened to come first.
 */
function usability(dir: string, needWrite: boolean): string | null {
  if (!isDir(dir)) return "not a directory";
  if (!needWrite) return null;
  try { accessSync(dir, constants.W_OK); return null; } catch { return "not writable"; }
}

export class RootResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RootResolutionError";
  }
}

/**
 * Resolve both roots, or throw naming every source that was tried.
 *
 * Fail-loud is the whole point. The previous behaviour — fall back to the
 * directory the code happens to live in — is correct for a checkout and
 * actively dangerous for a plugin: it silently writes a client's documents
 * into whatever tree the binary was installed under. "Have context of the
 * working folder BEFORE performing the task" is precisely this function's job,
 * and a guess is not context.
 */
export function resolveRoots(opts: ResolveRootsOptions = {}): Roots {
  const env = opts.env ?? process.env;
  const from = opts.from ?? process.cwd();
  const attempts: Attempt[] = [];

  const consider = (label: string, raw: string | undefined | null): string | null => {
    if (!raw || !raw.trim()) {
      attempts.push({ label, value: null, outcome: "not set" });
      return null;
    }
    // A relative value is resolved against the walk-up origin, not against the
    // module's own location: `WORKSPACE_PATH=.` should mean the caller's
    // directory, which is what every shell that sets it intends.
    const abs = isAbsolute(raw) ? raw : resolve(from, raw);
    const problem = usability(abs, false);
    attempts.push({ label, value: abs, outcome: problem ?? "ok" });
    return problem ? null : abs;
  };

  const installRoot =
    consider("explicit --root / config", opts.installRoot) ??
    consider("$SCYNE_INSTALL_ROOT", env.SCYNE_INSTALL_ROOT) ??
    // Kept because every one of the ten scripts and the chatbot already read
    // it. Dropping it would break every existing invocation for no gain.
    consider("$WORKSPACE_PATH", env.WORKSPACE_PATH) ??
    (() => {
      const found = findInstallRoot(from);
      attempts.push({
        label: `marker walk-up (${INSTALL_MARKERS.join(" + ")}) from ${from}`,
        value: found,
        outcome: found ? "ok" : `no ancestor within ${MAX_WALK_UP} levels carries both`,
      });
      return found;
    })();

  if (!installRoot) throw new RootResolutionError(explain(attempts));

  // A root that resolved from an explicit source but carries no markers is
  // almost always a path meant for something else. Say so here, naming the
  // directory, rather than failing later on a missing skill.
  if (!hasInstallMarkers(installRoot)) {
    throw new RootResolutionError(
      `'${installRoot}' is not a Scyne install root — it has no ` +
      `${INSTALL_MARKERS.map(m => `${m}/`).join(" and no ")}.\n` +
      `  The install root is the plugin payload: skills, agent instructions,\n` +
      `  examples and scripts. It is not where a project's documents live.`);
  }

  const workRoot = opts.workRoot
    ? (isAbsolute(opts.workRoot) ? opts.workRoot : resolve(from, opts.workRoot))
    : (env.SCYNE_WORK_ROOT?.trim()
        ? resolve(from, env.SCYNE_WORK_ROOT.trim())
        // Today: the same checkout holds both. Materialisation passes an
        // explicit workRoot per run and this branch stops being taken.
        : installRoot);

  const workProblem = usability(workRoot, true);
  if (workProblem) {
    throw new RootResolutionError(
      `the work root '${workRoot}' is ${workProblem}.\n` +
      `  This is where a project's tree is written (projects/, generated-apps/),\n` +
      `  so it must exist and be writable by this process.`);
  }

  return { installRoot, workRoot };
}

/** The failure message: every source tried, in order, with what happened. */
function explain(attempts: Attempt[]): string {
  const lines = attempts.map((a, i) =>
    `    ${i + 1}. ${a.label}` + (a.value ? `\n         → ${a.value} (${a.outcome})` : `  — ${a.outcome}`));
  return [
    `no Scyne workspace found.`,
    ``,
    `  Searched, in order:`,
    ...lines,
    ``,
    `  Run \`scyne init\` in the directory you want to work from, or set`,
    `  SCYNE_INSTALL_ROOT to an existing install.`,
  ].join("\n");
}
