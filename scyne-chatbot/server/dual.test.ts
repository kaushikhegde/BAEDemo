// Creation has to land on BOTH sides of the split.
//
// The agents read a folder tree under `projects/`; `scyne`, the console and
// every platform route read the database. `cli/dual.ts` has written both since
// it was added — the WEB wizard never did, so a project created from the UI had
// a complete folder tree and no row anywhere. The visible consequences were all
// downstream and none of them named the cause: the definition silently failed
// to save, `/spend?by=project` filed every run under an anonymous row because
// `issues.project_id` had no name to resolve, and `/projects/:id/documents`
// could not be reached at all because there was no id.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createProject, createFeature, updateProject, deleteDocumentRow, createDocumentRow, categoryFor } from "./store.js";

type Route = { status: number; body?: unknown };

const calls: Array<{ url: string; method: string; auth?: string; body?: any }> = [];
const realFetch = globalThis.fetch;

/** Routes are matched on `METHOD /path` substrings, longest first. */
const stub = (routes: Record<string, Route>) => {
  globalThis.fetch = vi.fn(async (url: any, init: any) => {
    const u = String(url);
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({
      url: u, method,
      auth: init?.headers?.authorization,
      body: init?.body ? JSON.parse(init.body) : undefined,
    });
    const hit = Object.entries(routes)
      .filter(([k]) => { const [m, p] = k.split(" "); return m === method && u.includes(p); })
      .sort((a, b) => b[0].length - a[0].length)[0]?.[1];
    if (!hit) return { ok: false, status: 404, json: async () => ({}) } as any;
    return {
      ok: hit.status >= 200 && hit.status < 300,
      status: hit.status,
      json: async () => hit.body ?? {},
    } as any;
  }) as any;
};

beforeEach(() => { calls.length = 0; });
afterEach(() => { globalThis.fetch = realFetch; });

const posted = (path: string) => calls.filter(c => c.method === "POST" && c.url.includes(path));
const patched = (path: string) => calls.filter(c => c.method === "PATCH" && c.url.includes(path));

describe("createProject", () => {
  it("creates the row and forwards the CALLER's token", async () => {
    stub({ "POST /projects": { status: 201, body: { id: "p1", name: "SAPN" } } });

    const r = await createProject("caller-token", { name: "SAPN", description: "Who they are", website: "x.com" });

    expect(r.state).toBe("created");
    expect(posted("/projects")).toHaveLength(1);
    expect(posted("/projects")[0].auth).toBe("Bearer caller-token");
    expect(posted("/projects")[0].body).toMatchObject({ name: "SAPN", description: "Who they are" });
  });

  it("treats 409 as exists, not as a failure", async () => {
    // The tree and the database drift apart by design — a `reset` clears one
    // and leaves the other — so re-creating a project whose row survived is an
    // ordinary outcome, and the wizard must not show it as an error.
    stub({
      "POST /projects": { status: 409 },
      "GET /projects": { status: 200, body: [{ id: "p1", name: "SAPN" }] },
      "PATCH /projects/p1": { status: 200 },
    });

    expect((await createProject("t", { name: "SAPN" })).state).toBe("exists");
  });

  it("puts the description onto a row that already existed", async () => {
    // A 409 used to end it there, DISCARDING the paragraph the wizard had just
    // spent a step collecting — after which the assistant goes on asking for a
    // definition the project demonstrably has.
    stub({
      "POST /projects": { status: 409 },
      "GET /projects": { status: 200, body: [{ id: "p1", name: "SAPN" }] },
      "PATCH /projects/p1": { status: 200 },
    });

    const r = await createProject("t", { name: "SAPN", description: "Who they are" });

    expect(r.state).toBe("exists");
    expect(patched("/projects/p1")).toHaveLength(1);
    expect(patched("/projects/p1")[0].body).toMatchObject({ description: "Who they are" });
  });

  it("does not patch when there is no description to save", async () => {
    stub({ "POST /projects": { status: 409 }, "GET /projects": { status: 200, body: [{ id: "p1", name: "SAPN" }] } });
    await createProject("t", { name: "SAPN" });
    expect(patched("/projects/p1")).toHaveLength(0);
  });

  it("reports a name held by an organisation the caller cannot see", async () => {
    // Project names are unique across the install, so a 409 can mean the row
    // belongs to another organisation — where a listing in your own shows
    // nothing. "already there" would send someone looking for a project they
    // will never find.
    stub({ "POST /projects": { status: 409 }, "GET /projects": { status: 200, body: [] } });

    const r = await createProject("t", { name: "SAPN", description: "d" });
    expect(r.state).toBe("exists");
    expect(r.reason).toMatch(/another organisation/i);
  });

  it("reports a real failure without pretending it worked", async () => {
    stub({ "POST /projects": { status: 500, body: { error: "boom" } } });
    const r = await createProject("t", { name: "SAPN" });
    expect(r.state).toBe("failed");
    expect(r.reason).toBeTruthy();
  });

  it("skips, and does not reach upstream, with no token", async () => {
    stub({ "POST /projects": { status: 201 } });
    const r = await createProject(null, { name: "SAPN" });
    expect(r.state).toBe("skipped");
    expect(calls).toHaveLength(0);
  });

  it("survives the orchestrator being unreachable", async () => {
    // `npm run dev` starts both, but they can be started separately. The folder
    // tree is real and worth keeping either way.
    globalThis.fetch = vi.fn(async () => { throw new Error("ECONNREFUSED"); }) as any;
    const r = await createProject("t", { name: "SAPN" });
    expect(r.state).toBe("failed");
    expect(r.reason).toMatch(/ECONNREFUSED/);
  });
});

