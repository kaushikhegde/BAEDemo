import { basename, extname, isAbsolute } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { OrchCtx } from "../orchestrator.js";
import { getObjectBuffer, getStorage, isNotFound } from "../../shared/storage.js";
import { ARTIFACTS } from "../../shared/config.js";
import { uploadFile } from "../../orchestrator/tools/upload-file.js";
import type { Ctx as FileCtx } from "../../orchestrator/mcp.js";
import { getJob } from "../../shared/jobs.js";
import { readArtifactJson } from "../../orchestrator/artifacts.js";
import type { JobResult } from "../../worker/artifacts.js";
import { log } from "../../shared/logger.js";
import { postDocument, type DocKind } from "./attach-document.js";
import { startStage } from "./start-stage.js";
import { resolveProject } from "../doc-store.js";
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
  /** Where it is stored, relative to its own level. There is no disk path to
   *  report any more — the bytes and the row live in the store together. */
  filename: string; storedPath: string; subfolder: string | null;
  version: number | null;
  /** false when identical content already sat at that path: a real answer the
   *  store gives, not a failure. */
  changed: boolean;
  /**
   * Extraction starts here, on arrival — a document is not usable until it is
   * extracted. Reported rather than thrown: the document is stored either way,
   * and `extract_status` is where the outcome is read.
   */
  extraction: { started: boolean; issueId: string | null; error: string | null };
}

/**
 * The large-file door into a Scyne project.
 *
 * `attach_document` reads the whole file into this process's memory and posts
 * it to the chatbot, which is fine for a 200 KB note and hopeless for a 2 GB
 * PDF — the exact ceiling this plugin exists to remove. This does the same job
 * without ever holding the document: the bytes are streamed to S3 as an 8 MiB
 * multipart upload, a worker converts them to markdown on ITS disk, and only the
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
 * - **The original is archived in S3, not in `original-files/`.** The object
 *   under `<uploads bucket>/<jobId>/` IS the archive, and it is the only copy
 *   that was never size-limited. `delete_job` is what disposes of it.
 */

/**
 * Kick off extraction for the project this document just landed in.
 *
 * It starts the `extract` WORKFLOW rather than running the extractor, and the
 * difference is the whole point. `scripts/extract-documents.mjs` enumerates
 * its inputs by walking `projects/<p>/`, which holds nothing on a machine
 * where documents live in the store — the engine is what materialises that
 * tree per step and harvests the extracts back out of it. Running the script
 * directly finds no documents and exits 0: a silent no-op wearing the costume
 * of a successful run.
 *
 * `extract` is project-level and idempotent — extracts are keyed by their
 * source document's content hash — so one run after each upload converges, and
 * a second run over an already-extracted document does nothing.
 *
 * Never fatal. The document and its row are real whatever happens here, and
 * `extract_status` reports what is still missing, so a failure to START is
 * reported in the result rather than thrown over an ingest that succeeded.
 */
const startExtraction = async (
  ctx: OrchCtx, project: string,
): Promise<{ started: boolean; issueId: string | null; error: string | null }> => {
  try {
    // The CANONICAL name, not the string the caller typed. `startStage` passes
    // it as the workflow's `project` param, and the engine resolves that to
    // `issues.project_id` by matching `projects.name` EXACTLY — so a caller who
    // typed a slug would get an issue with no project, and therefore a run
    // against an empty tree rather than a failure naming the cause.
    const { name } = await resolveProject(ctx, project);
    const started = await startStage(ctx, { workflow: "extract", project: name });
    return { started: true, issueId: started.issueId, error: null };
  } catch (e: any) {
    const message = e?.message ?? String(e);
    log.warn("workspace.extraction_not_started", { project, error: message });
    return { started: false, issueId: null, error: message };
  }
};

export const ingestDocument = async (
  ctx: OrchCtx, args: IngestArgs,
): Promise<IngestResult> => {
  const { path } = args;
  if (!isAbsolute(path)) throw userError("path_not_absolute", `path must be absolute, got ${path}`);
  if (args.kind && !args.feature) {
    throw userError("kind_not_applicable",
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
  // name, so it is reported rather than left in an object nobody opens.
  const result = await readArtifactJson<JobResult>(storage, up.jobId, "result.json")
    .catch(() => null);

  // The one download in this flow, and it is the MARKDOWN, not the document.
  const md = await getObjectBuffer(
    storage, storage.bucket(ARTIFACTS), `${up.jobId}/document.md`,
  ).catch((e: any) => {
    if (isNotFound(e)) {
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

  // `preConverted`: the worker already rendered this to markdown out in the
  // pool, so converting again would stamp a second engine header on top and
  // lose the record of which engine actually read the document.
  const posted = await postDocument(ctx, {
    project: args.project, feature: args.feature, kind: args.kind,
    filename: mdName, bytes: md, preConverted: true,
  });

  // `syncUp` used to run here, pushing the whole `projects/` tree from local
  // disk into a second bucket. It is gone with the disk write it existed to
  // mirror: the orchestrator's store now holds the bytes and the row together,
  // so a third copy is one more thing to fall out of step — and reading the
  // tree off local disk never worked anywhere the plugin did not share a
  // filesystem with it.
  //
  // What went with it, and should not have, is extraction. A document is not
  // USABLE until it has been extracted — `capabilities` hard-requires every
  // document to be ready and refuses `documents_not_ready` otherwise — and the
  // three chatbot upload routes have always started it on arrival for exactly
  // that reason. This door did not, so nine documents ingested here left the
  // project permanently unable to run its first stage, with no failure
  // anywhere to explain why.
  const extraction = await startExtraction(ctx, args.project);

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
    filename: posted.filename,
    storedPath: posted.storedPath,
    subfolder: posted.subfolder,
    version: posted.version,
    changed: posted.changed,
    extraction,
  };
};
