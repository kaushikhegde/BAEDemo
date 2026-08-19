import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveRoots, findInstallRoot, hasInstallMarkers, RootResolutionError, INSTALL_MARKERS,
} from "../src/core/roots.js";

let dir: string;

/** A directory carrying both install markers — i.e. a plausible plugin payload. */
function makeInstall(at: string): string {
  for (const m of INSTALL_MARKERS) mkdirSync(join(at, m), { recursive: true });
  return at;
}

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "orch-roots-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("roots", () => {
  it("recognises an install root by both markers, never by one alone", () => {
    expect(hasInstallMarkers(dir)).toBe(false);
    mkdirSync(join(dir, "skills"), { recursive: true });
    expect(hasInstallMarkers(dir)).toBe(false);   // 'skills' alone is not evidence
    mkdirSync(join(dir, "agent-instructions"), { recursive: true });
    expect(hasInstallMarkers(dir)).toBe(true);
  });

  it("walks up to find the install root from a nested directory", () => {
    makeInstall(dir);
    const deep = join(dir, "projects", "SAPN", "Some Feature", "outputs");
    mkdirSync(deep, { recursive: true });
    expect(findInstallRoot(deep)).toBe(dir);
  });

  it("returns null rather than guessing when nothing above carries the markers", () => {
    const orphan = join(dir, "nowhere");
    mkdirSync(orphan, { recursive: true });
    expect(findInstallRoot(orphan)).toBe(null);
  });

  it("defaults workRoot to installRoot — today one checkout holds both", () => {
    makeInstall(dir);
    const roots = resolveRoots({ installRoot: dir, env: {} });
    expect(roots.installRoot).toBe(dir);
    expect(roots.workRoot).toBe(dir);
  });

  it("lets a caller point workRoot elsewhere without moving installRoot", () => {
    makeInstall(dir);
    const work = join(dir, "..", "materialised");
    mkdirSync(work, { recursive: true });
    const roots = resolveRoots({ installRoot: dir, workRoot: work, env: {} });
    expect(roots.installRoot).toBe(dir);
    expect(roots.workRoot).toBe(work);
    rmSync(work, { recursive: true, force: true });
  });

  it("honours precedence: explicit beats SCYNE_INSTALL_ROOT beats WORKSPACE_PATH", () => {
    const a = makeInstall(join(dir, "a"));
    const b = makeInstall(join(dir, "b"));
    const c = makeInstall(join(dir, "c"));
    mkdirSync(a, { recursive: true }); mkdirSync(b, { recursive: true }); mkdirSync(c, { recursive: true });

    expect(resolveRoots({ installRoot: a, env: { SCYNE_INSTALL_ROOT: b, WORKSPACE_PATH: c } }).installRoot).toBe(a);
    expect(resolveRoots({ env: { SCYNE_INSTALL_ROOT: b, WORKSPACE_PATH: c } }).installRoot).toBe(b);
    expect(resolveRoots({ env: { WORKSPACE_PATH: c } }).installRoot).toBe(c);
  });

  it("falls through a configured-but-missing path instead of dying on it", () => {
    // The classic case: a .env copied from another developer's machine. The
    // named path does not exist here, so the next source should win.
    const real = makeInstall(join(dir, "real"));
    mkdirSync(real, { recursive: true });
    const roots = resolveRoots({
      env: { SCYNE_INSTALL_ROOT: join(dir, "does-not-exist"), WORKSPACE_PATH: real },
    });
    expect(roots.installRoot).toBe(real);
  });

  it("fails loudly, naming every source it tried, when no root resolves", () => {
    const orphan = join(dir, "orphan");
    mkdirSync(orphan, { recursive: true });
    let err: unknown;
    try { resolveRoots({ from: orphan, env: {} }); } catch (e) { err = e; }

    expect(err).toBeInstanceOf(RootResolutionError);
    const msg = (err as Error).message;
    expect(msg).toContain("no Scyne workspace found");
    expect(msg).toContain("$SCYNE_INSTALL_ROOT");
    expect(msg).toContain("$WORKSPACE_PATH");
    expect(msg).toContain("marker walk-up");
    expect(msg).toContain("scyne init");
  });

  it("refuses a directory that exists but is not an install root, naming it", () => {
    const notAnInstall = join(dir, "plain");
    mkdirSync(notAnInstall, { recursive: true });
    let err: unknown;
    try { resolveRoots({ installRoot: notAnInstall, env: {} }); } catch (e) { err = e; }

    expect(err).toBeInstanceOf(RootResolutionError);
    expect((err as Error).message).toContain(notAnInstall);
    expect((err as Error).message).toContain("not a Scyne install root");
  });

  it("refuses a work root that does not exist, because runs write into it", () => {
    makeInstall(dir);
    let err: unknown;
    try { resolveRoots({ installRoot: dir, workRoot: join(dir, "absent"), env: {} }); } catch (e) { err = e; }

    expect(err).toBeInstanceOf(RootResolutionError);
    expect((err as Error).message).toContain("not a directory");
  });
});
