import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localBlobBackend } from "./local-blobs.js";

/**
 * Bytes in a folder on the machine running the stack — what an install with no
 * Docker and no cloud account uses. Same contract as the S3 and Azure
 * backends: addressed by hash, never overwritten, and a locator another
 * backend wrote is not this one's to answer for.
 */

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "scyne-blobs-")); });

describe("local folder backend", () => {
  it("round-trips bytes under a locator that does not name the folder", async () => {
    const b = localBlobBackend({ dir });
    const loc = await b.write(SHA_A, Buffer.from("hello"), "text/markdown");
    // The folder is left out so the workspace can move without rewriting rows.
    expect(loc).toBe(`local:aa/aa/${SHA_A}`);
    expect((await b.read(loc))?.toString()).toBe("hello");
    expect(readFileSync(join(dir, "aa", "aa", SHA_A), "utf8")).toBe("hello");
  });

  it("survives the process: a new backend on the same folder reads it back", async () => {
    const loc = await localBlobBackend({ dir }).write(SHA_A, Buffer.from("kept"), null);
    expect((await localBlobBackend({ dir }).read(loc))?.toString()).toBe("kept");
  });

  it("never overwrites: the same hash is the same bytes", async () => {
    const b = localBlobBackend({ dir });
    await b.write(SHA_A, Buffer.from("first"), null);
    const loc = await b.write(SHA_A, Buffer.from("second"), null);
    expect((await b.read(loc))?.toString()).toBe("first");
  });

  it("leaves no temporary files behind", async () => {
    await localBlobBackend({ dir }).write(SHA_B, Buffer.from("x"), null);
    expect(readdirSync(join(dir, "bb", "bb"))).toEqual([SHA_B]);
  });

  it("answers null for a missing blob and for another backend's locator", async () => {
    const b = localBlobBackend({ dir });
    expect(await b.read(`local:aa/aa/${SHA_A}`)).toBeNull();
    expect(await b.read(`s3:docs/aa/aa/${SHA_A}`)).toBeNull();
  });

  it("refuses a locator that would reach outside its folder", async () => {
    const b = localBlobBackend({ dir });
    for (const bad of ["local:../../etc/passwd", "local:aa/aa/../../x", `local:/${SHA_A}`]) {
      expect(await b.read(bad), bad).toBeNull();
    }
  });
});
