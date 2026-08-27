import { GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { isNotFound, type Storage } from "./storage.js";

export type JobState =
  | "awaiting_upload" | "queued" | "running" | "succeeded" | "failed" | "deleted";
/** "converting" is the markdown render. It is a phase of its own rather than
 *  part of "extracting" because for a slide deck or a spreadsheet it is the
 *  only thing that reads the document at all, and it is the phase a large
 *  file spends most of its time in — a poll that reported "extracting"
 *  throughout would say nothing about where the time went. */
export type JobPhase =
  | "downloading" | "extracting" | "converting" | "chunking" | "uploading" | "done";

export interface Job {
  jobId: string;
  state: JobState;
  phase: JobPhase | null;
  pipelineId: string;
  params: string;          // JSON text, as it was: nothing reads inside it here
  objectKey: string;
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
  /**
   * The optimistic-concurrency token, as a string, because that is what every
   * caller passes back to `updateJob({ ifMatch })` and none of them does
   * arithmetic on it.
   *
   * Table Storage handed out an etag the service maintained. DynamoDB has no
   * such thing, so this IS the mechanism rather than a mirror of one: `rev` is
   * an ordinary attribute, every write bumps it, and a conditional write asserts
   * the value it read. That turns a read-then-write race (two callers both
   * observing `awaiting_upload`) into compare-and-swap — only the caller still
   * holding the current revision wins.
   *
   * Always present on a `Job` read back by `getJob`; absent on one built by
   * hand before `createJob`.
   */
  etag?: string;
}

/** Written by `createJob`, absent on a row created before this existed. Only
 *  `updateJob` reads it, and only when a caller asked for a conditional write. */
const REV = "rev";

/** DynamoDB Numbers are arbitrary-precision decimals, so `sizeBytes` needs none
 *  of the string-encoding Table Storage forced on it — its Int32 ceiling sat at
 *  2 GiB and our own is 5 GiB. Kept as a number, and `fromItem` coerces anyway
 *  so a row written by the older, string-encoded build still reads correctly. */
const toItem = (j: Partial<Job> & { jobId: string }): Record<string, unknown> => {
  const item: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(j)) {
    // "etag" is this module's own concurrency bookkeeping, carried on `Job` so
    // callers can read it back — never an attribute to write directly.
    if (k === "etag" || v === undefined) continue;
    item[k] = v;
  }
  return item;
};

const fromItem = (e: Record<string, any>): Job => ({
  jobId: e.jobId,
  state: e.state, phase: e.phase ?? null,
  pipelineId: e.pipelineId, params: e.params,
  objectKey: e.objectKey, filename: e.filename,
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
  etag: e[REV] === undefined ? undefined : String(e[REV]),
});

export const createJob = async (s: Storage, job: Job): Promise<void> => {
  await s.ddb.send(new PutCommand({
    TableName: s.jobsTable,
    Item: { ...toItem(job), [REV]: 1 },
    // Table Storage's createEntity answered 409 on a duplicate RowKey; PutItem
    // would happily overwrite. The condition restores that: a job id is minted
    // fresh per upload, so a collision means something is wrong and silently
    // replacing an existing job's row is the worst available response.
    ConditionExpression: "attribute_not_exists(jobId)",
  }));
};

export const getJob = async (s: Storage, jobId: string): Promise<Job | null> => {
  try {
    const r = await s.ddb.send(new GetCommand({
      TableName: s.jobsTable,
      Key: { jobId },
      // The worker's claim-and-update sequence reads a row it is about to write
      // conditionally, and an eventually-consistent read can hand back a
      // revision that is already stale — which turns a legitimate update into a
      // spurious precondition failure. Strong consistency costs double the read
      // capacity on a table that sees a handful of reads per job.
      ConsistentRead: true,
    }));
    return r.Item ? fromItem(r.Item) : null;
  } catch (e: any) {
    if (isNotFound(e)) return null;
    throw e;
  }
};

/**
 * Unconditional by default (today's every-caller behaviour, unchanged).
 *
 * Pass `ifMatch` to make the update conditional on a specific revision — the
 * write then fails with `ConditionalCheckFailedException`, which
 * `isPreconditionFailed` (shared/storage.ts) recognises and the caller decides
 * how to handle. See `start-job.ts`'s claim-before-enqueue.
 *
 * `rev` is bumped on EVERY update, conditional or not. An unconditional writer
 * that left it alone would let a conditional one succeed against a value that
 * no longer describes the row it read.
 */
export const updateJob = async (
  s: Storage, jobId: string, patch: Partial<Job>, opts?: { ifMatch?: string },
): Promise<void> => {
  const item = toItem({ ...patch, jobId });
  delete item.jobId; // the key is not a settable attribute

  const names: Record<string, string> = { "#rev": REV };
  const values: Record<string, unknown> = { ":one": 1 };
  const sets: string[] = ["#rev = if_not_exists(#rev, :zero) + :one"];
  values[":zero"] = 0;

  let i = 0;
  for (const [k, v] of Object.entries(item)) {
    const n = `#f${i}`, val = `:v${i}`;
    names[n] = k;
    values[val] = v;
    sets.push(`${n} = ${val}`);
    i++;
  }

  await s.ddb.send(new UpdateCommand({
    TableName: s.jobsTable,
    Key: { jobId },
    UpdateExpression: `SET ${sets.join(", ")}`,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
    ...(opts?.ifMatch !== undefined
      ? {
          ConditionExpression: "#rev = :expected",
          ExpressionAttributeValues: { ...values, ":expected": Number(opts.ifMatch) },
        }
      : {}),
  }));
};
