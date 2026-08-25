import http from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { loadConfig } from "../shared/config.js";
import { log } from "../shared/logger.js";
import { buildWorkspaceServer } from "./mcp.js";
import type { OrchCtx } from "./orchestrator.js";

const MAX_BODY_BYTES = 1_048_576;

/** Thrown when the cap trips, so the handler can respond 400 rather than let
 *  an ordinary JSON.parse failure and an oversized body look identical. */
class PayloadTooLargeError extends Error {}

const readBody = (req: http.IncomingMessage): Promise<unknown> =>
  new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const settle = (fn: () => void) => { if (!settled) { settled = true; fn(); } };

    const onData = (c: Buffer) => {
      bytes += c.length;
      if (bytes > MAX_BODY_BYTES) {
        req.removeListener("data", onData);
        req.pause();
        settle(() => reject(new PayloadTooLargeError("request body too large")));
        return;
      }
      parts.push(c);
    };

    req.on("data", onData);
    req.on("end", () => settle(() => {
      const raw = Buffer.concat(parts).toString("utf8");
      try { resolve(raw ? JSON.parse(raw) : undefined); } catch (e) { reject(e); }
    }));
    req.on("error", (e) => settle(() => reject(e)));
  });

/**
 * MCP server 2 — `scyne-workspace`, on its own port (default 8081; `scyne` on
 * :8080 is the file plane). Binds 127.0.0.1 only: it holds a bearer token that
 * can start paid agent runs on the orchestrator, so it must never be reachable
 * from the LAN the way the containerised file plane is.
 */
export const startWorkspaceServer = (ctx: OrchCtx, port: number): Promise<http.Server> => {
  const server = http.createServer(async (req, res) => {
    const path = (req.url ?? "/").split("?")[0];

    if (path === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, service: "scyne-workspace", version: "0.1.0" }));
      return;
    }

    if (path !== "/mcp") { res.writeHead(404).end(); return; }

    try {
      const body = await readBody(req);
      // Stateless: a fresh server and transport per request.
      const mcp = buildWorkspaceServer(ctx);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => {
        transport.close().catch((err) =>
          log.warn("mcp.transport_close_failed", { message: String(err).slice(0, 400) }));
        mcp.close().catch((err) =>
          log.warn("mcp.server_close_failed", { message: String(err).slice(0, 400) }));
      });
      await mcp.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (e) {
      const tooLarge = e instanceof PayloadTooLargeError;
      log.error(tooLarge ? "mcp.body_too_large" : "mcp.request_failed", {
        message: String((e as Error).message).slice(0, 400),
      });
      if (!res.headersSent) {
        res.writeHead(400, { "content-type": "application/json", connection: "close" });
        res.end(JSON.stringify({ error: "bad_request" }));
      }
    }
  });

  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
};

// Entry point when run as a service.
if (import.meta.url === `file://${process.argv[1]}`) {
  const cfg = loadConfig();
  const ctx: OrchCtx = { cfg };
  const server = await startWorkspaceServer(ctx, cfg.workspacePort);
  log.info("workspace.listening", { port: cfg.workspacePort });
  void server;
}
