// The chat writer, which is the first thing ever to write the conversation
// tables. They and their routes shipped with the platform migration and
// nothing used them, so `scyne chat history` printed "(no conversations yet)"
// for every installation, always.
//
// The contract that matters is the one `createDocumentRow` set: best-effort.
// A conversation that fails to record must never fail the conversation.

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { recordChatTurn } from "./store.js";

type Call = { url: string; method: string; body: any };
let calls: Call[] = [];
const realFetch = globalThis.fetch;

function stub(handler: (url: string, method: string) => { status: number; json?: unknown }) {
  globalThis.fetch = (async (url: any, init: any = {}) => {
    const method = (init.method ?? "GET").toUpperCase();
    calls.push({ url: String(url), method, body: init.body ? JSON.parse(init.body) : null });
    const { status, json } = handler(String(url), method);
    return { ok: status >= 200 && status < 300, status, json: async () => json ?? {} };
  }) as any;
}

beforeEach(() => { calls = []; });
afterEach(() => { globalThis.fetch = realFetch; });

const ok = (url: string) =>
  url.endsWith("/conversations") ? { status: 201, json: { id: "conv-1" } }
  : url.includes("/messages") ? { status: 201, json: { id: "msg" } }
  : url.endsWith("/projects") ? { status: 200, json: [{ id: "p1", name: "SAPN" }] }
  : { status: 200, json: [] };

describe("recordChatTurn", () => {
  it("opens one conversation and appends both halves of the turn", async () => {
    stub(ok);
    const r = await recordChatTurn("tok", {
      project: "SAPN", userMessage: "hello", assistantMessage: [{ type: "text", text: "hi" }],
    });
    expect(r.state).toBe("created");
    expect(r.conversationId).toBe("conv-1");

    const posts = calls.filter(c => c.method === "POST");
    expect(posts.filter(c => c.url.endsWith("/conversations"))).toHaveLength(1);
    const messages = posts.filter(c => c.url.includes("/messages"));
    expect(messages.map(m => m.body.role)).toEqual(["user", "assistant"]);
  });

  it("appends to an existing conversation instead of opening a second", async () => {
    stub(ok);
    const r = await recordChatTurn("tok", {
      conversationId: "conv-existing", userMessage: "again", assistantMessage: "sure",
    });
    expect(r.conversationId).toBe("conv-existing");
    expect(calls.filter(c => c.method === "POST" && c.url.endsWith("/conversations"))).toHaveLength(0);
    expect(calls.filter(c => c.url.includes("/messages"))).toHaveLength(2);
  });

  it("titles the conversation from what the person actually said", async () => {
    stub(ok);
    await recordChatTurn("tok", { userMessage: "  generate   the data model  ", assistantMessage: "ok" });
    const created = calls.find(c => c.url.endsWith("/conversations"))!;
    expect(created.body.title).toBe("generate the data model");
  });

  // The three ways it must fail quietly rather than loudly.
  it("skips when nobody is signed in", async () => {
    stub(ok);
    const r = await recordChatTurn(null, { userMessage: "x", assistantMessage: "y" });
    expect(r).toEqual({ state: "skipped", reason: "not signed in" });
    expect(calls).toHaveLength(0);
  });

  it("reports a refusal rather than throwing", async () => {
    stub(() => ({ status: 500, json: { message: "boom" } }));
    const r = await recordChatTurn("tok", { userMessage: "x", assistantMessage: "y" });
    expect(r.state).toBe("failed");
    expect(r.reason).toBe("boom");
  });

  it("reports an unreachable orchestrator rather than throwing", async () => {
    globalThis.fetch = (async () => { throw new Error("ECONNREFUSED"); }) as any;
    const r = await recordChatTurn("tok", { userMessage: "x", assistantMessage: "y" });
    expect(r.state).toBe("failed");
    expect(r.reason).toContain("ECONNREFUSED");
  });
});
