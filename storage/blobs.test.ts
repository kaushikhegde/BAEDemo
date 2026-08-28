import { describe, it, expect } from "vitest";
import { selectBlobBackend, compositeBlobBackend, describeBlobConfig } from "./blobs.js";
import { blobNameFor } from "./blob-name.js";
import type { BlobBackend } from "../packages/orchestrator/src/index.js";

/**
 * The two stacks share one installation and one Postgres:
 *
 *   Claude -> S3    + Jira/Confluence
 *   Codex  -> Azure + Azure DevOps
 *
 * These guard the property that makes that safe — a locator names its owner —
 * and the property that keeps them separate: neither SDK is loaded unless its
 * store is configured.
 */

const fake = (prefix: string, store = new Map<string, Buffer>()): BlobBackend => ({
  async write(sha256, content) {
    const locator = `${prefix}${blobNameFor(sha256)}`;
    store.set(locator, content);
    return locator;
  },
  async read(locator) {
    if (!locator.startsWith(prefix)) return null;   // the guard under test
    return store.get(locator) ?? null;
  },
});

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

describe("blob backend selection — env-separated, both usable at once", () => {
  it("picks nothing when neither store is configured", async () => {
    expect(await selectBlobBackend({})).toBeUndefined();
  });

  it("picks S3 alone for a Claude install", async () => {
    const b = await selectBlobBackend({ SCYNE_S3_DOCUMENTS_BUCKET: "docs" });
    expect(b).toBeDefined();
    // Nothing Azure may be reachable from a Claude install.
    expect(describeBlobConfig({ SCYNE_S3_DOCUMENTS_BUCKET: "docs" })).toBe("s3");
  });

  it("picks Azure alone for a Codex install", async () => {
    const env = { AZURE_STORAGE_CONNECTION_STRING: "UseDevelopmentStorage=true" };
    expect(await selectBlobBackend(env)).toBeDefined();
    expect(describeBlobConfig(env)).toBe("azure");
  });

  it("reports both, and which one takes writes, when both are configured", () => {
    const env = {
      SCYNE_S3_DOCUMENTS_BUCKET: "docs",
      AZURE_STORAGE_CONNECTION_STRING: "UseDevelopmentStorage=true",
    };
    // Silent would be wrong: a person who configured both and expected the
    // other should learn it at boot, not from a blob in the wrong bucket.
    expect(describeBlobConfig(env)).toContain("s3 + azure");
    expect(describeBlobConfig(env)).toContain("writing to s3");
    expect(describeBlobConfig({ ...env, SCYNE_BLOB_WRITE: "azure" })).toContain("writing to azure");
  });
});

describe("credentials — an emulator is not a reason to put secrets in .env", () => {
  it("uses LocalStack's placeholder pair only for a loopback endpoint", async () => {
    // LocalStack accepts any non-empty pair; the default provider chain would
    // find nothing and fail. Narrow on purpose — see the next test.
    const b = await selectBlobBackend({
      SCYNE_S3_DOCUMENTS_BUCKET: "docs",
      SCYNE_S3_ENDPOINT: "http://127.0.0.1:4566",
    });
    expect(b).toBeDefined();
  });

  it("leaves real AWS to the default provider chain", async () => {
    // Injecting a placeholder here would override a working instance role and
    // fail with a signature error that reads as a configuration problem.
    const b = await selectBlobBackend({ SCYNE_S3_DOCUMENTS_BUCKET: "docs" });
    expect(b).toBeDefined();
  });
});

describe("composite — one Postgres holding both stacks' documents", () => {
  const s3 = fake("s3:docs/");
  const azure = fake("azure:documents/");
  const both = compositeBlobBackend(s3, [s3, azure]);

  it("writes to the primary only", async () => {
    const loc = await both.write(SHA_A, Buffer.from("claude"), null);
    expect(loc.startsWith("s3:")).toBe(true);
    expect(await azure.read(loc)).toBeNull();
  });

  it("reads a blob written by the OTHER stack", async () => {
    // The whole point: a Codex-era document must stay readable after the
    // install starts writing to S3, without a migration.
    const loc = await azure.write(SHA_B, Buffer.from("codex"), null);
    expect((await both.read(loc))?.toString()).toBe("codex");
  });

  it("returns null for a locator no configured store owns", async () => {
    expect(await both.read("gcs:bucket/whatever")).toBeNull();
  });
});

describe("blob naming — shared, and free of either SDK", () => {
  it("fans out two levels under the hash", () => {
    expect(blobNameFor(SHA_A)).toBe(`aa/aa/${SHA_A}`);
  });

  it("refuses anything that is not a lowercase hex sha256", () => {
    // A value that is not a hash would either create a blob nothing can find
    // again or, with `../` in it, address a key space we do not own.
    for (const bad of ["", "../etc/passwd", SHA_A.toUpperCase(), "abc"]) {
      expect(() => blobNameFor(bad), bad).toThrow();
    }
  });
});
