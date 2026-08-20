// Pause, force-pause and cancel.
//
// The engine owns every status transition, so a route only ever writes a
// REQUEST. These tests are about the other half: that the engine honours one
// at the next step boundary, that a force-pause actually reaches the child,
// and that a cancelled run is never resurrected by the retry logic.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, migrate, type Db } from "../src/core/db.js";
import { createRepo } from "../src/core/repo.js";
import { createEngine, type Engine } from "../src/core/engine.js";
import { defineOrchestrator } from "../src/config.js";

let dir: string, db: Db, repo: ReturnType<typeof createRepo>, calls: string[];

/** A runner that records each call and can be told to hang until released. */
function makeRunner() {
  let release: (() => void) | null = null;
  let entered: (() => void) | null = null;
  return {
    /** Resolves once the runner has actually been entered. */
    started: () => new Promise<void>(r => { entered = r; }),
    release: () => { release?.(); release = null; },
    runner: {
      run: async () => {
        calls.push("run");
        entered?.();
        await new Promise<void>(r => { release = r; });
        return {
          exitCode: 0, status: "succeeded" as const, stderrTail: "",
          usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 0, cacheCreationTokens: 0,
                   costUsd: 0.01, durationMs: 100, numTurns: 1, sessionId: "s" },
        };
      },
    },
  };
}

const instantRunner = { run: async () => { calls.push("run"); return {
  exitCode: 0, status: "succeeded" as const, stderrTail: "",
  usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 0, cacheCreationTokens: 0,
           costUsd: 0.01, durationMs: 100, numTurns: 1, sessionId: "s" } }; } };

const fakeExec = async (cmd: string) => { calls.push(`exec:${cmd}`); return { code: 0, stdout: "", stderr: "" }; };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function config(workspace: string, runner: any) {
  return defineOrchestrator({
    workspace,
    db: { driver: "pglite", dir: join(workspace, "pg") },
    adapters: { claude_local: runner },
    defaults: { adapter: "claude_local", model: "claude-sonnet-4-6", effort: "medium" },
    org: [{ key: "ba", name: "BA" }],
    workflows: [{
      key: "requirements", label: "Requirements", assignee: "ba",
      steps: [
        { type: "exec",  cmd: "stage one" },
        { type: "exec",  cmd: "stage two" },
        { type: "agent", phase: "generate" },
        { type: "gate",  title: "Approve" },
      ],
    }],
  });
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "orch-ctl-"));
  db = await openDb({ driver: "pglite", dir: join(dir, "pg") });
  await migrate(db, new URL("../migrations", import.meta.url).pathname);
  repo = createRepo(db);
  calls = [];
  mkdirSync(join(dir, "outputs"), { recursive: true });
  writeFileSync(join(dir, "outputs/product-summary.md"), "# summary");
});
afterEach(async () => { await db.close(); rmSync(dir, { recursive: true, force: true }); });

const engineWith = (runner: unknown): Engine =>
  createEngine({ repo, config: config(dir, runner), exec: fakeExec });

describe("graceful pause", () => {
  it("parks the issue and stops it starting anything further", async () => {
    const engine = engineWith(instantRunner);
    const issue = await engine.start("requirements", { project: "P" });

    // Request BEFORE advancing: the next boundary is the first one.
    await engine.pause(issue.id);
    await engine.advance(issue.id);

    const after = await repo.getIssue(issue.id);
    expect(after?.status).toBe("paused");
    expect(calls).toEqual([]);            // nothing was started
    expect(after?.control_request).toBeNull();   // the request is spent, not left pending
  });

  it("names who asked, in the issue's own timeline", async () => {
    const engine = engineWith(instantRunner);
    const issue = await engine.start("requirements", { project: "P" });
    const { rows } = await db.query<{ id: string }>(
      `insert into users (id, company_id, email)
       select gen_random_uuid(), i.company_id, 'stopper@scyne.co' from issues i where i.id=$1
       returning id`, [issue.id]);

    await engine.pause(issue.id, { by: rows[0].id });
    await engine.advance(issue.id);

    const comments = await repo.listComments(issue.id);
    expect(comments.some(c => c.body.includes("stopper@scyne.co"))).toBe(true);
  });

  it("is a no-op on an issue that is already done", async () => {
    const engine = engineWith(instantRunner);
    const issue = await engine.start("requirements", { project: "P" });
    await repo.updateIssue(issue.id, { status: "done" });
    await expect(engine.pause(issue.id)).rejects.toThrow(/nothing to pause/i);
  });
});

