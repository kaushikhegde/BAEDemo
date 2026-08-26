import { stat } from "node:fs/promises";
import { basename, extname, isAbsolute } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { OrchCtx } from "../orchestrator.js";
import { chatFetch } from "../chatbot.js";
import { getStorage } from "../../shared/storage.js";
import { ensureWorkspaceContainer, syncUp } from "../sync.js";
import { ARTIFACTS_CONTAINER } from "../../shared/config.js";
import { uploadFile } from "../../orchestrator/tools/upload-file.js";
import type { Ctx as FileCtx } from "../../orchestrator/mcp.js";
import { getJob } from "../../shared/jobs.js";
import { readArtifactJson } from "../../orchestrator/artifacts.js";
import type { JobResult } from "../../worker/artifacts.js";
import { log } from "../../shared/logger.js";
import { postDocument, type DocKind } from "./attach-document.js";
import { userError, serviceError } from "../../shared/errors.js";

/** Long enough for a large PDF on a busy worker pool, short enough that a
 *  wedged job is reported rather than waited on forever. A caller who hits it
 *  has not lost anything: the job is still running and `job_status` still
 *  answers, so the ingest can be retried once it finishes. */
const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;
const POLL_MS = 2_000;

export interface IngestArgs {
  project: string; feature?: string; path: string; kind?: DocKind;
  timeoutMs?: number;
}

export interface IngestResult {
  project: string; feature: string | null;
  jobId: string; sourceFilename: string; bytes: number; sha256: string;
  converter: string | null; pages: number | null; markdownChars: number | null;
  filename: string; storedPath: string | null; subfolder: string | null;
  db: unknown; dbError: string | null;
  synced: { pushed: number; skipped: number; bytes: number } | { error: string };
}

/**
 * The large-file door into a Scyne project.
 *
 * `attach_document` reads the whole file into this process's memory and posts
 * it to the chatbot, which is fine for a 200 KB note and hopeless for a 2 GB
 * PDF — the exact ceiling this plugin exists to remove. This does the same job
 * without ever holding the document: the bytes are streamed to Azure in 8 MiB
 * blocks, a worker converts them to markdown on ITS disk, and only the
 * MARKDOWN — orders of magnitude smaller than the source, and the only part
 * any Scyne stage reads — travels on to the chatbot to be filed and recorded.
 *
 * Three properties worth stating, because each was a choice:
 *
 * - **The document's text never enters a tool response.** What comes back is
 *   counts, a path and an engine name. A caller learns the file is in place
 *   without learning what it says; `search_chunks` is how you read it.
 * - **The chatbot still writes the database row.** It is the only thing that
 *   may (CLAUDE.md is explicit), because only the server knows the name a file
 *   converts to and where `routeFile()` put it. Filing the markdown ourselves
 *   and asking for a row afterwards is how the CLI ended up writing rows that
 *   named files the converter had already renamed.
 * - **The original is archived in Azure, not in `original-files/`.** The blob
 *   under `uploads/<jobId>/` IS the archive, and it is the only copy that was
 *   never size-limited. `delete_job` is what disposes of it.
 */
/**
 * What the CHATBOT will accept, asked rather than assumed.
 *
 * This leg posts the converted markdown to `/api/upload`, whose multer cap is
 * 100 MB, while the file plane above accepts 5 GiB — three orders of magnitude
 * apart, with nothing comparing them. A 300 MB document was therefore streamed
 * to Azure, converted, downloaded and buffered before anything refused it, and
 * the refusal arrived as an unexplained 500.
 *
 * Read from `GET /api/limits`, which returns the same constant multer is
 * configured with, so there is no second copy of the number here to drift.
 * A failure to read it is NOT fatal: the cap is the chatbot's to enforce and it
 * answers a proper 413 now. This check exists to save the round trip, not to be
 * the authority.
 */
let cachedLimit: number | null = null;
const uploadLimit = async (ctx: OrchCtx): Promise<number | null> => {
  if (cachedLimit !== null) return cachedLimit;
  try {
    const r = await chatFetch<{ uploadMaxBytes?: number }>(ctx.cfg, "GET", "/api/limits");
    if (typeof r?.uploadMaxBytes === "number" && r.uploadMaxBytes > 0) cachedLimit = r.uploadMaxBytes;
  } catch { /* an older chatbot has no /api/limits — proceed and let it refuse */ }
  return cachedLimit;
};

const mb = (n: number) => `${Math.round(n / 1024 / 1024)} MB`;

/**
 * Extensions whose "conversion" is the identity, so the markdown that comes
 * back is the size of the source.
 *
 * Only these can be pre-checked. A 2 GB PDF may convert to 4 MB of markdown and
 * is exactly the case this plugin exists for — refusing it on its SOURCE size
 * would break the headline feature to fix a different bug. Everything else is
 * checked after conversion, when the real size is known.
 */
const PASSTHROUGH = new Set([".md", ".markdown", ".txt", ".text"]);

