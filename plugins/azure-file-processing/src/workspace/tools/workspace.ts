import { chatFetch, type WsCtx } from "../chatbot.js";
import { getStorage } from "../../shared/storage.js";
import { ensureWorkspaceContainer, syncUp } from "../sync.js";
import { log } from "../../shared/logger.js";

/**
 * Push a project's tree to blob after a write, and report rather than throw.
 *
 * `syncUp(storage, root, project, opts?)` returns `{ pushed, skipped, bytes }`.
 * A sync failure is never fatal here: the tree and the database row are real
 * whether or not blob heard about it, and the sync CLI can be run again by
 * hand.
 */
const pushToBlob = async (
  ctx: WsCtx, project: string,
): Promise<{ pushed: number; skipped: number; bytes: number } | { error: string }> => {
  try {
    const s = getStorage(ctx.cfg);
    await ensureWorkspaceContainer(s);
    return await syncUp(s, ctx.cfg.workspaceRoot, project);
  } catch (e: any) {
    return { error: e?.message ?? String(e) };
  }
};

export interface CreateProjectArgs { project: string; description?: string; website?: string }

/**
 * Creates a Scyne project through the CHATBOT's `POST /api/projects` rather
 * than writing `projects/<project>/` here directly. That route is the only
 * code that writes BOTH the folder tree and the database row (plus the Azure
 * DevOps project and the branding) — this repo has already paid for the
 * mistake of a surface that wrote only the tree once: a project created in
 * the web wizard existed for every agent and for no API, its definition
 * silently failed to save, and every run it produced filed under an
 * anonymous row in Spend.
 */
export const createProject = async (ctx: WsCtx, args: CreateProjectArgs) => {
  const res = await chatFetch<any>(ctx.cfg, "POST", "/api/projects", {
    project: args.project,
    description: args.description ?? "",
    website: args.website ?? "",
  });

  // The new tree is near-empty scaffolding, but pushing it now means blob holds
  // the project from the moment it exists rather than from its first stage run.
  const synced = await pushToBlob(ctx, res.project);

  log.info("workspace.project_created", {
    project: res.project,
    dbOk: !res.dbError, adoOk: !res.adoError,
  });

  return {
    project: res.project,
    // A name with spaces is SLUGGED, not refused: `{from, to}` when it
    // changed, null when the caller already typed the slug.
    slugged: res.slugged ?? null,
    definitionWritten: Boolean(res.definitionWritten),
    // Reported, never swallowed — everything that resolves a project BY NAME
    // stays empty until the row exists.
    db: res.db ?? null,
    dbError: res.dbError ?? null,
    adoTarget: res.adoTarget ?? null,
    adoError: res.adoError ?? null,
    brandError: res.brandError ?? null,
    synced,
  };
};

export const createFeature = async (ctx: WsCtx, args: { project: string; feature: string }) => {
  const res = await chatFetch<any>(ctx.cfg, "POST", "/api/features", {
    project: args.project, feature: args.feature,
  });
  log.info("workspace.feature_created", {
    project: args.project, feature: args.feature, dbOk: !res.dbError,
  });
  return {
    project: args.project,
    feature: res.feature ?? args.feature,
    db: res.db ?? null,
    dbError: res.dbError ?? null,
  };
};

/**
 * `GET /api/features` answers `store.available()`:
 *
 *   { "<project>": [ { name: "<feature>", counts: { sop: 2, … } }, … ] }
 *
 * An ARRAY OF OBJECTS, not of strings — reading it as strings is how a listing
 * comes back as a column of `[object Object]`.
 */
const availableTree = (ctx: WsCtx) =>
  chatFetch<Record<string, Array<{ name: string; counts?: Record<string, number> }>>>(
    ctx.cfg, "GET", "/api/features");

export const listProjects = async (ctx: WsCtx) => {
  const raw = await availableTree(ctx);
  return {
    projects: Object.keys(raw ?? {}).sort(),
    // The count is worth carrying: a project with no features is a real state
    // and the next question is always "which of these has anything in it".
    featureCounts: Object.fromEntries(
      Object.entries(raw ?? {}).map(([p, fs]) => [p, fs.length])),
  };
};

export const listFeatures = async (ctx: WsCtx, args: { project: string }) => {
  const raw = await availableTree(ctx);
  const features = raw?.[args.project];
  if (!features) throw new Error(`no such project: ${args.project}`);
  return {
    project: args.project,
    features: features.map((f) => f.name).sort(),
    // Which discovery folders hold documents, per feature — the thing that
    // decides whether a stage will refuse with `no_documents`.
    documentCounts: Object.fromEntries(features.map((f) => [f.name, f.counts ?? {}])),
  };
};

export const listDocuments = async (ctx: WsCtx, args: { project: string; feature?: string }) => {
  const q = new URLSearchParams({ project: args.project });
  if (args.feature) q.set("feature", args.feature);
  const raw = await chatFetch<any>(ctx.cfg, "GET", `/api/documents?${q}`);

  const rows = [...(raw?.documents?.project ?? []), ...(raw?.documents?.feature ?? [])]
    .map((d: any) => ({
      path: d.path, feature: d.feature ?? null, kind: d.kind ?? null,
      sizeBytes: d.bytes ?? null, inDb: Boolean(d.inDb),
    }));

  const notInDb = rows.filter((r) => !r.inDb).length;
  return {
    project: args.project,
    feature: args.feature ?? null,
    documents: rows,
    counts: raw?.counts ?? null,
    // Surfaced with its fix rather than hidden: a document on disk and absent
    // from the database is why `scyne doc list` and the Docs tab once disagreed.
    notInDb,
    fix: notInDb > 0 ? "npm run sync:docs -- --apply" : null,
    stale: raw?.stale ?? [],
  };
};
