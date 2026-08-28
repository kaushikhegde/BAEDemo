import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resolveProjectId, forgetProjectIds } from "../src/workspace/doc-store.js";
import { storedPathFor } from "../src/workspace/tools/attach-document.js";
import { loadConfig } from "../src/shared/config.js";

/**
 * Documents go to the orchestrator's store — object storage plus a database
 * row, written together — and never to `projects/` on disk.
 *
 * The old path POSTed to the chatbot's `/api/upload`, which did an
 * `fs.writeFile` into the tree and left the store untouched. That made disk
 * the record, which is backwards, and produced two real failures: a document
 * on disk with no row when the blob write failed, and an upload that only
 * worked where the plugin shared a filesystem with the tree. An end user has
 * no `projects/` folder, so that path could never ship.
 */

const ctx = () => ({ cfg: { ...loadConfig({}), orchUrl: "http://orch.test", orchToken: "t" } as any });

describe("project name -> id", () => {
  beforeEach(() => { forgetProjectIds(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  const serve = (projects: any[]) => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: any) => {
      calls.push(String(url));
      return new Response(JSON.stringify(projects), { status: 200 });
    });
    return calls;
  };

  it("resolves by name", async () => {
    serve([{ id: "uuid-1", name: "SA-DEMO" }]);
    expect(await resolveProjectId(ctx(), "SA-DEMO")).toBe("uuid-1");
  });

  it("falls back to the slug, and to case-insensitive", async () => {
    // `SA Demo` is stored with a slug of `SA-DEMO`, and the tools take whatever
    // the person typed.
    serve([{ id: "uuid-2", name: "SA Demo", slug: "SA-DEMO" }]);
    expect(await resolveProjectId(ctx(), "SA-DEMO")).toBe("uuid-2");
    forgetProjectIds();
    serve([{ id: "uuid-2", name: "SA Demo" }]);
    expect(await resolveProjectId(ctx(), "sa demo")).toBe("uuid-2");
  });

  it("caches, so an upload is not two round trips", async () => {
    const calls = serve([{ id: "uuid-3", name: "P" }]);
    await resolveProjectId(ctx(), "P");
    await resolveProjectId(ctx(), "P");
    expect(calls.length).toBe(1);
  });

  it("does NOT cache a miss, so a project created a moment ago resolves", async () => {
    serve([]);
    await expect(resolveProjectId(ctx(), "New")).rejects.toThrow();
    serve([{ id: "uuid-4", name: "New" }]);
    expect(await resolveProjectId(ctx(), "New")).toBe("uuid-4");
  });

  it("names the projects that DO exist, because a typo is the usual cause", async () => {
    serve([{ id: "a", name: "Alpha" }, { id: "b", name: "Beta" }]);
    await expect(resolveProjectId(ctx(), "Alfa")).rejects.toThrow(/Alpha, Beta/);
  });
});

describe("stored path — the convention every stage globs for", () => {
  it("puts a project document under documents/", () => {
    expect(storedPathFor("policy.md")).toBe("documents/policy.md");
  });

  it("puts a feature document in the folder its KIND names", () => {
    // The pipeline reads the folder, not the filename: the BA treats
    // Transcripts/ as the source of stories and SOP/ as context that is
    // explicitly not stories, so this choice changes what the document means.
    expect(storedPathFor("call.md", "intake", "transcripts")).toBe("requirements/Transcripts/call.md");
    expect(storedPathFor("p.md", "intake", "sop")).toBe("requirements/SOP/p.md");
    expect(storedPathFor("s.md", "intake", "ui")).toBe("requirements/UI/s.md");
  });

  it("defaults an unspecified kind to Notes rather than guessing at SOP", () => {
    expect(storedPathFor("x.md", "intake")).toBe("requirements/Notes/x.md");
  });

  it("never produces a path outside the level root", () => {
    // The store versions by path; a `..` would address a level this document
    // does not belong to.
    for (const p of [storedPathFor("a.md"), storedPathFor("b.md", "f", "notes")]) {
      expect(p.includes("..")).toBe(false);
      expect(p.startsWith("/")).toBe(false);
    }
  });
});
