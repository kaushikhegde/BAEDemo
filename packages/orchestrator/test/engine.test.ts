import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, migrate, type Db } from "../src/core/db.js";
import { createRepo } from "../src/core/repo.js";
import { createEngine } from "../src/core/engine.js";
import { defineOrchestrator } from "../src/config.js";

let dir: string, db: Db, repo: ReturnType<typeof createRepo>, calls: string[];

const fakeRunner = { run: async () => { calls.push("run"); return {
  exitCode: 0, status: "succeeded" as const, stderrTail: "",
  usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 0, cacheCreationTokens: 0,
           costUsd: 0.01, durationMs: 100, numTurns: 1, sessionId: "s" } }; } };

const fakeExec = async (cmd: string) => { calls.push(`exec:${cmd}`); return { code: 0, stdout: "", stderr: "" }; };

// NOTE: the config field is `adapters`, not `runners` (Task 3 shipped it as
// `config.adapters` — this brief predates that rename). The fake runner is
// injected THROUGH the adapter registry so the tests exercise the real
// adapter-resolution path (resolveRuntime → config.adapters[adapter]) rather
// than bypassing it.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function config(workspace: string, runner: any = fakeRunner) {
  return defineOrchestrator({
    workspace,
    db: { driver: "pglite", dir: join(workspace, "pg") },
    adapters: { claude_local: runner },
    defaults: { adapter: "claude_local", model: "claude-sonnet-4-6", effort: "medium" },
    org: [{ key: "ba", name: "BA", model: "claude-sonnet-4-6" }],
    workflows: [{
      key: "requirements", label: "Requirements", assignee: "ba",
      steps: [
        { type: "exec",   cmd: "stage {project}" },
        { type: "agent",  phase: "generate" },
        { type: "attach", files: ["outputs/product-summary.md"] },
        { type: "gate",   title: "Approve Requirements" },
        { type: "agent",  phase: "publish" },
      ],
    }],
  });
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "orch-eng-"));
  db = await openDb({ driver: "pglite", dir: join(dir, "pg") });
  await migrate(db, new URL("../migrations", import.meta.url).pathname);
  repo = createRepo(db);
  calls = [];
});
afterEach(async () => { await db.close(); rmSync(dir, { recursive: true, force: true }); });