export const ingestDocument = async (
  ctx: OrchCtx, args: IngestArgs,
): Promise<IngestResult> => {
  const { path } = args;
  if (!isAbsolute(path)) throw userError("path_not_absolute", `path must be absolute, got ${path}`);
  if (args.kind && !args.feature) {
    throw userError("kind_not_applicable",
      "kind applies to a FEATURE document only; a project document always lands in documents/");
  }

  // Refused BEFORE the upload, for the one case where the converted size is
  // predictable: a markdown or text source converts to itself.
  if (PASSTHROUGH.has(extname(path).toLowerCase())) {
    const limit = await uploadLimit(ctx);
    const size = await stat(path).then((st) => st.size).catch(() => null);
    if (limit !== null && size !== null && size > limit) {
      throw userError("file_too_large",
        `${basename(path)} is ${mb(size)}; a document may be at most ${mb(limit)}. ` +
        `Nothing was uploaded. A markdown source converts to itself, so this would ` +
        `have been refused after being streamed to Azure and converted.`);
    }
  }

  const storage = getStorage(ctx.cfg);
  // Typed as the FILE plane's own Ctx rather than cast. The two planes have
  // separate context types and this is the one place they meet; a cast here
  // would suppress exactly the mismatch worth being told about if either side
  // grows a field.
  const fileCtx: FileCtx = { cfg: ctx.cfg, storage };

  // Streams the bytes and queues the job in one call. Refuses a path that is
  // not there, is not a regular file, is empty, or carries an extension no
  // engine can read — all before anything is created.
  const up = await uploadFile(fileCtx, { path, start: true });

  const deadline = Date.now() + (args.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  let job = await getJob(storage, up.jobId);
  while (job && (job.state === "queued" || job.state === "running")) {
    if (Date.now() > deadline) {
      // Actionable: the work is still going, and waiting is the answer.
      throw userError("still_processing",
        `job ${up.jobId} is still ${job.state} after ${Math.round((args.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000)}s ` +
        `(phase: ${job.phase ?? "?"}). It is still running — poll job_status and ingest again when it succeeds.`);
    }
    await sleep(POLL_MS);
    job = await getJob(storage, up.jobId);
  }
  if (!job) throw serviceError("job_lost", `job ${up.jobId} vanished while it was being processed`, { nothingChanged: false });
  if (job.state !== "succeeded") {
    // The worker's own reason, verbatim. A scanned PDF with no text layer and
    // a corrupt archive fail differently and need different fixes.
    throw serviceError("processing_failed", `job ${up.jobId} ${job.state}: ${job.error ?? "no reason recorded"}`, { nothingChanged: false });
  }

  // Which engine read the document, and how many pages it had. Recorded in
  // result.json rather than on the job row: the row is a state machine the
  // orchestrator writes, the result is what the worker computed. A caller
  // deciding whether a capability map's input was any good needs the engine
  // name, so it is reported rather than left in a blob nobody opens.
  const result = await readArtifactJson<JobResult>(storage, up.jobId, "result.json")
    .catch(() => null);

  // The one download in this flow, and it is the MARKDOWN, not the document.
  const md = await storage.blob
    .getContainerClient(ARTIFACTS_CONTAINER)
    .getBlockBlobClient(`${up.jobId}/document.md`)
    .downloadToBuffer()
    .catch((e: any) => {
      if (e?.statusCode === 404) {
        throw userError("no_markdown",
          `that document produced no markdown. It was processed before markdown ` +
          `rendering existed — upload it again to convert it.`);
      }
      throw e;
    });

  // Named for the SOURCE, with a .md extension: `Handling Policy.pdf` files as
  // `Handling Policy.md`, which is what the same document uploaded through the
  // chatbot would have been called. Anything else would make the same document
  // appear under two names depending on which door it came in by.
  const stem = basename(up.filename, extname(up.filename));
  const mdName = `${stem}.md`;

  // The size is only KNOWN here, for anything that genuinely converted. Checked
  // before `postDocument`, which turns this buffer into a Blob — a second full
  // copy in memory — and posts it to a route that would refuse it anyway. The
  // job and its blob survive: `delete_job` disposes of them, and the caller may
  // still want the extracted text by other means.
  const limit = await uploadLimit(ctx);
  if (limit !== null && md.length > limit) {
    throw userError("file_too_large",
      `${basename(up.filename)} converted to ${mb(md.length)} of markdown; a document ` +
      `may be at most ${mb(limit)}. It was NOT filed into the project. The upload is ` +
      `still in Azure as job ${up.jobId} — delete_job disposes of it.`);
  }

  const posted = await postDocument(ctx, {
    project: args.project, feature: args.feature, kind: args.kind,
    filename: mdName, bytes: md,
  });

  let synced: IngestResult["synced"];
  try {
    await ensureWorkspaceContainer(storage);
    synced = await syncUp(storage, ctx.cfg.workspaceRoot, args.project);
  } catch (e: any) {
    // Never fatal, for the same reason attach_document treats it that way: the
    // file and its row are real whether or not the durable copy caught up.
    synced = { error: String(e?.message ?? e).slice(0, 400) };
  }

  log.info("workspace.document_ingested", {
    project: args.project, feature: args.feature ?? "",
    jobId: up.jobId, filename: mdName, bytes: up.bytes,
    converter: String(result?.converter ?? ""),
  });

  return {
    project: args.project, feature: args.feature ?? null,
    jobId: up.jobId, sourceFilename: up.filename, bytes: up.bytes, sha256: up.sha256,
    converter: result?.converter ?? null,
    pages: result?.pages ?? null,
    markdownChars: md.byteLength,
    filename: posted.filename ?? mdName,
    storedPath: posted.path ?? null,
    subfolder: posted.subfolder ?? null,
    db: posted.db ?? null,
    dbError: posted.db?.state === "failed"
      ? (posted.db.reason ?? "not recorded in the database") : null,
    synced,
  };
};
