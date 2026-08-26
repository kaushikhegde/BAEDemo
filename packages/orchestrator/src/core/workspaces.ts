import type { IssueRow } from "./repo.js";
import type { Db } from "./db.js";

/**
 * A working tree for ONE step, and the promise to put it back.
 *
 * `release(ok)` is called in a `finally`, so it runs whether the step
 * succeeded, failed, parked or threw. `ok` says whether what the step wrote
 * should be kept: a crashed agent's half-written tree must not become the
 * record, and harvest is the only thing that could make it one.
 */
export interface AcquiredWorkspace {
  /** Absolute path the step should treat as the workspace root. */
  root: string;
  release(ok: boolean): Promise<void>;
}

/**
 * Supplies a step its working tree.
 *
 * Returning null means "use the static workspace" — which is what an install
 * with everything on local disk wants, and what keeps this optional.
 *
 * Implemented by the CONSUMER, because materialising a tree means resolving an
 * issue to a project and its features, and the engine has no idea what a
 * project is. Same discipline as `adapters` and `blobs`.
 */
export interface WorkspaceProvider {
  acquire(issue: IssueRow, stepIndex: number): Promise<AcquiredWorkspace | null>;
}

/**
 * Built once, with the open database connection.
 *
 * The consumer's config object is evaluated before `createOrchestrator` opens
 * the database, so a provider that needs a connection cannot be constructed
 * there. Handing it the engine's own connection is also what stops it opening a
 * second one — PGlite is single-writer, and a second connection to an external
 * Postgres is a pool nobody asked for.
 */
export type WorkspaceProviderFactory = (db: Db) => WorkspaceProvider;
