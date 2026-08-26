import { readFile, stat } from "node:fs/promises";
import { basename, isAbsolute } from "node:path";
import { chatFetch, type WsCtx } from "../chatbot.js";
import type { OrchCtx } from "../orchestrator.js";
import { getStorage } from "../../shared/storage.js";
import { ensureWorkspaceContainer, syncUp } from "../sync.js";
import { log } from "../../shared/logger.js";
import { userError, serviceError } from "../../shared/errors.js";

/**
 * Removing and replacing a document — the two halves of the lifecycle the
 * plugin could not do, and which both the Docs tab and `scyne doc` have.
 *
 * Both go through the chatbot, which owns the ordering that makes them
 * correct: disk first (it is what every stage reads), the database row
 * reconciled alongside it, and — critically — the ARCHIVED ORIGINAL in
 * `original-files/` taken too. `convert-to-md.mjs` MOVES a source rather than
 * deleting it, so removing only the markdown leaves the thing that produced
 * it, and the next conversion pass puts the document straight back.
 */

export interface DocRef { project: string; feature?: string; path: string }

const q = (args: DocRef): string => {
  const p = new URLSearchParams({ project: args.project, path: args.path });
  if (args.feature) p.set("feature", args.feature);
  return p.toString();
};

/** DELETE reads its target from the BODY, GET from the query string. Not a
 *  symmetry worth assuming: sending a delete the way the read works returns
 *  `400 missing_target`, which reads like the caller forgot an argument rather
 *  than like the argument went to the wrong place. Found by a live call. */
const body = (args: DocRef): Record<string, string> => ({
  project: args.project,
  path: args.path,
  ...(args.feature ? { feature: args.feature } : {}),
});

/**
 * Deletes one document, its archived original, and its database row.
 *
 * NOT confirmed here, deliberately: this is a tool a model can call, and the
 * confirmation belongs with the PERSON. Both the chatbot and the `scyne`
 * session confirm before deleting for exactly that reason — a sentence typed
 * at a prompt is not consent to change what every later stage reads. The tool
 * description says so; the caller is expected to ask first.
 */
export const deleteDocument = async (ctx: OrchCtx & WsCtx, args: DocRef) => {
  const r = await chatFetch<any>(ctx.cfg, "DELETE", "/api/documents", body(args));
  // The durable copy must not keep a document the tree no longer has. syncUp
  // never deletes a blob (an accidental `rm -rf projects/` must not compound
  // itself), so this is reported rather than silently reconciled.
  log.info("workspace.document_deleted", {
    project: args.project, feature: args.feature ?? "", path: args.path,
  });
  return {
    ...r,
    note: "Removed from disk and the database. The copy already pushed to Azure Blob " +
          "is retained deliberately — syncUp never deletes, so an accidental local " +
          "delete cannot destroy the durable copy too.",
  };
};

/**
 * Replaces one document with a new local file.
 *
 * The route removes the old markdown AND its archived original FIRST, so the
 * replacement keeps its own name instead of landing beside it as
 * `handling (1).md` — which is what makes this different from a delete
 * followed by an upload.
 */
export const replaceDocument = async (
  ctx: OrchCtx & WsCtx, args: DocRef & { file: string },
) => {
  if (!isAbsolute(args.file)) throw userError("path_not_absolute", `file must be an absolute path, got ${args.file}`);
  const st = await stat(args.file).catch(() => null);
  if (!st || !st.isFile()) throw userError("no_such_file", `no such file: ${args.file}`);

  const form = new FormData();
  form.set("file", new Blob([new Uint8Array(await readFile(args.file))]), basename(args.file));
  form.set("project", args.project);
  form.set("path", args.path);
  if (args.feature) form.set("feature", args.feature);

  const url = `${ctx.cfg.chatbotUrl.replace(/\/+$/, "")}/api/documents`;
  const headers: Record<string, string> = { accept: "application/json" };
  if (ctx.cfg.orchToken) headers.authorization = `Bearer ${ctx.cfg.orchToken}`;

  const res = await fetch(url, { method: "PUT", headers, body: form })
    .catch((e: any) => { throw serviceError("service_unavailable", e, { context: { service: "chatbot", path: "/api/documents" } }); });
  const text = await res.text();
  let body: any;
  try { body = text ? JSON.parse(text) : undefined; } catch { body = undefined; }
    if (!res.ok) {
    if (body?.message) throw userError(String(body.error ?? `http_${res.status}`), String(body.message));
    throw serviceError(`http_${res.status}`, text.slice(0, 400), {
      nothingChanged: false, context: { service: "chatbot", path: "/api/documents", status: res.status },
    });
  }

  let synced: unknown;
  try {
    const storage = getStorage(ctx.cfg);
    await ensureWorkspaceContainer(storage);
    synced = await syncUp(storage, ctx.cfg.workspaceRoot, args.project);
  } catch (e: any) {
    synced = { error: String(e?.message ?? e).slice(0, 400) };
  }
  return { ...body, synced };
};

/** One document's text, for reading a SHORT document in full. Refuses a binary
 *  file and anything outside `documents/`. For anything large this is the wrong
 *  tool — upload it and use search_chunks, which is what the file plane is for. */
export const readDocument = async (ctx: WsCtx, args: DocRef) =>
  chatFetch<any>(ctx.cfg, "GET", `/api/documents/content?${q(args)}`);

/**
 * Whether a project's documents have finished extracting.
 *
 * Extraction is NOT a step a person runs. All three upload routes start it the
 * moment a document lands — detached and fire-and-forget, because a 300 MB PDF
 * is not something to hold an HTTP request open for — so by the time an upload
 * returns, the work is already under way. What a caller needs is not a verb to
 * start it but a way to ask whether it is done, which is this.
 *
 * It matters because `capabilities` hard-requires every document to be ready
 * and refuses with `documents_not_ready` otherwise. That refusal reads like a
 * missing step and is usually just impatience: the fix is to wait, and only to
 * re-run `extract` when a document arrived by some route other than an upload
 * (a file copied into the tree, `npm run convert`) or a spawn genuinely failed.
 * `no_documents` is the separate refusal that really does mean "upload
 * something".
 */
export const extractStatus = async (ctx: WsCtx, args: { project: string }) => {
  const raw = await chatFetch<any>(ctx.cfg, "GET", `/api/extract-status/${encodeURIComponent(args.project)}`);

  // `extractPath` is dropped. It is an ABSOLUTE path on whichever machine
  // serves this plane — the route answers
  // `/Users/<someone>/…/projects/<p>/solutions/Extracts/<hash>.extract.json` —
  // and an end user can neither open it nor act on it. Same class as the
  // `npm run …` advice removed from every thrown message; this one survived
  // because it is a RESULT field rather than an error string.
  //
  // `docId`, `state` and `reason` are what a caller actually needs: which
  // document, whether it is ready, and why not.
  const documents = (raw?.documents ?? []).map((d: any) => ({
    docId: d.docId, scope: d.scope ?? null, state: d.state,
    ...(d.reason ? { reason: String(d.reason) } : {}),
  }));

  return {
    ready: raw?.ready ?? 0, missing: raw?.missing ?? 0,
    failed: raw?.failed ?? 0, extracting: raw?.extracting ?? 0,
    documents,
  };
};
