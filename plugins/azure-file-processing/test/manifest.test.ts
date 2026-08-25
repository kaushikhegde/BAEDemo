import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashFile, localManifest, diff, type Entry } from "../src/workspace/manifest.js";

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "ws-man-"));
  mkdirSync(join(root, "projects/SAPN/MVP/requirements/SOP"), { recursive: true });
  mkdirSync(join(root, "projects/SAPN/documents"), { recursive: true });
  mkdirSync(join(root, "projects/OTHER"), { recursive: true });
  writeFileSync(join(root, "projects/SAPN/MVP/requirements/SOP/a.md"), "alpha");
  writeFileSync(join(root, "projects/SAPN/documents/policy.md"), "policy");
  writeFileSync(join(root, "projects/SAPN/documents/empty.md"), "");
  writeFileSync(join(root, "projects/SAPN/MVP/requirements/SOP/same1.txt"), "aaaaa");
  writeFileSync(join(root, "projects/SAPN/MVP/requirements/SOP/same2.txt"), "bbbbb");
  writeFileSync(join(root, "projects/OTHER/x.md"), "other");
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

const e = (path: string, sha256: string, bytes = 1): Entry => ({ path, sha256, bytes });

describe("hashFile", () => {
  it("is the sha256 of the contents", async () => {
    // Verify independently: printf 'alpha' | shasum -a 256
    const h = await hashFile(join(root, "projects/SAPN/MVP/requirements/SOP/a.md"));
    const { createHash } = await import("node:crypto");
    expect(h).toBe(createHash("sha256").update("alpha").digest("hex"));
  });

  it("returns 64 hex characters", async () => {
    const h = await hashFile(join(root, "projects/SAPN/documents/policy.md"));
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it("differs for different content", async () => {
    const a = await hashFile(join(root, "projects/SAPN/MVP/requirements/SOP/a.md"));
    const b = await hashFile(join(root, "projects/SAPN/documents/policy.md"));
    expect(a).not.toBe(b);
  });

  it("differs for same-length different content", async () => {
    const file1 = join(root, "projects/SAPN/MVP/requirements/SOP/same1.txt");
    const file2 = join(root, "projects/SAPN/MVP/requirements/SOP/same2.txt");
    const h1 = await hashFile(file1);
    const h2 = await hashFile(file2);
    expect(h1).not.toBe(h2);
  });
});

describe("localManifest", () => {
  it("lists a project's files as blob paths, recursively", async () => {
    const m = await localManifest(root, "SAPN");
    expect(m.map((x) => x.path)).toEqual([
      "SAPN/documents/empty.md",
      "SAPN/documents/policy.md",
      "SAPN/MVP/requirements/SOP/a.md",
      "SAPN/MVP/requirements/SOP/same1.txt",
      "SAPN/MVP/requirements/SOP/same2.txt",
    ]);
  });

  it("does not leak another project's files", async () => {
    const m = await localManifest(root, "SAPN");
    expect(m.some((x) => x.path.startsWith("OTHER/"))).toBe(false);
  });

  it("narrows to a prefix", async () => {
    const m = await localManifest(root, "SAPN", "MVP/requirements");
    expect(m.map((x) => x.path)).toEqual([
      "SAPN/MVP/requirements/SOP/a.md",
      "SAPN/MVP/requirements/SOP/same1.txt",
      "SAPN/MVP/requirements/SOP/same2.txt",
    ]);
  });

  it("returns empty for a project that does not exist locally", async () => {
    expect(await localManifest(root, "NOPE")).toEqual([]);
  });

  it("records byte length", async () => {
    const m = await localManifest(root, "SAPN", "documents");
    const policy = m.find((x) => x.path === "SAPN/documents/policy.md");
    expect(policy?.bytes).toBe(6); // "policy"
  });

  it("records zero-byte files", async () => {
    const m = await localManifest(root, "SAPN", "documents");
    const empty = m.find((x) => x.path === "SAPN/documents/empty.md");
    expect(empty).toBeDefined();
    expect(empty?.bytes).toBe(0);
    expect(empty?.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("skips symlinks pointing outside the project", async () => {
    const outside = join(root, "outside.txt");
    writeFileSync(outside, "external content");
    const linkPath = join(root, "projects/SAPN/documents/link.md");
    symlinkSync(outside, linkPath);
    const m = await localManifest(root, "SAPN");
    expect(m.some((x) => x.path === "SAPN/documents/link.md")).toBe(false);
  });
});

describe("diff", () => {
  it("classifies every file exactly once", () => {
    const local = [e("a", "h1"), e("b", "h2"), e("c", "h3")];
    const remote = [e("b", "h2"), e("c", "hX"), e("d", "h4")];
    const d = diff(local, remote);
    expect(d.onlyLocal.map((x) => x.path)).toEqual(["a"]);
    expect(d.onlyRemote.map((x) => x.path)).toEqual(["d"]);
    expect(d.differing.map((x) => x.path)).toEqual(["c"]);
    expect(d.same.map((x) => x.path)).toEqual(["b"]);
  });

  it("is empty on both sides for identical trees", () => {
    const both = [e("a", "h1"), e("b", "h2")];
    const d = diff(both, both);
    expect(d.onlyLocal).toEqual([]);
    expect(d.onlyRemote).toEqual([]);
    expect(d.differing).toEqual([]);
    expect(d.same).toHaveLength(2);
  });

  it("classifies same-length different-content files as differing", async () => {
    const local = await localManifest(root, "SAPN", "MVP/requirements/SOP");
    const same1 = local.find((x) => x.path.includes("same1.txt"));
    const same2 = local.find((x) => x.path.includes("same2.txt"));
    expect(same1).toBeDefined();
    expect(same2).toBeDefined();
    expect(same1?.bytes).toBe(same2?.bytes); // same length
    expect(same1?.sha256).not.toBe(same2?.sha256); // different hash
    // Now test that diff classifies them correctly
    const remote: Entry[] = [
      { path: same1!.path, sha256: same2!.sha256, bytes: same1!.bytes }, // pretend local has remote's hash
    ];
    const d = diff([same1!], remote);
    expect(d.differing).toHaveLength(1);
    expect(d.differing[0].path).toBe(same1?.path);
  });
});
