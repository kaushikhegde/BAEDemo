import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile, readFile, rm, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { openDb, migrate, type Db } from "../src/core/db.js";
import { createDocumentStore, type DocumentStore } from "../src/core/documents.js";
import { memoryBlobBackend } from "../src/core/blobs.js";
import {
  materialise, harvest, attribute, createWorkRoot, discardWorkRoot,
  EXCLUDED_FROM_MATERIALISE,
  type Manifest,
} from "../src/core/materialise.js";

let dir: string, db: Db, store: DocumentStore;
let projectId: string, featureId: string;
let installRoot: string, workRoot: string;

const FEATURES = () => [{ id: featureId, name: "Appeals" }];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "orch-mat-"));
  db = await openDb({ driver: "pglite", dir });
  await migrate(db, new URL("../migrations", import.meta.url).pathname);
  store = createDocumentStore(db, memoryBlobBackend());

  const company = randomUUID();
  projectId = randomUUID(); featureId = randomUUID();
  await db.query(`insert into companies (id, name, slug) values ($1,'Scyne','scyne')`, [company]);
  await db.query(`insert into projects (id, company_id, name) values ($1,$2,'RTWSA')`, [projectId, company]);
  await db.query(`insert into features (id, project_id, name) values ($1,$2,'Appeals')`, [featureId, projectId]);

  // A plausible install: the directories an agent's cwd must be able to reach.
  installRoot = mkdtempSync(join(tmpdir(), "orch-install-"));
  for (const d of ["scripts", "skills", "agent-instructions", "examples"]) {
    await mkdir(join(installRoot, d), { recursive: true });
  }
  await writeFile(join(installRoot, "scripts", "stage.mjs"), "// the real script");

  workRoot = await createWorkRoot("orch-test-work-");
});

afterEach(async () => {
  await db.close();
  await discardWorkRoot(workRoot);
  rmSync(dir, { recursive: true, force: true });
  rmSync(installRoot, { recursive: true, force: true });
});

async function seedDocs(): Promise<void> {
  await store.put({ projectId, featureId: null, path: "documents/policy.md", content: "client policy" });
  await store.put({ projectId, featureId, path: "requirements/SOP/sop.md", content: "the sop", category: "sop" });
  await store.put({ projectId, featureId, path: "outputs/product-summary.md", content: "# Summary" });
}

describe("materialise", () => {
  it("writes the tree at exactly the layout the scripts already expect", async () => {
    await seedDocs();
    const manifest = await materialise({ store, projectId, projectName: "RTWSA", features: FEATURES(), installRoot, workRoot });

    expect((await readFile(join(workRoot, "projects/RTWSA/documents/policy.md"), "utf8"))).toBe("client policy");
    expect((await readFile(join(workRoot, "projects/RTWSA/Appeals/requirements/SOP/sop.md"), "utf8"))).toBe("the sop");
    expect((await readFile(join(workRoot, "projects/RTWSA/Appeals/outputs/product-summary.md"), "utf8"))).toBe("# Summary");
    expect(Object.keys(manifest.files)).toHaveLength(3);
  });

  it("links the install's material in, rather than copying it", async () => {
    await materialise({ store, projectId, projectName: "RTWSA", features: FEATURES(), installRoot, workRoot });
    const st = await lstat(join(workRoot, "scripts"));
    expect(st.isSymbolicLink()).toBe(true);
    // and it resolves — an agent told to run `node scripts/stage.mjs` finds it
    expect(await readFile(join(workRoot, "scripts", "stage.mjs"), "utf8")).toBe("// the real script");
  });

  it("creates the directories the renderers write into even with nothing stored", async () => {
    await materialise({ store, projectId, projectName: "RTWSA", features: FEATURES(), installRoot, workRoot });
    await expect(lstat(join(workRoot, "generated-apps"))).resolves.toBeTruthy();
    await expect(lstat(join(workRoot, "projects", "RTWSA"))).resolves.toBeTruthy();
  });
});