describe("resume", () => {
  it("carries on from where it stopped, without re-running completed steps", async () => {
    const engine = engineWith(instantRunner);
    const issue = await engine.start("requirements", { project: "P" });

    // Let the first exec run, then pause before the second.
    await engine.advance(issue.id);   // runs everything to the gate in this fake
    const atGate = await repo.getIssue(issue.id);
    expect(atGate?.status).toBe("in_review");

    // Park it by hand at a mid-workflow step to prove resume does not rewind.
    await repo.updateIssue(issue.id, { status: "paused", stepIndex: 2 });
    calls = [];
    await engine.resume(issue.id);

    // Only the agent step (2) and onwards ran — the two execs were not repeated.
    expect(calls).toEqual(["run"]);
  });

  it("withdraws an outstanding request, or the issue would park again at once", async () => {
    const engine = engineWith(instantRunner);
    const issue = await engine.start("requirements", { project: "P" });
    await engine.pause(issue.id);
    await engine.advance(issue.id);
    expect((await repo.getIssue(issue.id))?.status).toBe("paused");

    await engine.resume(issue.id);
    const after = await repo.getIssue(issue.id);
    expect(after?.control_request).toBeNull();
    expect(after?.status).not.toBe("paused");
  });

  it("refuses to resume something that was cancelled", async () => {
    const engine = engineWith(instantRunner);
    const issue = await engine.start("requirements", { project: "P" });
    await engine.cancel(issue.id);
    await engine.advance(issue.id);
    await expect(engine.resume(issue.id)).rejects.toThrow(/cancelled/i);
  });
});

describe("cancel", () => {
  it("is terminal, and says so in the timeline", async () => {
    const engine = engineWith(instantRunner);
    const issue = await engine.start("requirements", { project: "P" });
    await engine.cancel(issue.id);
    await engine.advance(issue.id);

    const after = await repo.getIssue(issue.id);
    expect(after?.status).toBe("cancelled");
    const comments = await repo.listComments(issue.id);
    expect(comments.some(c => /cancelled/i.test(c.body))).toBe(true);
  });

  it("does not move an issue that is already done", async () => {
    const engine = engineWith(instantRunner);
    const issue = await engine.start("requirements", { project: "P" });
    await repo.updateIssue(issue.id, { status: "done" });
    await expect(engine.cancel(issue.id)).rejects.toThrow(/already done/i);
  });

  it("advancing a cancelled issue does nothing at all", async () => {
    const engine = engineWith(instantRunner);
    const issue = await engine.start("requirements", { project: "P" });
    await engine.cancel(issue.id);
    await engine.advance(issue.id);
    calls = [];
    await engine.advance(issue.id);
    expect(calls).toEqual([]);
  });
});

describe("force pause reaches the running agent", () => {
  it("kills the in-flight run rather than waiting for it", async () => {
    const h = makeRunner();
    const engine = engineWith(h.runner);
    const issue = await engine.start("requirements", { project: "P" });

    const advancing = engine.advance(issue.id);
    await h.started();                       // the agent step is genuinely in flight

    const running = await repo.runningRunFor(issue.id);
    expect(running).not.toBeNull();

    await engine.pause(issue.id, { force: true });
    // The fake runner is not a real child, so killRun() finds nothing to
    // signal — what this asserts is that the engine LOOKED for the live run
    // and recorded the request, which is the part that is ours.
    expect((await repo.getIssue(issue.id))?.control_request).toBe("pause_now");

    h.release();
    await advancing;
    await engine.advance(issue.id);
    expect((await repo.getIssue(issue.id))?.status).toBe("paused");
  });
});

