import { readFile, stat } from "node:fs/promises";
import { userError, serviceError, authError } from "../../shared/errors.js";
import { basename, isAbsolute, resolve } from "node:path";
import type { OrchCtx } from "../orchestrator.js";
import { getStorage } from "../../shared/storage.js";
import { ensureWorkspaceContainer, syncUp } from "../sync.js";
import { log } from "../../shared/logger.js";

/** The four discovery folders `routeFile()` recognises on the chatbot side.
 *  Supplying one is what avoids `409 ambiguous_kind` for a .docx whose name
 *  matches neither the SOP nor the transcript pattern. Arrives at the route as
 *  the form field `hint`, NOT `kind` — the mapping happens once, here. */
export type DocKind = "sop" | "transcripts" | "notes" | "ui";

export interface AttachArgs {
  project: string; feature?: string; path: string; kind?: DocKind;
}

export interface AttachResult {
  project: string;
  feature: string | null;
  filename: string;
  storedPath: string | null;
  subfolder: string | null;
  converted: boolean;
  db: unknown;
  dbError: string | null;
  synced: { pushed: number; skipped: number; bytes: number } | { error: string };
}

export interface PostArgs {
  project: string; feature?: string; kind?: DocKind;
  filename: string; bytes: Buffer;
}

/**
 * POSTs one document to the chatbot's multipart upload route and returns its
 * parsed response.
 *
 * Extracted so `attach_document` (bytes read from the caller's disk) and
 * `ingest_document` (markdown fetched back from Azure) reach the chatbot by
 * exactly one path. Two copies of this would be two places for the `hint`
 * mapping, the 409 translation and the project-vs-feature route choice to
 * drift — and the chatbot is the ONLY thing permitted to write a document row,
 * so this is the seam that rule lives on.
 */
export const postDocument = async (ctx: OrchCtx, args: PostArgs): Promise<any> => {
  const form = new FormData();
  form.set("file", new Blob([new Uint8Array(args.bytes)]), args.filename);
  form.set("project", args.project);
  if (args.feature) form.set("feature", args.feature);
  // The route reads `hint`, not `kind`. Mapped once, here.
  if (args.kind) form.set("hint", args.kind);

  const route = args.feature ? "/api/upload" : "/api/upload/project";
  const url = `${ctx.cfg.chatbotUrl.replace(/\/+$/, "")}${route}`;
  const headers: Record<string, string> = { accept: "application/json" };
  if (ctx.cfg.orchToken) headers.authorization = `Bearer ${ctx.cfg.orchToken}`;

  let res: Response;
  try {
    res = await fetch(url, { method: "POST", headers, body: form });
  } catch (e: any) {
    throw serviceError("service_unavailable", e, { context: { service: "chatbot", path: "/api/upload" } });
  }
  const text = await res.text();
  let body: any;
  try { body = text ? JSON.parse(text) : undefined; } catch { body = undefined; }

  if (res.status === 401) throw authError("chatbot refused the credential for an upload", { service: "chatbot" });
  if (res.status === 409 && body?.error === "ambiguous_kind") {
    throw userError("ambiguous_kind",
      `${args.filename} matches neither the SOP nor the transcript ` +
      `pattern. Pass kind: sop | transcripts | notes | ui.`);
  }
  if (!res.ok) {
    // An upload may have half-landed, so this one does NOT promise that
    // nothing changed.
    if (body?.message) throw userError(String(body.error ?? `http_${res.status}`), String(body.message));
    throw serviceError(`http_${res.status}`, text.slice(0, 400), {
      nothingChanged: false, context: { service: "chatbot", path: "/api/upload", status: res.status },
    });
  }
  return body ?? {};
};

/**
 * Uploads a LOCAL file into a Scyne project (or feature) via the chatbot's
 * multipart routes, then pushes the resulting workspace tree to blob so the
 * durable copy matches disk. A sync failure is reported, never thrown — the
 * file and its database row are real either way.
 *
 * Holds the whole file in memory, so it suits a note or a transcript and not a
 * multi-gigabyte PDF. `ingest_document` is the one for those: same destination,
 * but the bytes go disk → Azure → worker and only the markdown comes back.
 */
export const attachDocument = async (ctx: OrchCtx, args: AttachArgs): Promise<AttachResult> => {
  const abs = isAbsolute(args.path) ? args.path : resolve(process.cwd(), args.path);

  // Named refusal before the network call: "ENOENT" from inside a multipart
  // post is far harder to act on than the path that was not there.
  const st = await stat(abs).catch(() => null);
  // `args.path` rather than `abs`: the caller typed the first and can act on
  // it, while the second is a path on whichever machine serves this plane.
  if (!st || !st.isFile()) throw userError("no_such_file", `no such file: ${args.path}`);

  // Refused rather than ignored: /api/upload/project has no router at all —
  // a project document always lands in `documents/` — so accepting a `kind`
  // there would teach a caller that it did something.
  if (args.kind && !args.feature) {
    throw userError("kind_not_applicable",
      "kind applies to a FEATURE document only; a project document always lands in documents/");
  }

  const body = await postDocument(ctx, {
    project: args.project, feature: args.feature, kind: args.kind,
    filename: basename(abs), bytes: await readFile(abs),
  });

  // Push the converted markdown to blob so the durable copy matches disk.
  let synced: AttachResult["synced"];
  try {
    const storage = getStorage(ctx.cfg);
    await ensureWorkspaceContainer(storage);
    synced = await syncUp(storage, ctx.cfg.workspaceRoot, args.project);
  } catch (e: any) {
    synced = { error: String(e?.message ?? e).slice(0, 400) };
  }

  log.info("workspace.document_attached", {
    project: args.project, feature: args.feature ?? "",
    // The NAME, never the contents.
    filename: String(body?.filename ?? ""),
  });

  return {
    project: args.project,
    feature: args.feature ?? null,
    // The name it BECAME: the route converts on arrival, so a .docx arrives as .md.
    filename: body?.filename ?? basename(abs),
    // Relative to the FEATURE root for a feature document
    // (`requirements/Transcripts/x.md`), to the PROJECT root for a project one
    // (`documents/x.md`).
    storedPath: body?.path ?? null,
    // Which discovery folder it was routed into.
    subfolder: body?.subfolder ?? null,
    converted: Boolean(body?.converted),
    db: body?.db ?? null,
    dbError: body?.db?.state === "failed" ? (body.db.reason ?? "not recorded in the database") : null,
    synced,
  };
};
