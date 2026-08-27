import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadConfig } from "../src/shared/config.js";
import { getStorage, ensureStorage } from "../src/shared/storage.js";
import { startServer } from "../src/orchestrator/server.js";

let server: Server;
let port: number;

beforeAll(async () => {
  const cfg = { ...loadConfig(), orchPort: 0 };
  const storage = getStorage(cfg);
  await ensureStorage(storage);
  server = await startServer({ cfg, storage }, 0);
  port = (server.address() as any).port;
});

afterAll(async () => { await new Promise((r) => server.close(r)); });

const connect = async () => {
  const client = new Client({ name: "test", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
  return client;
};

describe("MCP over streamable HTTP", () => {
  it("serves health without a credential", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
    expect((await res.json() as any).ok).toBe(true);
  });

  it("completes an MCP handshake and lists its tools", async () => {
    const client = await connect();
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "create_upload_url", "delete_job", "fetch_chunks",
      "get_result", "job_status", "search_chunks", "start_job", "upload_file",
    ]);
    await client.close();
  });

  it("does not offer upload_file where the orchestrator cannot read the caller's disk", async () => {
    // Absent, not present-and-throwing: a tool that always fails teaches a
    // model to retry it, and the create_upload_url pair still does the job.
    const cfg = { ...loadConfig(), allowLocalPathUpload: false };
    const s2 = await startServer({ cfg, storage: getStorage(cfg) }, 0);
    const p2 = (s2.address() as any).port;
    const client = new Client({ name: "test", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${p2}/mcp`)));
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).not.toContain("upload_file");
    expect(names).toContain("create_upload_url");
    await client.close();
    await new Promise((r) => s2.close(r));
  });

  it("404s an unknown path rather than falling through to MCP", async () => {
    expect((await fetch(`http://127.0.0.1:${port}/nope`)).status).toBe(404);
  });
});

describe("bearer auth, when configured", () => {
  it("refuses /mcp without the token and allows /health", async () => {
    const cfg = { ...loadConfig(), bearerToken: "s3cret" };
    const s2 = await startServer({ cfg, storage: getStorage(cfg) }, 0);
    const p2 = (s2.address() as any).port;
    expect((await fetch(`http://127.0.0.1:${p2}/health`)).status).toBe(200);
    const res = await fetch(`http://127.0.0.1:${p2}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(401);
    await new Promise((r) => s2.close(r));
  });
});

describe("request body cap", () => {
  it("cleanly refuses a body over 1 MiB with 400 bad_request, not a socket reset", async () => {
    const oversized = "x".repeat(1_048_577); // one byte past the cap
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: oversized,
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "bad_request" });
  });
});