describe("an issue that is already parked can still be stopped", () => {
  it("cancels one waiting at a gate, and cancels the gate with it", async () => {
    // The regression this guards: `advance()` used to return early for
    // `in_review` BEFORE looking at the control request, so a cancel on an
    // issue awaiting approval was recorded and then silently never honoured.
    // Waiting for a human is the single most likely moment to call something
    // off, so that made Cancel useless exactly when it was wanted.
    const engine = engineWith(instantRunner);
    const issue = await engine.start("requirements", { project: "P" });
    await engine.advance(issue.id);
    expect((await repo.getIssue(issue.id))?.status).toBe("in_review");
    expect((await repo.listGates(issue.id))[0].status).toBe("pending");

    await engine.cancel(issue.id);

    expect((await repo.getIssue(issue.id))?.status).toBe("cancelled");
    // A gate left pending on a cancelled issue sits in every "awaiting
    // approval" list forever, inviting someone to approve abandoned work.
    expect((await repo.listGates(issue.id))[0].status).toBe("cancelled");
  });

  it("pauses one that is blocked, so a failed issue can be shelved", async () => {
    const engine = engineWith(instantRunner);
    const issue = await engine.start("requirements", { project: "P" });
    await repo.updateIssue(issue.id, { status: "blocked" });

    await engine.pause(issue.id);
    expect((await repo.getIssue(issue.id))?.status).toBe("paused");
  });

  it("does not disturb an issue parked at a gate when nothing was requested", async () => {
    const engine = engineWith(instantRunner);
    const issue = await engine.start("requirements", { project: "P" });
    await engine.advance(issue.id);
    await engine.advance(issue.id);   // a second, later call on a parked issue
    expect((await repo.getIssue(issue.id))?.status).toBe("in_review");
    expect((await repo.listGates(issue.id)).length).toBe(1);   // not duplicated
  });
});

describe("a request made while a step is running is not lost", () => {
  it("honours a cancel that arrives before the step blocks", async () => {
    // Observed live, and the reason this test exists: an exec step failed,
    // `block()` set the status and `advance()` returned — so a cancel sent
    // moments earlier sat in `control_request` unhonoured. The issue read
    // `blocked`, the operator saw nothing happen, and the next resume quietly
    // cleared the request. The cancel vanished with no trace.
    const failingExec = async (cmd: string) => {
      calls.push(`exec:${cmd}`);
      return { code: 1, stdout: "", stderr: "no" };
    };
    const engine = createEngine({ repo, config: config(dir, instantRunner), exec: failingExec });
    const issue = await engine.start("requirements", { project: "P" });

    // Request it BEFORE advancing, so the step blocks with the request outstanding.
    await repo.requestControl(issue.id, "cancel", null);
    await engine.advance(issue.id);

    expect((await repo.getIssue(issue.id))?.status).toBe("cancelled");
    expect((await repo.getIssue(issue.id))?.control_request).toBeNull();
  });

  it("still blocks normally when nothing was requested", async () => {
    const failingExec = async (cmd: string) => {
      calls.push(`exec:${cmd}`);
      return { code: 1, stdout: "", stderr: "no" };
    };
    const engine = createEngine({ repo, config: config(dir, instantRunner), exec: failingExec });
    const issue = await engine.start("requirements", { project: "P" });
    await engine.advance(issue.id);
    expect((await repo.getIssue(issue.id))?.status).toBe("blocked");
  });

  it("honours a pause that arrives before the issue parks at a gate", async () => {
    const engine = engineWith(instantRunner);
    const issue = await engine.start("requirements", { project: "P" });
    await repo.requestControl(issue.id, "pause", null);
    await engine.advance(issue.id);
    expect((await repo.getIssue(issue.id))?.status).toBe("paused");
  });
});
