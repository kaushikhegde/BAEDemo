// Killing a live agent process on request.
//
// The registry is in-process, which is correct rather than a limitation:
// PGlite is single-writer, so exactly one process owns the engine, and the CLI
// already reaches it over HTTP. A CLI holding the database directly cannot
// also have a live child belonging to the server.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runChild, killRun, liveRuns } from "../src/core/spawn.js";
import type { RunRequest } from "../src/core/runner.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "orch-kill-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const req = (runId: string): RunRequest => ({
  agent: { key: "ba" },
  prompt: "",
  cwd: dir,
  logPath: join(dir, `${runId}.jsonl`),
  runId,
});

/** A child that will never exit on its own, so only a kill can end it. */
const forever = { bin: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"], extractUsage: () => null };

describe("the live-run registry", () => {
  it("registers a running child and forgets it when it settles", async () => {
    const running = runChild(req("run-1"), forever);
    // Give the child a moment to actually spawn before looking for it.
    await new Promise(r => setTimeout(r, 250));
    expect(liveRuns()).toContain("run-1");

    expect(killRun("run-1")).toBe(true);
    await running;
    expect(liveRuns()).not.toContain("run-1");
  });

  it("reports a killed run as `cancelled`, not as `failed`", async () => {
    const running = runChild(req("run-2"), forever);
    await new Promise(r => setTimeout(r, 250));
    killRun("run-2");
    const res = await running;
    // The distinction is load-bearing: core/retry.ts must never spend money
    // re-running something a person deliberately stopped.
    expect(res.status).toBe("cancelled");
  });

  it("answers false for a run it does not have", () => {
    expect(killRun("never-existed")).toBe(false);
  });

  it("does not report a run that has already finished", async () => {
    const quick = { bin: process.execPath, args: ["-e", "process.exit(0)"], extractUsage: () => null };
    await runChild(req("run-3"), quick);
    expect(liveRuns()).not.toContain("run-3");
    expect(killRun("run-3")).toBe(false);
  });

  it("tracks several at once and kills only the one asked for", async () => {
    const a = runChild(req("run-a"), forever);
    const b = runChild(req("run-b"), forever);
    await new Promise(r => setTimeout(r, 250));
    expect(liveRuns().sort()).toEqual(expect.arrayContaining(["run-a", "run-b"]));

    killRun("run-a");
    expect((await a).status).toBe("cancelled");
    expect(liveRuns()).toContain("run-b");

    killRun("run-b");
    await b;
  });

  it("does not register a run with no id — nothing could address it by one anyway", async () => {
    // Short-lived rather than `forever`: an unregistered run cannot be killed
    // by id, so a test that spawned an immortal one would have to reach
    // outside the process to clean up — and `pkill -f` on a developer's
    // machine is not something a test suite should ever do.
    const brief = {
      bin: process.execPath,
      args: ["-e", "setTimeout(() => process.exit(0), 400)"],
      extractUsage: () => null,
    };
    const running = runChild({ ...req("run-4"), runId: undefined }, brief);
    await new Promise(r => setTimeout(r, 200));
    expect(liveRuns()).not.toContain("run-4");
    expect(killRun("run-4")).toBe(false);
    expect((await running).status).toBe("succeeded");
  });
});
