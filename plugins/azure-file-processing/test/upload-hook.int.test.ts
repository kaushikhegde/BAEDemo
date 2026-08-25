import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/shared/config.js";
import { getStorage, ensureStorage } from "../src/shared/storage.js";
import { WORKSPACE_CONTAINER } from "../src/workspace/paths.js";
import { ensureWorkspaceContainer, syncStatus } from "../src/workspace/sync.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const SYNC_TSX = join(repoRoot, "plugins/azure-file-processing/node_modules/.bin/tsx");
const SYNC_CLI = join(repoRoot, "plugins/azure-file-processing/scripts/sync.mjs");
const cfg = loadConfig();
const s = getStorage(cfg);
const PROJ = "UPLOADHOOK";

const wipeBlob = async () => {
  const c = s.blob.getContainerClient(WORKSPACE_CONTAINER);
  for await (const b of c.listBlobsFlat({ prefix: `${PROJ}/` })) {
    await c.getBlockBlobClient(b.name).deleteIfExists();
  }
};

beforeAll(async () => { await ensureStorage(s); await ensureWorkspaceContainer(s); await wipeBlob(); });
afterAll(async () => {
  await wipeBlob();
  rmSync(join(repoRoot, "projects", PROJ), { recursive: true, force: true });
});

describe("upload route sync hook", () => {
  it("a document written into the tree reaches blob when the hook runs", async () => {
    // The hook is a subprocess call; exercise it exactly as the route does
    // (server/index.ts's syncProjectToBlob), against a file placed exactly
    // the way an upload route places one.
    const docs = join(repoRoot, "projects", PROJ, "documents");
    mkdirSync(docs, { recursive: true });
    writeFileSync(join(docs, "uploaded.md"), "# uploaded\n");

    execFileSync(SYNC_TSX, [SYNC_CLI, PROJ, "--up", "--root", repoRoot], {
      cwd: join(repoRoot, "plugins/azure-file-processing"), encoding: "utf8",
    });

    const st = await syncStatus(s, repoRoot, PROJ);
    expect(st.onlyLocal).toEqual([]);
    expect(st.same).toBe(1);
  });
});
