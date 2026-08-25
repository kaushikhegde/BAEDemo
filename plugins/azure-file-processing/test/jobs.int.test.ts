import { describe, it, expect, beforeAll } from "vitest";
import { loadConfig } from "../src/shared/config.js";
import { getStorage, ensureStorage } from "../src/shared/storage.js";
import { newJobId } from "../src/shared/ids.js";
import { createJob, getJob, updateJob, type Job } from "../src/shared/jobs.js";

const s = getStorage(loadConfig());
beforeAll(async () => { await ensureStorage(s); });

const sample = (jobId: string): Job => ({
  jobId, state: "awaiting_upload", phase: null,
  pipelineId: "extract-chunks", params: "{}",
  blobPath: `${jobId}/contract.pdf`, filename: "contract.pdf",
  sizeBytes: 5_368_709_120,      // 5 GiB — deliberately larger than Int32
  sha256: null, progressDone: 0, progressTotal: 0, attempts: 0, workerId: null,
  createdAt: new Date().toISOString(), startedAt: null, finishedAt: null, error: null,
});

describe("job store", () => {
  it("round-trips a job, including a size beyond Int32", async () => {
    const id = newJobId();
    await createJob(s, sample(id));
    const got = await getJob(s, id);
    expect(got?.sizeBytes).toBe(5_368_709_120);
    expect(got?.state).toBe("awaiting_upload");
    expect(got?.phase).toBeNull();
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
});
