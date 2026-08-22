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

/**
 * What a NEW project may be called. Mirrors `isNewProjectName` in
 * scyne-chatbot/server/names.ts, which is the authority — this copy exists so
 * the wizard can refuse before asking four more questions, and because `cli/`
 * carries no dependency it cannot import from.
 *
 * FEATURE names are unaffected and keep their spaces: "Interim Benefit",
 * "Appeals & Reviews". Every generated command quotes both, so a space is no
 * longer what breaks a run; a project name is restricted because it is also
 * the Azure DevOps project, the wiki path segment and the `--project`
 * argument on every verb, and it only has to survive one caller forgetting.
 *
 * Only NEW names. Existing projects with spaces stay usable everywhere.
 */
export const PROJECT_NAME = /^[A-Za-z0-9._&-]+$/;

/**
 * `SA Demo` -> `SA-Demo`.
 *
 * APPLIED now, not merely offered. It was offered by the interactive wizard and
 * by nothing else, so `scyne project create "SA Power Networks"` was refused
 * outright while the web wizard created it happily — the same disagreement
 * between two copies of one rule that this module exists to prevent between two
 * stores. Idempotent, so applying it to a name that needs nothing is the
 * identity. Must stay in step with slugProjectName() in names.ts.
 */
export const suggestProjectName = (name: string): string =>
  String(name ?? "").trim().replace(/[\s-]+/g, "-").replace(/^-+|-+$/g, "");

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
    const parsed = await res.json().catch(() => null) as (T & { error?: string; message?: string }) | null;
    if (res.ok) return { side: { state: "created" }, body: parsed };
    if (res.status === 409) return { side: { state: "exists" }, body: parsed };
    // `message` before `error`, as the two upload paths below already do: the
    // second is a code, so a refused feature name reported "reserved_name"
    // rather than naming which names are reserved and why.
    return { side: { state: "failed", detail: parsed?.message ?? parsed?.error ?? res.statusText }, body: parsed };
  } catch {
    // Not an error worth stopping for: the database side still succeeded, and
    // the tree can be created later. Say which half is missing.
    return { side: { state: "skipped", detail: `chatbot server not running at ${chatUrl()}` }, body: null };
  }
}

