import { basename, extname, isAbsolute } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { OrchCtx } from "../orchestrator.js";
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
export const ingestDocument = async (
  ctx: OrchCtx, args: IngestArgs,
): Promise<IngestResult> => {
  const { path } = args;
  if (!isAbsolute(path)) throw new Error(`path must be absolute, got ${path}`);
  if (args.kind && !args.feature) {
    throw new Error(
      "kind applies to a FEATURE document only; a project document always lands in documents/");
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
      throw new Error(
        `job ${up.jobId} is still ${job.state} after ${Math.round((args.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000)}s ` +
        `(phase: ${job.phase ?? "?"}). It is still running — poll job_status and ingest again when it succeeds.`);
    }
    await sleep(POLL_MS);
    job = await getJob(storage, up.jobId);
  }
  if (!job) throw new Error(`job ${up.jobId} vanished while it was being processed`);
  if (job.state !== "succeeded") {
    // The worker's own reason, verbatim. A scanned PDF with no text layer and
    // a corrupt archive fail differently and need different fixes.
    throw new Error(`job ${up.jobId} ${job.state}: ${job.error ?? "no reason recorded"}`);
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
        throw new Error(
          `job ${up.jobId} produced no document.md. It was processed by a worker ` +
          `predating markdown rendering — re-upload it to convert.`);
      }
      throw e;
    });

  // Named for the SOURCE, with a .md extension: `Handling Policy.pdf` files as
  // `Handling Policy.md`, which is what the same document uploaded through the
  // chatbot would have been called. Anything else would make the same document
  // appear under two names depending on which door it came in by.
  const stem = basename(up.filename, extname(up.filename));
  const mdName = `${stem}.md`;

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
