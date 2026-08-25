import http from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { loadConfig } from "../shared/config.js";
import { log } from "../shared/logger.js";
import { getStorage, ensureStorage } from "../shared/storage.js";
import { buildMcpServer, type Ctx } from "./mcp.js";

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
      // A tool call carries ids and parameters. Anything near a megabyte means a
      // caller is trying to push a payload through the control plane — refuse it.
      // Stop reading immediately (the memory bound is the whole point of the
      // cap) but do NOT call req.destroy(): on HTTP/1.1 the request and
      // response share one socket, and destroying the request tears the
      // socket down before the client ever sees the 400. Removing the
      // listener and pausing stops consumption without touching the socket
      // the response still needs to write on.
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

export const startServer = (ctx: Ctx, port: number): Promise<http.Server> => {
  const server = http.createServer(async (req, res) => {
    const path = (req.url ?? "/").split("?")[0];

    if (path === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, service: "azure-files", version: "0.1.0" }));
      return;
    }

    if (path !== "/mcp") { res.writeHead(404).end(); return; }

    if (ctx.cfg.bearerToken) {
      const auth = req.headers.authorization ?? "";
      if (auth !== `Bearer ${ctx.cfg.bearerToken}`) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorised" }));
        return;
      }
    }

    try {
      const body = await readBody(req);
      // Stateless: a fresh server and transport per request. All state lives in
      // Azurite, so there is nothing to keep in memory and nothing to make
      // sticky when the orchestrator is scaled.
      const mcp = buildMcpServer(ctx);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      // `void` alone would discard the promise with no handler attached: if
      // close() rejects after an abrupt client disconnect, that is an
      // unhandled rejection, fatal under Node's default
      // --unhandled-rejections=throw. Log and swallow instead — one
      // disconnecting caller must not take the whole service down.
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
        // The oversized-body case stopped reading mid-request, so the socket
        // may still carry unread bytes of that body — closing the connection
        // after this response flushes is what stops those bytes being
        // misread as the start of the next request. Applying it to every
        // 400 from this catch is simpler than branching and costs nothing on
        // the paths that already fully drained the body.
        res.writeHead(400, { "content-type": "application/json", connection: "close" });
        res.end(JSON.stringify({ error: "bad_request" }));
      }
    }
  });

  return new Promise((resolve) => server.listen(port, "0.0.0.0", () => resolve(server)));
};

// Entry point when run as a service.
if (import.meta.url === `file://${process.argv[1]}`) {
  const cfg = loadConfig();
  const storage = getStorage(cfg);
  await ensureStorage(storage);
  await startServer({ cfg, storage }, cfg.orchPort);
  log.info("orchestrator.listening", { port: cfg.orchPort });
}
