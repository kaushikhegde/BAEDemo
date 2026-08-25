import { extname } from "node:path";
import { UPLOADS_CONTAINER } from "../../shared/config.js";
import { newJobId } from "../../shared/ids.js";
import { createJob } from "../../shared/jobs.js";
import { mintUploadSas } from "../../shared/sas.js";
import { log } from "../../shared/logger.js";
import type { Ctx } from "../mcp.js";

export const SUPPORTED_EXTENSIONS = [".pdf", ".docx", ".txt", ".md"] as const;

/** Azure caps a single Put Blob at 5000 MiB, and a request that large is fragile
 *  regardless. scripts/upload.mjs stages blocks above this. */
export const MAX_SINGLE_PUT_BYTES = 67_108_864; // 64 MiB

export interface CreateUploadUrlArgs {
  filename: string; sizeBytes: number; contentType?: string; sha256?: string;
}

/** Every refusal that applies to a blob regardless of HOW its bytes arrive —
 *  a minted SAS the caller PUTs to, or `upload_file` streaming server-side.
 *  Shared rather than restated, because a check only one of the two entry
 *  points makes is a check the other one is missing. Returns the validated
 *  extension so a caller need not re-derive it. */
export const assertUploadable = (
  filename: string, sizeBytes: number, maxUploadBytes: number,
): string => {
  // The filename becomes a blob path segment. A separator or a climb would let a
  // caller write outside its own jobId prefix, which is the only thing keeping
  // one job's bytes away from another's.
  if (/[/\\]/.test(filename) || filename.includes("..") || filename.startsWith(".")) {
    throw new Error(`filename must be a plain name with no path separators: ${filename}`);
  }
  // Beside the other refusals, before newJobId/mintUploadSas/createJob run:
  // the logger's own field cap (MAX_FIELD_CHARS, shared/logger.ts) is 512
  // chars, and log.info("upload.url_minted", …) below logs `filename`
  // verbatim. Left unchecked, an over-long name throws from INSIDE that log
  // call, after the job row is already created and the SAS already minted —
  // an orphan row and a stack trace that names the logger, not the filename.
  if (filename.length > 512) {
    throw new Error(`filename is too long: ${filename.length} chars, max 512`);
  }
  const ext = extname(filename).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.includes(ext as any)) {
    throw new Error(`unsupported extension ${ext || "(none)"}; expected one of ${SUPPORTED_EXTENSIONS.join(", ")}`);
  }
  if (sizeBytes > maxUploadBytes) {
    throw new Error(`file too large: ${sizeBytes} bytes exceeds the ${maxUploadBytes} byte ceiling`);
  }
  return ext;
};

export const createUploadUrl = async (ctx: Ctx, args: CreateUploadUrlArgs) => {
  const { filename, sizeBytes } = args;
  const ext = assertUploadable(filename, sizeBytes, ctx.cfg.maxUploadBytes);

  const jobId = newJobId();
  const blobPath = `${jobId}/${filename}`;
  const { url, expiresAt } = mintUploadSas(ctx.storage, ctx.cfg, UPLOADS_CONTAINER, blobPath);

  await createJob(ctx.storage, {
    jobId, state: "awaiting_upload", phase: null,
    pipelineId: "extract-chunks", params: "{}",
    blobPath, filename, sizeBytes,
    sha256: args.sha256 ?? null,
    progressDone: 0, progressTotal: 0, attempts: 0, workerId: null,
    createdAt: new Date().toISOString(), startedAt: null, finishedAt: null, error: null,
  });

  // The URL carries a signature; it is deliberately NOT logged.
  log.info("upload.url_minted", { jobId, filename, sizeBytes, ext });

  return {
    jobId, uploadUrl: url, blobPath,
    container: UPLOADS_CONTAINER, expiresAt,
    maxSinglePutBytes: MAX_SINGLE_PUT_BYTES,
  };
};
