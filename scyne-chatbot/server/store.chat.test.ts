// The chat writer, which is the first thing ever to write the conversation
// tables. They and their routes shipped with the platform migration and
// nothing used them, so `scyne chat history` printed "(no conversations yet)"
// for every installation, always.
//
// The contract that matters is the one `createDocumentRow` set: best-effort.
// A conversation that fails to record must never fail the conversation.

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { recordChatTurn, loadProjectChat, clearProjectChat } from "./store.js";

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

// The chat is per PROJECT. `conversations.project_id` carried one all along,
// but the browser held ONE conversation id across every project it switched
// between, so a thread begun under one client kept being appended to while the
// person talked about another.

const withChat = (url: string) =>
  url.endsWith("/projects") ? { status: 200, json: [{ id: "p1", name: "SAPN" }] }
  : url.includes("/conversations?projectId=") ? { status: 200, json: [{ id: "conv-1" }, { id: "conv-0" }] }
  : url.includes("/messages") ? { status: 200, json: [
      { role: "user", content: "hello" },
      { role: "assistant", content: [{ type: "text", text: "hi" }] },
    ] }
  : { status: 200, json: {} };

describe("loadProjectChat", () => {
  it("returns the project's most recent conversation and its messages", async () => {
    stub(withChat);
    const r = await loadProjectChat("tok", "SAPN");
    // listConversations orders by updated_at desc, so the first row is the one
    // to resume — this reads it rather than choosing again.
    expect(r?.conversationId).toBe("conv-1");
    expect(r?.messages.map(m => m.role)).toEqual(["user", "assistant"]);
    expect(calls.some(c => c.url.includes("projectId=p1"))).toBe(true);
  });

  it("returns null for a project the database does not know", async () => {
    stub(withChat);
    expect(await loadProjectChat("tok", "NoSuchProject")).toBeNull();
  });

  it("returns null when the project has never been chatted about", async () => {
    stub(url => url.endsWith("/projects") ? { status: 200, json: [{ id: "p1", name: "SAPN" }] }
                : { status: 200, json: [] });
    expect(await loadProjectChat("tok", "SAPN")).toBeNull();
  });

  it("returns null rather than throwing when the orchestrator is unreachable", async () => {
    // The caller opens an empty chat. A chat that will not LOAD must never be a
    // chat that will not START.
    globalThis.fetch = (async () => { throw new Error("ECONNREFUSED"); }) as any;
    expect(await loadProjectChat("tok", "SAPN")).toBeNull();
  });

  it("skips when nobody is signed in", async () => {
    stub(withChat);
    expect(await loadProjectChat(null, "SAPN")).toBeNull();
    expect(calls).toHaveLength(0);
  });
});

describe("clearProjectChat", () => {
  it("deletes every conversation the project has, and only that project's", async () => {
    stub(withChat);
    const r = await clearProjectChat("tok", "SAPN");
    expect(r.state).toBe("created");
    expect(r.cleared).toBe(2);
    const deletes = calls.filter(c => c.method === "DELETE");
    expect(deletes.map(d => d.url.split("/").pop())).toEqual(["conv-1", "conv-0"]);
  });

  it("treats an already-deleted conversation as the outcome asked for", async () => {
    stub((url, method) =>
      method === "DELETE" ? { status: 404, json: { error: "not_found" } } : withChat(url));
    const r = await clearProjectChat("tok", "SAPN");
    expect(r.state).toBe("created");
    expect(r.cleared).toBe(0);
  });

  it("reports a refusal rather than throwing", async () => {
    stub((url, method) =>
      method === "DELETE" ? { status: 403, json: { message: "nope" } } : withChat(url));
    const r = await clearProjectChat("tok", "SAPN");
    expect(r.state).toBe("failed");
    expect(r.reason).toBe("nope");
  });

  it("skips an unknown project instead of clearing nothing silently", async () => {
    stub(withChat);
    const r = await clearProjectChat("tok", "NoSuchProject");
    expect(r.state).toBe("skipped");
    expect(calls.filter(c => c.method === "DELETE")).toHaveLength(0);
  });

  it("skips when nobody is signed in", async () => {
    stub(withChat);
    expect(await clearProjectChat(null, "SAPN")).toEqual({ state: "skipped", reason: "not signed in" });
    expect(calls).toHaveLength(0);
  });
});