export async function createProject(
  client: Client, input: { name: string; description?: string; website?: string },
): Promise<DualResult> {
  // Slugged HERE rather than only in the wizard, because `scyne project create`
  // reaches this function without passing through it — and because both halves
  // below must be written under the SAME name. Slugging inside either one would
  // produce a folder tree and a row that do not know about each other, which is
  // the exact failure this module exists to prevent.
  const name = suggestProjectName(input.name);
  if (!PROJECT_NAME.test(name) || name.startsWith(".") || /[. ]$/.test(name)) {
    throw new ApiError(400, "a project name may use letters, numbers, spaces and . _ & - only");
  }
  input = { ...input, name };
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
    if ((err as ApiError).status !== 409) {
      db = { state: "failed", detail: (err as Error).message };
    } else {
      // A 409 used to end it here, silently DISCARDING the description the
      // wizard had just spent a paragraph collecting. The row keeps whatever
      // description it already had — usually none — while the file is written
      // correctly, so the assistant goes on asking for a definition the project
      // demonstrably has.
      //
      // This is not a corner case: the tree and the database drift apart by
      // design (a `reset` clears one and leaves the other), and
      // `projectNameTaken` is install-wide, so the name can be held by a row in
      // an organisation the caller cannot even see. Deleting projects/<p>/ and
      // re-running `/new` hits it every time.
      db = { state: "exists", detail: (err as Error).message || undefined };
      if (input.description?.trim()) {
        try {
          const proj = await resolveProject(client, input.name);
          await client.patch(`/projects/${proj.id}`, { description: input.description.trim() });
          db = { state: "exists", detail: "already in the database — definition updated on it" };
        } catch {
          // Left as a plain `exists`. The name is held by an organisation this
          // caller cannot reach, which is the one 409 there is nothing useful
          // to do about — and is exactly what the detail above says.
        }
      }
    }
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

  // What we EXPECT the path to be. The server decides the real one — it routes
  // by filename when there is no --as, and conversion renames the file — so this
  // is only a fallback for reporting when the server tells us nothing.
  let extra: Record<string, unknown> = { path };

  // Two upload routes, one per level. A project's own documents — the
  // client-wide policy and legislation every skill reads before any feature —
  // go to `/api/upload/project`, which lands them in `projects/<p>/documents/`
  // AND runs convert-to-md. That conversion is not a nicety: the skills read
  // `.md` only, and the capability map refuses to start with "no documents"
  // when a project holds nothing but PDFs.
  const projectLevel = !input.feature;
  let disk: SideResult;
  // What the SERVER reported about the database row it wrote. See below.
  let serverDb: { state: string; reason?: string } | null = null;
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
      const parsed = await res.json().catch(() => ({} as {
        filename?: string; converted?: boolean; path?: string;
        db?: { state: string; reason?: string };
      }));
      disk = {
        state: "created",
        detail: parsed.filename + (parsed.converted ? " (converted to markdown)" : ""),
      };
      extra = {
        ...extra,
        filename: parsed.filename,
        converted: parsed.converted,
        ...(parsed.path ? { path: parsed.path } : {}),
      };
      serverDb = parsed.db ?? null;
    } else {
      const parsed = await res.json().catch(() => ({} as { error?: string; message?: string }));
      disk = { state: "failed", detail: parsed.message ?? parsed.error ?? res.statusText };
    }
  } catch {
    disk = { state: "skipped", detail: `chatbot server not running at ${chatUrl()}` };
  }

  // The DISK write goes first, and a REFUSAL cancels the database row.
  //
  // These two used to run independently and report side by side, which produced
  // the one outcome neither side can detect afterwards: the server rejects an
  // ambiguous `.docx` with `Couldn't infer where it belongs` (services/
  // fileRouter.ts marks any .docx/.pdf matching neither the SOP nor the
  // transcript pattern ambiguous), no file is written, and the row is created
  // anyway. The session then prints
  //
  //     folder tree (agents read this)   ✗ Couldn't infer where … belongs
  //     database (scyne reads this)      ✓ v1
  //
  // and `/docs` lists that document from then on. Every agent reads the DISK,
  // so it does not exist for any stage — while looking uploaded in the one
  // place a person checks.
  //
  // `skipped` is deliberately NOT a refusal: that is the chatbot being down,
  // the tree can be created later, and dropping the row would lose the upload
  // altogether. Only an ACTIVE rejection cancels it.
  //
  // THE SERVER WRITES THE ROW, not this function. It used to be written here,
  // from the bytes read off this machine and under the path computed above —
  // and both were wrong by the time the write happened:
  //
  //   * the CONTENT was the raw .docx, while the skills read `.md` only. The
  //     server converts on arrival and MOVES the source into original-files/,
  //     so the row held bytes no stage would ever read.
  //   * the PATH was pre-conversion (`requirements/SOP/handling.docx`) and
  //     therefore named a file that no longer exists on disk — exactly the
  //     "`/docs` lists documents that are not on disk" state in CLAUDE.md. With
  //     no --as it was wronger still: this function guesses `requirements/`,
  //     while the server's routeFile() infers SOP/, Transcripts/, Notes/ or UI/.
  //
  // Only the server knows the converted name, so only the server can write the
  // row. Reported here from what it says it did.
  let db: SideResult;
  if (disk.state === "failed") {
    db = { state: "skipped", detail: "not recorded — the file was rejected, so there would be nothing to point at" };
  } else if (disk.state === "skipped") {
    db = { state: "skipped", detail: "not recorded — the upload never reached the server" };
  } else if (!serverDb) {
    // An older chatbot that does not report its database half. Say so rather
    // than claiming either outcome.
    db = { state: "skipped", detail: "the server did not say whether it recorded the document" };
  } else {
    db = serverDb.state === "created" ? { state: "created" }
      : serverDb.state === "exists" ? { state: "exists", detail: serverDb.reason }
      : serverDb.state === "skipped" ? { state: "skipped", detail: serverDb.reason ?? "not recorded" }
      : { state: "failed", detail: serverDb.reason ?? "not recorded" };
  }

  return { disk, db, extra };
}

/**
 * Remove a document — file, archived original, and row.
 *
 * Through the CHATBOT rather than straight at the platform API, for the same
 * reason the upload is: disk is what every stage reads, and only that server
 * knows where the file lives and what archived source it was converted from.
 * Retiring the row alone would report success and leave the document being read
 * by every stage.
 */
export async function deleteDocument(
  client: Client, input: { project: string; feature?: string | null; path: string },
): Promise<DualResult> {
  let disk: SideResult;
  let parsed: { removed?: string[]; error?: string; message?: string } | null = null;
  let status = 0;
  try {
    const res = await fetch(chatUrl() + "/api/documents", {
      method: "DELETE",
      headers: { "content-type": "application/json", ...chatAuth() },
      body: JSON.stringify({
        project: input.project, feature: input.feature ?? undefined, path: input.path,
      }),
    });
    status = res.status;
    parsed = await res.json().catch(() => null);
    disk = res.ok
      ? { state: "created", detail: (parsed?.removed ?? []).length > 1 ? "with its archived original" : undefined }
      : { state: "failed", detail: parsed?.message ?? parsed?.error ?? res.statusText };
  } catch {
    return {
      disk: { state: "skipped", detail: `chatbot server not running at ${chatUrl()}` },
      db: { state: "skipped", detail: "not retired — the request never reached the server" },
    };
  }

  // The one case worth handling apart: no file on disk, but a row may still
  // point at one. That is the exact state the OLD `scyne doc upload` left
  // behind — it recorded the pre-conversion path, which the converter had
  // already renamed and moved — so refusing here would leave those rows
  // undeletable by the only tool that lists them.
  if (status === 404) {
    try {
      const proj = await resolveProject(client, input.project);
      const q = new URLSearchParams({ path: input.path });
      if (input.feature) q.set("feature", input.feature);
      await client.del(`/projects/${proj.id}/documents?${q}`);
      return {
        disk: { state: "skipped", detail: "no such file on disk" },
        db: { state: "created", detail: "row retired — it named a file that was not there" },
      };
    } catch (err) {
      return {
        disk: { state: "failed", detail: "no such file on disk" },
        db: { state: "failed", detail: (err as Error).message },
      };
    }
  }

  return {
    disk,
    // The server retires the row in the same request, so there is no second
    // call to make and no window where the two disagree.
    db: disk.state === "created" ? { state: "created" } : { state: "skipped", detail: "not retired" },
    extra: { removed: parsed?.removed ?? [] },
  };
}

