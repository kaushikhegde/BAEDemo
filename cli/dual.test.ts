// Creation, on both sides of the split — and which side writes what.
//
// The document row is the subtle one. It used to be written HERE, from the
// bytes read off this machine, under a path computed before the upload. Both
// were wrong by the time the write landed: the server converts on arrival and
// MOVES the source into original-files/, so the row held raw .docx bytes at a
// path naming a file that no longer existed. Only the server knows the
// converted name, so only the server may write the row — and this file is the
// guard against it quietly coming back and producing two rows per upload.

import { test } from "node:test";
import assert from "node:assert/strict";
import { uploadDocument, suggestProjectName } from "./dual.ts";

type Call = { url: string; method: string };

/** Stub global fetch (the chatbot) and a Client (the platform API). */
function harness(chat: { status: number; body?: unknown }) {
  const calls: Call[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any) => {
    calls.push({ url: String(url), method: (init?.method ?? "GET").toUpperCase() });
    return {
      ok: chat.status >= 200 && chat.status < 300,
      status: chat.status,
      json: async () => chat.body ?? {},
    };
  }) as any;

  const client: any = {
    config: {},
    get: async (path: string) => {
      calls.push({ url: path, method: "GET" });
      return path === "/projects" ? [{ id: "p1", name: "SAPN" }] : {};
    },
    post: async (path: string) => { calls.push({ url: path, method: "POST" }); return {}; },
    patch: async (path: string) => { calls.push({ url: path, method: "PATCH" }); return {}; },
    put: async (path: string) => { calls.push({ url: path, method: "PUT" }); return {}; },
    del: async (path: string) => { calls.push({ url: path, method: "DELETE" }); return {}; },
  };
  return { calls, client, restore: () => { globalThis.fetch = realFetch; } };
}

/** A file this machine really has, so readFile succeeds. */
const SELF = new URL(import.meta.url).pathname;

test("the document row is written by the SERVER, never a second time from here", async () => {
  const h = harness({
    status: 200,
    body: { filename: "handling.md", converted: true, path: "requirements/SOP/handling.md", db: { state: "created" } },
  });
  try {
    const r = await uploadDocument(h.client, {
      project: "SAPN", feature: "MVP", file: SELF, as: "sop",
    });

    // Exactly one write, and it is the multipart upload to the chatbot.
    const writes = h.calls.filter(c => c.method === "POST" || c.method === "PUT");
    assert.equal(writes.length, 1, `expected one write, got ${JSON.stringify(h.calls)}`);
    assert.ok(writes[0].url.includes("/api/upload"), writes[0].url);
    // Never this: it would create a SECOND row, holding the pre-conversion
    // bytes at a path the converter has already renamed.
    assert.ok(!h.calls.some(c => c.url.includes("/documents")),
      "the CLI must not post a document row of its own");

    assert.equal(r.db.state, "created");
    assert.equal(r.disk.state, "created");
  } finally { h.restore(); }
});

test("the path reported is the one the SERVER wrote, after conversion", async () => {
  // The guess made before the upload is `requirements/SOP/dual.test.ts`. What
  // matters is what actually landed — with no --as the server's own routeFile()
  // picks the subfolder, so the guess can be wrong about the folder too.
  const h = harness({
    status: 200,
    body: { filename: "handling.md", converted: true, path: "requirements/Transcripts/handling.md", db: { state: "created" } },
  });
  try {
    const r = await uploadDocument(h.client, { project: "SAPN", feature: "MVP", file: SELF });
    assert.equal(r.extra?.path, "requirements/Transcripts/handling.md");
  } finally { h.restore(); }
});

test("a rejected upload records nothing, on either side", async () => {
  // An ambiguous .docx is refused outright, so no file is written. A row
  // created anyway is a document that exists for every person and no agent.
  const h = harness({ status: 409, body: { error: "ambiguous_kind", message: "Couldn't infer where it belongs." } });
  try {
    const r = await uploadDocument(h.client, { project: "SAPN", feature: "MVP", file: SELF });
    assert.equal(r.disk.state, "failed");
    assert.equal(r.db.state, "skipped");
    assert.ok(!h.calls.some(c => c.url.includes("/documents")));
  } finally { h.restore(); }
});

test("an unreachable chatbot records nothing rather than half of it", async () => {
  const realFetch = globalThis.fetch;
  const calls: Call[] = [];
  globalThis.fetch = (async () => { throw new Error("ECONNREFUSED"); }) as any;
  const client: any = {
    get: async (p: string) => { calls.push({ url: p, method: "GET" }); return [{ id: "p1", name: "SAPN" }]; },
    post: async (p: string) => { calls.push({ url: p, method: "POST" }); return {}; },
  };
  try {
    const r = await uploadDocument(client, { project: "SAPN", feature: "MVP", file: SELF, as: "sop" });
    assert.equal(r.disk.state, "skipped");
    // The upload never happened. A row pointing at a file nothing wrote is
    // worse than no row: `/docs` lists it and no stage can read it.
    assert.equal(r.db.state, "skipped");
    assert.ok(!calls.some(c => c.url.includes("/documents")));
  } finally { globalThis.fetch = realFetch; }
});

test("a server that reports no database half says so, rather than guessing", async () => {
  const h = harness({ status: 200, body: { filename: "handling.md", converted: true } });
  try {
    const r = await uploadDocument(h.client, { project: "SAPN", feature: "MVP", file: SELF, as: "sop" });
    assert.equal(r.db.state, "skipped");
    assert.match(String(r.db.detail), /did not say/i);
  } finally { h.restore(); }
});

test("a failed row is reported as failed, not swallowed", async () => {
  const h = harness({
    status: 200,
    body: { filename: "h.md", path: "requirements/SOP/h.md", db: { state: "failed", reason: "no such project in the database" } },
  });
  try {
    const r = await uploadDocument(h.client, { project: "SAPN", feature: "MVP", file: SELF, as: "sop" });
    assert.equal(r.db.state, "failed");
    assert.match(String(r.db.detail), /no such project/);
  } finally { h.restore(); }
});

test("suggestProjectName matches the server's slug rule", () => {
  // Two copies of one rule, because cli/ carries no dependency it could import
  // through. They must agree, or `scyne project create` and the web wizard
  // create two different projects from the same typed name.
  assert.equal(suggestProjectName("SA Power Networks"), "SA-Power-Networks");
  assert.equal(suggestProjectName("SAPN"), "SAPN");
  assert.equal(suggestProjectName("  SA   Power "), "SA-Power");
  assert.equal(suggestProjectName("SA - Power"), "SA-Power");
  assert.equal(suggestProjectName("SA--Power"), "SA-Power");
  assert.equal(suggestProjectName(""), "");
  // Idempotent, so applying it defensively cannot rename a working project.
  for (const n of ["SA Power Networks", "SA - Power", "  SAPN "]) {
    assert.equal(suggestProjectName(suggestProjectName(n)), suggestProjectName(n));
  }
});
