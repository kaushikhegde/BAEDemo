import { describe, it, expect } from "vitest";
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
    expect(c.connectionString).toContain("devstoreaccount1");
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
