import type { Storage } from "./storage.js";

export type JobState =
  | "awaiting_upload" | "queued" | "running" | "succeeded" | "failed" | "deleted";
export type JobPhase = "downloading" | "extracting" | "chunking" | "uploading" | "done";

export interface Job {
  jobId: string;
  state: JobState;
  phase: JobPhase | null;
  pipelineId: string;
  params: string;          // JSON text: Table Storage has no nested types
  blobPath: string;
  filename: string;
  sizeBytes: number;
  sha256: string | null;
  progressDone: number;
  progressTotal: number;
  attempts: number;
  workerId: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  /** Table Storage's optimistic-concurrency token. Always present on a `Job`
   *  read back by `getJob`; absent on one built by hand before `createJob`.
   *  `updateJob`'s `ifMatch` option uses it to turn a read-then-write race
   *  (two callers both observing the same state) into compare-and-swap —
   *  only the caller still holding the current etag can win the update. */
  etag?: string;
}

const PARTITION = "job";

/** sizeBytes crosses Int32 at 2 GiB and our ceiling is 5 GiB, so it is stored
 *  as a string. The client would otherwise widen it to a float and quietly
 *  lose precision on a large upload. */
const toEntity = (j: Partial<Job> & { jobId: string }) => {
  const e: Record<string, unknown> = { partitionKey: PARTITION, rowKey: j.jobId };
  for (const [k, v] of Object.entries(j)) {
    // "etag" is the table SDK's own optimistic-concurrency metadata, carried
    // on `Job` only so callers can read it back — never a column to write.
    if (k === "jobId" || k === "etag" || v === undefined) continue;
    e[k] = k === "sizeBytes" ? String(v) : v;
  }
  return e;
};

const fromEntity = (e: Record<string, any>): Job => ({
  jobId: e.rowKey,
  state: e.state, phase: e.phase ?? null,
  pipelineId: e.pipelineId, params: e.params,
  blobPath: e.blobPath, filename: e.filename,
  sizeBytes: Number(e.sizeBytes),
  sha256: e.sha256 ?? null,
  progressDone: Number(e.progressDone ?? 0),
  progressTotal: Number(e.progressTotal ?? 0),
  attempts: Number(e.attempts ?? 0),
  workerId: e.workerId ?? null,
  createdAt: e.createdAt,
  startedAt: e.startedAt ?? null,
  finishedAt: e.finishedAt ?? null,
  error: e.error ?? null,
  etag: e.etag,
});

export const createJob = async (s: Storage, job: Job): Promise<void> => {
  await s.table.createEntity(toEntity(job) as any);
};

export const getJob = async (s: Storage, jobId: string): Promise<Job | null> => {
  try {
    return fromEntity(await s.table.getEntity(PARTITION, jobId) as any);
  } catch (e: any) {
    if (e?.statusCode === 404) return null;
    throw e;
  }
};

/** Unconditional by default (today's every-caller behaviour, unchanged).
 *  Pass `ifMatch` to make the update conditional on a specific etag — the
 *  table service answers a stale etag with 412, which the caller decides how
 *  to handle (see `start-job.ts`'s claim-before-enqueue). */
export const updateJob = async (
  s: Storage, jobId: string, patch: Partial<Job>, opts?: { ifMatch?: string },
): Promise<void> => {
  await s.table.updateEntity(
    toEntity({ ...patch, jobId }) as any,
    "Merge",
    opts?.ifMatch ? { etag: opts.ifMatch } : undefined,
  );
};
