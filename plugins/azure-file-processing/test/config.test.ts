import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { getHeapStatistics } from "node:v8";
import { join } from "node:path";
import { loadConfig } from "../src/shared/config.js";

describe("loadConfig", () => {
  it("runs correctly with no environment at all", () => {
    const c = loadConfig({});
    expect(c.orchPort).toBe(8080);
    expect(c.bearerToken).toBeNull();
    expect(c.sasTtlSeconds).toBe(900);
    expect(c.fetchMaxBytes).toBe(32768);
    expect(c.chunkChars).toBe(4000);
    expect(c.maxDequeueCount).toBe(3);
    expect(c.publicBlobEndpoint).toBeNull();
    expect(c.allowLocalPathUpload).toBe(true);
    expect(c.connectionString).toContain("devstoreaccount1");
    // MCP server 2 (scyne-workspace) config — reaches the Scyne stack that
    // already runs natively on this machine, not Azurite.
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
