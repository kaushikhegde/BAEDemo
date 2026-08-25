import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/shared/config.js";
import { getStorage, ensureStorage } from "../src/shared/storage.js";
import { WORKSPACE_CONTAINER } from "../src/workspace/paths.js";
import { ensureWorkspaceContainer } from "../src/workspace/sync.js";

const script = resolve(dirname(fileURLToPath(import.meta.url)), "../scripts/sync.mjs");
const tsx = resolve(dirname(fileURLToPath(import.meta.url)), "../node_modules/.bin/tsx");
const cfg = loadConfig();
const s = getStorage(cfg);
const PROJ = "CLITEST";
let root: string;

const run = (...args: string[]) => {
  const out = execFileSync(tsx, [script, PROJ, "--root", root, ...args], { encoding: "utf8" }).trim();
  return JSON.parse(out);
};

const wipeBlob = async () => {
  const c = s.blob.getContainerClient(WORKSPACE_CONTAINER);
  for await (const b of c.listBlobsFlat({ prefix: `${PROJ}/` })) {
    await c.getBlockBlobClient(b.name).deleteIfExists();
  }
};

beforeAll(async () => { await ensureStorage(s); await ensureWorkspaceContainer(s); });
beforeEach(async () => {
  await wipeBlob();
  if (root) rmSync(root, { recursive: true, force: true });
  root = mkdtempSync(join(tmpdir(), "ws-cli-"));
  mkdirSync(join(root, "projects", PROJ, "documents"), { recursive: true });
  writeFileSync(join(root, "projects", PROJ, "documents/a.md"), "hello");
});
afterAll(async () => { await wipeBlob(); if (root) rmSync(root, { recursive: true, force: true }); });

describe("sync.mjs", () => {
  it("pushes and reports JSON", () => {
    const out = run("--up");
    expect(out).toMatchObject({ ok: true, direction: "up", pushed: 1 });
  });

  it("pulls into an empty tree", () => {
    run("--up");
    rmSync(join(root, "projects", PROJ), { recursive: true, force: true });
    const out = run("--down");
    expect(out).toMatchObject({ ok: true, direction: "down", pulled: 1 });
    expect(existsSync(join(root, "projects", PROJ, "documents/a.md"))).toBe(true);
  });

  it("reports status without moving anything", () => {
    const out = run("--status");
    expect(out.onlyLocal).toContain(`${PROJ}/documents/a.md`);
    expect(run("--status").onlyLocal).toHaveLength(1);
  });

  it("honours --dry-run", () => {
    expect(run("--up", "--dry-run")).toMatchObject({ dryRun: true, pushed: 1 });
    expect(run("--status").onlyLocal).toHaveLength(1);
  });

  it("exits non-zero and names the problem with no direction flag", () => {
    let code = 0, err = "";
    try {
      execFileSync(tsx, [script, PROJ, "--root", root], { encoding: "utf8" });
    } catch (e: any) { code = e.status; err = String(e.stderr ?? ""); }
    expect(code).not.toBe(0);
    expect(err).toMatch(/--up|--down|--status/);
  });
});
