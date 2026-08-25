import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/shared/config.js";
import { getStorage, ensureStorage } from "../src/shared/storage.js";
import { WORKSPACE_CONTAINER } from "../src/workspace/paths.js";
import { ensureWorkspaceContainer, syncUp } from "../src/workspace/sync.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const cfg = loadConfig();
const s = getStorage(cfg);
const PROJ = "HOOKTEST";
const FEAT = "demo";

const wipeBlob = async () => {
  const c = s.blob.getContainerClient(WORKSPACE_CONTAINER);
  for await (const b of c.listBlobsFlat({ prefix: `${PROJ}/` })) {
    await c.getBlockBlobClient(b.name).deleteIfExists();
  }
};
const localProj = join(repoRoot, "projects", PROJ);

beforeAll(async () => {
  await ensureStorage(s);
  await ensureWorkspaceContainer(s);
  await wipeBlob();
  rmSync(localProj, { recursive: true, force: true });
  // Seed a project locally, push it to blob, then delete the local copy —
  // so the only way stage.mjs can find it is by syncing down.
  mkdirSync(join(localProj, FEAT, "requirements/SOP"), { recursive: true });
  writeFileSync(join(localProj, FEAT, "requirements/SOP/policy.md"), "# policy\n\nrule one\n");
  mkdirSync(join(localProj, "documents"), { recursive: true });
  writeFileSync(join(localProj, "documents/client.md"), "# client\n");
  await syncUp(s, repoRoot, PROJ);
  rmSync(localProj, { recursive: true, force: true });
});

afterAll(async () => {
  await wipeBlob();
  rmSync(localProj, { recursive: true, force: true });
});

describe("stage.mjs sync hook", () => {
  it("stages a project that exists ONLY in blob", () => {
    expect(existsSync(localProj)).toBe(false);
    execFileSync("node", ["scripts/stage.mjs", PROJ, FEAT, "requirements"], {
      cwd: repoRoot, encoding: "utf8",
    });
    expect(existsSync(join(localProj, FEAT, "requirements/SOP/policy.md"))).toBe(true);
  });

  it("is a no-op on a second run — nothing to pull", () => {
    const out = execFileSync("node", ["scripts/stage.mjs", PROJ, FEAT, "requirements"], {
      cwd: repoRoot, encoding: "utf8",
    });
    expect(out).toMatch(/pulled 0|already up to date|synced/i);
  });
});
