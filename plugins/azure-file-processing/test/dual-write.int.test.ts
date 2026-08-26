import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { writeFile, mkdtemp } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/shared/config.js";
import { createProject, createFeature, listProjects, listFeatures, listDocuments } from "../src/workspace/tools/workspace.js";
import { attachDocument } from "../src/workspace/tools/attach-document.js";

const cfg = loadConfig();
const ctx = { cfg };
const NAME = "PLUGIN-DUALWRITE-TEST";

beforeAll(async () => {
  // The chatbot has NO /api/health — everything under /api except /api/auth/*
  // is behind requireSession. So probe a real route and treat ANY HTTP answer,
  // 401 included, as "the server is up": a 401 here is a token problem, which
  // the unauthenticated test below is what checks.
  const res = await fetch(`${cfg.chatbotUrl}/api/features`).catch(() => null);
  if (!res) {
    throw new Error(
      `The Scyne chatbot is not running at ${cfg.chatbotUrl}. ` +
      `\`npm run dev\` from the repo root starts it on :4000.`);
  }
});

// NOTE: this file's first run (2026-08-25) created TWO real Azure DevOps
// projects — "PLUGIN-DUALWRITE-TEST" and "PLUGIN-DUALWRITE-TEST-Two" — in the
// live Scyne-AI-Lab org, because createProject really does write all three
// stores. That is a genuine, standing side effect on the client's tenant
// (same category as the stray "ExtractProof" project), left for the repo
// owner to delete by hand. It must NOT be repeated: `ensureAdoProject`
// (scyne-chatbot/server/services/adoProject.ts) checks-then-creates, so
// re-running against the SAME name reuses the existing ADO project rather
// than creating a third one — which is why this suite deliberately does not
// delete the project tree for `NAME` any more (a local delete would desync
// disk from the ADO project and database row that are staying regardless,
// and the next run would just recreate the tree against the same target).
// Never rename `NAME`/`NAME Two` to a fresh string — that WOULD create a new
// stray project.
afterAll(async () => {
  // Nothing to clean up here on purpose — see the note above.
});

describe("createProject", () => {
  it("creates the tree and reports BOTH halves (or confirms it already did)", async () => {
    // Idempotent by design, and MUST be: this project now exists permanently
    // (see the file-level note). A fresh checkout hits the true "create"
    // branch once; every run after that hits "exists" — both are a pass here.
    const r = await createProject(ctx, { project: NAME, description: "A dual-write test project." })
      .catch((e) => e);
    if (r instanceof Error) {
      expect(r.message).toMatch(/exists|incomplete/i);
    } else {
      expect(r.project).toBe(NAME);
      // The point of the task: the database half is REPORTED, whichever way it went.
      expect(r).toHaveProperty("dbError");
      expect(r).toHaveProperty("db");
    }
    expect(existsSync(join(cfg.workspaceRoot, "projects", NAME, "documents"))).toBe(true);
  });

  it("reports a slug rather than silently renaming", async () => {
    const r = await createProject(ctx, { project: `${NAME} Two` }).catch((e) => e);
    if (r instanceof Error) {
      // Already exists from a previous run — acceptable, and it must SAY so.
      expect(r.message).toMatch(/exists|slug_collision/);
    } else {
      expect(r.project).toBe(`${NAME}-Two`);
      expect(r.slugged).toEqual({ from: `${NAME} Two`, to: `${NAME}-Two` });
      // No cleanup here — see the file-level note above `afterAll`. This
      // project is now a real, permanent ADO project; deleting only its local
      // tree would desync disk from ADO and the database row.
    }
  });

  it("refuses a duplicate rather than reporting success", async () => {
    await expect(createProject(ctx, { project: NAME })).rejects.toThrow(/exists|incomplete/i);
  });
});

