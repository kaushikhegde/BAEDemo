import {
  createWorkRoot, discardWorkRoot, materialise, harvest,
  createPlatformRepo, createDocumentStore,
  type Db, type BlobBackend, type WorkspaceProvider, type AcquiredWorkspace,
} from "../packages/orchestrator/src/index.js";

/**
 * A scratch tree per step, materialised out of the store and harvested back.
 *
 * Lives here rather than in `packages/orchestrator/` because acquiring one
 * means resolving an ISSUE to a PROJECT and its features, and the engine has no
 * idea what a project is — `config.workspaces` is the seam, the same shape
 * `adapters` and `blobs` already use.
 *
 * ## Why per step, and not per issue
 *
 * A workflow parks at a gate for hours or days. A temporary directory that has
 * to survive that is a lifecycle somebody has to own — what discards the tree
 * of a `blocked` issue nobody returns to, and what happens when a container
 * restarts mid-issue. A step is stateless instead: pull, work, push, discard.
 * Nothing survives a step, so nothing can be orphaned by a replica dying.
 *
 * The cost is one pull per step. Measured against a real project that is ~8 MB,
 * so a ten-step workflow moves under 100 MB — and the push back is
 * hash-compared, so a step that changed one file of forty uploads one file.
 *
 * ## What is NOT kept
 *
 * `release(false)` discards without harvesting. A step that failed or was
 * killed leaves a half-written tree, and a half-written tree must not become
 * the record — after this change there is no second copy to recover from.
 */
export const scratchWorkspaces = (opts: {
  db: Db;
  installRoot: string;
  blobs?: BlobBackend;
  /** Ceiling for one tree. Refused loudly rather than filling a container. */
  maxBytes?: number;
  /** Where a harvest failure is reported. Defaults to console.error. */
  onError?: (message: string) => void;
}): WorkspaceProvider => {
  const platform = createPlatformRepo(opts.db);
  const store = createDocumentStore(opts.db, opts.blobs);
  const report = opts.onError ?? ((m: string) => console.error(m));

  return {
    async acquire(issue): Promise<AcquiredWorkspace | null> {
      // An issue with no project resolves to nothing to materialise. That is a
      // real state — `repo.createIssue` leaves `project_id` null rather than
      // guessing when a name matches nothing — so it falls back to the static
      // workspace rather than failing the run.
      const projectId = (issue as { project_id?: string | null }).project_id;
      if (!projectId) return null;

      const project = await platform.getProject(projectId);
      if (!project) return null;

      const features = (await platform.listFeatures(projectId))
        .map(f => ({ id: f.id, name: f.name }));

      const root = await createWorkRoot("scyne-step-");
      let manifest;
      try {
        manifest = await materialise({
          store,
          projectId,
          projectName: project.name,
          features,
          installRoot: opts.installRoot,
          workRoot: root,
          maxBytes: opts.maxBytes,
        });
      } catch (e) {
        // A failure to BUILD the tree leaves nothing behind. Rethrown rather
        // than swallowed: running the step against a tree that is missing its
        // inputs produces a confidently wrong artefact, which is worse than a
        // blocked issue naming the cause.
        await discardWorkRoot(root);
        throw e;
      }

      return {
        root,
        async release(ok) {
          try {
            if (ok) {
              const result = await harvest({ store, workRoot: root, manifest });
              // Reported, never thrown. The step itself succeeded and its
              // status is already recorded; failing here would contradict a
              // result the engine has already acted on. A missing file is
              // REPORTED by harvest rather than deleted from the store, so
              // nothing is lost by carrying on.
              if (result.missing.length) {
                report(`[workspace] ${project.name}: ${result.missing.length} file(s) ` +
                       `vanished from the tree and were left in the store: ${result.missing.slice(0, 5).join(", ")}`);
              }
            }
          } catch (e) {
            report(`[workspace] ${project.name}: harvest failed — ${(e as Error).message}`);
          } finally {
            // Always. A container has finite disk and an abandoned tree is a
            // leak that outlives the run that made it.
            await discardWorkRoot(root);
          }
        },
      };
    },
  };
};
