import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { loadConfig, UPLOADS } from "../src/shared/config.js";
import { ScanCommand } from "@aws-sdk/lib-dynamodb";
import { getStorage, ensureStorage, headObject } from "../src/shared/storage.js";
import { getJob } from "../src/shared/jobs.js";
import { uploadFile } from "../src/orchestrator/tools/upload-file.js";

const cfg = loadConfig();
const storage = getStorage(cfg);
const ctx = { cfg, storage };

let dir: string;
beforeAll(async () => {
  await ensureStorage(storage);
  dir = mkdtempSync(join(tmpdir(), "afp-ufi-"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const committed = async (key: string) =>
  (await headObject(storage, storage.bucket(UPLOADS), key)).contentLength;

describe("upload_file, end to end", () => {
  it("streams a file from disk to storage and queues it in one call", async () => {
    const body = "# contract\nthe quick brown fox\n".repeat(500);
    const file = join(dir, "contract.md");
    writeFileSync(file, body);

    const out = await uploadFile(ctx, { path: file });

    expect(out.started).toBe(true);
    expect(out.state).toBe("queued");
    expect(out.filename).toBe("contract.md");
    expect(out.bytes).toBe(Buffer.byteLength(body));
    expect(out.sha256).toBe(createHash("sha256").update(body).digest("hex"));
    expect(await committed(out.objectKey)).toBe(Buffer.byteLength(body));

    // The digest is written back to the row, so the worker can verify the
    // bytes it downloads against the ones this process actually sent — the
    // integrity check the presigned path gets only if a caller runs `shasum`.
    const job = await getJob(storage, out.jobId);
    expect(job?.sha256).toBe(out.sha256);
    expect(job?.state).toBe("queued");
    expect(job?.sizeBytes).toBe(Buffer.byteLength(body));
  });

  it("returns nothing that contains the file's own text", async () => {
    // The whole point of the plugin, asserted at the one tool that now touches
    // file bytes on this side of the wire.
    const needle = "PINEAPPLE-CANARY-91773";
    const file = join(dir, "needle.txt");
    writeFileSync(file, `intro\n${needle}\ntail\n`);

    const out = await uploadFile(ctx, { path: file, start: false });
    expect(JSON.stringify(out)).not.toContain(needle);
  });

  it("stops at the upload when asked not to start", async () => {
    const file = join(dir, "later.md");
    writeFileSync(file, "not yet\n");

    const out = await uploadFile(ctx, { path: file, start: false });
    expect(out.started).toBe(false);
    expect(out.state).toBe("awaiting_upload");
    expect((await getJob(storage, out.jobId))?.state).toBe("awaiting_upload");
    expect(await committed(out.objectKey)).toBe(8);
  });

  it("sends a file past one part without holding it in memory", async () => {
    // 20 MiB against an 8 MiB part size: three parts, so lib-storage's
    // multipart path is genuinely exercised rather than assumed.
    const file = join(dir, "big.txt");
    const mib = Buffer.alloc(1024 * 1024, 0x62);
    writeFileSync(file, Buffer.concat(Array(20).fill(mib)));
    const size = 20 * 1024 * 1024;

    const out = await uploadFile(ctx, { path: file, start: false });
    expect(out.bytes).toBe(size);
    expect(await committed(out.objectKey)).toBe(size);
    expect(out.sha256).toBe(
      createHash("sha256").update(Buffer.concat(Array(20).fill(mib))).digest("hex"));
  });

  it("records a failed job rather than leaving a silent orphan", async () => {
    // An S3 client whose every call throws makes the upload fail AFTER the row
    // is written — the state the row is left in is the whole assertion. The
    // real DynamoDB client is untouched, so the row this test then reads is a
    // genuine one.
    const file = join(dir, "doomed.md");
    writeFileSync(file, "x\n");
    const broken = {
      cfg,
      storage: {
        ...storage,
        s3: { ...storage.s3, send: async () => { throw new Error("bucket not found"); } },
      },
    } as any;

    // `upload_failed:` — the CODE, not the prose. `serviceError` replaces the
    // message with a fixed sentence and a reference, deliberately (the caller
    // cannot fix a storage failure and the cause goes to the operator's log),
    // so the code in front of the colon is the only stable thing to match on.
    // It is also the part the model branches on.
    await expect(uploadFile(broken, { path: file })).rejects.toThrow(/^upload_failed:/);

    // `uploadFile` mints the id itself and throws a reference rather than the
    // cause (that is what serviceError is for), so the row is found by the
    // marker it left behind. A Scan is what the Azure build's listEntities()
    // was too — this one at least narrows to the single document name.
    const scan: any = await storage.ddb.send(new ScanCommand({
      TableName: storage.jobsTable,
      FilterExpression: "#s = :failed and #f = :name",
      ExpressionAttributeNames: { "#s": "state", "#f": "filename" },
      ExpressionAttributeValues: { ":failed": "failed", ":name": "doomed.md" },
    }));
    const failed = (scan.Items ?? [])
      .filter((r: any) => String(r.error ?? "").startsWith("upload_failed:"));
    expect(failed.length).toBeGreaterThan(0);
  });
});