describe("createFeature", () => {
  it("creates one under an existing project (or confirms it already did)", async () => {
    // Unlike createProject, /api/features is NOT idempotent by name — a
    // second create of the same feature answers 409 "exists" rather than
    // completing quietly. `NAME`'s "Dual Write" feature now exists permanently
    // (see the file-level note above), so tolerate that outcome the same way.
    const r = await createFeature(ctx, { project: NAME, feature: "Dual Write" }).catch((e) => e);
    if (r instanceof Error) {
      expect(r.message).toMatch(/exists/i);
    } else {
      expect(r.feature).toBe("Dual Write");
      expect(r).toHaveProperty("dbError");
    }
    expect(existsSync(join(cfg.workspaceRoot, "projects", NAME, "Dual Write", "requirements", "SOP")))
      .toBe(true);
  });

  it("refuses a reserved name, naming the reason", async () => {
    await expect(createFeature(ctx, { project: NAME, feature: "personas" }))
      .rejects.toThrow(/reserved/i);
  });

  it("refuses an unknown project", async () => {
    await expect(createFeature(ctx, { project: "NO-SUCH-PROJECT-XYZ", feature: "x" }))
      .rejects.toThrow(/no_project|No project/i);
  });
});

describe("unauthenticated", () => {
  it("says so instead of reporting a creation failure", async () => {
    const anon = { cfg: { ...cfg, orchToken: null } };
    await expect(createProject(anon as any, { project: `${NAME}-Anon` }))
      .rejects.toThrow(/not_authenticated|401/);
  });
});

describe("attachDocument", () => {
  it("uploads a local file and reports the name it BECAME", async () => {
    const dir = await mkdtemp(join(tmpdir(), "attach-"));
    const src = join(dir, "policy note.md");
    await writeFile(src, "# Handling policy\n\nClaims are triaged within 24 hours.\n");

    const r = await attachDocument(ctx, { project: NAME, path: src });
    expect(r.filename).toBeTruthy();
    expect(r.storedPath).toMatch(/^documents\//);
    expect(r).toHaveProperty("converted");
    expect(r).toHaveProperty("dbError");
  });

  it("refuses a file that is not there, naming the path", async () => {
    await expect(attachDocument(ctx, { project: NAME, path: "/no/such/file.md" }))
      .rejects.toThrow(/\/no\/such\/file\.md/);
  });

  it("routes a feature-level document into a named folder", async () => {
    const dir = await mkdtemp(join(tmpdir(), "attach-"));
    const src = join(dir, "kickoff.md");
    await writeFile(src, "Transcript of the kickoff call.\n");
    const r = await attachDocument(ctx, {
      project: NAME, feature: "Dual Write", path: src, kind: "transcripts",
    });
    expect(r.storedPath).toMatch(/Transcripts\//);
  });
});

describe("listings", () => {
  it("lists projects", async () => {
    const r = await listProjects(ctx);
    expect(r.projects).toContain(NAME);
  });

  it("lists features under one project", async () => {
    const r = await listFeatures(ctx, { project: NAME });
    expect(r.features).toContain("Dual Write");
  });

  it("lists documents without leaking the two-store reconciliation", async () => {
    const r = await listDocuments(ctx, { project: NAME });
    expect(Array.isArray(r.documents)).toBe(true);
    for (const d of r.documents) {
      expect(d.path).toBeTypeOf("string");
      // `inDb` used to ride along on every row, beside a `notInDb` count and a
      // literal `fix: "npm run sync:docs -- --apply"`. This plugin is installed
      // by end users who have no checkout to run that in and no shell on the
      // machine holding the tree — so it was an instruction to do something
      // impossible about a state they cannot cause. It is logged for the
      // operator instead.
      expect(d).not.toHaveProperty("inDb");
    }
    expect(r).not.toHaveProperty("notInDb");
    expect(r).not.toHaveProperty("fix");
    // `stale` stays: re-running an artefact costs agent time and money, so it
    // is genuinely the caller's decision rather than the operator's.
    expect(r).toHaveProperty("stale");
  });
});
