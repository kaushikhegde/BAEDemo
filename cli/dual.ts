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

import { basename } from "node:path";
import { readFile } from "node:fs/promises";
import { ApiError, resolveProject, type Client } from "./client.ts";

export const DEFAULT_CHAT_URL = "http://127.0.0.1:4000";
export const chatUrl = (): string => process.env.SCYNE_CHAT_URL || DEFAULT_CHAT_URL;

/** What happened on one side. "exists" is a normal outcome, not a failure. */
export type SideResult =
  | { state: "created"; detail?: string }
  | { state: "exists" }
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

async function postChat(path: string, body: unknown): Promise<SideResult> {
  try {
    const res = await fetch(chatUrl() + path, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    if (res.ok) return { state: "created" };
    if (res.status === 409) return { state: "exists" };
    const parsed = await res.json().catch(() => ({} as { error?: string }));
    return { state: "failed", detail: parsed.error ?? res.statusText };
  } catch {
    // Not an error worth stopping for: the database side still succeeded, and
    // the tree can be created later. Say which half is missing.
    return { state: "skipped", detail: `chatbot server not running at ${chatUrl()}` };
  }
}

export async function createProject(
  client: Client, input: { name: string; description?: string; website?: string },
): Promise<DualResult> {
  // The chatbot's route is what fetches the client's website and writes
  // design/style-guides/theme.json, so passing `website` here is what makes
  // branding happen at all.
  const disk = await postChat("/api/projects", {
    project: input.name, description: input.description, website: input.website,
  });

  let db: SideResult;
  try {
    await client.post("/projects", {
      name: input.name, description: input.description ?? null, website: input.website ?? null,
    });
    db = { state: "created" };
  } catch (err) {
    db = (err as ApiError).status === 409
      ? { state: "exists" }
      : { state: "failed", detail: (err as Error).message };
  }
  return { disk, db };
}

export async function createFeature(
  client: Client, input: { project: string; feature: string },
): Promise<DualResult> {
  const disk = await postChat("/api/features", { project: input.project, feature: input.feature });

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
  const bytes = await readFile(input.file);
  const name = basename(input.file);
  const dir = input.as ? CATEGORY_DIR[input.as] : null;
  if (input.as && !dir) {
    throw new ApiError(400, `--as must be one of ${Object.keys(CATEGORY_DIR).join(", ")}`);
  }
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
      method: "POST", body: form,
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