describe("createFeature", () => {
  it("resolves the project by name, then creates the feature under its id", async () => {
    stub({
      "GET /projects": { status: 200, body: [{ id: "p1", name: "SAPN" }] },
      "POST /projects/p1/features": { status: 201, body: { id: "f1", name: "Appeals & Reviews" } },
    });

    const r = await createFeature("t", { project: "SAPN", feature: "Appeals & Reviews" });

    expect(r.state).toBe("created");
    expect(posted("/projects/p1/features")[0].body).toMatchObject({ name: "Appeals & Reviews" });
  });

  it("says the PROJECT is missing when it is the project that is missing", async () => {
    // Distinguishable from any other failure, because the fix is different:
    // create the project row, not the feature.
    stub({ "GET /projects": { status: 200, body: [] } });
    const r = await createFeature("t", { project: "SAPN", feature: "Appeals" });
    expect(r.state).toBe("failed");
    expect(r.reason).toMatch(/project/i);
  });

  it("treats 409 as exists", async () => {
    stub({
      "GET /projects": { status: 200, body: [{ id: "p1", name: "SAPN" }] },
      "POST /projects/p1/features": { status: 409 },
    });
    expect((await createFeature("t", { project: "SAPN", feature: "Appeals" })).state).toBe("exists");
  });

  it("skips without a token", async () => {
    stub({ "GET /projects": { status: 200, body: [] } });
    expect((await createFeature(null, { project: "SAPN", feature: "Appeals" })).state).toBe("skipped");
    expect(calls).toHaveLength(0);
  });
});

describe("deleteDocumentRow", () => {
  const deleted = (path: string) => calls.filter(c => c.method === "DELETE" && c.url.includes(path));

  it("resolves the project by name and deletes by path at project level", async () => {
    stub({
      "GET /projects": { status: 200, body: [{ id: "p1", name: "SAPN" }] },
      "DELETE /projects/p1/documents": { status: 200, body: { ok: true } },
    });

    const r = await deleteDocumentRow("t", { project: "SAPN", path: "documents/policy.md" });

    expect(r.state).toBe("created");
    const [call] = deleted("/projects/p1/documents");
    expect(call.url).toContain("path=documents%2Fpolicy.md");
    expect(call.url).not.toContain("feature=");
  });

  it("carries the feature when there is one", async () => {
    stub({
      "GET /projects": { status: 200, body: [{ id: "p1", name: "SAPN" }] },
      "DELETE /projects/p1/documents": { status: 200, body: { ok: true } },
    });

    await deleteDocumentRow("t", { project: "SAPN", feature: "Appeals & Reviews", path: "requirements/SOP/x.md" });

    // Asserted by ROUND TRIP rather than by the encoded bytes. A feature name
    // routinely holds a space and an ampersand, and there is more than one
    // correct way to encode either — what has to hold is that the server reads
    // back the name that was sent.
    const q = new URL(deleted("/projects/p1/documents")[0].url).searchParams;
    expect(q.get("feature")).toBe("Appeals & Reviews");
    expect(q.get("path")).toBe("requirements/SOP/x.md");
  });

  it("treats a row that is not there as done, not as a failure", async () => {
    // The two stores drift by design, and the DISK half is the one that decides
    // what the agents read. A file deleted with no row behind it has succeeded
    // at the thing that matters, and must not be reported as an error.
    stub({
      "GET /projects": { status: 200, body: [{ id: "p1", name: "SAPN" }] },
      "DELETE /projects/p1/documents": { status: 404 },
    });
    expect((await deleteDocumentRow("t", { project: "SAPN", path: "documents/x.md" })).state).toBe("exists");
  });

  it("reports a refusal, which is not the same as an absence", async () => {
    stub({
      "GET /projects": { status: 200, body: [{ id: "p1", name: "SAPN" }] },
      "DELETE /projects/p1/documents": { status: 403, body: { error: "forbidden" } },
    });
    const r = await deleteDocumentRow("t", { project: "SAPN", path: "documents/x.md" });
    expect(r.state).toBe("failed");
  });

  it("skips a project that has no row at all", async () => {
    stub({ "GET /projects": { status: 200, body: [] } });
    expect((await deleteDocumentRow("t", { project: "SAPN", path: "documents/x.md" })).state).toBe("skipped");
  });

  it("skips without a token", async () => {
    stub({ "GET /projects": { status: 200, body: [] } });
    expect((await deleteDocumentRow(null, { project: "SAPN", path: "x.md" })).state).toBe("skipped");
    expect(calls).toHaveLength(0);
  });
});