describe("engine", () => {
  it("runs exec then agent then attach, and stops at the gate", async () => {
    mkdirSync(join(dir, "outputs"), { recursive: true });
    writeFileSync(join(dir, "outputs/product-summary.md"), "# summary");

    const engine = createEngine({ repo, config: config(dir), exec: fakeExec });
    const issue = await engine.start("requirements", { project: "P", feature: "F" });
    await engine.advance(issue.id);

    expect(calls).toEqual(["exec:stage P", "run"]);
    const after = await repo.getIssue(issue.id);
    expect(after?.status).toBe("in_review");          // parked at the gate
    expect((await repo.listWorkProducts(issue.id)).length).toBe(1);
    expect((await repo.listGates(issue.id))[0].status).toBe("pending");
  });

  it("resumes into the publish step when the gate is approved", async () => {
    mkdirSync(join(dir, "outputs"), { recursive: true });
    writeFileSync(join(dir, "outputs/product-summary.md"), "# summary");
    const engine = createEngine({ repo, config: config(dir), exec: fakeExec });
    const issue = await engine.start("requirements", { project: "P", feature: "F" });
    await engine.advance(issue.id);

    const gate = (await repo.listGates(issue.id))[0];
    await engine.decideGate(gate.id, "approved", "ok", "tagari");

    expect(calls.filter(c => c === "run").length).toBe(2);   // generate + publish
    expect((await repo.getIssue(issue.id))?.status).toBe("done");
  });

  it("blocks when an exec step exits non-zero, and does not reach the agent", async () => {
    const failing = async () => ({ code: 1, stdout: "", stderr: "boom" });
    const engine = createEngine({ repo, config: config(dir), exec: failing });
    const issue = await engine.start("requirements", { project: "P", feature: "F" });
    await engine.advance(issue.id);

    expect(calls).toEqual([]);                                  // runner never called
    expect((await repo.getIssue(issue.id))?.status).toBe("blocked");
    expect((await repo.listComments(issue.id))[0].body).toContain("boom");
  });

  it("blocks when a produces file is missing, naming it, and raises NO gate", async () => {
    const engine = createEngine({ repo, config: config(dir), exec: fakeExec });
    const issue = await engine.start("requirements", { project: "P", feature: "F" });
    await engine.advance(issue.id);

    const i = await repo.getIssue(issue.id);
    expect(i?.status).toBe("blocked");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((await repo.listComments(issue.id)).map((c: any) => c.body).join("\n"))
      .toContain("outputs/product-summary.md");
    expect((await repo.listGates(issue.id)).length).toBe(0);
  });

  it("rewinds to the generating step when a gate is rejected", async () => {
    mkdirSync(join(dir, "outputs"), { recursive: true });
    writeFileSync(join(dir, "outputs/product-summary.md"), "# summary");
    const engine = createEngine({ repo, config: config(dir), exec: fakeExec });
    const issue = await engine.start("requirements", { project: "P", feature: "F" });
    await engine.advance(issue.id);

    const gate = (await repo.listGates(issue.id))[0];
    await engine.decideGate(gate.id, "rejected", "wrong personas", "tagari");

    const i = await repo.getIssue(issue.id);
    expect(i?.status).toBe("todo");
    expect(i?.step_index).toBe(1);                   // back to the agent step
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((await repo.listComments(issue.id)).map((c: any) => c.body).join("\n"))
      .toContain("wrong personas");
  });

  it("records the run with its usage", async () => {
    mkdirSync(join(dir, "outputs"), { recursive: true });
    writeFileSync(join(dir, "outputs/product-summary.md"), "# summary");
    const engine = createEngine({ repo, config: config(dir), exec: fakeExec });
    const issue = await engine.start("requirements", { project: "P", feature: "F" });
    await engine.advance(issue.id);

    const runs = await repo.listRuns(issue.id);
    expect(runs.length).toBe(1);
    expect(Number(runs[0].output_tokens)).toBe(20);
    expect(Number(runs[0].cost_usd)).toBeCloseTo(0.01, 4);
  });

  it("passes the agent's budget to the runner and blocks on over_budget", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const seen: any[] = [];
    const budgetRunner = { run: async (req: any) => {
      seen.push(req.budget);
      return { exitCode: 0, status: "over_budget" as const, stderrTail: "",
               usage: { inputTokens: 900_000, outputTokens: 1, cacheReadTokens: 0,
                        cacheCreationTokens: 0, costUsd: 99, durationMs: 1, numTurns: 1, sessionId: "s" } };
    } };
    const cfg = config(dir, budgetRunner);
    cfg.org[0].budget = { maxTokens: 400_000, maxCostUsd: 5 };
    const companyId = await repo.ensureCompany("Scyne");
    await repo.upsertAgent(companyId, cfg.org[0]);

    const engine = createEngine({ repo, config: cfg, exec: fakeExec });
    const issue = await engine.start("requirements", { project: "P", feature: "F" });
    await engine.advance(issue.id);

    expect(seen[0]).toMatchObject({ maxTokens: 400_000, maxCostUsd: 5 });
    expect((await repo.getIssue(issue.id))?.status).toBe("blocked");
    expect((await repo.listRuns(issue.id))[0].status).toBe("over_budget");
  });

  it("resolves the runner from config.adapters and passes the resolved model and effort", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const seen: any[] = [];
    const spy = { run: async (req: any) => { seen.push(req); return {
      exitCode: 0, status: "succeeded" as const, stderrTail: "",
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0,
               costUsd: 0, durationMs: 1, numTurns: 1, sessionId: "s" } }; } };

    const cfg = config(dir, spy);
    // The step overrides the agent, which overrides the defaults.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (cfg.workflows[0].steps[1] as any).effort = "xhigh";
    const companyId = await repo.ensureCompany("Scyne");
    await repo.upsertAgent(companyId, cfg.org[0]);

    mkdirSync(join(dir, "outputs"), { recursive: true });
    writeFileSync(join(dir, "outputs/product-summary.md"), "# summary");

    const engine = createEngine({ repo, config: cfg, exec: fakeExec });
    const issue = await engine.start("requirements", { project: "P", feature: "F" });
    await engine.advance(issue.id);

    expect(seen[0].model).toBe("claude-sonnet-4-6");  // from the agent
    expect(seen[0].effort).toBe("xhigh");             // from the step
  });

  it("blocks with a clear message when an agent's adapter is not registered", async () => {
    const cfg = config(dir);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (cfg.workflows[0].steps[1] as any).adapter = "openai_local";
    const engine = createEngine({ repo, config: cfg, exec: fakeExec });
    const issue = await engine.start("requirements", { project: "P", feature: "F" });
    await engine.advance(issue.id);

    expect((await repo.getIssue(issue.id))?.status).toBe("blocked");
    expect((await repo.listComments(issue.id))[0].body).toMatch(/adapter 'openai_local' is not registered/);
  });

  it("marks an orphaned run and returns the issue to todo", async () => {
    const engine = createEngine({ repo, config: config(dir), exec: fakeExec });
    const issue = await engine.start("requirements", { project: "P", feature: "F" });
    await repo.startRun({ issueId: issue.id, agentId: null, stepIndex: 1, phase: "generate", logPath: "/tmp/x" });
    await engine.recoverOrphans();
    const runs = await repo.listRuns(issue.id);
    expect(runs[0].status).toBe("orphaned");
    expect((await repo.getIssue(issue.id))?.status).toBe("todo");
  });
});

