import { describe, it, expect } from "vitest";
import { azureBlobBackend, blobNameFor } from "./azure-blobs.js";

const CONN = process.env.AZURE_STORAGE_CONNECTION_STRING ?? "UseDevelopmentStorage=true";

/**
 * The integration half runs against Azurite, which
 * `plugins/azure-file-processing/scripts/stack.sh up` already starts. It skips
 * itself when Azurite is not reachable rather than failing a machine that has
 * not started it — the pure tests below still run everywhere, and they are the
 * ones guarding the part a caller can get wrong.
 *
 * Probed at MODULE scope, not in `beforeAll`. `it.skipIf` is evaluated while
 * the file is being collected, which happens before any hook runs — so a flag
 * set in `beforeAll` is always still false when `skipIf` reads it, and every
 * integration test skipped silently on a machine where Azurite was running
 * perfectly.
 */
const up = await azureBlobBackend({ connectionString: CONN, container: "test-blobs" })
  .write("0".repeat(64), Buffer.from("probe"), null)
  .then(() => true, () => false);

describe("blobNameFor", () => {
  it("fans out on the first four hex characters, so one container is not one flat namespace", () => {
    const sha = "abcd1234" + "0".repeat(56);
    expect(blobNameFor(sha)).toBe(`ab/cd/${sha}`);
  });

  it("refuses anything that is not a sha256, because the name IS the hash", () => {
    // A caller passing a path here would create a blob nothing can find again,
    // and one passing "../" would address a key space this backend does not own.
    expect(() => blobNameFor("../escape")).toThrow(/sha256/);
    expect(() => blobNameFor("")).toThrow(/sha256/);
    expect(() => blobNameFor("ABCD" + "0".repeat(60))).toThrow(/sha256/);
  });
});

describe("azureBlobBackend", () => {
  const backend = () => azureBlobBackend({ connectionString: CONN, container: "test-blobs" });

  it("refuses a locator belonging to another backend", async () => {
    // Reached before any network call, so it holds with or without Azurite.
    expect(await backend().read("pg:" + "5".repeat(64))).toBeNull();
  });

  it.skipIf(!up)("round-trips bytes through the locator it returns", async () => {
    const b = backend();
    const content = Buffer.from("hello azure");
    const sha = "1".repeat(64);
    const locator = await b.write(sha, content, "text/plain");
    expect(locator).toBe(`azure:test-blobs/11/11/${sha}`);
    expect(await b.read(locator)).toEqual(content);
  });

  it.skipIf(!up)("is idempotent — writing the same hash twice is not an error", async () => {
    const b = backend();
    const sha = "2".repeat(64);
    await b.write(sha, Buffer.from("z"), null);
    await expect(b.write(sha, Buffer.from("z"), null)).resolves.toContain(sha);
  });

  it.skipIf(!up)("returns null rather than throwing for a blob that is not there", async () => {
    // A missing blob is a real state — a store restored without its container —
    // and `get()` distinguishes it from an error by the null.
    expect(await backend().read(`azure:test-blobs/33/33/${"3".repeat(64)}`)).toBeNull();
  });

  it.skipIf(!up)("stages a file larger than one block", async () => {
    // 8 MiB is the block size; this crosses it, so it exercises the staged path
    // rather than the single PUT.
    const b = backend();
    const content = Buffer.alloc(9 * 1024 * 1024, 7);
    const sha = "4".repeat(64);
    const locator = await b.write(sha, content, null);
    const back = await b.read(locator);
    expect(back?.length).toBe(content.length);
    expect(back?.equals(content)).toBe(true);
  });
});
