import { describe, it, expect, beforeAll } from "vitest";
import { loadConfig, UPLOADS_CONTAINER, ARTIFACTS_CONTAINER, JOB_QUEUE } from "../src/shared/config.js";
import { getStorage, ensureStorage } from "../src/shared/storage.js";

const cfg = loadConfig();
const storage = getStorage(cfg);

beforeAll(async () => {
  try {
    await ensureStorage(storage);
  } catch (e) {
    // Loud, not skipped: a silently skipped integration suite is a green build
    // that proves nothing.
    throw new Error(
      "Azurite is not reachable. Run ./scripts/stack.sh up first.\n" + String(e));
  }
});

describe("storage bootstrap", () => {
  it("creates both blob containers", async () => {
    for (const name of [UPLOADS_CONTAINER, ARTIFACTS_CONTAINER]) {
      expect(await storage.blob.getContainerClient(name).exists()).toBe(true);
    }
  });

  it("creates the job queue", async () => {
    expect(await storage.queue(JOB_QUEUE).exists()).toBe(true);
  });

  it("is idempotent — a second run changes nothing and throws nothing", async () => {
    await expect(ensureStorage(storage)).resolves.toBeUndefined();
  });

  it("exposes the shared key, which SAS minting needs", () => {
    expect(storage.accountName).toBe("devstoreaccount1");
    expect(storage.sharedKey).toBeDefined();
  });
});