// Fix round 1 (post-review). Two findings shared one root cause: the
// per-issue lock only protects calls that overlap IN FLIGHT — it is released
// the instant the first call returns to park at a "wait" step, so a second,
// LATER, separate advance() call on an already-parked issue is completely
// unprotected by it. A "gate" step re-raised a duplicate gate row on every
// such call; a "flow" step re-fired a duplicate (real, cost-incurring) child
// issue on every such call. The fix is idempotency by ARTEFACT (does a
// pending gate / a child issue for this exact step already exist?), not by a
// new status flag — plus an `in_review` halt-condition check as
// belt-and-braces for the "gate" case specifically (the "flow" case has no
// status of its own to check, so its artefact check is the ONLY guard).
describe("engine (fix round 1: idempotent wait steps, interpolate() throws don't reject)", () => {
  it("does not duplicate the gate when advance() is called again on an issue already parked at it", async () => {
    mkdirSync(join(dir, "outputs"), { recursive: true });
    writeFileSync(join(dir, "outputs/product-summary.md"), "# summary");
    const engine = createEngine({ repo, config: config(dir), exec: fakeExec });
    const issue = await engine.start("requirements", { project: "P", feature: "F" });

    await engine.advance(issue.id);   // 1st: reaches and parks at the gate — one gate is expected
    await engine.advance(issue.id);   // 2nd: issue is already parked — must NOT raise a second gate
    await engine.advance(issue.id);   // 3rd: same

    const gates = await repo.listGates(issue.id);
    expect(gates.length).toBe(1);
    expect(gates[0].status).toBe("pending");
    // The 2nd/3rd calls must not even re-run the generate agent step —
    // confirms they halted before re-entering the workflow at all, not just
    // that the gate step itself happened to no-op.
    expect(calls.filter(c => c === "run").length).toBe(1);
  });

  it("does not duplicate the child issue when advance() is called again on an issue parked at a flow step", async () => {
    const cfg = defineOrchestrator({
      workspace: dir,
      db: { driver: "pglite", dir: join(dir, "pg") },
      adapters: { claude_local: fakeRunner },
      org: [{ key: "ba", name: "BA" }],
      workflows: [{
        key: "parent-flow", label: "Parent Flow", assignee: "ba",
        steps: [{ type: "flow", workflow: "child-workflow" }],
      }],
    });
    const engine = createEngine({ repo, config: cfg, exec: fakeExec });
    const issue = await engine.start("parent-flow", { project: "P" });

    await engine.advance(issue.id);   // 1st: fires the child, parks — one child is expected
    await engine.advance(issue.id);   // 2nd: already fired — must NOT fire a second, real child issue
    await engine.advance(issue.id);   // 3rd: same

    const companyId = await repo.ensureCompany("Scyne");
    const children = await repo.listIssues(companyId, { parentId: issue.id });
    expect(children.length).toBe(1);
    expect(children[0].workflow_key).toBe("child-workflow");
  });

  it("still allows a genuinely new gate after a rejection rewinds and the step regenerates", async () => {
    // Guards the fix itself against being over-eager: the dedupe check must
    // be scoped to `pending` gates at this step_index, not "any gate ever
    // raised at this step_index" — otherwise a rejected-then-regenerated
    // pass could never re-raise, which would be a worse bug than the one
    // being fixed.
    mkdirSync(join(dir, "outputs"), { recursive: true });
    writeFileSync(join(dir, "outputs/product-summary.md"), "# summary");
    const engine = createEngine({ repo, config: config(dir), exec: fakeExec });
    const issue = await engine.start("requirements", { project: "P", feature: "F" });
    await engine.advance(issue.id);

    const firstGate = (await repo.listGates(issue.id))[0];
    await engine.decideGate(firstGate.id, "rejected", "wrong personas", "tagari");
    // Rewound to the generate step (index 1); advancing again re-runs
    // generate + attach and reaches the gate step a second time, which must
    // raise a genuinely NEW gate — the old one is `rejected`, not `pending`.
    await engine.advance(issue.id);

    const gates = await repo.listGates(issue.id);
    expect(gates.length).toBe(2);
    expect(gates.filter(g => g.status === "pending").length).toBe(1);
    expect(gates.filter(g => g.status === "rejected").length).toBe(1);
  });

  it("blocks with a comment naming the placeholder when a step references an unknown variable, instead of rejecting", async () => {
    const cfg = defineOrchestrator({
      workspace: dir,
      db: { driver: "pglite", dir: join(dir, "pg") },
      adapters: { claude_local: fakeRunner },
      org: [{ key: "ba", name: "BA" }],
      workflows: [{
        key: "bad-placeholder", label: "Bad Placeholder", assignee: "ba",
        steps: [{ type: "exec", cmd: "stage {missingvar}" }],
      }],
    });
    const engine = createEngine({ repo, config: cfg, exec: fakeExec });
    const issue = await engine.start("bad-placeholder", { project: "P" });

    // Must resolve, not reject — a thrown interpolate() error inside a step
    // is a normal blocked-workflow outcome, not a failure of advance() itself.
    await expect(engine.advance(issue.id)).resolves.toBeUndefined();

    const after = await repo.getIssue(issue.id);
    expect(after?.status).toBe("blocked");
    const comments = await repo.listComments(issue.id);
    expect(comments.map(c => c.body).join("\n")).toContain("{missingvar}");
  });
});