/**
 * Replace a document with a new file.
 *
 * The server removes the old one and its archived original FIRST, so the
 * replacement keeps its own name rather than landing beside the thing it was
 * meant to supersede as `handling (1).md` — two documents where the client
 * expected one, both staged, the pack quietly citing the superseded policy.
 */
export async function replaceDocument(
  _client: Client, input: { project: string; feature?: string | null; path: string; file: string },
): Promise<DualResult> {
  const local = input.file.startsWith("~/")
    ? resolve(homedir(), input.file.slice(2))
    : input.file;

  let bytes: Buffer;
  try {
    bytes = await readFile(local);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new ApiError(400, `no such file on this machine: ${local}`);
    if (code === "EISDIR") throw new ApiError(400, `that is a directory, not a file: ${local}`);
    throw err;
  }

  try {
    const form = new FormData();
    form.set("file", new Blob([new Uint8Array(bytes)]), basename(local));
    form.set("project", input.project);
    if (input.feature) form.set("feature", input.feature);
    form.set("path", input.path);

    const res = await fetch(chatUrl() + "/api/documents", {
      // No content-type: fetch sets the multipart boundary itself.
      method: "PUT", headers: chatAuth(), body: form,
    });
    const parsed = await res.json().catch(() => null) as {
      path?: string; filename?: string; converted?: boolean;
      db?: { state: string; reason?: string }; error?: string; message?: string;
    } | null;

    if (!res.ok) {
      return {
        disk: { state: "failed", detail: parsed?.message ?? parsed?.error ?? res.statusText },
        db: { state: "skipped", detail: "not recorded — the replacement was rejected" },
      };
    }
    return {
      disk: {
        state: "created",
        detail: parsed?.filename + (parsed?.converted ? " (converted to markdown)" : ""),
      },
      db: parsed?.db?.state === "created" ? { state: "created" }
        : { state: "skipped", detail: parsed?.db?.reason ?? "not recorded" },
      extra: { path: parsed?.path ?? input.path, filename: parsed?.filename },
    };
  } catch {
    return {
      disk: { state: "skipped", detail: `chatbot server not running at ${chatUrl()}` },
      db: { state: "skipped", detail: "not recorded — the request never reached the server" },
    };
  }
}

/** One document as the DISK sees it, with whether the database agrees. */
export interface DiskDocument {
  name: string;
  path: string;
  subfolder: string;
  level: "project" | "feature";
  feature: string | null;
  bytes: number;
  kind: string;
  original: string | null;
  inDb?: boolean;
}

/**
 * What documents a project has, from DISK — the same answer the web UI gives.
 *
 * `scyne doc list` used to read the platform API's rows, and the Docs tab reads
 * the folder tree. That difference IS the mismatch: measured on this
 * installation, 20 documents sat on disk against 2 rows, so the CLI reported
 * nothing for a project the browser showed nine documents for.
 *
 * Disk is the honest answer to "what documents are there", because disk is what
 * every stage reads — the 409 gates count `.md` there and the skills read the
 * folder tree. The database still matters, so each row carries `inDb` and the
 * caller says which are missing rather than hiding the difference.
 */
export async function listDiskDocuments(
  project: string, feature?: string | null,
): Promise<{ documents: DiskDocument[]; projectInDb: boolean; notInDb: number }> {
  const q = new URLSearchParams({ project });
  if (feature) q.set("feature", feature);
  const res = await fetch(`${chatUrl()}/api/documents?${q}`, {
    headers: { accept: "application/json", ...chatAuth() },
  });
  const text = await res.text();
  const parsed = text ? JSON.parse(text) : {};
  if (!res.ok) throw new ApiError(res.status, parsed?.message ?? parsed?.error ?? res.statusText);
  return {
    documents: [...(parsed.documents?.project ?? []), ...(parsed.documents?.feature ?? [])],
    projectInDb: parsed.db?.projectInDb ?? true,
    notInDb: parsed.db?.notInDb ?? 0,
  };
}
