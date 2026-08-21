// Operations that must land on BOTH sides of the split.
//
// This system currently keeps two records of what exists. The agents read a
// folder tree under `projects/`; `scyne` and the API read the database. Until
// they are bridged for good, anything that CREATES something has to write to
// both, or the tool contradicts itself — "SAPN already exists" from the
// assistant, directly above "(no projects yet)" from `/projects`.
//
// One module rather than two copies, because the session and the one-shot
// commands both need exactly this and a divergence between them would be
// invisible until someone's upload went missing.
//
// The folder-tree side goes through the CHATBOT server, deliberately: it
// already owns creating a project tree, pulling branding from a client's
// website, and routing an upload into the right `requirements/` subfolder.
// Reimplementing any of that here would be a second thing to keep in step.

import { basename, resolve } from "node:path";
import { homedir } from "node:os";
import { readFile } from "node:fs/promises";
import { ApiError, resolveProject, type Client } from "./client.ts";
import { load } from "./config.ts";

export const DEFAULT_CHAT_URL = "http://127.0.0.1:4000";
export const chatUrl = (): string => process.env.SCYNE_CHAT_URL || DEFAULT_CHAT_URL;

/**
 * The credential for the chatbot server.
 *
 * The browser holds an httpOnly cookie it cannot read; a terminal holds a
 * bearer token and no cookie. Sending nothing — which every call here used to
 * do — is why the chatbot answered 401 not_authenticated to the whole of the
 * session's natural-language path and to the on-disk half of creating a
 * project, a feature or a document.
 */
export function chatAuth(): Record<string, string> {
  const token = load().token;
  return token ? { authorization: `Bearer ${token}` } : {};
}

/** What happened on one side. "exists" is a normal outcome, not a failure. */
export type SideResult =
  | { state: "created"; detail?: string }
  // `detail` because a 409 has two meanings that read very differently to a
  // person: already in YOUR organisation, or the name is held by another one.
  | { state: "exists"; detail?: string }
  | { state: "skipped"; detail: string }
  | { state: "failed"; detail: string };

export interface DualResult {
  disk: SideResult;
  db: SideResult;
  /** Anything the caller wants to report — the stored path, its version. */
  extra?: Record<string, unknown>;
}

/** `sop` → the folder the pipeline expects. Matches fileRouter.ts. */
export const CATEGORY_DIR: Record<string, string> = {
  sop: "requirements/SOP",
  transcripts: "requirements/Transcripts",
  notes: "requirements/Notes",
  ui: "requirements/UI",
  template: "requirements/templates",
};

/**
 * The body comes back as well as the outcome.
 *
 * `POST /api/projects` does three things in one call — scaffolds the tree,
 * writes description.md, and runs extract-brand inline — and reports what the
 * branding found. Throwing that away meant the wizard had to re-extract to
 * show a palette it had already fetched.
 */
async function postChat<T = unknown>(
  path: string, body: unknown,
): Promise<{ side: SideResult; body: T | null }> {
  try {
    const res = await fetch(chatUrl() + path, {
      method: "POST",
      headers: { "content-type": "application/json", ...chatAuth() },
      body: JSON.stringify(body),
    });
    const parsed = await res.json().catch(() => null) as (T & { error?: string }) | null;
    if (res.ok) return { side: { state: "created" }, body: parsed };
    if (res.status === 409) return { side: { state: "exists" }, body: parsed };
    return { side: { state: "failed", detail: parsed?.error ?? res.statusText }, body: parsed };
  } catch {
    // Not an error worth stopping for: the database side still succeeded, and
    // the tree can be created later. Say which half is missing.
    return { side: { state: "skipped", detail: `chatbot server not running at ${chatUrl()}` }, body: null };
  }
}

