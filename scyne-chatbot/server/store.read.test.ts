// Reading one stored document by path. Every feature has its own
// `outputs/product-summary.md`, so for a feature's artefact the path alone is
// ambiguous — the read has to be able to say WHICH level it means.

import { describe, expect, it, afterEach } from "vitest";
import { readDocumentByPath } from "./store.js";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const rows = [
  { id: "d-appeals", path: "outputs/product-summary.md", feature: "appeals" },
  { id: "d-intake", path: "outputs/product-summary.md", feature: "intake" },
  { id: "d-proj", path: "solutions/Capabilities/outputs/capability-process.md", feature: null },
];

function stub() {
  const read: string[] = [];
  globalThis.fetch = (async (url: any) => {
    const u = String(url);
    if (u.endsWith("/projects")) return { ok: true, status: 200, json: async () => [{ id: "p1", name: "BAE" }] };
    if (u.includes("/documents?")) return { ok: true, status: 200, json: async () => rows };
    const id = u.split("/").pop()!;
    read.push(id);
    return { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode(`body of ${id}`).buffer };
  }) as any;
  return read;
}

describe("readDocumentByPath", () => {
  it("reads the named feature's copy when a feature is given", async () => {
    const read = stub();
    const b = await readDocumentByPath("tok", "BAE", "outputs/product-summary.md", { feature: "intake" });
    expect(String(b)).toBe("body of d-intake");
    expect(read).toEqual(["d-intake"]);
  });

  it("reads only a project-level row when the feature is null", async () => {
    stub();
    expect(await readDocumentByPath("tok", "BAE", "outputs/product-summary.md", { feature: null })).toBeNull();
    const b = await readDocumentByPath("tok", "BAE", "solutions/Capabilities/outputs/capability-process.md", { feature: null });
    expect(String(b)).toBe("body of d-proj");
  });

  it("matches on path alone when no level is given, as before", async () => {
    stub();
    expect(String(await readDocumentByPath("tok", "BAE", "outputs/product-summary.md"))).toBe("body of d-appeals");
  });
});
