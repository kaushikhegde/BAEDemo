import { describe, it, expect } from "vitest";
import express from "express";
import multer from "multer";
import type { AddressInfo } from "node:net";
import { carryAuth, currentToken } from "./auth.js";
import { fileUpload } from "./upload.js";

/**
 * A route behind multer must still know who is signed in.
 *
 * multer parses the body in busboy's stream callbacks, which run outside the
 * AsyncLocalStorage context `carryAuth` opened for the request. The upload
 * itself still worked — it passes `tokenFor(req)` explicitly — but every
 * `orchestrator.call()` made from that handler went out with no credential.
 * The one that mattered was `startExtraction`: it was refused with a 401 that
 * was only logged, so documents uploaded through the project wizard were never
 * read and Deploy waited on them for ever.
 */

async function tokenSeenBy(chain: express.RequestHandler[]): Promise<string | null> {
  const app = express();
  app.use(carryAuth);
  app.post("/up", ...chain, (_req, res) => { res.json({ token: currentToken() }); });
  const server = app.listen(0);
  try {
    const { port } = server.address() as AddressInfo;
    const form = new FormData();
    form.append("file", new Blob(["# doc"]), "a.md");
    const res = await fetch(`http://127.0.0.1:${port}/up`, {
      method: "POST", body: form, headers: { authorization: "Bearer scy_test" },
    });
    return ((await res.json()) as { token: string | null }).token;
  } finally {
    server.close();
  }
}

describe("file uploads keep the request's credential", () => {
  it("is lost behind bare multer — the bug", async () => {
    expect(await tokenSeenBy([multer({ storage: multer.memoryStorage() }).single("file")])).toBeNull();
  });

  it("is carried through fileUpload()", async () => {
    expect(await tokenSeenBy([fileUpload("file")])).toBe("scy_test");
  });
});
