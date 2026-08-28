import type { Config } from "../shared/config.js";
import type { OrchCtx } from "./orchestrator.js";
import { orchFetch } from "./orchestrator.js";
import { userError, serviceError, authError } from "../shared/errors.js";

/**
 * Documents, through the ORCHESTRATOR's store — object storage plus a database
 * row, written together.
 *
 * This replaced a path that POSTed to the chatbot's `/api/upload`, which did an
 * `fs.writeFile` into `projects/<p>/documents/` and left the store untouched.
 * That made DISK the record, which is the opposite of what was decided: the
 * bucket is the source of truth, and a `projects/` tree exists only while a
 * stage is running, pulled down at the start of a step and deleted after it.
 *
 * Two things followed from the old shape, and both are why this module exists:
 *
 *   - A document could land on disk with no row — exactly what happened when
 *     the blob write failed and left an upload half-registered.
 *   - The write only worked where the plugin shared a filesystem with the
 *     tree. An end user has no `projects/` folder and never will, so an upload
 *     that depends on one cannot be shipped to them.
 *
 * Nothing here touches the filesystem.
 */

/**
 * The store addresses a project by UUID; every tool here is given a NAME.
 *
 * Cached for the life of the process because the mapping does not change — a
 * project is not renamed underneath a running server, and re-listing every
 * project on each document call would turn one upload into two round trips.
 * A miss is not cached: a project created a moment ago must resolve on the
 * next call rather than after a restart.
 */
const idCache = new Map<string, { id: string; name: string }>();

/**
 * The store's id AND the project's canonical name.
 *
 * Both, because the two are needed by different callers and only one lookup
 * should pay for them. The NAME matters more than it looks: this resolver is
 * deliberately forgiving — it matches slug and case as well as name, so a
 * person can type `sa-demo` for `SA-DEMO` — while the engine's `createIssue`
 * matches `projects.name` exactly when it resolves a workflow's `project`
 * param to `issues.project_id`. Hand it the string the caller typed and a
 * project can resolve here and NOT there, which does not fail: the issue is
 * created with a null `project_id`, the scratch-tree provider finds nothing to
 * materialise, and the run proceeds against an empty tree. Pass this name on
 * instead.
 */
export const resolveProject = async (
  ctx: OrchCtx, name: string,
): Promise<{ id: string; name: string }> => {
  const hit = idCache.get(name);
  if (hit) return hit;

  const rows = await orchFetch<any>(ctx.cfg, "GET", "/projects");
  const list: any[] = Array.isArray(rows) ? rows : rows?.projects ?? [];
  // Matched on `name` first and `slug` second: the tools take whatever the
  // person typed, and `SA Demo` is stored with a slug of `SA-DEMO`.
  const found = list.find((p) => p?.name === name)
    ?? list.find((p) => p?.slug === name)
    ?? list.find((p) => String(p?.name ?? "").toLowerCase() === name.toLowerCase())
    ?? list.find((p) => String(p?.slug ?? "").toLowerCase() === name.toLowerCase());

  if (!found?.id) {
    // Names the ones that exist. A typo is the common cause and a bare
    // "not found" makes the caller guess at spelling and capitalisation.
    const known = list.map((p) => p?.name ?? p?.slug).filter(Boolean).sort();
    throw userError("no_such_project",
      `no project called ${JSON.stringify(name)}`
      + (known.length ? `. Projects: ${known.join(", ")}` : ". No projects exist yet."));
  }
  const resolved = { id: found.id, name: String(found.name ?? name) };
  idCache.set(name, resolved);
  return resolved;
};

export const resolveProjectId = async (ctx: OrchCtx, name: string): Promise<string> =>
  (await resolveProject(ctx, name)).id;

/** Only for tests — the cache is otherwise process-lifetime by design. */
export const forgetProjectIds = () => idCache.clear();

/**
 * One call carrying BYTES rather than JSON.
 *
 * `orchFetch` serialises its body as JSON, which for a document means base64:
 * a third larger, and under V8's cap on a single string. The orchestrator
 * accepts `application/octet-stream` for exactly this reason — its own comment
 * calls the raw form "how a document of any size should arrive" — so the
 * plugin uses it and never builds a base64 string at all.
 */
