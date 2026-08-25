import { readFile, stat } from "node:fs/promises";
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

/**
 * Uploads a LOCAL file into a Scyne project (or feature) via the chatbot's
 * multipart routes, then pushes the resulting workspace tree to blob so the
 * durable copy matches disk. A sync failure is reported, never thrown — the
 * file and its database row are real either way.
 */
export const attachDocument = async (ctx: OrchCtx, args: AttachArgs): Promise<AttachResult> => {
  const abs = isAbsolute(args.path) ? args.path : resolve(process.cwd(), args.path);

  // Named refusal before the network call: "ENOENT" from inside a multipart
  // post is far harder to act on than the path that was not there.
  const st = await stat(abs).catch(() => null);
  if (!st || !st.isFile()) throw new Error(`no such file: ${abs}`);

  // Refused rather than ignored: /api/upload/project has no router at all —
  // a project document always lands in `documents/` — so accepting a `kind`
  // there would teach a caller that it did something.
  if (args.kind && !args.feature) {
    throw new Error(
      "kind applies to a FEATURE document only; a project document always lands in documents/");
  }

  const bytes = await readFile(abs);
  const form = new FormData();
  form.set("file", new Blob([new Uint8Array(bytes)]), basename(abs));
  form.set("project", args.project);
  if (args.feature) form.set("feature", args.feature);
  // The route reads `hint`, not `kind`.
  if (args.kind) form.set("hint", args.kind);

  const path = args.feature ? "/api/upload" : "/api/upload/project";
  const url = `${ctx.cfg.chatbotUrl.replace(/\/+$/, "")}${path}`;
  const headers: Record<string, string> = { accept: "application/json" };
  if (ctx.cfg.orchToken) headers.authorization = `Bearer ${ctx.cfg.orchToken}`;

  let res: Response;
  try {
    res = await fetch(url, { method: "POST", headers, body: form });
  } catch (e: any) {
    throw new Error(`cannot reach the Scyne chatbot at ${url}: ${e?.message ?? e}`);
  }
  const text = await res.text();
  let body: any;
  try { body = text ? JSON.parse(text) : undefined; } catch { body = undefined; }

  if (res.status === 401) throw new Error("not_authenticated: set SCYNE_ORCH_TOKEN");
  if (res.status === 409 && body?.error === "ambiguous_kind") {
    throw new Error(
      `ambiguous_kind: ${basename(abs)} matches neither the SOP nor the transcript ` +
      `pattern. Pass kind: sop | transcripts | notes | ui.`);
  }
  if (!res.ok) {
    throw new Error(`${body?.error ?? `http_${res.status}`}: ${body?.message ?? text.slice(0, 300)}`);
  }

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
