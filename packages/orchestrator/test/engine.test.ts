import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, migrate, type Db } from "../src/core/db.js";
import { createRepo } from "../src/core/repo.js";
import { createEngine, closingNote } from "../src/core/engine.js";
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

  it("never narrates the COMMAND — that timeline is read by clients", async () => {
    // `Step 7 of 7 · running `node scripts/render-companion-app.mjs SAPN`` is
    // what this timeline used to say, in a panel a client watches while their
    // run proceeds. It tells them nothing they wanted to know and discloses a
    // path on our machine. An unlabelled step says "running" and nothing more:
    // describing a command is opt-IN, so a new step cannot leak by omission.
    const engine = createEngine({ repo, config: config(dir), exec: fakeExec });
    const issue = await engine.start("requirements", { project: "P", feature: "F" });
    await engine.advance(issue.id);

    const timeline = (await repo.listComments(issue.id)).map(c => c.body).join("\n");
    expect(timeline).not.toContain("stage P");
    expect(timeline).toContain("running");
  });

  /**
   * An exec step's command can only name a param every run carries:
   * `interpolate` throws on one the issue does not have, so
   * `--parent {adoParentEpicId}` would block every run that omits it. Optional
   * params reach the command's environment instead — which is how
   * `ado-workitems.mjs` receives a parent epic without the requirements
   * workflow breaking for the runs (all of them, today) that set none.
   */
  it("passes the workflow's params to an exec step as SCYNE_PARAM_*", async () => {
    let seen: NodeJS.ProcessEnv | undefined;
    const capturing = async (_c: string, _w: string, _t?: number, env?: NodeJS.ProcessEnv) => {
      seen = env; return { code: 0, stdout: "", stderr: "" };
    };
    const engine = createEngine({ repo, config: config(dir), exec: capturing });
    const issue = await engine.start("requirements", { project: "P", feature: "F", adoParentEpicId: "4242" });
    await engine.advance(issue.id);

    expect(seen?.SCYNE_PARAM_PROJECT).toBe("P");
    expect(seen?.SCYNE_PARAM_FEATURE).toBe("F");
    // Upper-cased whole, not snake_cased: the reader is a shell, and the
    // script looks the name up literally.
    expect(seen?.SCYNE_PARAM_ADOPARENTEPICID).toBe("4242");
    // The existing contract is untouched.
    expect(seen?.WORKSPACE_PATH).toBe(dir);
  });

  /**
   * The engine narrates STEPS and cannot narrate inside one. That is fine for a
   * step that runs for a second, and wrong for a step that runs for twenty
   * minutes — `extract` is a single exec that spawns one agent per document, so
   * between "step 2 of 5 started" and "step 2 finished" the timeline a client
   * watches showed nothing at all, and a healthy run was indistinguishable from
   * a wedged one.
   *
   * Passing the id rather than a callback keeps the seam narrow: a script may
   * POST a comment, and gains no other reach into the engine.
   */
  it("tells an exec step which issue it belongs to, so a long script can narrate itself", async () => {
    let seen: NodeJS.ProcessEnv | undefined;
    const capturing = async (_c: string, _w: string, _t?: number, env?: NodeJS.ProcessEnv) => {
      seen = env; return { code: 0, stdout: "", stderr: "" };
    };
    const engine = createEngine({ repo, config: config(dir), exec: capturing });
    const issue = await engine.start("requirements", { project: "P", feature: "F" });
    await engine.advance(issue.id);

    expect(seen?.SCYNE_ISSUE_ID).toBe(issue.id);
  });

  it("narrates an exec step's label when it has one", async () => {
    const cfg = config(dir);
    cfg.workflows[0].steps[0] = { type: "exec", cmd: "stage {project}", label: "Gathering the inputs" };
    const engine = createEngine({ repo, config: cfg, exec: fakeExec });
    const issue = await engine.start("requirements", { project: "P", feature: "F" });
    await engine.advance(issue.id);

    const timeline = (await repo.listComments(issue.id)).map(c => c.body).join("\n");
    expect(timeline).toContain("Gathering the inputs");
    expect(timeline).not.toContain("stage P");
  });

  it("DOES record the command when the step fails — that is when it is needed", async () => {
    // The one moment the exact command earns its place. It goes inside the
    // diagnostics fence with the stderr, not in the sentence.
    const failing = async () => ({ code: 1, stdout: "", stderr: "boom" });
    const cfg = config(dir);
    cfg.workflows[0].steps[0] = { type: "exec", cmd: "stage {project}", label: "Gathering the inputs" };
    const engine = createEngine({ repo, config: cfg, exec: failing });
    const issue = await engine.start("requirements", { project: "P", feature: "F" });
    await engine.advance(issue.id);

    const timeline = (await repo.listComments(issue.id)).map(c => c.body).join("\n");
    expect(timeline).toContain("Gathering the inputs failed");
    expect(timeline).toContain("$ stage P");
    expect(timeline).toContain("boom");
  });

  it("falls back to what the command printed when it said nothing on stderr", async () => {
    // A script that reports its failure on STDOUT — extract-documents.mjs prints
    // a JSON summary there and exits 1 — used to block the issue with an empty
    // diagnostics fence: "exited with code 1 and returned no error details",
    // while the reason sat in the output nobody kept.
    const quiet = async () => ({ code: 1, stdout: "2 of 10 documents failed: no text layer", stderr: "" });
    const cfg = config(dir);
    cfg.workflows[0].steps[0] = { type: "exec", cmd: "extract {project}", label: "Building the extracts" };
    const engine = createEngine({ repo, config: cfg, exec: quiet });
    const issue = await engine.start("requirements", { project: "P", feature: "F" });
    await engine.advance(issue.id);

    const timeline = (await repo.listComments(issue.id)).map(c => c.body).join("\n");
    expect(timeline).toContain("no text layer");
  });

  it("prefers stderr over stdout when the command wrote both", async () => {
    const both = async () => ({ code: 1, stdout: "progress chatter", stderr: "the real reason" });
    const cfg = config(dir);
    cfg.workflows[0].steps[0] = { type: "exec", cmd: "stage {project}", label: "Gathering the inputs" };
    const engine = createEngine({ repo, config: cfg, exec: both });
    const issue = await engine.start("requirements", { project: "P", feature: "F" });
    await engine.advance(issue.id);

    const timeline = (await repo.listComments(issue.id)).map(c => c.body).join("\n");
    expect(timeline).toContain("the real reason");
    expect(timeline).not.toContain("progress chatter");
  });

  it("blocks when an exec step exits non-zero, and does not reach the agent", async () => {
    const failing = async () => ({ code: 1, stdout: "", stderr: "boom" });
    const engine = createEngine({ repo, config: config(dir), exec: failing });
    const issue = await engine.start("requirements", { project: "P", feature: "F" });
    await engine.advance(issue.id);

    expect(calls).toEqual([]);                                  // runner never called
    expect((await repo.getIssue(issue.id))?.status).toBe("blocked");
    expect((await repo.listComments(issue.id)).map(c => c.body).join("\n")).toContain("boom");
  });

  /**
   * A step that checks ANOTHER step's work has to send Resume back to that
   * step. `verify published` asserts the publish step actually published; when
   * it fails, re-running the verifier cannot change the answer, because the
   * thing that would have to change happened one step earlier — and that step
   * already recorded `succeeded`, so it is never re-run.
   *
   * Measured on SCY-1 before this existed: Resume → fail → block → Resume →
   * fail → block, the issue permanently at the verifier, the timeline showing
   * nothing but repeats, and no way out short of hand-editing step_index.
   */
  it("rewinds to the step being checked when a checking step fails", async () => {
    const cfg = defineOrchestrator({
      workspace: dir,
      db: { driver: "pglite", dir: join(dir, "pg") },
      adapters: { claude_local: fakeRunner },
      defaults: { adapter: "claude_local", model: "claude-sonnet-4-6", effort: "medium" },
      org: [{ key: "ba", name: "BA", model: "claude-sonnet-4-6" }],
      workflows: [{
        key: "pub", label: "Publish", assignee: "ba",
        steps: [
          { type: "agent", phase: "publish" },                              // 0
          { type: "exec",  cmd: "verify", label: "Confirming", rewindOnFailure: 0 },  // 1
        ],
      }],
    });
    const engine = createEngine({
      repo, config: cfg,
      exec: async () => ({ code: 1, stdout: "", stderr: "no record" }),
    });

    const issue = await engine.start("pub", { project: "P" });
    await engine.advance(issue.id);

    const i = await repo.getIssue(issue.id);
    expect(i?.status).toBe("blocked");
    // The cursor is back on the publish step, so Resume re-publishes rather
    // than re-checking a result that cannot have changed.
    expect(i?.step_index).toBe(0);
    const timeline = (await repo.listComments(issue.id)).map(c => c.body).join("\n");
    expect(timeline).toContain("no record");
    expect(timeline).toContain("Resume will re-run step 1");
  });

  it("does not rewind a step that checks its own command", async () => {
    // The default, and correct for a validator: it exited non-zero on work it
    // did itself, so resuming AT it is exactly what a person wants.
    const engine = createEngine({
      repo, config: config(dir),
      exec: async () => ({ code: 1, stdout: "", stderr: "boom" }),
    });
    const issue = await engine.start("requirements", { project: "P", feature: "F" });
    await engine.advance(issue.id);

    const i = await repo.getIssue(issue.id);
    expect(i?.status).toBe("blocked");
    expect(i?.step_index).toBe(0);        // the exec step itself, not moved
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

  it("rewinds to the generating step when a gate is rejected, and regenerates without a second call", async () => {
    mkdirSync(join(dir, "outputs"), { recursive: true });
    writeFileSync(join(dir, "outputs/product-summary.md"), "# summary");
    const engine = createEngine({ repo, config: config(dir), exec: fakeExec });
    const issue = await engine.start("requirements", { project: "P", feature: "F" });
    await engine.advance(issue.id);

    const gate = (await repo.listGates(issue.id))[0];
    await engine.decideGate(gate.id, "rejected", "wrong personas", "tagari");

    // Rewinding alone left the issue parked at `todo` forever: nothing else in
    // the system watches for it, so both the chatbot's Reject and its
    // Request-changes buttons were dead ends. decideGate advances after a
    // rejection exactly as it always has after an approval.
    expect(calls.filter(c => c === "run").length).toBe(2);   // generate ran again
    const i = await repo.getIssue(issue.id);
    expect(i?.status).toBe("in_review");                     // back at a fresh gate
    const gates = await repo.listGates(issue.id);
    expect(gates.filter(g => g.status === "pending").length).toBe(1);
    expect(gates.filter(g => g.status === "rejected").length).toBe(1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((await repo.listComments(issue.id)).map((c: any) => c.body).join("\n"))
      .toContain("wrong personas");
  });

  it("retry() restarts a blocked issue from the step that blocked it", async () => {
    // No outputs/ written, so the attach step blocks on a missing file.
    const engine = createEngine({ repo, config: config(dir), exec: fakeExec });
    const issue = await engine.start("requirements", { project: "P", feature: "F" });
    await engine.advance(issue.id);
    expect((await repo.getIssue(issue.id))?.status).toBe("blocked");

    // Fix the cause, then retry.
    mkdirSync(join(dir, "outputs"), { recursive: true });
    writeFileSync(join(dir, "outputs/product-summary.md"), "# summary");
    await engine.retry(issue.id);

    expect((await repo.getIssue(issue.id))?.status).toBe("in_review");
    expect((await repo.listWorkProducts(issue.id)).length).toBe(1);
  });

  it("retry() refuses an issue that is already done", async () => {
    const engine = createEngine({ repo, config: config(dir), exec: fakeExec });
    const issue = await engine.start("requirements", { project: "P", feature: "F" });
    await repo.updateIssue(issue.id, { status: "done" });
    await expect(engine.retry(issue.id)).rejects.toThrow(/done/);
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

  it("uses the workflow's title template when it has one", async () => {
    const c = config(dir);
    c.workflows[0].title = "{project} / {feature} — Requirements";
    const engine = createEngine({ repo, config: c, exec: fakeExec });
    const issue = await engine.start("requirements", { project: "P", feature: "F" });
    expect(issue.title).toBe("P / F — Requirements");
  });

  it("gives a retried step its own log file", async () => {
    // The log path used to be `<issueId>-<stepIndex>.jsonl` with no attempt in
    // it, and the runner opens it in append mode — so a retried step appended
    // to the previous attempt's log, two run rows pointed at one file, and the
    // console showed the FAILED attempt's events inside the successful run's
    // transcript. Observed live while re-running a blocked publish step.
    const engine = createEngine({ repo, config: config(dir), exec: fakeExec });
    const issue = await engine.start("requirements", { project: "P", feature: "F" });
    await engine.advance(issue.id);              // agent runs, attach blocks (no outputs/)
    expect((await repo.getIssue(issue.id))?.status).toBe("blocked");

    mkdirSync(join(dir, "outputs"), { recursive: true });
    writeFileSync(join(dir, "outputs/product-summary.md"), "# summary");
    await repo.updateIssue(issue.id, { stepIndex: 1 });   // rewind to the agent step
    await engine.retry(issue.id);

    const logs = (await repo.listRuns(issue.id)).map(r => r.log_path);
    expect(logs).toHaveLength(2);
    expect(new Set(logs).size).toBe(2);          // two runs, two files
  });

  it("reads files into the agent's prompt", async () => {
    mkdirSync(join(dir, "outputs"), { recursive: true });
    writeFileSync(join(dir, "outputs/product-summary.md"), "# summary");
    writeFileSync(join(dir, "outputs/previous.md"), "the previous version {not-a-placeholder}");

    const prompts: string[] = [];
    const capturing = { run: async (req: { prompt: string }) => { prompts.push(req.prompt); return {
      exitCode: 0, status: "succeeded" as const, stderrTail: "",
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0,
               costUsd: 0, durationMs: 1, numTurns: 1, sessionId: "s" } }; } };

    const c = config(dir, capturing);
    c.workflows[0].steps[1] = {
      type: "agent", phase: "revise",
      reads: { previous: "outputs/previous.md" },
      prompt: "Change: {instruction}\n---\n{previous}\n---",
    };

    const engine = createEngine({ repo, config: c, exec: fakeExec });
    const issue = await engine.start("requirements", { project: "P", feature: "F", instruction: "add SLA field" });
    await engine.advance(issue.id);

    expect(prompts[0]).toContain("Change: add SLA field");
    // Substituted content is inserted literally and never re-scanned, which is
    // what makes injecting a JSON artefact full of braces safe.
    expect(prompts[0]).toContain("the previous version {not-a-placeholder}");
  });

  it("blocks, naming the file, when a reads target is missing", async () => {
    const c = config(dir);
    c.workflows[0].steps[1] = {
      type: "agent", phase: "revise",
      reads: { previous: "outputs/{feature}/nope.md" },
      prompt: "{previous}",
    };
    const engine = createEngine({ repo, config: c, exec: fakeExec });
    const issue = await engine.start("requirements", { project: "P", feature: "F" });
    await engine.advance(issue.id);

    const after = await repo.getIssue(issue.id);
    expect(after?.status).toBe("blocked");
    const comments = await repo.listComments(issue.id);
    expect(comments[comments.length - 1].body).toContain("previous");
    expect(comments[comments.length - 1].body).toContain("outputs/F/nope.md");
    expect(calls.filter(c2 => c2 === "run").length).toBe(0);   // never spawned the agent
    expect(await repo.listRuns(issue.id)).toHaveLength(0);     // and left no mystery run row
  });

  it("appends the issue params to an explicit prompt", async () => {
    mkdirSync(join(dir, "outputs"), { recursive: true });
    writeFileSync(join(dir, "outputs/product-summary.md"), "# summary");
    const prompts: string[] = [];
    const capturing = { run: async (req: { prompt: string }) => { prompts.push(req.prompt); return {
      exitCode: 0, status: "succeeded" as const, stderrTail: "",
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0,
               costUsd: 0, durationMs: 1, numTurns: 1, sessionId: "s" } }; } };
    const c = config(dir, capturing);
    c.workflows[0].steps[1] = { type: "agent", phase: "generate", prompt: "Do the thing for {project}." };

    const engine = createEngine({ repo, config: c, exec: fakeExec });
    const issue = await engine.start("requirements", { project: "P", feature: "F", confluenceSpace: "SADA" });
    await engine.advance(issue.id);

    expect(prompts[0]).toContain("Do the thing for P.");
    // An explicit prompt still reaches optional params — a publish step needs
    // the space key, and a {placeholder} for it would throw on every run that
    // omits it.
    expect(prompts[0]).toContain("confluenceSpace: SADA");
  });

  it("blocks with a clear message when an agent's adapter is not registered", async () => {
    const cfg = config(dir);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (cfg.workflows[0].steps[1] as any).adapter = "openai_local";
    const engine = createEngine({ repo, config: cfg, exec: fakeExec });
    const issue = await engine.start("requirements", { project: "P", feature: "F" });
    await engine.advance(issue.id);

    expect((await repo.getIssue(issue.id))?.status).toBe("blocked");
    expect((await repo.listComments(issue.id)).map(c => c.body).join("\n")).toMatch(/adapter 'openai_local' is not registered/);
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

  // ---- self-healing ------------------------------------------------------

  /**
   * A runner whose first N attempts fail with `first` and whose later attempts
   * return `then`. `calls` counts every spawn, which is the figure the retry
   * policy is really about: each one is a real agent process.
   */
  const flakyRunner = (failures: number, first: any, then?: any) => {
    let n = 0;
    return { run: async () => {
      calls.push("run");
      n += 1;
      if (n <= failures) return { exitCode: 1, status: "failed" as const, usage: null, stderrTail: "", ...first };
      return then ?? {
        exitCode: 0, status: "succeeded" as const, stderrTail: "",
        usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 0, cacheCreationTokens: 0,
                 costUsd: 0.01, durationMs: 100, numTurns: 1, sessionId: "s" },
      };
    } };
  };

  it("retries a cheap transient failure once and carries on", async () => {
    mkdirSync(join(dir, "outputs"), { recursive: true });
    writeFileSync(join(dir, "outputs/product-summary.md"), "# summary");

    const engine = createEngine({
      repo, exec: fakeExec,
      config: config(dir, flakyRunner(1, { stderrTail: "Error: connect ETIMEDOUT 160.79.104.10:443" })),
    });
    const issue = await engine.start("requirements", { project: "P", feature: "F" });
    await engine.advance(issue.id);

    // Two spawns for one step, and the workflow still reached its gate — the
    // human was never woken for something a retry cleared.
    expect(calls.filter(c => c === "run").length).toBe(2);
    expect((await repo.getIssue(issue.id))?.status).toBe("in_review");

    const runs = await repo.listRuns(issue.id);
    expect(runs.filter(r => r.step_index === 1).length).toBe(2);
    expect(runs.some(r => r.status === "failed")).toBe(true);
    expect(runs.some(r => r.status === "succeeded")).toBe(true);

    const said = (await repo.listComments(issue.id)).map(c => c.body).join("\n");
    expect(said).toContain("retrying once");
  });

  it("retries at most once, then blocks saying it already had its retry", async () => {
    const engine = createEngine({
      repo, exec: fakeExec,
      config: config(dir, flakyRunner(99, { stderrTail: "Error: socket hang up" })),
    });
    const issue = await engine.start("requirements", { project: "P", feature: "F" });
    await engine.advance(issue.id);

    expect(calls.filter(c => c === "run").length).toBe(2);
    const after = await repo.getIssue(issue.id);
    expect(after?.status).toBe("blocked");
    expect(after?.step_index).toBe(1);   // parked ON the failing step, not past it

    const last = (await repo.listComments(issue.id)).pop();
    expect(last?.body).toContain("after 2 attempts");
    expect(last?.body).toContain("already had its one retry");
  });

  it("does NOT retry a run that spent real tokens — it blocks on the first failure", async () => {
    // The whole point of the policy: a fifteen-minute run that failed on its
    // own terms must not be paid for twice.
    const expensive = {
      exitCode: 2, status: "failed" as const, stderrTail: "the agent gave up",
      usage: { inputTokens: 148_231, outputTokens: 21_044, cacheReadTokens: 0, cacheCreationTokens: 0,
               costUsd: 3.19, durationMs: 900_000, numTurns: 61, sessionId: "s" },
    };
    const engine = createEngine({
      repo, exec: fakeExec,
      config: config(dir, { run: async () => { calls.push("run"); return expensive; } }),
    });
    const issue = await engine.start("requirements", { project: "P", feature: "F" });
    await engine.advance(issue.id);

    expect(calls.filter(c => c === "run").length).toBe(1);
    expect((await repo.getIssue(issue.id))?.status).toBe("blocked");
    const last = (await repo.listComments(issue.id)).pop();
    expect(last?.body).toContain("after 1 attempt");
    expect(last?.body).toContain("failed on its own terms");
  });

  it("does NOT retry a configuration error, however cheap it was", async () => {
    const engine = createEngine({
      repo, exec: fakeExec,
      config: config(dir, flakyRunner(99, { stderrTail: "System prompt file not found: agent-instructions/ba.thin.md" })),
    });
    const issue = await engine.start("requirements", { project: "P", feature: "F" });
    await engine.advance(issue.id);

    expect(calls.filter(c => c === "run").length).toBe(1);
    const last = (await repo.listComments(issue.id)).pop();
    expect(last?.body).toContain("configuration error");
  });

  it("gives each attempt its own log file, so one transcript is not two runs", async () => {
    // The runner appends to its log. Without a per-attempt filename the retry
    // writes into the first attempt's log and the console renders the failed
    // attempt's events inside the successful run's transcript.
    mkdirSync(join(dir, "outputs"), { recursive: true });
    writeFileSync(join(dir, "outputs/product-summary.md"), "# summary");

    const engine = createEngine({
      repo, exec: fakeExec,
      config: config(dir, flakyRunner(1, { stderrTail: "fetch failed" })),
    });
    const issue = await engine.start("requirements", { project: "P", feature: "F" });
    await engine.advance(issue.id);

    const paths = (await repo.listRuns(issue.id)).filter(r => r.step_index === 1).map(r => r.log_path);
    expect(new Set(paths).size).toBe(2);
    expect(paths.some(p => p.includes("-retry1"))).toBe(true);
  });

  // ---- progress narration --------------------------------------------------

  it("narrates a HEALTHY run, so the activity timeline is not empty", async () => {
    // The regression this exists for: the engine only ever commented on a
    // block, a retry, or a gate decision carrying a note — so a run that went
    // fine produced NOTHING, and a chatbot user watched an empty panel for the
    // twenty-five minutes an agent takes with no way to tell working from
    // wedged.
    mkdirSync(join(dir, "outputs"), { recursive: true });
    writeFileSync(join(dir, "outputs/product-summary.md"), "# summary");

    const engine = createEngine({ repo, config: config(dir), exec: fakeExec });
    const issue = await engine.start("requirements", { project: "P", feature: "F" });
    await engine.advance(issue.id);

    const bodies = (await repo.listComments(issue.id)).map(c => c.body);
    expect(bodies.length).toBeGreaterThan(0);
    const all = bodies.join("\n");

    expect(all).toContain("Step 1 of 5");            // the exec, positioned
    // NOT the command. This asserted `stage P` until the timeline turned out to
    // be something clients read: an unlabelled exec now narrates "running" and
    // the command appears only if the step fails.
    expect(all).not.toContain("stage P");
    expect(all).toContain("running");
    // The fixture never seeds the org, so the engine falls back to the agent
    // KEY — which is the right fallback: a name it does not have must not stop
    // it saying who is working.
    expect(all).toContain("ba");                     // who is working, and on what
    expect(all).toContain("generate");
    expect(all).toContain("attached 1 work product");
    expect(all).toContain("awaiting your approval");
  });

  it("announces an agent BEFORE it runs, not only after", async () => {
    // Posting only on completion would leave the panel blank for exactly the
    // period the user is watching it.
    mkdirSync(join(dir, "outputs"), { recursive: true });
    writeFileSync(join(dir, "outputs/product-summary.md"), "# summary");

    let commentsWhenRunnerCalled: string[] = [];
    const spy = { run: async () => {
      commentsWhenRunnerCalled = (await repo.listComments(issue.id)).map(c => c.body);
      return { exitCode: 0, status: "succeeded" as const, stderrTail: "",
               usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheCreationTokens: 0,
                        costUsd: 0.5, durationMs: 100, numTurns: 3, sessionId: "s" } };
    } };
    const engine = createEngine({ repo, config: config(dir, spy), exec: fakeExec });
    const issue = await engine.start("requirements", { project: "P", feature: "F" });
    await engine.advance(issue.id);

    expect(commentsWhenRunnerCalled.join("\n")).toMatch(/\*\*ba\*\* generate/);
  });

  it("reports what the run cost when the agent finishes", async () => {
    mkdirSync(join(dir, "outputs"), { recursive: true });
    writeFileSync(join(dir, "outputs/product-summary.md"), "# summary");
    const engine = createEngine({ repo, config: config(dir), exec: fakeExec });
    const issue = await engine.start("requirements", { project: "P", feature: "F" });
    await engine.advance(issue.id);
    // 100ms of reported usage.durationMs, not the engine's own wall clock.
    expect((await repo.listComments(issue.id)).map(c => c.body).join("\n"))
      .toMatch(/finished generate in 0s · \$0\.0100/);
  });

  it("closes the timeline when the workflow completes", async () => {
    mkdirSync(join(dir, "outputs"), { recursive: true });
    writeFileSync(join(dir, "outputs/product-summary.md"), "# summary");
    const engine = createEngine({ repo, config: config(dir), exec: fakeExec });
    const issue = await engine.start("requirements", { project: "P", feature: "F" });
    await engine.advance(issue.id);

    const gate = (await repo.listGates(issue.id))[0];
    await engine.decideGate(gate.id, "approved");

    expect((await repo.getIssue(issue.id))?.status).toBe("done");
    expect((await repo.listComments(issue.id)).map(c => c.body).join("\n"))
      .toMatch(/Requirements complete\./);
  });

  it("does not repeat the approval line when advance() is called twice", async () => {
    // The gate step is idempotent by artefact; its narration has to be too, or
    // a duplicate wake posts "awaiting your approval" again.
    mkdirSync(join(dir, "outputs"), { recursive: true });
    writeFileSync(join(dir, "outputs/product-summary.md"), "# summary");
    const engine = createEngine({ repo, config: config(dir), exec: fakeExec });
    const issue = await engine.start("requirements", { project: "P", feature: "F" });
    await engine.advance(issue.id);
    await engine.advance(issue.id);

    const awaiting = (await repo.listComments(issue.id))
      .filter(c => c.body.includes("awaiting your approval"));
    expect(awaiting.length).toBe(1);
  });

  it("a failed narration never fails the step it was describing", async () => {
    // Narration is commentary. If the comment insert throws, the work that
    // already succeeded must still count.
    mkdirSync(join(dir, "outputs"), { recursive: true });
    writeFileSync(join(dir, "outputs/product-summary.md"), "# summary");
    const brokenRepo = { ...repo, addComment: async () => { throw new Error("db down"); } } as typeof repo;
    const engine = createEngine({ repo: brokenRepo, config: config(dir), exec: fakeExec });
    const issue = await engine.start("requirements", { project: "P", feature: "F" });
    await engine.advance(issue.id);

    expect((await repo.getIssue(issue.id))?.status).toBe("in_review");
    expect((await repo.listGates(issue.id))[0].status).toBe("pending");
  });

  it("says how many runs reported no cost instead of summing them as zero", async () => {
    // A workflow that completed entirely on an adapter that does not price runs
    // must not close with a bare run count that reads as free.
    const companyId = await repo.ensureCompany("Scyne");
    const issue = await repo.createIssue({
      companyId, title: "unpriced", workflowKey: "datamodel",
    });
    const run = await repo.startRun({
      issueId: issue.id, agentId: null, stepIndex: 0, phase: "generate",
      logPath: "/tmp/u.jsonl", adapter: "codex",
    });
    await repo.finishRun(run.id, {
      status: "succeeded", exitCode: 0, sessionId: null,
      inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheCreationTokens: 0,
      costUsd: null, durationMs: 1000, numTurns: 3,
    });

    const line = closingNote(await repo.listRuns(issue.id), "Data Model");
    expect(line).toContain("1 agent run");
    expect(line).toContain("cost not reported");
    expect(line).not.toContain("$0.0000");
  });
});

describe("costing a run whose CLI reports no cost", () => {
  /** A runner shaped like Codex: real token counts, no dollar figure at all. */
  const codexLike = (inTok = 1_000_000, outTok = 1_000_000) => ({
    run: async () => { calls.push("run"); return {
      exitCode: 0, status: "succeeded" as const, stderrTail: "",
      usage: { inputTokens: inTok, outputTokens: outTok, cacheReadTokens: 0,
               cacheCreationTokens: 0, costUsd: null, durationMs: 100, numTurns: 1,
               sessionId: "s" } }; },
  });

  function pricedConfig(workspace: string, runner: any, model: string) {
    const c = config(workspace, runner) as any;
    c.defaults = { ...c.defaults, model };
    c.org = [{ key: "ba", name: "BA", model }];
    return c;
  }

  it("records which model ran, so the run can be priced at all", async () => {
    mkdirSync(join(dir, "outputs"), { recursive: true });
    writeFileSync(join(dir, "outputs/product-summary.md"), "# s");
    const engine = createEngine({ repo, config: pricedConfig(dir, codexLike(), "gpt-5.6-terra"), exec: fakeExec });
    const issue = await engine.start("requirements", { project: "P" });
    await engine.advance(issue.id);
    const run = (await repo.listRuns(issue.id))[0];
    expect(run.model).toBe("gpt-5.6-terra");
  });

  it("estimates the cost, and says the figure is ours", async () => {
    mkdirSync(join(dir, "outputs"), { recursive: true });
    writeFileSync(join(dir, "outputs/product-summary.md"), "# s");
    const engine = createEngine({ repo, config: pricedConfig(dir, codexLike(), "gpt-5.6-terra"), exec: fakeExec });
    const issue = await engine.start("requirements", { project: "P" });
    await engine.advance(issue.id);

    const run = (await repo.listRuns(issue.id))[0];
    // gpt-5.6-terra: 1M in at $2 + 1M out at $12
    expect(Number(run.est_cost_usd)).toBeCloseTo(14, 4);
    expect(run.cost_source).toBe("estimated");
    // The reported column stays empty. Merging the two would make the total
    // unauditable, which is the whole reason they are separate columns.
    expect(run.cost_usd).toBeNull();
  });

  it("leaves an UNPRICED model with no figure rather than with zero", async () => {
    mkdirSync(join(dir, "outputs"), { recursive: true });
    writeFileSync(join(dir, "outputs/product-summary.md"), "# s");
    const engine = createEngine({
      repo, config: pricedConfig(dir, codexLike(), "gpt-5.3-codex-spark"), exec: fakeExec });
    const issue = await engine.start("requirements", { project: "P" });
    await engine.advance(issue.id);

    const run = (await repo.listRuns(issue.id))[0];
    expect(run.est_cost_usd).toBeNull();
    expect(run.cost_source).toBeNull();
  });

  it("leaves a model nobody has priced alone", async () => {
    mkdirSync(join(dir, "outputs"), { recursive: true });
    writeFileSync(join(dir, "outputs/product-summary.md"), "# s");
    const engine = createEngine({
      repo, config: pricedConfig(dir, codexLike(), "some-model-we-never-heard-of"), exec: fakeExec });
    const issue = await engine.start("requirements", { project: "P" });
    await engine.advance(issue.id);
    expect((await repo.listRuns(issue.id))[0].est_cost_usd).toBeNull();
  });

  it("does NOT overwrite a cost the CLI did report", async () => {
    mkdirSync(join(dir, "outputs"), { recursive: true });
    writeFileSync(join(dir, "outputs/product-summary.md"), "# s");
    // fakeRunner reports costUsd: 0.01
    const engine = createEngine({ repo, config: pricedConfig(dir, fakeRunner, "gpt-5.6-terra"), exec: fakeExec });
    const issue = await engine.start("requirements", { project: "P" });
    await engine.advance(issue.id);

    const run = (await repo.listRuns(issue.id))[0];
    expect(Number(run.cost_usd)).toBeCloseTo(0.01, 6);
    expect(run.est_cost_usd).toBeNull();
    expect(run.cost_source).toBe("reported");
  });

  it("fires a cost budget on the ESTIMATE — the whole point of pricing Codex", async () => {
    // Before this, a cost ceiling could not fire on a Codex run at all,
    // because the runner checks the CLI's own reported figure and Codex
    // reports none. Moving the org onto Codex silently removed the dollar cap.
    mkdirSync(join(dir, "outputs"), { recursive: true });
    writeFileSync(join(dir, "outputs/product-summary.md"), "# s");
    const engine = createEngine({
      repo, config: pricedConfig(dir, codexLike(), "gpt-5.6-terra"), exec: fakeExec });
    const issue = await engine.start("requirements", { project: "P" });
    // This suite does not seed the org chart, so `upsertAgent` never wrote a
    // budget row. Set it directly, against the company the issue landed in.
    const started = (await repo.getIssue(issue.id))!;
    await repo.setBudget(started.company_id, "agent", "ba", { maxCostUsd: 1 });
    await engine.advance(issue.id);

    const run = (await repo.listRuns(issue.id))[0];
    expect(run.status).toBe("over_budget");

    const comments = await repo.listComments(issue.id);
    const said = comments.map(c => c.body).join("\n");
    // Being stopped by an arithmetic nobody can see is worse than not being
    // stopped, so the comment has to say whose figure it is.
    expect(said).toMatch(/estimated/i);
    expect(said).toMatch(/gpt-5\.6-terra/);
  });

  it("does not fire a budget the estimate is under", async () => {
    mkdirSync(join(dir, "outputs"), { recursive: true });
    writeFileSync(join(dir, "outputs/product-summary.md"), "# s");
    const engine = createEngine({
      repo, config: pricedConfig(dir, codexLike(1000, 1000), "gpt-5.6-terra"), exec: fakeExec });
    const issue = await engine.start("requirements", { project: "P" });
    const started = (await repo.getIssue(issue.id))!;
    await repo.setBudget(started.company_id, "agent", "ba", { maxCostUsd: 5 });
    await engine.advance(issue.id);
    expect((await repo.listRuns(issue.id))[0].status).toBe("succeeded");
  });
});

/**
 * A step works in a tree it was handed, and gives it back.
 *
 * Per STEP rather than per issue: a workflow parks at a gate for hours or days,
 * and a temporary directory that must survive that is a lifecycle nobody wants
 * to own on a container that can restart. Nothing survives a step, so nothing
 * can be orphaned by a replica dying mid-run.
 */
describe("a step works in the tree it is given", () => {
  /** Records every root handed out and how each was released. */
  const recordingProvider = (roots: string[], released: boolean[]) => () => ({
    async acquire() {
      const root = mkdtempSync(join(tmpdir(), "orch-step-"));
      mkdirSync(join(root, "outputs"), { recursive: true });
      writeFileSync(join(root, "outputs/product-summary.md"), "# summary");
      roots.push(root);
      return {
        root,
        async release(ok: boolean) { released.push(ok); rmSync(root, { recursive: true, force: true }); },
      };
    },
  });

  it("acquires a fresh tree per step and releases every one", async () => {
    const roots: string[] = [], released: boolean[] = [];
    const cfg = { ...config(dir), workspaces: recordingProvider(roots, released) };
    const engine = createEngine({ repo, config: cfg, exec: fakeExec, db });
    const issue = await engine.start("requirements", { project: "P", feature: "F" });
    await engine.advance(issue.id);

    // exec, agent, attach, gate — four steps, four trees, four releases.
    expect(roots.length).toBeGreaterThanOrEqual(3);
    expect(released.length).toBe(roots.length);
    // Each one is its own directory, not one shared root handed out repeatedly.
    expect(new Set(roots).size).toBe(roots.length);
    // And none of them survives.
    for (const r of roots) expect(existsSync(r)).toBe(false);
  });

  it("keeps what a successful step wrote", async () => {
    const roots: string[] = [], released: boolean[] = [];
    const cfg = { ...config(dir), workspaces: recordingProvider(roots, released) };
    const engine = createEngine({ repo, config: cfg, exec: fakeExec, db });
    const issue = await engine.start("requirements", { project: "P", feature: "F" });
    await engine.advance(issue.id);
    expect(released.every(ok => ok)).toBe(true);
  });

  it("discards WITHOUT keeping when a step fails", async () => {
    // A failed step leaves a half-written tree, and after this change there is
    // no second copy to recover from — so a half-written tree must never
    // become the record.
    const roots: string[] = [], released: boolean[] = [];
    const failing = async (cmd: string) => { calls.push(`exec:${cmd}`); return { code: 1, stdout: "", stderr: "boom" }; };
    const cfg = { ...config(dir), workspaces: recordingProvider(roots, released) };
    const engine = createEngine({ repo, config: cfg, exec: failing, db });
    const issue = await engine.start("requirements", { project: "P", feature: "F" });
    await engine.advance(issue.id);

    expect((await repo.getIssue(issue.id))?.status).toBe("blocked");
    expect(released).toEqual([false]);
    expect(existsSync(roots[0])).toBe(false);
  });

  it("falls back to the static workspace when a provider declines", async () => {
    // An issue with no project resolves to nothing to materialise, which is a
    // real state rather than an error — `createIssue` leaves `project_id` null
    // rather than guessing when a name matches nothing.
    mkdirSync(join(dir, "outputs"), { recursive: true });
    writeFileSync(join(dir, "outputs/product-summary.md"), "# summary");
    const cfg = { ...config(dir), workspaces: () => ({ acquire: async () => null }) };
    const engine = createEngine({ repo, config: cfg, exec: fakeExec, db });
    const issue = await engine.start("requirements", { project: "P", feature: "F" });
    await engine.advance(issue.id);
    // Reached the gate, meaning attach found its file in the static tree.
    expect((await repo.getIssue(issue.id))?.status).toBe("in_review");
  });
});

describe("coalesceKey", () => {
  // Nine uploads used to start nine `extract` issues, racing each other over
  // one project's document tree; eight of them blocked. `requirements` stands
  // in for `extract` here — coalescing is a property of the engine, not of any
  // one workflow, and this file's config already defines it.

  it("returns the open issue instead of creating a second", async () => {
    const engine = createEngine({ repo, config: config(dir), exec: fakeExec });
    const a = await engine.start("requirements", { project: "P" }, { coalesceKey: "extract:P" });
    const b = await engine.start("requirements", { project: "P" }, { coalesceKey: "extract:P" });

    expect(a.coalesced).toBe(false);
    expect(b.coalesced).toBe(true);
    expect(b.id).toBe(a.id);
  });

  it("does not coalesce onto a terminal issue", async () => {
    const engine = createEngine({ repo, config: config(dir), exec: fakeExec });
    const a = await engine.start("requirements", { project: "P" }, { coalesceKey: "extract:P" });
    await repo.updateIssue(a.id, { status: "done" });

    const b = await engine.start("requirements", { project: "P" }, { coalesceKey: "extract:P" });
    expect(b.coalesced).toBe(false);
    expect(b.id).not.toBe(a.id);
  });

  it("does not coalesce across projects", async () => {
    const engine = createEngine({ repo, config: config(dir), exec: fakeExec });
    const a = await engine.start("requirements", { project: "P" }, { coalesceKey: "extract:P" });
    const b = await engine.start("requirements", { project: "Q" }, { coalesceKey: "extract:Q" });
    expect(b.id).not.toBe(a.id);
  });

  it("creates normally when no key is given", async () => {
    const engine = createEngine({ repo, config: config(dir), exec: fakeExec });
    const a = await engine.start("requirements", { project: "P" });
    const b = await engine.start("requirements", { project: "P" });
    expect(b.id).not.toBe(a.id);
    expect(a.coalesced).toBe(false);
  });

  it("records the key on the issue it created, so a later start can find it", async () => {
    const engine = createEngine({ repo, config: config(dir), exec: fakeExec });
    const a = await engine.start("requirements", { project: "P" }, { coalesceKey: "extract:P" });
    // Read back from the DATABASE, not from the return value: the lookup
    // queries params->>'coalesceKey', so it has to actually be persisted.
    const stored = await repo.getIssue(a.id);
    expect(stored?.params.coalesceKey).toBe("extract:P");
    expect(stored?.params.project).toBe("P");
  });

  it("does not coalesce onto a BLOCKED issue", async () => {
    // `blocked` is not "still going" — the router deliberately does not
    // advance() a coalesced issue, so joining one that nothing will move is a
    // silent drop: the document that triggered the start never gets extracted
    // and nothing anywhere reports a fault. SA-DEMO's SCY-1 and SCY-2 are the
    // measured case, both parked at the validator for ever.
    const engine = createEngine({ repo, config: config(dir), exec: fakeExec });
    const a = await engine.start("requirements", { project: "P" }, { coalesceKey: "extract:P" });
    await repo.updateIssue(a.id, { status: "blocked" });

    const b = await engine.start("requirements", { project: "P" }, { coalesceKey: "extract:P" });
    expect(b.coalesced).toBe(false);
    expect(b.id).not.toBe(a.id);
  });

  it("does not coalesce onto an issue waiting on a human", async () => {
    // Same reasoning as `blocked`, for the other two statuses only a person
    // moves. Joining any of them parks the new work behind a decision nobody
    // knows they owe.
    for (const status of ["paused", "in_review"]) {
      const engine = createEngine({ repo, config: config(dir), exec: fakeExec });
      const key = `extract:${status}`;
      const a = await engine.start("requirements", { project: "P" }, { coalesceKey: key });
      await repo.updateIssue(a.id, { status });

      const b = await engine.start("requirements", { project: "P" }, { coalesceKey: key });
      expect(b.coalesced, `should not join a ${status} issue`).toBe(false);
    }
  });

  it("still coalesces onto an issue the engine will reach on its own", async () => {
    // The other half of the rule: `todo` and `in_progress` are exactly the
    // statuses where the work IS still coming, and joining them is the whole
    // point — 50 uploads, one issue.
    for (const status of ["todo", "in_progress"]) {
      const engine = createEngine({ repo, config: config(dir), exec: fakeExec });
      const key = `extract:live-${status}`;
      const a = await engine.start("requirements", { project: "P" }, { coalesceKey: key });
      await repo.updateIssue(a.id, { status });

      const b = await engine.start("requirements", { project: "P" }, { coalesceKey: key });
      expect(b.coalesced, `should join a ${status} issue`).toBe(true);
      expect(b.id).toBe(a.id);
    }
  });

  it("supersedes the blocked issue it stepped past", async () => {
    // Left standing, the blocked issue sits in the console's `blocked` counter
    // for ever with nothing to do: its successor extracts the same documents
    // and reaches `done`, so there is no work left in it to resume. Cancelling
    // is what makes the count mean "needs a human" again.
    const engine = createEngine({ repo, config: config(dir), exec: fakeExec });
    const a = await engine.start("requirements", { project: "P" }, { coalesceKey: "extract:P" });
    await repo.updateIssue(a.id, { status: "blocked" });

    const b = await engine.start("requirements", { project: "P" }, { coalesceKey: "extract:P" });

    const old = await repo.getIssue(a.id);
    expect(old?.status).toBe("cancelled");
    // Named, so the timeline says where the work went rather than just ending.
    const said = (await repo.listComments(a.id)).map(c => c.body).join("\n");
    expect(said).toContain(b.identifier);
  });

  it("supersedes every blocked issue carrying the key, not just the newest", async () => {
    // SA-DEMO ended with TWO. Cancelling one would have left the counter at 1
    // and the same question unanswered.
    const engine = createEngine({ repo, config: config(dir), exec: fakeExec });
    const a = await engine.start("requirements", { project: "P" }, { coalesceKey: "extract:P" });
    await repo.updateIssue(a.id, { status: "blocked" });
    const b = await engine.start("requirements", { project: "P" }, { coalesceKey: "extract:P" });
    await repo.updateIssue(b.id, { status: "blocked" });

    await engine.start("requirements", { project: "P" }, { coalesceKey: "extract:P" });

    expect((await repo.getIssue(a.id))?.status).toBe("cancelled");
    expect((await repo.getIssue(b.id))?.status).toBe("cancelled");
  });

  it("supersedes ONLY the blocked ones — never a paused issue", async () => {
    // A pause is somebody's deliberate act and they intend to come back to it.
    // A block is the engine giving up. Only the second is ours to clear.
    const engine = createEngine({ repo, config: config(dir), exec: fakeExec });
    const a = await engine.start("requirements", { project: "P" }, { coalesceKey: "extract:P" });
    await repo.updateIssue(a.id, { status: "paused" });

    await engine.start("requirements", { project: "P" }, { coalesceKey: "extract:P" });
    expect((await repo.getIssue(a.id))?.status).toBe("paused");
  });

  it("supersedes nothing when it JOINED an issue rather than creating one", async () => {
    // The supersede is a consequence of stepping past a dead issue. A start
    // that coalesced stepped past nothing.
    const engine = createEngine({ repo, config: config(dir), exec: fakeExec });
    const a = await engine.start("requirements", { project: "P" }, { coalesceKey: "extract:P" });
    const b = await engine.start("requirements", { project: "P" }, { coalesceKey: "extract:P" });

    expect(b.id).toBe(a.id);
    expect((await repo.getIssue(a.id))?.status).not.toBe("cancelled");
  });

  it("supersedes nothing across coalesce keys", async () => {
    // A blocked extract on project P must survive a start for project Q.
    const engine = createEngine({ repo, config: config(dir), exec: fakeExec });
    const a = await engine.start("requirements", { project: "P" }, { coalesceKey: "extract:P" });
    await repo.updateIssue(a.id, { status: "blocked" });

    await engine.start("requirements", { project: "Q" }, { coalesceKey: "extract:Q" });
    expect((await repo.getIssue(a.id))?.status).toBe("blocked");
  });

  it("supersedes nothing when no key is given", async () => {
    // Every other caller in the system starts without a key, and a bare start
    // must never reach across and cancel somebody else's blocked issue.
    const engine = createEngine({ repo, config: config(dir), exec: fakeExec });
    const a = await engine.start("requirements", { project: "P" }, { coalesceKey: "extract:P" });
    await repo.updateIssue(a.id, { status: "blocked" });

    await engine.start("requirements", { project: "P" });
    expect((await repo.getIssue(a.id))?.status).toBe("blocked");
  });
});

describe("attempt counting alongside fan-out runs", () => {
  /**
   * A fan-out step writes one run row per ITEM at a single step_index —
   * scripts/extract-documents.mjs writes one per document. Those are the step's
   * output, not attempts at it, and counting them as attempts makes the engine
   * lie to whoever is reading the blocked issue: "after 11 attempts" when the
   * agent ran twice.
   *
   * An engine-started run carries the step's own phase; a fan-out row carries
   * `extract: <docId>`. `agent_id` cannot be the discriminator — fan-out rows
   * deliberately carry one, because that spend must attribute to the agent that
   * incurred it.
   */
  it("counts only runs of this step's phase, not a fan-out's rows", async () => {
    // Fails instantly having accounted for nothing — the one case that retries.
    const failing = { run: async () => { calls.push("run"); return {
      exitCode: 1, status: "failed" as const, usage: null,
      stderrTail: "Error: connect ETIMEDOUT" }; } };

    const engine = createEngine({ repo, config: config(dir, failing), exec: fakeExec });
    const issue = await engine.start("requirements", { project: "P", feature: "F" });

    // Nine fan-out rows at the agent step's index, as the extract script writes.
    for (let i = 0; i < 9; i++) {
      await repo.startRun({
        issueId: issue.id, stepIndex: 1, phase: `extract: documents/doc${i}.md`,
        logPath: join(dir, `fanout-${i}.jsonl`),
      });
    }

    await engine.advance(issue.id);

    // The agent ran twice: one attempt plus its single automatic retry.
    expect(calls.filter(c => c === "run").length).toBe(2);

    const blocking = (await repo.listComments(issue.id)).map(c => c.body).join("\n");
    expect(blocking).toMatch(/after 2 attempts/);
    // The bug this pins: nine unrelated rows must not be read as nine attempts.
    expect(blocking).not.toMatch(/after 11 attempts/);
  });
});
