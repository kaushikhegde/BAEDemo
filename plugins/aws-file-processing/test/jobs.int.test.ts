import { describe, it, expect, beforeAll } from "vitest";
import { loadConfig } from "../src/shared/config.js";
import { getStorage, ensureStorage, isPreconditionFailed } from "../src/shared/storage.js";
import { newJobId } from "../src/shared/ids.js";
import { createJob, getJob, updateJob, type Job } from "../src/shared/jobs.js";

const s = getStorage(loadConfig());
beforeAll(async () => { await ensureStorage(s); });

const sample = (jobId: string): Job => ({
  jobId, state: "awaiting_upload", phase: null,
  pipelineId: "extract-chunks", params: "{}",
  objectKey: `${jobId}/contract.pdf`, filename: "contract.pdf",
  sizeBytes: 5_368_709_120,      // 5 GiB — deliberately larger than Int32
  sha256: null, progressDone: 0, progressTotal: 0, attempts: 0, workerId: null,
  createdAt: new Date().toISOString(), startedAt: null, finishedAt: null, error: null,
});

describe("job store", () => {
  it("round-trips a job, including a size beyond Int32", async () => {
    // DynamoDB Numbers are arbitrary-precision decimals, so this needs none of
    // the string encoding Table Storage forced on it — but 5 GiB is still the
    // size worth asserting, because it is the plugin's own ceiling.
    const id = newJobId();
    await createJob(s, sample(id));
    const got = await getJob(s, id);
    expect(got?.sizeBytes).toBe(5_368_709_120);
    expect(got?.state).toBe("awaiting_upload");
    expect(got?.phase).toBeNull();
    expect(got?.objectKey).toBe(`${id}/contract.pdf`);
  });

  it("patches only the fields given", async () => {
    const id = newJobId();
    await createJob(s, sample(id));
    await updateJob(s, id, { state: "running", phase: "extracting", progressDone: 25 });
    const got = await getJob(s, id);
    expect(got?.state).toBe("running");
    expect(got?.progressDone).toBe(25);
    expect(got?.filename).toBe("contract.pdf"); // untouched
  });

  it("answers null for an id that was never created", async () => {
    expect(await getJob(s, newJobId())).toBeNull();
  });

  it("refuses to overwrite an existing job row", async () => {
    // Table Storage's createEntity answered 409 on a duplicate RowKey; PutItem
    // would happily overwrite. A job id is minted fresh per upload, so a
    // collision means something is wrong and replacing a live job's row is the
    // worst available response.
    const id = newJobId();
    await createJob(s, sample(id));
    await expect(createJob(s, sample(id))).rejects.toThrow();
  });
});

describe("optimistic concurrency", () => {
  // DynamoDB has no server-maintained ETag, so `rev` is an ordinary attribute
  // every write bumps and a conditional write asserts. `Job.etag` carries it,
  // because no caller does arithmetic on it.

  it("hands back a revision that changes on every write", async () => {
    const id = newJobId();
    await createJob(s, sample(id));
    const first = await getJob(s, id);
    expect(first?.etag).toBeDefined();
    await updateJob(s, id, { phase: "downloading" });
    const second = await getJob(s, id);
    expect(second?.etag).not.toBe(first?.etag);
  });

  it("lets the holder of the current revision win", async () => {
    const id = newJobId();
    await createJob(s, sample(id));
    const job = await getJob(s, id);
    await expect(updateJob(s, id, { state: "queued" }, { ifMatch: job!.etag }))
      .resolves.toBeUndefined();
    expect((await getJob(s, id))?.state).toBe("queued");
  });

  it("refuses a stale revision, recognisably", async () => {
    // This is the whole of start_job's claim-before-enqueue: two callers can
    // both observe "awaiting_upload" before either has written "queued", and
    // this write is what actually decides the race.
    const id = newJobId();
    await createJob(s, sample(id));
    const stale = (await getJob(s, id))!.etag;
    await updateJob(s, id, { phase: "downloading" });   // someone else moves first

    let thrown: unknown;
    await updateJob(s, id, { state: "queued" }, { ifMatch: stale }).catch((e) => { thrown = e; });
    expect(thrown).toBeDefined();
    // Recognised by the shared predicate rather than by a name typed out at
    // each call site — that is how one of DynamoDB's spellings gets missed.
    expect(isPreconditionFailed(thrown)).toBe(true);
    // And nothing was written.
    expect((await getJob(s, id))?.state).toBe("awaiting_upload");
  });

  it("bumps the revision on an UNCONDITIONAL write too", async () => {
    // An unconditional writer that left `rev` alone would let a conditional one
    // succeed against a value that no longer describes the row it read.
    const id = newJobId();
    await createJob(s, sample(id));
    const before = (await getJob(s, id))!.etag;
    await updateJob(s, id, { workerId: "w-deadbeef" });   // no ifMatch
    await expect(updateJob(s, id, { state: "queued" }, { ifMatch: before })).rejects.toThrow();
  });
});