describe("harvest", () => {
  const round = async (): Promise<Manifest> =>
    materialise({ store, projectId, projectName: "RTWSA", features: FEATURES(), installRoot, workRoot });

  it("writes back only what changed", async () => {
    await seedDocs();
    const manifest = await round();

    await writeFile(join(workRoot, "projects/RTWSA/Appeals/outputs/product-summary.md"), "# Summary\n\nRevised.");
    const r = await harvest({ store, workRoot, manifest, stage: "requirements" });

    expect(r.written).toEqual(["projects/RTWSA/Appeals/outputs/product-summary.md"]);
    expect(r.unchanged).toHaveLength(2);
    expect(r.missing).toEqual([]);

    const got = await store.get(projectId, featureId, "outputs/product-summary.md");
    expect(got!.content.toString()).toBe("# Summary\n\nRevised.");
    expect(got!.ref.version).toBe(2);
    expect(got!.ref.stage).toBe("requirements");
  });

  it("captures every new file a stage writes, across nested directories", async () => {
    await seedDocs();
    const manifest = await round();

    // What a real stage does: several files, several directories deep.
    const base = join(workRoot, "projects/RTWSA/Appeals");
    await mkdir(join(base, "solutions/DataModel/outputs"), { recursive: true });
    await mkdir(join(base, "solutions/UI/outputs"), { recursive: true });
    await mkdir(join(workRoot, "generated-apps/RTWSA/mockups/Appeals"), { recursive: true });
    await writeFile(join(base, "solutions/DataModel/outputs/salesforce-data-model.md"), "# Data model");
    await writeFile(join(base, "solutions/UI/outputs/mockups.json"), "{}");
    await writeFile(join(base, "outputs/stories.json"), "[]");
    await writeFile(join(workRoot, "generated-apps/RTWSA/index.html"), "<html>");
    await writeFile(join(workRoot, "generated-apps/RTWSA/mockups/Appeals/screen-1.html"), "<html>");
    await writeFile(join(workRoot, "projects/RTWSA/documents/new-policy.md"), "another");

    const r = await harvest({ store, workRoot, manifest, stage: "datamodel" });
    expect(r.written).toHaveLength(6);

    expect((await store.get(projectId, featureId, "solutions/DataModel/outputs/salesforce-data-model.md"))!
      .content.toString()).toBe("# Data model");
    // generated-apps is a project-level artefact, not a feature's
    expect((await store.get(projectId, null, "generated-apps/RTWSA/mockups/Appeals/screen-1.html"))!
      .content.toString()).toBe("<html>");
    expect((await store.get(projectId, null, "documents/new-policy.md"))!.content.toString()).toBe("another");
  });

  it("is idempotent — harvesting twice writes nothing the second time", async () => {
    await seedDocs();
    const manifest = await round();
    await writeFile(join(workRoot, "projects/RTWSA/Appeals/outputs/product-summary.md"), "changed");

    const first = await harvest({ store, workRoot, manifest });
    expect(first.written).toHaveLength(1);

    const second = await harvest({ store, workRoot, manifest });
    expect(second.written).toEqual([]);           // put() reports no change
    expect(second.unchanged).toHaveLength(3);

    // and no second version was burned
    expect((await store.history(projectId, featureId, "outputs/product-summary.md"))).toHaveLength(2);
  });

  it("reports a vanished file without deleting it from the store", async () => {
    await seedDocs();
    const manifest = await round();
    await rm(join(workRoot, "projects/RTWSA/Appeals/requirements/SOP/sop.md"));

    const r = await harvest({ store, workRoot, manifest });
    expect(r.missing).toEqual(["projects/RTWSA/Appeals/requirements/SOP/sop.md"]);

    // Still in the store. This is the whole point: the store is the only copy.
    const survived = await store.get(projectId, featureId, "requirements/SOP/sop.md");
    expect(survived).not.toBeNull();
    expect(survived!.content.toString()).toBe("the sop");
  });

  it("never harvests the linked install, however much code is behind the link", async () => {
    await seedDocs();
    const manifest = await round();
    const r = await harvest({ store, workRoot, manifest });

    // stage.mjs lives behind the `scripts` symlink and must not become a document.
    const all = await store.list(projectId, { anyLevel: true });
    expect(all.some(d => d.path.includes("stage.mjs"))).toBe(false);
    expect([...r.written, ...r.unchanged].some(p => p.startsWith("scripts/"))).toBe(false);
  });

  it("round-trips binary content without corrupting it", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe, 0x01]);
    await store.put({ projectId, featureId, path: "requirements/UI/screen.png", content: png });
    const manifest = await round();

    const onDisk = await readFile(join(workRoot, "projects/RTWSA/Appeals/requirements/UI/screen.png"));
    expect(Buffer.compare(onDisk, png)).toBe(0);

    const r = await harvest({ store, workRoot, manifest });
    expect(r.written).toEqual([]);                // identical bytes, so nothing to write
  });

  it("names a file it cannot attribute rather than dropping it", async () => {
    const manifest = await round();
    await mkdir(join(workRoot, "projects", "SomeOtherProject"), { recursive: true });
    await writeFile(join(workRoot, "projects/SomeOtherProject/stray.md"), "not ours");

    const r = await harvest({ store, workRoot, manifest });
    expect(r.skipped).toEqual(["projects/SomeOtherProject/stray.md"]);
    expect(r.written).toEqual([]);
  });
});

