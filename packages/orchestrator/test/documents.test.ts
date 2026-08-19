import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { openDb, migrate, type Db } from "../src/core/db.js";
import { createDocumentStore, sha256Of, type DocumentStore } from "../src/core/documents.js";

let dir: string, db: Db, store: DocumentStore;
let project: string, featureA: string, featureB: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "orch-docs-"));
  db = await openDb({ driver: "pglite", dir });
  await migrate(db, new URL("../migrations", import.meta.url).pathname);

  const company = randomUUID();
  project = randomUUID(); featureA = randomUUID(); featureB = randomUUID();
  await db.query(`insert into companies (id, name) values ($1,'Scyne')`, [company]);
  await db.query(`insert into projects (id, company_id, name) values ($1,$2,'RTWSA')`, [project, company]);
  await db.query(`insert into features (id, project_id, name) values ($1,$2,'Appeals')`, [featureA, project]);
  await db.query(`insert into features (id, project_id, name) values ($1,$2,'Claims')`, [featureB, project]);

  store = createDocumentStore(db);
});
afterEach(async () => { await db.close(); rmSync(dir, { recursive: true, force: true }); });

describe("document store", () => {
  it("round-trips content, including bytes that are not text", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]);
    await store.put({ projectId: project, featureId: featureA, path: "requirements/UI/screen.png", content: png });

    const got = await store.get(project, featureA, "requirements/UI/screen.png");
    expect(got).not.toBeNull();
    expect(Buffer.compare(got!.content, png)).toBe(0);
    expect(got!.ref.bytes).toBe(png.length);
  });

  it("reports changed:false for identical bytes — the harvest contract", async () => {
    const p = { projectId: project, featureId: featureA, path: "outputs/product-summary.md" };
    const first = await store.put({ ...p, content: "# Summary" });
    expect(first.changed).toBe(true);
    expect(first.doc.version).toBe(1);

    const again = await store.put({ ...p, content: "# Summary" });
    expect(again.changed).toBe(false);
    expect(again.doc.version).toBe(1);          // no version burned on a no-op
    expect(again.doc.id).toBe(first.doc.id);

    const changed = await store.put({ ...p, content: "# Summary\n\nRevised." });
    expect(changed.changed).toBe(true);
    expect(changed.doc.version).toBe(2);
  });

  it("keeps one current version and the full history behind it", async () => {
    const p = { projectId: project, featureId: featureA, path: "outputs/stories.md" };
    await store.put({ ...p, content: "v1" });
    await store.put({ ...p, content: "v2" });
    await store.put({ ...p, content: "v3" });

    const current = await store.get(project, featureA, "outputs/stories.md");
    expect(current!.content.toString()).toBe("v3");
    expect(current!.ref.version).toBe(3);

    const history = await store.history(project, featureA, "outputs/stories.md");
    expect(history.map(h => h.version)).toEqual([3, 2, 1]);

    // Every superseded version is still readable by id — that is what makes
    // this a history rather than a changelog.
    const v1 = await store.read(history[2].id);
    expect(v1!.toString()).toBe("v1");
  });

  it("stores one blob when two features upload identical content", async () => {
    const same = "identical policy text";
    await store.put({ projectId: project, featureId: featureA, path: "requirements/SOP/p.md", content: same });
    await store.put({ projectId: project, featureId: featureB, path: "requirements/SOP/p.md", content: same });
    await store.put({ projectId: project, featureId: null, path: "documents/p.md", content: same });

    const blobs = await db.query<{ n: string }>(`select count(*)::text as n from blobs`);
    const docs = await db.query<{ n: string }>(`select count(*)::text as n from documents`);
    expect(blobs.rows[0].n).toBe("1");
    expect(docs.rows[0].n).toBe("3");
    expect(sha256Of(same)).toHaveLength(64);
  });

  it("treats project level and feature level as different documents at the same path", async () => {
    const path = "documents/overview.md";
    await store.put({ projectId: project, featureId: null, path, content: "project view" });
    await store.put({ projectId: project, featureId: featureA, path, content: "feature view" });

    expect((await store.get(project, null, path))!.content.toString()).toBe("project view");
    expect((await store.get(project, featureA, path))!.content.toString()).toBe("feature view");
  });

  it("lists by level, and anyLevel is a third answer rather than a synonym for project level", async () => {
    await store.put({ projectId: project, featureId: null, path: "documents/a.md", content: "a" });
    await store.put({ projectId: project, featureId: featureA, path: "requirements/SOP/b.md", content: "b" });
    await store.put({ projectId: project, featureId: featureB, path: "requirements/SOP/c.md", content: "c" });

    expect((await store.list(project)).map(d => d.path)).toEqual(["documents/a.md"]);
    expect((await store.list(project, { featureId: featureA })).map(d => d.path)).toEqual(["requirements/SOP/b.md"]);
    expect((await store.list(project, { anyLevel: true }))).toHaveLength(3);
  });

  it("filters by category, stage and path prefix", async () => {
    await store.put({ projectId: project, featureId: featureA, path: "requirements/SOP/x.md", content: "x", category: "sop" });
    await store.put({ projectId: project, featureId: featureA, path: "requirements/Transcripts/y.md", content: "y", category: "transcripts" });
    await store.put({ projectId: project, featureId: featureA, path: "outputs/z.md", content: "z", category: "output", stage: "requirements" });

    expect((await store.list(project, { featureId: featureA, category: "sop" })).map(d => d.path))
      .toEqual(["requirements/SOP/x.md"]);
    expect((await store.list(project, { featureId: featureA, stage: "requirements" })).map(d => d.path))
      .toEqual(["outputs/z.md"]);
    expect((await store.list(project, { featureId: featureA, prefix: "requirements/" }))).toHaveLength(2);
  });

  it("carries category forward across versions unless the caller changes it", async () => {
    const p = { projectId: project, featureId: featureA, path: "requirements/SOP/p.md" };
    await store.put({ ...p, content: "v1", category: "sop" });
    const v2 = await store.put({ ...p, content: "v2" });          // no category supplied
    expect(v2.doc.category).toBe("sop");
  });

  it("removes a document without destroying bytes another path still uses", async () => {
    const shared = "shared content";
    await store.put({ projectId: project, featureId: featureA, path: "a.md", content: shared });
    await store.put({ projectId: project, featureId: featureB, path: "b.md", content: shared });

    expect(await store.remove(project, featureA, "a.md")).toBe(true);
    expect(await store.get(project, featureA, "a.md")).toBeNull();
    // The other document is untouched and still readable.
    expect((await store.get(project, featureB, "b.md"))!.content.toString()).toBe(shared);
    expect(await store.remove(project, featureA, "a.md")).toBe(false);   // already gone
  });

  it("returns null for a path that was never written", async () => {
    expect(await store.get(project, featureA, "nope.md")).toBeNull();
    expect(await store.history(project, featureA, "nope.md")).toEqual([]);
  });

  it("lets a removed path be written again, continuing its version history", async () => {
    const p = { projectId: project, featureId: featureA, path: "outputs/x.md" };
    await store.put({ ...p, content: "v1" });
    await store.remove(project, featureA, "outputs/x.md");
    const revived = await store.put({ ...p, content: "v2" });
    expect(revived.changed).toBe(true);
    expect((await store.get(project, featureA, "outputs/x.md"))!.content.toString()).toBe("v2");
  });
});