export async function createProject(
  client: Client, input: { name: string; description?: string; website?: string },
): Promise<DualResult> {
  // The chatbot's route is what fetches the client's website and writes
  // design/style-guides/theme.json, so passing `website` here is what makes
  // branding happen at all.
  const created = await postChat<{
    definitionWritten?: boolean;
    brand?: BrandResult["theme"] & { logoSrc?: string };
    brandError?: string | null;
  }>("/api/projects", {
    project: input.name, description: input.description, website: input.website,
  });
  const disk = created.side;

  let db: SideResult;
  try {
    await client.post("/projects", {
      name: input.name, description: input.description ?? null, website: input.website ?? null,
    });
    db = { state: "created" };
  } catch (err) {
    // A 409 here means one of two very different things: the project already
    // exists in YOUR organisation, or the name is held by ANOTHER one — the
    // project folder tree is flat and shared, so names are unique across the
    // install. "already there" is misleading for the second, because a listing
    // in your own organisation will show nothing.
    db = (err as ApiError).status === 409
      ? { state: "exists", detail: (err as Error).message || undefined }
      : { state: "failed", detail: (err as Error).message };
  }
  return {
    disk, db,
    extra: {
      definitionWritten: created.body?.definitionWritten ?? false,
      // Normalised to the same shape extractBrand() reports, so a caller can
      // render one palette block whichever route produced it.
      brand: created.body?.brand
        ? { ...created.body.brand, logoSrc: undefined, hasLogo: Boolean(created.body.brand.logoSrc ?? created.body.brand.hasLogo) }
        : null,
      brandError: created.body?.brandError ?? null,
    },
  };
}

export async function createFeature(
  client: Client, input: { project: string; feature: string },
): Promise<DualResult> {
  const disk = (await postChat("/api/features", { project: input.project, feature: input.feature })).side;

  let db: SideResult;
  try {
    const proj = await resolveProject(client, input.project);
    await client.post(`/projects/${proj.id}/features`, { name: input.feature });
    db = { state: "created" };
  } catch (err) {
    const status = (err as ApiError).status;
    db = status === 409 ? { state: "exists" }
      : status === 404 ? { state: "failed", detail: "that project is not in the database yet" }
      : { state: "failed", detail: (err as Error).message };
  }
  return { disk, db };
}

/**
 * The project definition, on both sides.
 *
 * The database column is what `scyne project show` prints; the file at
 * `projects/<p>/description.md` is what every SKILL reads before any discovery
 * document. Writing only the first — which `scyne project describe` did, via
 * an unauthenticated fetch whose 401 was swallowed by a bare `.catch` — leaves
 * a definition that looks saved everywhere a person looks and reaches no agent.
 */
export async function saveProjectDefinition(
  client: Client, input: { project: string; description: string },
): Promise<DualResult> {
  const text = input.description.trim();
  if (text.length < 40) {
    throw new ApiError(400, "a project definition needs at least a couple of sentences");
  }

  let db: SideResult;
  try {
    const proj = await resolveProject(client, input.project);
    await client.patch(`/projects/${proj.id}`, { description: text });
    db = { state: "created" };
  } catch (err) {
    db = { state: "failed", detail: (err as Error).message };
  }

  let disk: SideResult;
  let extra: Record<string, unknown> = {};
  try {
    const res = await fetch(chatUrl() + "/api/project-description", {
      method: "POST",
      headers: { "content-type": "application/json", ...chatAuth() },
      body: JSON.stringify({ project: input.project, description: text }),
    });
    if (res.ok) {
      const parsed = await res.json().catch(() => ({} as { path?: string; bytes?: number }));
      extra = { path: parsed.path, bytes: parsed.bytes };
      disk = { state: "created", detail: `${parsed.path} (${parsed.bytes ?? 0} bytes)` };
    } else {
      const parsed = await res.json().catch(() => ({} as { error?: string; message?: string }));
      disk = { state: "failed", detail: parsed.message ?? parsed.error ?? res.statusText };
    }
  } catch {
    disk = { state: "skipped", detail: `chatbot server not running at ${chatUrl()}` };
  }

  return { disk, db, extra };
}

/** What `/api/brand/extract` reports back, minus the inlined logo data URI. */
export interface BrandResult {
  url: string;
  rerendered: boolean;
  theme: {
    brand?: string; brandDeep?: string; accent?: string;
    logoText?: string; fontFamily?: string; hasLogo?: boolean;
  } | null;
}

/**
 * Pull a client's palette, wordmark and logo off their website.
 *
 * Not dual: branding is a file the renderer reads and the database holds no
 * copy of it. Synchronous, unlike a stage trigger — it writes theme.json and
 * re-renders, so the caller can report the colours and be corrected.
 */
export async function extractBrand(input: { project: string; url: string }): Promise<BrandResult> {
  const res = await fetch(chatUrl() + "/api/brand/extract", {
    method: "POST",
    headers: { "content-type": "application/json", ...chatAuth() },
    body: JSON.stringify({ project: input.project, url: input.url }),
  }).catch(() => {
    throw new ApiError(503, `chatbot server not running at ${chatUrl()}`);
  });
  if (!res.ok) {
    const parsed = await res.json().catch(() => ({} as { error?: string; message?: string }));
    throw new ApiError(res.status, parsed.message ?? parsed.error ?? res.statusText);
  }
  return res.json() as Promise<BrandResult>;
}

