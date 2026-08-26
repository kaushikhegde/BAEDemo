import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readDocumentByPath } from "./store.js";

const calls: Array<{ url: string; accept?: string }> = [];
const realFetch = globalThis.fetch;

const stub = (routes: Record<string, { status: number; body?: unknown; bytes?: string }>) => {
  globalThis.fetch = vi.fn(async (url: any, init: any) => {
    const u = String(url);
    calls.push({ url: u, accept: init?.headers?.accept });
    const hit = Object.entries(routes)
      .filter(([k]) => u.includes(k))
      .sort((a, b) => b[0].length - a[0].length)[0]?.[1];
    if (!hit) return { ok: false, status: 404, json: async () => ({}) } as any;
    return {
      ok: hit.status >= 200 && hit.status < 300,
      status: hit.status,
      json: async () => hit.body ?? {},
      arrayBuffer: async () => new TextEncoder().encode(hit.bytes ?? "").buffer,
    } as any;
  }) as any;
};

beforeEach(() => { calls.length = 0; });
afterEach(() => { globalThis.fetch = realFetch; });

/**
 * The companion app is read from the STORE, not off disk.
 *
 * `sendCompanionFile` used to `fs.readFile` from `generated-apps/<project>/`.
 * Once a step works in a scratch tree that is discarded when the step ends,
 * that directory is not there afterwards.
 */
describe("readDocumentByPath", () => {
  const PATH = "generated-apps/SA-DEMO-1/index.html";

  it("resolves the project by name, finds the document by path, and returns its bytes", async () => {
    stub({
      "/projects": { status: 200, body: [{ id: "p1", name: "SA-DEMO-1" }] },
      "/projects/p1/documents": { status: 200, body: [{ id: "d1", path: PATH }] },
      "/projects/p1/documents/d1": { status: 200, bytes: "<html>rendered</html>" },
    });
    const out = await readDocumentByPath("t", "SA-DEMO-1", PATH);
    expect(out?.toString()).toBe("<html>rendered</html>");
  });

  it("asks for RAW bytes, not base64", async () => {
    // A companion app is megabytes; inflating it by a third to move it between
    // two local processes buys nothing, and the JSON form tops out around
    // 384 MB because V8 refuses a string over 512 MB.
    stub({
      "/projects": { status: 200, body: [{ id: "p1", name: "SA-DEMO-1" }] },
      "/projects/p1/documents": { status: 200, body: [{ id: "d1", path: PATH }] },
      "/projects/p1/documents/d1": { status: 200, bytes: "x" },
    });
    await readDocumentByPath("t", "SA-DEMO-1", PATH);
    expect(calls.at(-1)?.accept).toBe("application/octet-stream");
  });

  it("matches the path EXACTLY, not merely by prefix", async () => {
    // `prefix` narrows the listing; it does not decide the answer. A sibling
    // whose path starts with the same characters must not be served as the one
    // that was asked for.
    stub({
      "/projects": { status: 200, body: [{ id: "p1", name: "SA-DEMO-1" }] },
      "/projects/p1/documents": { status: 200, body: [{ id: "d9", path: PATH + ".bak" }] },
    });
    expect(await readDocumentByPath("t", "SA-DEMO-1", PATH)).toBeNull();
  });

  it("returns null for a project that is not there, rather than throwing", async () => {
    stub({ "/projects": { status: 200, body: [] } });
    expect(await readDocumentByPath("t", "Nope", PATH)).toBeNull();
  });

  it("returns null for a path the project does not hold", async () => {
    stub({
      "/projects": { status: 200, body: [{ id: "p1", name: "SA-DEMO-1" }] },
      "/projects/p1/documents": { status: 200, body: [] },
    });
    expect(await readDocumentByPath("t", "SA-DEMO-1", PATH)).toBeNull();
  });

  it("does nothing without a session", async () => {
    stub({});
    expect(await readDocumentByPath(null, "SA-DEMO-1", PATH)).toBeNull();
    expect(calls).toHaveLength(0);
  });
});