describe("categoryFor", () => {
  it("maps each discovery subfolder to the vocabulary --as writes", () => {
    // `store.available()` counts documents by this field and the assistant
    // reads those counts, so a folder mapped to nothing shows a feature as
    // having no transcripts while three sit on disk.
    expect(categoryFor("requirements/SOP/handling.md")).toBe("sop");
    expect(categoryFor("requirements/Transcripts/w.md")).toBe("transcripts");
    expect(categoryFor("requirements/Notes/n.md")).toBe("notes");
    expect(categoryFor("requirements/UI/screen.png")).toBe("ui");
    expect(categoryFor("requirements/templates/house.md")).toBe("template");
  });

  it("gives a project document no category, as the CLI does", () => {
    expect(categoryFor("documents/policy.md")).toBeNull();
  });

  it("is case-insensitive, because the folder is not spelled one way everywhere", () => {
    // CLAUDE.md says `templates/`; some features carry `Templates/`.
    expect(categoryFor("requirements/sop/x.md")).toBe("sop");
    expect(categoryFor("requirements/Templates/x.md")).toBe("template");
  });

  it("gives an uncategorised feature upload no category rather than guessing", () => {
    // `requirements/<name>` with no subfolder is what an upload with no --as
    // produces. Guessing would tell the BA a transcript is an SOP.
    expect(categoryFor("requirements/loose.md")).toBeNull();
  });
});

describe("createDocumentRow", () => {
  it("stores the bytes base64, under a level-relative path", async () => {
    stub({
      "GET /projects": { status: 200, body: [{ id: "p1", name: "SAPN" }] },
      "POST /projects/p1/documents": { status: 201, body: { id: "d1", version: 1, changed: true } },
    });

    const r = await createDocumentRow("t", {
      project: "SAPN", feature: "MVP",
      path: "requirements/SOP/handling.md", content: Buffer.from("# sop"),
    });

    expect(r.state).toBe("created");
    const [call] = posted("/projects/p1/documents");
    expect(call.body).toMatchObject({
      feature: "MVP", path: "requirements/SOP/handling.md", category: "sop", encoding: "base64",
    });
    // base64 is not an optimisation: a .docx or a screenshot cannot survive a
    // JSON string, and corrupting one would be found much later by a model
    // reading gibberish.
    expect(Buffer.from(call.body.content, "base64").toString()).toBe("# sop");
  });

  it("omits the feature for a project document", async () => {
    stub({
      "GET /projects": { status: 200, body: [{ id: "p1", name: "SAPN" }] },
      "POST /projects/p1/documents": { status: 201, body: { id: "d1" } },
    });
    await createDocumentRow("t", { project: "SAPN", path: "documents/policy.md", content: Buffer.from("x") });
    expect(posted("/projects/p1/documents")[0].body.feature).toBeUndefined();
  });

  it("skips a project with no row, rather than failing the upload", async () => {
    // The file is on disk and every stage can read it. A row that could not be
    // written is worth logging and is not worth refusing the upload over.
    stub({ "GET /projects": { status: 200, body: [] } });
    const r = await createDocumentRow("t", { project: "SAPN", path: "documents/x.md", content: Buffer.from("x") });
    expect(r.state).toBe("skipped");
  });

  it("skips without a token", async () => {
    stub({ "GET /projects": { status: 200, body: [] } });
    const r = await createDocumentRow(null, { project: "SAPN", path: "x.md", content: Buffer.from("x") });
    expect(r.state).toBe("skipped");
    expect(calls).toHaveLength(0);
  });
});

