import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readArtefact, MAX_ARTEFACT_BYTES, type ReadScope } from "./artefact-reader.js";

/**
 * The chat reads generated artefacts to answer questions about them. It may
 * only read the fixed files a stage produces, only for a project the caller
 * can already see, and never a path the model made up.
 */

let ws: string;
const visible = { BAE: [{ name: "intake" }], Empty: [] };
const scope = (): ReadScope => ({ workspace: ws, visible });

async function put(rel: string, body: string) {
  const file = path.join(ws, rel);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, body);
}

beforeAll(async () => {
  ws = await fs.mkdtemp(path.join(os.tmpdir(), "artefact-reader-"));
  await put("projects/BAE/solutions/Capabilities/outputs/capability-process.md", "# Capabilities\nL1.1 Source to Pay");
  await put("projects/BAE/intake/outputs/product-summary.md", "# Summary");
  await put("projects/BAE/intake/outputs/stories.md", "# Stories");
  await put("projects/BAE/intake/solutions/QA/outputs/test-cases.md", "x".repeat(MAX_ARTEFACT_BYTES + 10));
  await put("projects/Secret/solutions/Capabilities/outputs/capability-process.md", "secret");
});

afterAll(() => fs.rm(ws, { recursive: true, force: true }));

describe("readArtefact", () => {
  it("reads a project-level artefact", async () => {
    const r = await readArtefact({ project: "BAE", artefact: "capabilities" }, scope());
    expect(r).toMatchObject({ state: "ok", files: ["solutions/Capabilities/outputs/capability-process.md"], truncated: false });
    expect(r.state === "ok" && r.content).toContain("L1.1 Source to Pay");
  });

  it("joins every file of a multi-file artefact", async () => {
    const r = await readArtefact({ project: "BAE", feature: "intake", artefact: "requirements" }, scope());
    expect(r.state).toBe("ok");
    if (r.state !== "ok") return;
    expect(r.files).toEqual(["outputs/product-summary.md", "outputs/stories.md"]);
    expect(r.content).toContain("# Summary");
    expect(r.content).toContain("# Stories");
  });

  it("says not_generated when the stage has not run", async () => {
    const r = await readArtefact({ project: "BAE", artefact: "personas" }, scope());
    expect(r).toEqual({ state: "not_generated", artefact: "personas", files: ["solutions/Experience/outputs/personas-journeys.md"] });
  });

  it("asks for a feature when a feature-level artefact has none", async () => {
    const r = await readArtefact({ project: "BAE", artefact: "qa" }, scope());
    expect(r.state).toBe("invalid");
    expect(r.state === "invalid" && r.reason).toMatch(/which feature/i);
  });

  it("refuses a project the caller cannot see", async () => {
    const r = await readArtefact({ project: "Secret", artefact: "capabilities" }, scope());
    expect(r.state).toBe("invalid");
    expect(r).not.toHaveProperty("content");
  });

  it("refuses path tricks in either name", async () => {
    for (const args of [
      { project: "../Secret", artefact: "capabilities" },
      { project: "BAE", feature: "../../Secret", artefact: "qa" },
      { project: "BAE", feature: "..", artefact: "qa" },
    ]) {
      expect((await readArtefact(args, scope())).state).toBe("invalid");
    }
  });

  it("refuses a feature the project does not have", async () => {
    expect((await readArtefact({ project: "BAE", feature: "nope", artefact: "qa" }, scope())).state).toBe("invalid");
  });

  it("refuses an unknown artefact, including prototype keys", async () => {
    for (const artefact of ["wiki", "__proto__", "toString", ""]) {
      const r = await readArtefact({ project: "BAE", artefact }, scope());
      expect(r.state).toBe("invalid");
    }
  });

  it("caps a large artefact and says so", async () => {
    const r = await readArtefact({ project: "BAE", feature: "intake", artefact: "qa" }, scope());
    expect(r.state).toBe("ok");
    if (r.state !== "ok") return;
    expect(r.truncated).toBe(true);
    expect(Buffer.byteLength(r.content)).toBeLessThanOrEqual(MAX_ARTEFACT_BYTES);
  });
});

/**
 * A run's outputs live in the store, not on disk: every step works in a
 * scratch tree that is harvested into the store and deleted. A project made
 * since then has nothing on disk at all, and an older one has a disk copy that
 * stops matching the moment a revision is approved.
 */
describe("readArtefact — the store is the system of record", () => {
  const stored = (files: Record<string, string>) => {
    const calls: Array<[string, string | null, string]> = [];
    const readStored = async (project: string, feature: string | null, rel: string) => {
      calls.push([project, feature, rel]);
      return files[`${project}|${feature ?? ""}|${rel}`] ?? null;
    };
    return { calls, readStored };
  };

  it("prefers the stored copy over a stale one on disk", async () => {
    const s = stored({ "BAE||solutions/Capabilities/outputs/capability-process.md": "# Revised\nL1.9 Supplier Payments" });
    const r = await readArtefact({ project: "BAE", artefact: "capabilities" }, { ...scope(), readStored: s.readStored });
    expect(r.state === "ok" && r.content).toContain("L1.9 Supplier Payments");
    expect(r.state === "ok" && r.content).not.toContain("L1.1 Source to Pay");
  });

  it("reads an artefact that exists only in the store", async () => {
    const s = stored({ "BAE||solutions/Experience/outputs/personas-journeys.md": "# Personas\nAlex — Requester" });
    const r = await readArtefact({ project: "BAE", artefact: "personas" }, { ...scope(), readStored: s.readStored });
    expect(r).toMatchObject({ state: "ok", files: ["solutions/Experience/outputs/personas-journeys.md"] });
  });

  it("falls back to disk when the store has no copy", async () => {
    const s = stored({});
    const r = await readArtefact({ project: "BAE", artefact: "capabilities" }, { ...scope(), readStored: s.readStored });
    expect(r.state === "ok" && r.content).toContain("L1.1 Source to Pay");
  });

  it("asks the store for a project artefact with no feature, and a feature artefact with its feature", async () => {
    const s = stored({});
    await readArtefact({ project: "BAE", feature: "intake", artefact: "capabilities" }, { ...scope(), readStored: s.readStored });
    await readArtefact({ project: "BAE", feature: "intake", artefact: "requirements" }, { ...scope(), readStored: s.readStored });
    expect(s.calls).toEqual([
      ["BAE", null, "solutions/Capabilities/outputs/capability-process.md"],
      ["BAE", "intake", "outputs/product-summary.md"],
      ["BAE", "intake", "outputs/stories.md"],
    ]);
  });
});
