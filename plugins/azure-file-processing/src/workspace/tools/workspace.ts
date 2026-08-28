import type { WsCtx } from "../chatbot.js";
import { orchFetch } from "../orchestrator.js";
import { resolveProjectId, forgetProjectIds, listStoreDocuments } from "../doc-store.js";
import { log } from "../../shared/logger.js";
import { userError } from "../../shared/errors.js";

/**
 * Projects, features and documents — all through the ORCHESTRATOR, none of it
 * through disk.
 *
 * These used to go to the chatbot, which wrote `projects/<p>/` and answered
 * "what exists" by globbing that tree. The bucket is the source of truth: a
 * `projects/` folder exists only while a stage is running, pulled down at the
 * start of a step and deleted after it. A surface that CREATES one, or reads
 * one to answer a question, contradicts that — and on an end user's machine
 * there is no such folder to read, so the answer came back empty rather than
 * wrong-but-plausible.
 *
 * `pushToS3` went with them. It synced the local tree into a second bucket to
 * keep a durable copy of something that is no longer the record.
 */

export interface CreateProjectArgs { project: string; description?: string; website?: string }

export const createProject = async (ctx: WsCtx, args: CreateProjectArgs) => {
  const row: any = await orchFetch<any>(ctx.cfg as any, "POST", "/projects", {
    name: args.project,
    description: args.description ?? null,
    website: args.website ?? null,
  });
  // The name may have been slugged on the way in, so a later call must resolve
  // afresh rather than trust what was asked for.
  forgetProjectIds();
  log.info("workspace.project_created", { project: row?.name ?? args.project, id: row?.id });
  return {
    project: row?.name ?? args.project,
    slug: row?.slug ?? null,
    id: row?.id ?? null,
    description: row?.description ?? args.description ?? null,
    // No tree is created. Whatever a stage needs on disk is materialised for
    // that step out of the store and discarded after it.
    note: "Created in the database. Documents live in object storage; there is no folder.",
  };
};

export const createFeature = async (ctx: WsCtx, args: { project: string; feature: string }) => {
  const id = await resolveProjectId(ctx as any, args.project);
  const row: any = await orchFetch<any>(ctx.cfg as any, "POST", `/projects/${id}/features`,
    { name: args.feature });
  log.info("workspace.feature_created", { project: args.project, feature: args.feature });
  return { project: args.project, feature: row?.name ?? args.feature, id: row?.id ?? null };
};

export const listProjects = async (ctx: WsCtx) => {
  const rows = await orchFetch<any>(ctx.cfg as any, "GET", "/projects");
  const list: any[] = Array.isArray(rows) ? rows : rows?.projects ?? [];
  return {
    projects: list.map((p) => p?.name ?? p?.slug).filter(Boolean).sort(),
    // Worth carrying: a project with no features is a real state, and the next
    // question is always "which of these has anything in it".
    featureCounts: Object.fromEntries(
      list.map((p) => [p?.name ?? p?.slug, p?.featureCount ?? p?.features?.length ?? 0])),
  };
};

export const listFeatures = async (ctx: WsCtx, args: { project: string }) => {
  const id = await resolveProjectId(ctx as any, args.project);
  const rows = await orchFetch<any>(ctx.cfg as any, "GET", `/projects/${id}/features`);
  const list: any[] = Array.isArray(rows) ? rows : rows?.features ?? [];
  return { project: args.project, features: list.map((f) => f?.name).filter(Boolean).sort() };
};

export const listDocuments = async (ctx: WsCtx, args: { project: string; feature?: string }) => {
  // From the STORE. `/api/documents` globbed the `projects/` tree, so it
  // answered "what is on this machine right now" — which where there is no
  // tree is nothing at all.
  const rows = await listStoreDocuments(
    ctx as any, args.project, args.feature ?? null, !args.feature);

  const all = (rows ?? []).map((d: any) => ({
    path: d.path,
    feature: d.featureId ?? null,
    kind: d.category ?? null,
    sizeBytes: d.bytes ?? null,
    version: d.version ?? null,
  }));

  return {
    project: args.project,
    feature: args.feature ?? null,
    documents: all,
    counts: {
      project: all.filter((d) => !d.feature).length,
      feature: all.filter((d) => d.feature).length,
    },
  };
};