/**
 * The row is the record now, so the caller needs it back.
 *
 * `POST /api/projects` writes the row FIRST and then patches the Azure DevOps
 * target and the extracted theme onto it as each resolves — so it needs the
 * id. While the folder tree was the record, a caller only had to know whether
 * the write had happened.
 */
describe("createProject returns the row", () => {
  it("carries the created project back", async () => {
    stub({ "POST /projects": { status: 201, body: { id: "p1", name: "SA-Demo", ado_target: null } } });
    const r = await createProject("t", { name: "SA-Demo" });
    expect(r.state).toBe("created");
    expect(r.project?.id).toBe("p1");
  });

  it("carries the EXISTING row back on a 409 in this organisation", async () => {
    // The completing-an-incomplete-project path depends on this: the route has
    // to patch a target onto a row it did not just create.
    stub({
      "POST /projects": { status: 409 },
      "GET /projects": { status: 200, body: [{ id: "p9", name: "SA-Demo", ado_target: null }] },
    });
    const r = await createProject("t", { name: "SA-Demo" });
    expect(r.state).toBe("exists");
    expect(r.project?.id).toBe("p9");
  });

  it("carries NO row when the name is held by another organisation", async () => {
    // Project names are unique across the install, so a 409 can name a project
    // this caller cannot list. The route turns a missing row here into
    // `409 name_taken` rather than `502 db_unavailable` — the database is fine.
    stub({ "POST /projects": { status: 409 }, "GET /projects": { status: 200, body: [] } });
    const r = await createProject("t", { name: "SA-Demo" });
    expect(r.state).toBe("exists");
    expect(r.project).toBeUndefined();
    expect(r.reason).toMatch(/another organisation/);
  });

  it("carries no row when the write genuinely failed", async () => {
    stub({ "POST /projects": { status: 500, body: { message: "boom" } } });
    const r = await createProject("t", { name: "SA-Demo" });
    expect(r.state).toBe("failed");
    expect(r.project).toBeUndefined();
  });
});

/**
 * Two values that were written to a FILE and to nothing else.
 *
 * `adoTarget` lived only in `projects/<p>/.published.json`; `projects.theme`
 * has been a supported jsonb column since 002_platform and nothing ever wrote
 * it, so every project in the database carried `{}` while its real palette sat
 * on disk.
 */
describe("updateProject", () => {
  it("patches the Azure DevOps target onto the row", async () => {
    stub({ "PATCH /projects/p1": { status: 200, body: { id: "p1", name: "SA-Demo" } } });
    const target = { org: "Scyne-AI-Lab", project: "SA-Demo", workItemType: "User Story" };
    expect((await updateProject("t", "p1", { adoTarget: target })).state).toBe("created");
    expect(patched("/projects/p1")[0].body).toEqual({ adoTarget: target });
  });

  it("patches the theme", async () => {
    stub({ "PATCH /projects/p1": { status: 200, body: { id: "p1" } } });
    await updateProject("t", "p1", { theme: { brand: "#464e7e" } });
    expect(patched("/projects/p1")[0].body).toEqual({ theme: { brand: "#464e7e" } });
  });

  it("forwards the CALLER's token, never a service credential", async () => {
    stub({ "PATCH /projects/p1": { status: 200, body: {} } });
    await updateProject("caller-token", "p1", { theme: {} });
    expect(patched("/projects/p1")[0].auth).toBe("Bearer caller-token");
  });

  it("reports rather than throws when the patch is refused", async () => {
    // Not fatal at the call site: the Azure DevOps project genuinely exists by
    // then. What is lost is the route's ability to recognise that on a re-post.
    stub({ "PATCH /projects/p1": { status: 403, body: { message: "needs editor" } } });
    const r = await updateProject("t", "p1", { adoTarget: {} });
    expect(r.state).toBe("failed");
    expect(r.reason).toBe("needs editor");
  });

  it("does nothing without a session", async () => {
    stub({});
    expect((await updateProject(null, "p1", { theme: {} })).state).toBe("skipped");
    expect(patched("/projects/p1")).toHaveLength(0);
  });
});
