import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, WORKSPACE } from "../src/shared/config.js";
import {
  getStorage, ensureStorage, ensureWorkspaceBucket, deleteObjects, listObjects,
} from "../src/shared/storage.js";
import { syncStatus } from "../src/workspace/sync.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const SYNC_TSX = join(repoRoot, "plugins/aws-file-processing/node_modules/.bin/tsx");
const SYNC_CLI = join(repoRoot, "plugins/aws-file-processing/scripts/sync.mjs");
const cfg = loadConfig();
const s = getStorage(cfg);
const PROJ = "UPLOADHOOK";

const wipeRemote = async () => {
  const bucket = s.bucket(WORKSPACE);
  const keys: string[] = [];
  for await (const o of listObjects(s, bucket, `${PROJ}/`)) keys.push(o.key);
  if (keys.length) await deleteObjects(s, bucket, keys);
};

beforeAll(async () => { await ensureStorage(s); await ensureWorkspaceBucket(s); await wipeRemote(); });
afterAll(async () => {
  await wipeRemote();
  rmSync(join(repoRoot, "projects", PROJ), { recursive: true, force: true });
});

describe("upload route sync hook", () => {
  it("a document written into the tree reaches S3 when the hook runs", async () => {
    // The hook is a subprocess call; exercise it exactly as the route does
    // (server/index.ts's syncProjectToBlob), against a file placed exactly
    // the way an upload route places one. Both this test and that route now
    // resolve the CLI out of THIS plugin — the repo root was rewired with it.
    const docs = join(repoRoot, "projects", PROJ, "documents");
    mkdirSync(docs, { recursive: true });
    writeFileSync(join(docs, "uploaded.md"), "# uploaded\n");

    execFileSync(SYNC_TSX, [SYNC_CLI, PROJ, "--up", "--root", repoRoot], {
      cwd: join(repoRoot, "plugins/aws-file-processing"), encoding: "utf8",
    });

    const st = await syncStatus(s, repoRoot, PROJ);
    expect(st.onlyLocal).toEqual([]);
    expect(st.same).toBe(1);
  });
});
