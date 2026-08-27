import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { basename, isAbsolute } from "node:path";
import { createHash } from "node:crypto";
import { Transform } from "node:stream";
import { UPLOADS } from "../../shared/config.js";
import { newJobId } from "../../shared/ids.js";
import { createJob, updateJob, type JobState } from "../../shared/jobs.js";
import { uploadStream } from "../../shared/storage.js";
import { log } from "../../shared/logger.js";
import type { Ctx } from "../mcp.js";
import { assertUploadable } from "./create-upload-url.js";
import { startJob } from "./start-job.js";
import { userError, serviceError } from "../../shared/errors.js";

/** Only the formats worth labelling precisely. Anything absent here uploads
 *  with no explicit content type, which S3 stores as
 *  application/octet-stream — correct, and never load-bearing: every consumer
 *  routes on the FILENAME's extension, not on this header. */
const CONTENT_TYPES: Record<string, string> = {
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".html": "text/html",
  ".htm": "text/html",
  ".csv": "text/csv",
  ".rtf": "application/rtf",
  ".epub": "application/epub+zip",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".markdown": "text/markdown",
};

export interface UploadFileArgs {
  path: string;
  pipeline?: { id: string; params?: Record<string, number> };
  start?: boolean;
}

export interface UploadFileResult {
  jobId: string;
  state: JobState;
  filename: string;
  objectKey: string;
  bytes: number;
  sha256: string;
  started: boolean;
}

/** The whole upload in one call: read the file the caller named, stream it to
 *  S3 as a multipart upload, and queue it — no signed URL crossing the
 *  conversation and no shell step. Its bytes never enter a tool RESPONSE, which
 *  is the property that matters; they go disk → this process → S3, and what
 *  comes back is the same compact JSON every other tool returns.
 *
 *  `uploadStream` (shared/storage.ts) drives 8 MiB parts, four in flight, so
 *  memory is ~32 MiB whether the file is 8 MiB or 5 GiB — and a failed part
 *  retries alone rather than restarting the transfer, which is the real reason
 *  to prefer this door over the presigned single PUT.
 *
 *  It can only exist where the orchestrator and the file share a machine. In
 *  Compose the orchestrator's filesystem is the IMAGE's, so a host path is
 *  simply not there — hence `scripts/stack.sh up` running this process
 *  natively, and `ALLOW_LOCAL_PATH_UPLOAD` refusing the tool wherever that
 *  assumption does not hold. */
export const uploadFile = async (ctx: Ctx, args: UploadFileArgs): Promise<UploadFileResult> => {
  if (!ctx.cfg.allowLocalPathUpload) {
    throw userError("upload_file_disabled",
      "upload_file is not available here: this service does not read the caller's filesystem. " +
      "Use create_upload_url and PUT the bytes to the returned URL instead.");
  }

  const { path } = args;
  // A relative path would resolve against the ORCHESTRATOR's working
  // directory, which is not where the caller is standing and not somewhere
  // they can see. Refusing is the only answer that cannot silently upload the
  // wrong file.
  if (!isAbsolute(path)) {
    throw userError("path_not_absolute", `path must be absolute, got ${path}`);
  }

  let info;
  try {
    info = await stat(path);
  } catch (e: any) {
    if (e?.code === "ENOENT") throw userError("no_such_file", `no such file: ${path}`);
    if (e?.code === "EACCES") throw userError("permission_denied", `cannot read ${path}: permission denied`);
    throw userError("unreadable_file", `cannot read ${path}: ${e?.code ?? "unreadable"}`);
  }
  // stat() follows symlinks, so a link to a real document is fine and a link
  // to a directory or a device is caught here rather than hanging on a read.
  if (!info.isFile()) throw userError("not_a_file", `not a regular file: ${path}`);

  const filename = basename(path);
  const sizeBytes = info.size;
  const ext = assertUploadable(filename, sizeBytes, ctx.cfg.maxUploadBytes);
  if (sizeBytes === 0) throw userError("empty_file", `file is empty: ${path}`);

  const jobId = newJobId();
  const objectKey = `${jobId}/${filename}`;

  // The row exists BEFORE the bytes move, so a failure part-way through is a
  // job somebody can ask about rather than an orphaned object with no record.
  await createJob(ctx.storage, {
    jobId, state: "awaiting_upload", phase: null,
    pipelineId: args.pipeline?.id ?? "extract-chunks", params: "{}",
    objectKey, filename, sizeBytes,
    sha256: null,
    progressDone: 0, progressTotal: 0, attempts: 0, workerId: null,
    createdAt: new Date().toISOString(), startedAt: null, finishedAt: null, error: null,
  });

  const hash = createHash("sha256");
  let observed = 0;
  // Hashing INSIDE the upload stream, not in a second pass over the file: one
  // read of a 5 GiB document rather than two, and the digest describes the
  // exact bytes that were sent rather than the bytes that were on disk at some
  // earlier moment.
  const tee = new Transform({
    transform(chunk, _enc, cb) {
      hash.update(chunk);
      observed += chunk.length;
      cb(null, chunk);
    },
  });

  try {
    await uploadStream(
      ctx.storage, ctx.storage.bucket(UPLOADS), objectKey,
      createReadStream(path).pipe(tee),
      { contentType: CONTENT_TYPES[ext] },
    );
  } catch (e: any) {
    const why = String(e?.message ?? e).slice(0, 400);
    await updateJob(ctx.storage, jobId, { state: "failed", error: `upload_failed: ${why}` })
      .catch(() => { /* the throw below is the report that matters */ });
    throw serviceError("upload_failed", `upload failed after ${observed} of ${sizeBytes} bytes: ${why}`, { nothingChanged: false });
  }

  const sha256 = hash.digest("hex");
  // Recorded now that it is known, so the worker verifies the download against
  // the bytes this process actually sent — the same integrity check the
  // presigned path gets from a caller running `shasum`, without asking anyone
  // to run it.
  await updateJob(ctx.storage, jobId, { sha256 });

  log.info("upload.file_streamed", {
    jobId, filename, sizeBytes, ext, parts: Math.ceil(sizeBytes / (8 * 1024 * 1024)),
  });

  if (args.start === false) {
    return { jobId, state: "awaiting_upload", filename, objectKey, bytes: sizeBytes, sha256, started: false };
  }

  // startJob re-reads the object's committed length and compares it against the
  // declared size, so a truncated or racing write is caught by the same check
  // the presigned path relies on rather than by a second, parallel
  // implementation.
  const started = await startJob(ctx, { jobId, pipeline: args.pipeline });
  return { jobId, state: started.state, filename, objectKey, bytes: sizeBytes, sha256, started: true };
};
