import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { getHeapStatistics } from "node:v8";
import { join } from "node:path";
import { loadConfig, bucketFor, queueNameFor, UPLOADS, ARTIFACTS, WORKSPACE, JOB_QUEUE, POISON_QUEUE } from "../src/shared/config.js";

describe("loadConfig", () => {
  it("runs correctly with no environment at all", () => {
    const c = loadConfig({});
    expect(c.orchPort).toBe(8080);
    expect(c.bearerToken).toBeNull();
    expect(c.presignTtlSeconds).toBe(900);
    expect(c.fetchMaxBytes).toBe(32768);
    expect(c.chunkChars).toBe(4000);
    expect(c.maxDequeueCount).toBe(3);
    expect(c.publicS3Endpoint).toBeNull();
    expect(c.allowLocalPathUpload).toBe(true);
    // No AWS configuration at all can only mean a developer machine, so the
    // LocalStack default applies — and brings its placeholder credentials and
    // path-style addressing with it, because an emulator needs all three or
    // none.
    expect(c.endpoint).toBe("http://127.0.0.1:4566");
    expect(c.accessKeyId).toBe("test");
    expect(c.forcePathStyle).toBe(true);
    // MCP server 2 (scyne-workspace) config — reaches the Scyne stack that
    // already runs natively on this machine, not LocalStack.
    expect(c.orchUrl).toBe("http://127.0.0.1:3100");
    expect(c.orchToken).toBeNull();
    expect(c.chatbotUrl).toBe("http://127.0.0.1:4000");
    expect(c.workspacePort).toBe(8081);
    // The WORKSPACE ROOT, not cwd. This test used to assert cwd and passed only
    // because vitest happens to run from the plugin directory — which is
    // exactly the bug the root walk in config.ts fixes: resolved against cwd,
    // `projects/` would be looked for inside the plugin, where there is none.
    // Asserted by shape rather than by literal path so it holds wherever the
    // repo is checked out.
    expect(c.workspaceRoot).toMatch(/requirement-generator$/);
    expect(existsSync(join(c.workspaceRoot, "agent-instructions"))).toBe(true);
    expect(existsSync(join(c.workspaceRoot, "skills"))).toBe(true);
  });

  it("takes overrides from the environment", () => {
    const c = loadConfig({ ORCH_PORT: "9999", MCP_BEARER_TOKEN: "s3cret" });
    expect(c.orchPort).toBe(9999);
    expect(c.bearerToken).toBe("s3cret");
  });

  it("refuses a numeric setting that is not a number", () => {
    expect(() => loadConfig({ ORCH_PORT: "eighty-eighty" }))
      .toThrow(/ORCH_PORT/);
  });
});

describe("choosing between an emulator and real AWS", () => {
  it("stops guessing LocalStack the moment a real region is configured", () => {
    // The dangerous failure is the silent one: an account that IS configured,
    // pointed at 127.0.0.1 because this file had an opinion, with every upload
    // disappearing into a container nobody is looking at.
    const c = loadConfig({ AWS_REGION: "ap-southeast-2" });
    expect(c.endpoint).toBeNull();
    expect(c.region).toBe("ap-southeast-2");
    expect(c.forcePathStyle).toBe(false);
  });

  it("leaves credentials to the provider chain when none are given", () => {
    // Null, so `credentialsFor` hands the SDK `undefined` and the default chain
    // (env, shared config, SSO, instance role) runs. A hard-coded "test" here
    // would shadow a perfectly good instance role and fail with a message that
    // names none of this.
    const c = loadConfig({ AWS_REGION: "eu-west-1" });
    expect(c.accessKeyId).toBeNull();
    expect(c.secretAccessKey).toBeNull();
  });

  it("honours AWS_ENDPOINT_URL, the SDK's own variable", () => {
    // So `AWS_ENDPOINT_URL=http://localhost:4566` does the same thing for this
    // plugin as for the `aws` CLI sitting next to it.
    const c = loadConfig({ AWS_ENDPOINT_URL: "http://minio.internal:9000/", AWS_REGION: "us-east-1" });
    expect(c.endpoint).toBe("http://minio.internal:9000");
    expect(c.forcePathStyle).toBe(true);
  });

  it("lets an operator force path style off against a custom endpoint", () => {
    const c = loadConfig({ AWS_ENDPOINT_URL: "https://s3.example.com", S3_FORCE_PATH_STYLE: "false" });
    expect(c.forcePathStyle).toBe(false);
  });
});

describe("bucket and queue names", () => {
  it("are configurable, because an S3 bucket name is globally unique", () => {
    // The one structural difference from the Azure build. A container name was
    // scoped to a storage account, so "uploads" was safe as a literal; a bucket
    // name collides with every other AWS account on earth, so it has to be a
    // key into config rather than the name itself.
    const c = loadConfig({
      S3_UPLOADS_BUCKET: "acme-scyne-uploads",
      S3_ARTIFACTS_BUCKET: "acme-scyne-artifacts",
      S3_WORKSPACE_BUCKET: "acme-scyne-workspace",
    });
    expect(bucketFor(c, UPLOADS)).toBe("acme-scyne-uploads");
    expect(bucketFor(c, ARTIFACTS)).toBe("acme-scyne-artifacts");
    expect(bucketFor(c, WORKSPACE)).toBe("acme-scyne-workspace");
  });

  it("default to distinct names, so nothing shares a prefix by accident", () => {
    const c = loadConfig({});
    const names = [bucketFor(c, UPLOADS), bucketFor(c, ARTIFACTS), bucketFor(c, WORKSPACE)];
    expect(new Set(names).size).toBe(3);
    expect(queueNameFor(c, JOB_QUEUE)).not.toBe(queueNameFor(c, POISON_QUEUE));
  });
});

describe("markdownMaxBytes", () => {
  it("is derived from the heap, so a capped worker converts less, not more", () => {
    const c = loadConfig({});
    const limit = getHeapStatistics().heap_size_limit;
    expect(c.markdownMaxBytes).toBe(
      Math.max(4 * 1024 * 1024, Math.min(268_435_456, Math.floor(limit / 12))));
    // Never more than an eighth of the heap: the source buffer, the parser's
    // intermediate strings and the markdown output are all live at once, so a
    // ceiling near the heap size is a heap-out-of-memory waiting to happen.
    // This is the guard on the acceptance suite's bounded-memory property.
    expect(c.markdownMaxBytes).toBeLessThan(limit / 8);
  });

  it("caps at 256 MiB however large the heap is", () => {
    expect(loadConfig({}).markdownMaxBytes).toBeLessThanOrEqual(268_435_456);
  });

  it("is overridable outright, for an operator who knows their documents", () => {
    expect(loadConfig({ MARKDOWN_MAX_BYTES: "1048576" }).markdownMaxBytes).toBe(1_048_576);
  });
});
