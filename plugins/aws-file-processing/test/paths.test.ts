import { describe, it, expect } from "vitest";
import {
  objectKeyFor, localPathFor, projectPrefix, assertSafeSegment, isSyncTempFile,
} from "../src/workspace/paths.js";

const ROOT = "/repo";

describe("objectKeyFor", () => {
  it("strips the workspace root and the projects/ prefix", () => {
    expect(objectKeyFor("/repo/projects/SAPN/MVP/requirements/SOP/a.md", ROOT))
      .toBe("SAPN/MVP/requirements/SOP/a.md");
  });

  it("handles a project-level document", () => {
    expect(objectKeyFor("/repo/projects/SAPN/documents/policy.md", ROOT))
      .toBe("SAPN/documents/policy.md");
  });

  it("refuses a path outside projects/", () => {
    expect(() => objectKeyFor("/repo/scripts/stage.mjs", ROOT)).toThrow(/outside/);
  });

  it("round-trips through localPathFor", () => {
    const local = "/repo/projects/SAPN/MVP/outputs/stories.json";
    expect(localPathFor(objectKeyFor(local, ROOT), ROOT)).toBe(local);
  });

  it("normalises a trailing slash on the root", () => {
    expect(objectKeyFor("/repo/projects/X/a.md", "/repo/")).toBe("X/a.md");
  });
});

describe("localPathFor", () => {
  it("validates each segment of the object key", () => {
    expect(() => localPathFor("../../../etc/cron.d/x", ROOT)).toThrow(/would climb/);
  });

  it("refuses a leading ../", () => {
    expect(() => localPathFor("../SAPN/a.md", ROOT)).toThrow(/would climb/);
  });

  it("refuses an embedded .. segment", () => {
    expect(() => localPathFor("SAPN/../../../etc/x", ROOT)).toThrow(/would climb/);
  });

  it("refuses an absolute object key", () => {
    expect(() => localPathFor("/abs/path", ROOT)).toThrow(/is empty/);
  });

  it("refuses a segment containing a separator", () => {
    // A key with a literal backslash in it (when split by /, it's one segment)
    for (const bad of ["SAPN\\Documents", "a\\b\\c"]) {
      expect(() => localPathFor(bad, ROOT), bad).toThrow(/contains a path separator/);
    }
  });
});

describe("projectPrefix", () => {
  it("ends with a slash so one project cannot prefix another", () => {
    // "SA" must not match "SAPN/..." — the slash forces a segment boundary.
    expect(projectPrefix("SA")).toBe("SA/");
    expect("SAPN/MVP/a.md".startsWith(projectPrefix("SA"))).toBe(false);
  });
});

describe("assertSafeSegment", () => {
  it("accepts an ordinary name", () => {
    expect(() => assertSafeSegment("Appeals & Reviews")).not.toThrow();
  });

  it("rejects .. with climb message", () => {
    expect(() => assertSafeSegment("..")).toThrow(/would climb/);
  });

  it("rejects . with current directory message", () => {
    expect(() => assertSafeSegment(".")).toThrow(/refers to the current directory/);
  });

  it("rejects separators with separator message", () => {
    for (const bad of ["a/b", "a\\b"]) {
      expect(() => assertSafeSegment(bad), bad).toThrow(/contains a path separator/);
    }
  });

  it("rejects absolute paths with absolute message", () => {
    expect(() => assertSafeSegment("/abs")).toThrow(/is an absolute path/);
  });

  it("rejects ../ prefix with climb message", () => {
    expect(() => assertSafeSegment("../x")).toThrow(/would climb/);
  });

  it("refuses empty segments", () => {
    expect(() => assertSafeSegment("")).toThrow(/is empty/);
  });
});

describe("isSyncTempFile", () => {
  // The exclusion syncDown/localManifest rely on to keep a crash orphan
  // (a temp file left by a SIGKILL between downloadToFile and rename) from
  // ever being hashed and pushed to S3 as a real document. Must be narrow:
  // catching only the exact shape syncDown itself writes, not any file whose
  // name happens to mention ".tmp".
  it("matches syncDown's own temp-file shape", () => {
    expect(isSyncTempFile("a.md.sync-11111111-1111-4111-8111-111111111111.tmp")).toBe(true);
    expect(isSyncTempFile("documents/policy.md.sync-abcdef01-2345-6789-abcd-ef0123456789.tmp"))
      .toBe(true);
  });

  it("does not match a genuine file whose name merely contains .tmp", () => {
    for (const name of ["notes.tmp", "report.tmp.md", "backup.tmp", "a.md.sync.tmp"]) {
      expect(isSyncTempFile(name), name).toBe(false);
    }
  });

  it("requires the exact UUID shape, not any hex-looking suffix", () => {
    for (const name of [
      "a.md.sync-not-a-uuid.tmp",
      "a.md.sync-1111.tmp",
      "a.md.sync-11111111111141118111111111111111.tmp", // right length, no hyphens
    ]) {
      expect(isSyncTempFile(name), name).toBe(false);
    }
  });
});
