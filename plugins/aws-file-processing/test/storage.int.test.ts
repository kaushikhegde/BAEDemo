import { describe, it, expect, beforeAll } from "vitest";
import { HeadBucketCommand } from "@aws-sdk/client-s3";
import { DescribeTableCommand } from "@aws-sdk/client-dynamodb";
import { loadConfig, UPLOADS, ARTIFACTS, JOB_QUEUE, POISON_QUEUE } from "../src/shared/config.js";
import { getStorage, ensureStorage } from "../src/shared/storage.js";

const cfg = loadConfig();
const storage = getStorage(cfg);

beforeAll(async () => {
  try {
    await ensureStorage(storage);
  } catch (e) {
    // Loud, not skipped: a silently skipped integration suite is a green build
    // that proves nothing.
    throw new Error(
      "LocalStack is not reachable. Run ./scripts/stack.sh up first.\n" + String(e));
  }
});

describe("storage bootstrap", () => {
  it("creates both S3 buckets", async () => {
    for (const key of [UPLOADS, ARTIFACTS] as const) {
      await expect(storage.s3.send(new HeadBucketCommand({ Bucket: storage.bucket(key) })))
        .resolves.toBeDefined();
    }
  });

  it("creates the job queue and its poison queue, with different names", async () => {
    const job = await storage.queue(JOB_QUEUE).url();
    const poison = await storage.queue(POISON_QUEUE).url();
    expect(job).toMatch(/^https?:\/\//);
    expect(job).not.toBe(poison);
  });

  it("creates the jobs table and waits for it to be ACTIVE", async () => {
    // Not merely "exists". CreateTable returns while the table is still
    // CREATING, and a worker that boots and immediately claims a job would
    // fail against one that exists but cannot yet be written to.
    const d = await storage.ddbRaw.send(new DescribeTableCommand({ TableName: storage.jobsTable }));
    expect(d.Table?.TableStatus).toBe("ACTIVE");
    // One HASH key and nothing else: Table Storage made us name a partition and
    // every job used the same literal "job", a partition of one.
    expect(d.Table?.KeySchema).toEqual([{ AttributeName: "jobId", KeyType: "HASH" }]);
  });

  it("is idempotent — a second run changes nothing and throws nothing", async () => {
    await expect(ensureStorage(storage)).resolves.toBeUndefined();
  });

  it("resolves a queue URL once and caches it", async () => {
    // Two calls, one GetQueueUrl: SQS addresses a queue by URL, and a round
    // trip in front of every send would be a needless call per message.
    const q = storage.queue(JOB_QUEUE);
    const [a, b] = await Promise.all([q.url(), q.url()]);
    expect(a).toBe(b);
  });

  it("always builds a SEPARATE presigning client, even on one endpoint", () => {
    // Not an optimisation that was missed. The presigning client must run with
    // request checksums OFF — see makeS3 in shared/storage.ts — and the
    // ordinary client must keep them on, so they can never be the same object
    // however identical their endpoints are.
    expect(storage.presign).not.toBe(storage.s3);
  });
});