describe("attribute", () => {
  const manifest = {
    files: {}, projectId: "p", projectName: "RTWSA", featuresByName: { Appeals: "f1", "Review & Verify": "f2" },
  } as Manifest;

  it("tells a feature document from a project document", () => {
    expect(attribute("projects/RTWSA/Appeals/outputs/x.md", manifest))
      .toEqual({ featureId: "f1", docPath: "outputs/x.md", category: "output" });
    expect(attribute("projects/RTWSA/documents/x.md", manifest))
      .toEqual({ featureId: null, docPath: "documents/x.md", category: "source" });
  });

  it("handles a feature name with spaces and an ampersand", () => {
    expect(attribute("projects/RTWSA/Review & Verify/requirements/SOP/a.md", manifest))
      .toEqual({ featureId: "f2", docPath: "requirements/SOP/a.md", category: "sop" });
  });

  it("classifies the upload folders the way fileRouter does", () => {
    const cat = (p: string) => attribute(p, manifest)!.category;
    expect(cat("projects/RTWSA/Appeals/requirements/SOP/a.md")).toBe("sop");
    expect(cat("projects/RTWSA/Appeals/requirements/Transcripts/a.md")).toBe("transcripts");
    expect(cat("projects/RTWSA/Appeals/requirements/Notes/a.md")).toBe("notes");
    expect(cat("projects/RTWSA/Appeals/requirements/UI/a.png")).toBe("ui");
  });

  it("treats generated-apps as a project artefact", () => {
    expect(attribute("generated-apps/RTWSA/index.html", manifest))
      .toEqual({ featureId: null, docPath: "generated-apps/RTWSA/index.html", category: "artefact" });
  });

  it("returns null for anything outside this project", () => {
    expect(attribute("projects/OTHER/x.md", manifest)).toBeNull();
    expect(attribute("scripts/stage.mjs", manifest)).toBeNull();
    expect(attribute("projects/RTWSA", manifest)).toBeNull();
  });
});


/**
 * A scratch tree exists on a container with 1–2 GB of ephemeral disk, so what
 * it REFUSES to hold is as load-bearing as what it places.
 */
describe("what a scratch tree refuses to hold", () => {
  const base = () => ({ store, projectId, projectName: "RTWSA", features: FEATURES(), installRoot, workRoot });

  it("never places anything under original-files/", async () => {
    // That directory is the archive of raw uploads and the only part of a
    // project that reaches gigabytes. It lives in object storage and nothing
    // pulls it down — a container would fill on the first restore.
    await store.put({ projectId, featureId: null, path: "documents/policy.md", content: "kept" });
    await store.put({
      projectId, featureId: null,
      path: "original-files/documents/policy.docx", content: "not kept",
    });

    const manifest = await materialise(base());
    const placed = Object.keys(manifest.files);
    expect(placed).toContain("projects/RTWSA/documents/policy.md");
    expect(placed.some(f => f.includes("original-files"))).toBe(false);
  });

  it("excludes the directory itself, not merely paths beneath it", async () => {
    // A prefix test written as `startsWith("original-files/")` alone would let
    // a document stored at exactly `original-files` through.
    expect(EXCLUDED_FROM_MATERIALISE).toContain("original-files");
    await store.put({ projectId, featureId: null, path: "original-files", content: "edge" });
    const manifest = await materialise(base());
    expect(Object.keys(manifest.files).some(f => f.includes("original-files"))).toBe(false);
  });

  it("refuses above the ceiling, naming what it was asked to place", async () => {
    // A loud refusal, because the alternative is a container filling and a run
    // dying on ENOSPC with nothing saying why.
    await store.put({ projectId, featureId: null, path: "documents/big.md", content: "x".repeat(2048) });
    await expect(materialise({ ...base(), maxBytes: 1024 }))
      .rejects.toThrow(/over the ceiling of 1024/);
    await expect(materialise({ ...base(), maxBytes: 1024 }))
      .rejects.toThrow(/documents\/big\.md/);
  });

  it("places a tree that fits, so the ceiling is not simply always fatal", async () => {
    await store.put({ projectId, featureId: null, path: "documents/small.md", content: "x" });
    const manifest = await materialise({ ...base(), maxBytes: 1024 });
    expect(Object.keys(manifest.files)).toContain("projects/RTWSA/documents/small.md");
  });
});
