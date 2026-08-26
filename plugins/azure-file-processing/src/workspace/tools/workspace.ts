import { chatFetch, type WsCtx } from "../chatbot.js";
import { getStorage } from "../../shared/storage.js";
import { ensureWorkspaceContainer, syncUp } from "../sync.js";
import { log } from "../../shared/logger.js";
import { userError } from "../../shared/errors.js";

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

  // Everything an OPERATOR needs, and nothing a caller does. The blob mirror
  // and the database write are both this installation's plumbing: a caller
  // cannot make either succeed, and a `synced: { error: … }` on an otherwise
  // successful creation reads like a failure of the thing they asked for.
  log.info("workspace.project_created", {
    project: res.project,
    adoOk: !res.adoError,
    ado: res.adoError ? String(res.adoError).slice(0, 400) : "",
    synced: "error" in synced ? `error: ${synced.error}`.slice(0, 400) : `pushed ${synced.pushed}`,
  });

  return {
    project: res.project,
    // The row's id. The project IS the row now — the tree is materialised from
    // it — so carrying the id back is what lets a caller address the project
    // through any platform route (`/projects/{id}/documents`, members, spend)
    // rather than only by name.
    projectId: res.projectId ?? null,
    // A name with spaces is SLUGGED, not refused: `{from, to}` when it
    // changed, null when the caller already typed the slug.
    slugged: res.slugged ?? null,
    definitionWritten: Boolean(res.definitionWritten),
    // Where this project will publish. The client's OWN Azure DevOps project
    // and wiki, so it is theirs to see.
    adoTarget: res.adoTarget ?? null,
    // A sentence, not the API's refusal text. The project is real and usable —
    // documents, stages and gates all work — but publishing is not wired up,
    // and that is worth knowing before someone approves a gate expecting a
    // wiki page. The cause went to the log above.
    publishingReady: !res.adoError,
    publishingNote: res.adoError
      ? "This project has no Azure DevOps target yet, so published documents and work items will not be created. Everything else works."
      : null,
    // The caller supplied the website, so a refusal to read it is theirs.
    brandError: res.brandError ?? null,
  };
};

export const createFeature = async (ctx: WsCtx, args: { project: string; feature: string }) => {
  const res = await chatFetch<any>(ctx.cfg, "POST", "/api/features", {
    project: args.project, feature: args.feature,
  });
  log.info("workspace.feature_created", { project: args.project, feature: args.feature });
  return {
    project: args.project,
    feature: res.feature ?? args.feature,
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
  if (!features) throw userError("no_such_project", `no project called "${args.project}"`);
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

  const all = [...(raw?.documents?.project ?? []), ...(raw?.documents?.feature ?? [])];
  const rows = all.map((d: any) => ({
    path: d.path, feature: d.feature ?? null, kind: d.kind ?? null,
    sizeBytes: d.bytes ?? null,
  }));

  // `inDb` is a reconciliation detail between two stores, and it used to be
  // returned per document alongside `notInDb` and a literal
  // `fix: "npm run sync:docs -- --apply"`. An end user has no checkout to run
  // that in and no shell on the machine holding the tree, so it was an
  // instruction to do something impossible about a state they cannot cause. It
  // goes to the operator's log instead, where somebody can act on it.
  const notInDb = all.filter((d: any) => !d.inDb).length;
  if (notInDb > 0) {
    log.warn("workspace.documents_not_in_db", {
      project: args.project, feature: args.feature ?? "", notInDb, total: all.length,
    });
  }

  return {
    project: args.project,
    feature: args.feature ?? null,
    documents: rows,
    counts: raw?.counts ?? null,
    // `stale` STAYS. Unlike the above it is genuinely the caller's decision —
    // it lists artefacts that now predate their inputs, and re-running them
    // costs agent time and money that nobody should spend on someone's behalf.
    stale: raw?.stale ?? [],
  };
};
