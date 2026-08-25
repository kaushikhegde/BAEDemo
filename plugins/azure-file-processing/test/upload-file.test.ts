import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, symlinkSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/shared/config.js";
import { uploadFile } from "../src/orchestrator/tools/upload-file.js";

// Every case here is refused BEFORE any storage call, so a storage that would
// throw on contact is exactly the right stub: if one of these assertions ever
// reaches Azure, the test fails loudly rather than quietly needing a live
// Azurite to pass.
const storage = new Proxy({}, {
  get() { throw new Error("storage must not be touched by a refused upload_file"); },
}) as any;

const ctx = (over: Partial<ReturnType<typeof loadConfig>> = {}) => ({
  cfg: { ...loadConfig({}), ...over }, storage,
});

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "afp-uf-"));
  writeFileSync(join(dir, "doc.md"), "# hello\n");
  writeFileSync(join(dir, "empty.md"), "");
  writeFileSync(join(dir, "photo.png"), "not a document");
  mkdirSync(join(dir, "adir.md"));
  symlinkSync(join(dir, "adir.md"), join(dir, "link-to-dir.md"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("upload_file refusals", () => {
  it("is disabled when the config says so, naming the fallback", async () => {
    await expect(uploadFile(ctx({ allowLocalPathUpload: false }), { path: join(dir, "doc.md") }))
      .rejects.toThrow(/disabled.*create_upload_url/s);
  });

  it("refuses a relative path rather than resolving it against its own cwd", async () => {
    // The caller's cwd and the orchestrator's are different directories on the
    // same machine; silently reading the server's one is how you upload a file
    // nobody asked for.
    await expect(uploadFile(ctx(), { path: "doc.md" })).rejects.toThrow(/must be absolute/);
  });

  it("says the file is missing, not that something failed", async () => {
    await expect(uploadFile(ctx(), { path: join(dir, "nope.md") }))
      .rejects.toThrow(/no such file/);
  });

  it("refuses a directory, including one reached through a symlink", async () => {
    await expect(uploadFile(ctx(), { path: join(dir, "adir.md") }))
      .rejects.toThrow(/not a regular file/);
    await expect(uploadFile(ctx(), { path: join(dir, "link-to-dir.md") }))
      .rejects.toThrow(/not a regular file/);
  });

  it("refuses an unsupported extension — the same check the SAS path makes", async () => {
    await expect(uploadFile(ctx(), { path: join(dir, "photo.png") }))
      .rejects.toThrow(/unsupported extension \.png/);
  });

  it("refuses an empty file", async () => {
    // Zero bytes upload and process perfectly happily into a document with
    // nothing in it, which reads downstream as "the document does not say so".
    await expect(uploadFile(ctx(), { path: join(dir, "empty.md") }))
      .rejects.toThrow(/file is empty/);
  });

  it("refuses a file over the size ceiling", async () => {
    await expect(uploadFile(ctx({ maxUploadBytes: 4 }), { path: join(dir, "doc.md") }))
      .rejects.toThrow(/file too large/);
  });
});

describe("the gate's default", () => {
  it("is on for a local stack with no token", () => {
    expect(loadConfig({}).allowLocalPathUpload).toBe(true);
  });

  it("is OFF the moment a bearer token says the endpoint is exposed", () => {
    // A token is only ever set because something other than this machine can
    // reach the port — at which point "read the path I name" reads a path on
    // the SERVER, which is nobody's intent.
    expect(loadConfig({ MCP_BEARER_TOKEN: "s3cret" }).allowLocalPathUpload).toBe(false);
  });

  it("can be forced back on explicitly, for a token-protected local server", () => {
    expect(loadConfig({ MCP_BEARER_TOKEN: "s3cret", ALLOW_LOCAL_PATH_UPLOAD: "true" })
      .allowLocalPathUpload).toBe(true);
  });

  it("refuses a value it cannot read rather than defaulting to off", () => {
    expect(() => loadConfig({ ALLOW_LOCAL_PATH_UPLOAD: "sure" }))
      .toThrow(/ALLOW_LOCAL_PATH_UPLOAD/);
  });

  it("is turned OFF explicitly by the containerised orchestrator", () => {
    // MEASURED: without this line the --all-docker stack advertised
    // upload_file, and every call to it would have failed on a path that
    // simply does not exist inside the image. The default cannot help here —
    // it keys off MCP_BEARER_TOKEN, which a local Compose stack does not set.
    const compose = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), "../docker-compose.yml"), "utf8");
    const orchestrator = compose.slice(
      compose.indexOf("\n  orchestrator:"), compose.indexOf("\n  worker:"));
    expect(orchestrator).toMatch(/ALLOW_LOCAL_PATH_UPLOAD:\s*"false"/);
  });
});
