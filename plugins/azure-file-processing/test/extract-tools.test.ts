// The two extraction tools, at the seam where a chatbot response becomes a
// tool result. What is worth covering is not "does fetch work" but what
// survives the mapping: `extract_status` deliberately drops a field, and a
// field it drops by accident is one the skill tells the model to read.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { extractStatus, retryExtraction } from "../src/workspace/tools/documents.js";
import { loadConfig } from "../src/shared/config.js";

const ctx = { cfg: loadConfig({}) };
let calls: { url: string; method: string; body: unknown }[] = [];

const answering = (payload: unknown) => vi.fn(async (url: string, init: any) => {
  calls.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : undefined });
  return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
});

beforeEach(() => { calls = []; });
afterEach(() => { vi.unstubAllGlobals(); });

describe("extract_status", () => {
  const failing = {
    ready: 1, missing: 0, failed: 1, extracting: 0,
    documents: [
      { docId: "documents/a.md", scope: "project", state: "ready", extractPath: "/Users/someone/p/solutions/Extracts/aa.extract.json" },
      {
        docId: "requirements/SOP/b.md", scope: "Appeals", state: "failed",
        reason: "no text layer in PDF", attempts: 4,
        firstFailedAt: "2026-08-20T01:00:00.000Z", lastFailedAt: "2026-08-26T09:00:00.000Z",
        extractPath: "/Users/someone/p/Appeals/solutions/Extracts/bb.extract.json",
      },
    ],
  };

  it("carries the attempt count and the last failure time", async () => {
    // The skill tells the model to read `attempts` to decide whether retrying
    // is worth anything. A mapping that drops it makes that advice unfollowable.
    vi.stubGlobal("fetch", answering(failing));
    const out: any = await extractStatus(ctx, { project: "P" });

    expect(out.documents[1]).toMatchObject({
      docId: "requirements/SOP/b.md", state: "failed",
      reason: "no text layer in PDF", attempts: 4,
      lastFailedAt: "2026-08-26T09:00:00.000Z",
    });
  });

  it("still drops extractPath, which names a directory on somebody else's machine", async () => {
    vi.stubGlobal("fetch", answering(failing));
    const out: any = await extractStatus(ctx, { project: "P" });
    expect(JSON.stringify(out)).not.toContain("/Users/someone");
  });

  it("leaves a healthy document with no attempt count rather than 0", async () => {
    vi.stubGlobal("fetch", answering(failing));
    const out: any = await extractStatus(ctx, { project: "P" });
    expect(out.documents[0]).not.toHaveProperty("attempts");
  });
});

describe("retry_extraction", () => {
  it("posts to the project's retry route", async () => {
    vi.stubGlobal("fetch", answering({ ok: true, retrying: [] }));
    await retryExtraction(ctx, { project: "SA Demo" });

    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toContain("/api/extract-retry/SA%20Demo");
    expect(calls[0].body).toEqual({});
  });

  it("sends only the options it was given", async () => {
    // `force` re-extracts documents that are already ready, at an agent run
    // each. A default that leaked through as `false` would be harmless; one
    // that leaked through as `true` would not, so neither is sent unasked.
    vi.stubGlobal("fetch", answering({ ok: true, retrying: [] }));
    await retryExtraction(ctx, { project: "P", doc: "documents/a.md" });
    expect(calls[0].body).toEqual({ doc: "documents/a.md" });

    await retryExtraction(ctx, { project: "P", doc: "documents/a.md", force: true });
    expect(calls[1].body).toEqual({ doc: "documents/a.md", force: true });
  });
});