export interface UploadInput {
  project: string;
  feature?: string | null;
  file: string;
  /** sop | transcripts | notes | ui | template */
  as?: string | null;
}

/**
 * Store one document on both sides.
 *
 * The database copy is the system of record and is written first — if the
 * folder-tree write fails, the document still exists and can be materialised
 * later. The reverse order would risk a file on disk that nothing knows about.
 */
export async function uploadDocument(client: Client, input: UploadInput): Promise<DualResult> {
  // `~` is expanded by a SHELL, and the session is not one — a path typed into
  // `/upload` reaches here verbatim, so `~/Downloads/x.pdf` would be read as a
  // directory literally named "~".
  const local = input.file.startsWith("~/")
    ? resolve(homedir(), input.file.slice(2))
    : input.file;

  let bytes: Buffer;
  try {
    bytes = await readFile(local);
  } catch (err) {
    // ENOENT's default text names the resolved path and nothing else, which
    // reads like a server error inside a session that never mentions the
    // filesystem. Say it is a local file that is not there.
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new ApiError(400, `no such file on this machine: ${local}`);
    if (code === "EISDIR") throw new ApiError(400, `that is a directory, not a file: ${local}`);
    throw err;
  }
  const name = basename(local);
  const dir = input.as ? CATEGORY_DIR[input.as] : null;
  if (input.as && !dir) {
    throw new ApiError(400, `--as must be one of ${Object.keys(CATEGORY_DIR).join(", ")}`);
  }
  // No --as, and the two answers are genuinely different:
  //   feature in scope  -> requirements/<name>, the working folder's ROOT.
  //                        On disk and in the database, but in none of the four
  //                        categorised folders, so the BA reads it with no idea
  //                        whether it is a transcript (the primary source of
  //                        stories) or an SOP (context, explicitly NOT stories).
  //   no feature        -> documents/<name>, the project's client-wide folder,
  //                        which is exactly right for policy and legislation.
  const path = dir ? `${dir}/${name}` : (input.feature ? `requirements/${name}` : `documents/${name}`);

  let db: SideResult;
  let extra: Record<string, unknown> = { path };
  try {
    const proj = await resolveProject(client, input.project);
    const res = await client.post<{ version: number; changed: boolean }>(
      `/projects/${proj.id}/documents`, {
        feature: input.feature ?? undefined,
        path, category: input.as ?? null,
        content: bytes.toString("base64"), encoding: "base64",
      });
    extra = { path, version: res.version, changed: res.changed };
    db = res.changed ? { state: "created", detail: `v${res.version}` } : { state: "exists" };
  } catch (err) {
    db = { state: "failed", detail: (err as Error).message };
  }

  // Two upload routes, one per level. A project's own documents — the
  // client-wide policy and legislation every skill reads before any feature —
  // go to `/api/upload/project`, which lands them in `projects/<p>/documents/`
  // AND runs convert-to-md. That conversion is not a nicety: the skills read
  // `.md` only, and the capability map refuses to start with "no documents"
  // when a project holds nothing but PDFs.
  const projectLevel = !input.feature;
  let disk: SideResult;
  try {
    const form = new FormData();
    form.set("file", new Blob([new Uint8Array(bytes)]), name);
    form.set("project", input.project);
    if (!projectLevel) {
      form.set("feature", input.feature as string);
      if (input.as) form.set("hint", input.as);
    }
    const res = await fetch(chatUrl() + (projectLevel ? "/api/upload/project" : "/api/upload"), {
      // No content-type: fetch sets the multipart boundary itself.
      method: "POST", headers: chatAuth(), body: form,
    });
    if (res.ok) {
      const parsed = await res.json().catch(() => ({} as { filename?: string; converted?: boolean }));
      disk = {
        state: "created",
        detail: parsed.filename + (parsed.converted ? " (converted to markdown)" : ""),
      };
      extra = { ...extra, filename: parsed.filename, converted: parsed.converted };
    } else {
      const parsed = await res.json().catch(() => ({} as { error?: string; message?: string }));
      disk = { state: "failed", detail: parsed.message ?? parsed.error ?? res.statusText };
    }
  } catch {
    disk = { state: "skipped", detail: `chatbot server not running at ${chatUrl()}` };
  }

  return { disk, db, extra };
}