const orchBytes = async (
  cfg: Config, method: string, path: string, body?: Buffer,
): Promise<any> => {
  const url = `${cfg.orchUrl.replace(/\/+$/, "")}${path}`;
  const headers: Record<string, string> = { accept: "application/json" };
  if (cfg.orchToken) headers.authorization = `Bearer ${cfg.orchToken}`;
  if (body) headers["content-type"] = "application/octet-stream";

  let res: Response;
  try {
    res = await fetch(url, {
      method, headers,
      ...(body ? { body: new Uint8Array(body) } : {}),
    });
  } catch (e: any) {
    throw serviceError("service_unavailable", e, { context: { service: "orchestrator", method, path } });
  }

  const text = await res.text();
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      throw authError(`orchestrator answered ${res.status} for ${method} ${path}`,
        { service: "orchestrator", path, status: res.status });
    }
    let parsed: any; try { parsed = text ? JSON.parse(text) : undefined; } catch { /* not JSON */ }
    if (res.status === 400 && parsed?.message) throw userError("bad_request", String(parsed.message));
    throw serviceError("orchestrator_error", new Error(`${res.status} ${method} ${path}`),
      { context: { status: res.status } });
  }
  try { return text ? JSON.parse(text) : undefined; } catch { return undefined; }
};

export interface PutDocInput {
  project: string;
  feature?: string | null;
  /** Relative to the document's own level, the convention `produces[]` uses. */
  path: string;
  content: Buffer;
  category?: string | null;
}

/** Store a document version. Identical content is a no-op, reported as `changed: false`. */
export const putDocument = async (ctx: OrchCtx, input: PutDocInput) => {
  const id = await resolveProjectId(ctx, input.project);
  const q = new URLSearchParams({ path: input.path });
  if (input.feature) q.set("feature", input.feature);
  if (input.category) q.set("category", input.category);
  return await orchBytes(ctx.cfg, "POST", `/projects/${id}/documents?${q}`, input.content);
};

export const listStoreDocuments = async (
  ctx: OrchCtx, project: string, feature?: string | null, allLevels = false,
) => {
  const id = await resolveProjectId(ctx, project);
  const q = new URLSearchParams();
  if (allLevels) q.set("all", "true");
  else if (feature) q.set("feature", feature);
  const qs = q.toString();
  return await orchFetch<any[]>(ctx.cfg, "GET", `/projects/${id}/documents${qs ? `?${qs}` : ""}`);
};

/** The bytes of one document version, as bytes — never base64 through a string. */
export const readStoreDocument = async (
  ctx: OrchCtx, project: string, docId: string,
): Promise<Buffer> => {
  const id = await resolveProjectId(ctx, project);
  const url = `${ctx.cfg.orchUrl.replace(/\/+$/, "")}/projects/${id}/documents/${encodeURIComponent(docId)}`;
  const headers: Record<string, string> = { accept: "application/octet-stream" };
  if (ctx.cfg.orchToken) headers.authorization = `Bearer ${ctx.cfg.orchToken}`;

  let res: Response;
  try { res = await fetch(url, { headers }); }
  catch (e: any) {
    throw serviceError("service_unavailable", e, { context: { service: "orchestrator", path: "/documents" } });
  }
  if (res.status === 404) throw userError("no_document", `no document ${docId} in ${project}`);
  if (!res.ok) {
    throw serviceError("orchestrator_error", new Error(`${res.status} reading ${docId}`),
      { context: { status: res.status } });
  }
  return Buffer.from(await res.arrayBuffer());
};

/** Retire the current version at a path. Bytes are kept — other paths may share them. */
export const deleteStoreDocument = async (
  ctx: OrchCtx, project: string, path: string, feature?: string | null,
) => {
  const id = await resolveProjectId(ctx, project);
  const q = new URLSearchParams({ path });
  if (feature) q.set("feature", feature);
  return await orchFetch<any>(ctx.cfg, "DELETE", `/projects/${id}/documents?${q}`);
};
