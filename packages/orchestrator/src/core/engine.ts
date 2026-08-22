// The engine sequences a workflow's steps against an issue, one wake at a
// time. It owns every issue status transition (todo → in_progress →
// in_review → done/blocked) and parks — returns, without looping — at
// anything that waits on something external: a human approval gate, or a
// spawned child flow.
//
// Deliberately takes NO runner. Every agent step resolves its runtime
// (adapter/model/effort) via `resolveRuntime` (step → agent → defaults) and
// looks the adapter up in `config.adapters` at the moment it is needed. That
// indirection is what lets seven different CLI/API adapters plug in later
// without this file changing — and it is what lets every test in this suite
// run against a fake registered under `config.adapters.claude_local`, so no
// Claude process and no shell is ever spawned by the engine itself.

import { exec as nodeExec } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { interpolate } from "./interpolate.js";
import { classifyFailure } from "./retry.js";
import { priceRun } from "./usage.js";
import { killRun } from "./spawn.js";
import type { RunResult } from "./runner.js";
import { resolveRuntime } from "../config.js";
import type { OrchestratorConfig, OrchestratorDefaults, Step, WorkflowDef } from "../config.js";
import type { createRepo, AgentRow, IssueRow } from "./repo.js";

/** The shape `createRepo(db)` returns. There is no separately exported `Repo` interface (Task 2). */
type Repo = ReturnType<typeof createRepo>;

/**
 * The closing line of an issue's timeline.
 *
 * Exported so it can be tested directly, and because the unpriced case is
 * easy to get wrong: `sum(cost_usd)` over rows where some are null yields a
 * number that looks complete and is not. An adapter that reports no cost
 * (Codex does not price its own runs) must produce a line that says so, not a
 * quiet total that understates what was spent.
 */
export function closingNote(runs: Array<{ cost_usd: string | number | null }>, label: string): string {
  const priced = runs.filter(r => r.cost_usd != null);
  const total = priced.reduce((n, r) => n + Number(r.cost_usd), 0);
  const unpriced = runs.length - priced.length;

  return `**${label} complete.** ${runs.length} agent run${runs.length === 1 ? "" : "s"}` +
    (total > 0 ? ` · $${total.toFixed(4)}` : "") +
    (unpriced ? ` · cost not reported for ${unpriced} run${unpriced === 1 ? "" : "s"}` : "") + `.`;
}

/**
 * `env` is how an `exec` step is told which project tree to act on. The ten
 * scripts under `scripts/` all resolve their root as
 * `process.env.WORKSPACE_PATH || <the script's own directory>/..`, so setting
 * it is the whole mechanism — no script needs to change, and one that is run
 * by hand keeps behaving exactly as it does today. Optional so the fakes in
 * engine.test.ts, which take only `cmd`, still satisfy the type.
 */
export type ExecFn = (cmd: string, cwd: string, timeoutMs?: number, env?: NodeJS.ProcessEnv)
  => Promise<{ code: number; stdout: string; stderr: string }>;

/**
 * Ceiling on how much of one file is injected into a prompt. A product summary
 * is ~40 KB and a stories.json ~85 KB, so this is roughly 3x the largest real
 * artefact — high enough never to fire in normal use, low enough that a
 * pathological input cannot blow the context window before the agent has read
 * its own instructions.
 */
export const MAX_READ_CHARS = 256_000;

export interface Engine {
  start(
    workflowKey: string,
    params: Record<string, string>,
    opts?: { companyId?: string; createdBy?: string | null },
  ): Promise<IssueRow>;
  advance(issueId: string): Promise<void>;
  retry(issueId: string): Promise<void>;
  /**
   * Ask a running issue to stop.
   *
   * `force: false` (the default) lets the in-flight step finish and parks
   * before the NEXT one — nothing lost, nothing wasted, but it can take as
   * long as an agent run. `force: true` kills the child now and parks at THIS
   * step, which will be re-run on resume.
   */
  pause(issueId: string, opts?: { force?: boolean; by?: string | null }): Promise<IssueRow | null>;
  /** Stop for good. Kills any live child; the issue does not resume. */
  cancel(issueId: string, opts?: { by?: string | null }): Promise<IssueRow | null>;
  /** Carry a paused issue on from where it stopped. */
  resume(issueId: string): Promise<void>;
  /**
   * Record a gate decision and, unless `opts.advance` is false, carry the issue
   * forward from it. HTTP callers pass `{ advance: false }` and fire `advance()`
   * themselves in the background: resuming runs an agent step, and a request
   * that waits for one holds the connection open for tens of minutes. Returns
   * the issue the gate belongs to, so a caller that opted out knows what to
   * advance.
   */
  decideGate(gateId: string, status: "approved" | "rejected", note?: string, by?: string,
             opts?: { advance?: boolean }): Promise<{ issueId: string }>;
  recoverOrphans(): Promise<void>;
}

/**
 * Real shell exec, used only when a caller supplies none — production use.
 * Every test in engine.test.ts injects its own `exec`, so this path is never
 * hit by the suite.
 */
const defaultExec: ExecFn = (cmd, cwd, timeoutMs = 20 * 60_000, env) =>
  new Promise((res) => {
    nodeExec(cmd, { cwd, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, env: env ?? process.env },
      (err, stdout, stderr) => res({ code: err ? (err.code ?? 1) : 0, stdout, stderr }));
  });

/**
 * `stopped` is what a step returns when an operator killed it mid-flight.
 *
 * It is deliberately NOT `blocked`: blocking would overwrite the `paused` or
 * `cancelled` status the control request is about to set, and would leave the
 * timeline saying the agent failed when in fact somebody stopped it. It sends
 * `advance()` back to the top of its loop WITHOUT advancing `step_index`, so
 * the control check there records what actually happened.
 */
type StepOutcome = "next" | "wait" | "blocked" | "stopped";

export function createEngine(deps: {
  repo: Repo; config: OrchestratorConfig; exec?: ExecFn;
}): Engine {
  const { repo, config } = deps;
  const exec = deps.exec ?? defaultExec;

  /**
   * The two roots, resolved once. `config.workspace` used to answer both of
   * these questions at once, which is true only while one checkout holds the
   * code AND the projects — the shape a plugin breaks immediately.
   *
   *   installRoot   skills/, agent-instructions/, scripts/, .mcp.json.
   *                 Where the code and its library live.
   *   workRoot      projects/, generated-apps/. The tree being worked on.
   *
   * `workRoot` defaults to `installRoot`, so today nothing moves and the
   * existing suite is the proof of that. Materialisation supplies a different
   * one per run, and only the value changes — every consumer below already
   * names which of the two it wants.
   */
  const installRoot = config.workspace;
  const workRoot = config.workRoot ?? config.workspace;

  /**
   * The environment an `exec` step's child process gets.
   *
   * `exec` steps run with cwd = installRoot, because their commands name
   * `scripts/…` relatively and that is where the scripts are. They are pointed
   * at the project tree through `WORKSPACE_PATH` instead — the variable those
   * scripts already read. Agent steps are the other way round (cwd = workRoot),
   * because their prompts name `projects/{project}/…` relatively.
   */
  const execEnv = (vars: Record<string, string> = {}): NodeJS.ProcessEnv => ({
    ...process.env,
    WORKSPACE_PATH: workRoot,
    SCYNE_WORK_ROOT: workRoot,
    SCYNE_INSTALL_ROOT: installRoot,
    // How an exec step reaches an OPTIONAL param. It cannot name one in its
    // command: `interpolate` throws on a placeholder the issue does not carry,
    // so `--parent {adoParentEpicId}` would block every run that omits it —
    // which is exactly how the requirements publish broke once, and why
    // `ensureAdoProjectStep` restricts itself to `{project}`. The agent side
    // has had this escape all along: `buildPrompt` appends every param as a
    // `Parameters:` block for precisely the same reason.
    ...Object.fromEntries(
      Object.entries(vars).map(([k, v]) => [`SCYNE_PARAM_${k.toUpperCase()}`, v])),
  });

  // Per-issue in-memory lock. advance() must be safe to call twice
  // concurrently for the same issue — a status-change trigger and a manual
  // "check now" landing at the same moment, say — without running one step
  // twice. A second call arriving while the first is still stepping through
  // the workflow simply no-ops rather than interleaving with it; the first
  // call's own loop already carries the issue forward as far as it can go
  // in one pass.
  const locks = new Set<string>();

  const workflow = (key: string | null): WorkflowDef => {
    const w = key ? config.workflows.find(wf => wf.key === key) : undefined;
    if (!w) throw new Error(`unknown workflow '${key}'`);
    return w;
  };

  async function block(issueId: string, message: string): Promise<void> {
    await repo.addComment(issueId, message, { user: "orchestrator" });
    await repo.updateIssue(issueId, { status: "blocked" });
  }

  /**
   * Narrate a step to the issue's comment timeline.
   *
   * Before this, the engine wrote a comment in exactly three situations — a
   * block, a retry, and a gate decision carrying a note — so a HEALTHY run
   * produced nothing at all. A chatbot user watched an empty activity panel for
   * the twenty-five minutes an agent takes, with no way to tell a working run
   * from a wedged one.
   *
   * The Paperclip-era bundles made each agent post its own progress ("Live
   * progress comments (REQUIRED — clients watch the chatbot timeline)"). That
   * instruction was correctly deleted when the bundles were thinned — an agent
   * should not be calling an API — but nothing replaced it. The engine is the
   * right author: it knows precisely where it is, it spends no tokens saying
   * so, and one implementation covers every workflow and both UIs.
   *
   * Deliberately terse. This is a timeline, not a log; the Live Transcript
   * already carries the detail of what an agent is doing minute to minute.
   */
  async function note(issueId: string, body: string): Promise<void> {
    // Narration must never be the thing that fails a run: a comment insert that
    // throws would abort a step whose real work had already succeeded.
    try {
      await repo.addComment(issueId, body, { user: "orchestrator" });
    } catch (err) {
      console.error(`[orchestrator] could not record progress on ${issueId}:`, err);
    }
  }

  /** "step 2 of 6" — the position a person actually asks about. */
  const where = (issue: IssueRow, wf: WorkflowDef): string =>
    `Step ${issue.step_index + 1} of ${wf.steps.length}`;

  const humanDuration = (ms: number): string => {
    const sec = Math.round(ms / 1000);
    if (sec < 90) return `${sec}s`;
    const m = Math.floor(sec / 60);
    return m < 60 ? `${m}m ${sec % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
  };

  /**
   * `AgentRow`'s nullable columns (`model: string | null`, `effort: string |
   * null`) don't line up with `resolveRuntime`'s optional-field shape
   * (`model?: string`) — null and undefined are different types under
   * strict mode. Converted once, here, rather than at every call site.
   */
  function toRuntimeAgent(agent: AgentRow | null): { adapter?: string; model?: string; effort?: string; fallbackModel?: string[] } | null {
    if (!agent) return null;
    // `?? undefined` on the adapter is load-bearing, not tidying. A null
    // adapter means the agent expresses no preference, and resolveRuntime
    // falls through step -> agent -> scope -> defaults on undefined ONLY.
    // Passing null answers the question with "null" and stops the chain,
    // which is exactly how a configured default came to be ignored.
    return {
      adapter: agent.adapter ?? undefined,
      model: agent.model ?? undefined,
      effort: agent.effort ?? undefined,
      // Raw off the row — resolveRuntime is what decides whether this
      // actually reaches the runner (only when the FINAL resolved adapter is
      // claude_local; see its own doc comment for why).
      fallbackModel: agent.fallback_model,
    };
  }

  /**
   * Runtime settings that apply to this issue because of what it is ABOUT.
   *
   * For each name in `config.runtimeScopes` (the CONSUMER says which issue
   * params are scopes — this library does not know what a "project" is), the
   * issue's own param value is the scope key. Company-wide settings come last,
   * so a project overrides the organisation and the organisation overrides the
   * config file.
   *
   * This is what makes "this client's work runs on Azure" expressible at all:
   * before it the only dimensions were per-step, per-agent, and one global
   * default read from an environment variable at boot.
   */
  async function scopedSettings(issue: IssueRow): Promise<Array<Partial<OrchestratorDefaults>>> {
    const out: Array<Partial<OrchestratorDefaults>> = [];
    const params = (issue.params ?? {}) as Record<string, unknown>;
    try {
      for (const scope of config.runtimeScopes ?? []) {
        const key = params[scope];
        if (typeof key !== "string" || !key) continue;
        const found = await repo.getSettings(issue.company_id, scope, key);
        if (Object.keys(found).length) out.push(found as Partial<OrchestratorDefaults>);
      }
      const company = await repo.getSettings(issue.company_id, "company", "*");
      if (Object.keys(company).length) out.push(company as Partial<OrchestratorDefaults>);
    } catch (err) {
      // A settings lookup that fails must not stop a run — the configured
      // defaults are a complete answer on their own.
      console.error("[orchestrator] could not read runtime settings:", err);
    }
    return out;
  }

  /**
   * Resolve an agent step's `reads` into prompt variables. Returns the
   * variables it could read AND the entries it could not, so the caller can
   * block naming every missing path at once rather than one per retry.
   */
  async function readVars(
    step: Extract<Step, { type: "agent" }>,
    vars: Record<string, string>,
  ): Promise<{ vars: Record<string, string>; missing: string[] }> {
    const out: Record<string, string> = {};
    const missing: string[] = [];
    for (const [name, tpl] of Object.entries(step.reads ?? {})) {
      const rel = interpolate(tpl, vars);
      try {
        // workRoot: a `reads` entry names a project artefact
        // (`projects/{project}/…/salesforce-data-model.md`), never a library file.
        const body = await readFile(resolve(workRoot, rel), "utf8");
        out[name] = body.length > MAX_READ_CHARS
          ? `${body.slice(0, MAX_READ_CHARS)}\n\n[…truncated at ${MAX_READ_CHARS} characters]`
          : body;
      } catch {
        missing.push(`${name} → ${rel}`);
      }
    }
    return { vars: out, missing };
  }

  function buildPrompt(step: Extract<Step, { type: "agent" }>, wf: WorkflowDef, vars: Record<string, string>): string {
    const params = Object.entries(vars)
      .filter(([k]) => k !== "workspace" && k !== "issueId" && !(k in (step.reads ?? {})))
      .map(([k, v]) => `  ${k}: ${v}`);

    if (step.prompt) {
      // The appendix is not decoration: it is how an explicit prompt reaches
      // optional params (confluenceSpace, jiraProjectKey, startingStoryNumber)
      // without a `{placeholder}` that would throw on every run omitting them.
      return [interpolate(step.prompt, vars), ``, `Parameters:`, ...params].join("\n");
    }
    return [
      `Run PHASE ${step.phase} for workflow \`${wf.key}\`.`,
      ...params,
      step.skill ? `  Invoke skill: ${step.skill}` : "",
      ``,
      `Do not call any API. Do not change issue status. Exit when your files are written.`,
    ].filter(Boolean).join("\n");
  }

  async function runStep(step: Step, issue: IssueRow, wf: WorkflowDef, vars: Record<string, string>): Promise<StepOutcome> {
    switch (step.type) {
      case "exec": {
        const cmd = interpolate(step.cmd, vars);
        // The first thing a person sees after clicking Run — and that person is
        // often a CLIENT watching the chatbot, not an operator. So this narrates
        // the step's `label` and never the command: a shell line tells them
        // nothing they wanted to know while disclosing a path on somebody's
        // machine. The command is still recorded verbatim in the blocking
        // comment below, where whoever is debugging actually needs it.
        await note(issue.id,
          `${where(issue, wf)} · ${step.label ? interpolate(step.label, vars) : "running"}`);
        // installRoot: the command says `node scripts/stage.mjs …`, and that
        // path is relative to where the scripts live. The project tree reaches
        // it through WORKSPACE_PATH in execEnv() instead.
        const r = await exec(cmd, step.cwd ?? installRoot, step.timeoutMs, execEnv(vars));
        if (r.code !== 0) {
          // The label in the headline, the command inside the fence with the
          // stderr. A failure is the one moment the exact command is worth
          // having — but it belongs in the diagnostics block a person opens,
          // not in the sentence a client reads.
          const rewind = step.rewindOnFailure;
          await block(issue.id,
            `${step.label ? interpolate(step.label, vars) : "A step"} failed (exit ${r.code}).` +
            `\n\n\`\`\`\n$ ${cmd}\n\n${r.stderr.slice(-2000)}\n\`\`\`` +
            (rewind != null && rewind < issue.step_index
              ? `\n\nResume will re-run step ${rewind + 1}, not this one — this step ` +
                `checks that step's work, so re-running the check cannot change the answer.`
              : ""));
          // AFTER block(), which sets the status: this only moves the cursor.
          // Guarded on `< step_index` so a mis-set value can never turn Resume
          // into an infinite loop forward through the workflow.
          if (rewind != null && rewind < issue.step_index) {
            await repo.updateIssue(issue.id, { stepIndex: rewind });
          }
          return "blocked";
        }
        return "next";
      }

      case "agent": {
        const agentKey = step.agent ?? wf.assignee;
        const agentRow = await repo.getAgentByKey(issue.company_id, agentKey);

        const read = await readVars(step, vars);
        if (read.missing.length) {
          // Block BEFORE startRun(): a run row for a step that never spawned a
          // process shows in the console as a zero-token mystery failure.
          await block(issue.id,
            `Step ${issue.step_index} (\`agent\`) cannot read its required input file(s):\n` +
            read.missing.map(m => `- \`${m}\``).join("\n"));
          return "blocked";
        }

        // Resolve adapter / model / effort: step → agent → defaults.
        const rt = resolveRuntime(
          step, toRuntimeAgent(agentRow), config.defaults, await scopedSettings(issue));
        const runner = config.adapters[rt.adapter];
        if (!runner) {
          await block(issue.id,
            `Agent \`${agentKey}\`: adapter '${rt.adapter}' is not registered. ` +
            `Available: ${Object.keys(config.adapters).join(", ") || "(none)"}.`);
          return "blocked";
        }

        // Budget: the workflow's limit wins over the agent's when both exist.
        const agentBudget = await repo.getBudget(issue.company_id, "agent", agentKey);
        const wfBudget = await repo.getBudget(issue.company_id, "workflow", wf.key);
        const b = wfBudget ?? agentBudget;
        // Postgres returns bigint/numeric columns as STRINGS — Number() them
        // before they reach RunRequest.budget, which wants real numbers.
        const budget = b ? {
          maxTokens: b.max_tokens ? Number(b.max_tokens) : undefined,
          maxCostUsd: b.max_cost_usd ? Number(b.max_cost_usd) : undefined,
          maxDurationMs: b.max_duration_ms ? Number(b.max_duration_ms) : undefined,
        } : undefined;

        const prompt = buildPrompt(step, wf, { ...vars, ...read.vars });

        // Posted BEFORE the run, which is the whole point: an agent step is
        // tens of minutes of silence otherwise, and this is the line that tells
        // a watching human the difference between working and wedged.
        await note(issue.id,
          `${where(issue, wf)} · **${agentRow?.name ?? agentKey}** ${step.phase}` +
          (step.skill ? ` using the \`${step.skill}\` skill` : "") + `.`);

        /**
         * One attempt: its own run row, its own log file, its own wall-clock
         * measurement.
         *
         * The attempt number is part of the filename because the runner opens
         * the log in APPEND mode: without it a retried step appends to the
         * previous attempt's log, two run rows point at one file, and the
         * console renders the failed attempt's events inside the successful
         * run's transcript. The first attempt keeps the plain name, so nothing
         * already on disk is orphaned.
         *
         * `elapsedMs` is measured HERE rather than taken from `usage.durationMs`
         * because the failures worth retrying are exactly the ones that never
         * emitted a usage record.
         */
        const attemptOnce = async (): Promise<{ res: RunResult; elapsedMs: number }> => {
          const attempt = (await repo.listRuns(issue.id))
            .filter(r => r.step_index === issue.step_index).length;
          // installRoot: run logs are this deployment's own runtime data, not
          // the project's. (They move into Postgres entirely in a later step.)
          const logPath = join(installRoot, ".orchestrator", "runs",
            `${issue.id}-${issue.step_index}${attempt ? `-retry${attempt}` : ""}.jsonl`);
          const run = await repo.startRun({
            issueId: issue.id, agentId: agentRow?.id ?? null,
            stepIndex: issue.step_index, phase: step.phase, logPath,
            // `rt` is the ONLY place that knows: step → agent → project
            // setting → default. Recorded so the transcript can be decoded
            // and spend can be attributed.
            adapter: rt.adapter,
            // Same reasoning as `adapter`: resolveRuntime is the only place
            // that knows, and a price needs a model. The Codex transcript
            // carries no model field, so without this a Codex run could never
            // be priced at all.
            model: rt.model ?? null,
          });

          const startedAt = Date.now();
          const res = await runner.run({
            // The run row's id, so `killRun` can find this child. Without it a
            // running agent is unaddressable and Pause/Cancel could only ever
            // take effect at the NEXT step boundary.
            runId: run.id,
            agent: {
              key: agentKey,
              // installRoot: `agent-instructions/<agent>.thin.md` ships with the install.
              bundlePath: agentRow?.bundle_path ? resolve(installRoot, agentRow.bundle_path) : undefined,
              mcpEnabled: agentRow?.mcp_enabled ?? false,
              extraArgs: agentRow?.extra_args ?? [],
            },
            model: rt.model,
            effort: rt.effort,
            // Resolved by resolveRuntime, NOT read straight off agentRow: a
            // Claude fallback list configured on the agent row must not ride
            // along when the run's resolved adapter is codex (or anything
            // else) — see resolveRuntime's doc comment.
            fallbackModel: rt.fallbackModel ?? [],
            prompt,
            // Passed so a non-Claude adapter can load the SKILL.md itself;
            // createClaudeRunner ignores it and discovers the skill as before.
            skill: step.skill,
            // Read only by the Codex runner, to sandbox a `publish` step
            // differently from a `generate` one.
            phase: step.phase,
            // workRoot: the agent's prompt names `projects/{project}/…`
            // relatively, so it must stand in the project tree.
            cwd: workRoot,
            logPath,
            budget,
            // installRoot: the MCP registration belongs to the install.
            mcpConfigPath: join(installRoot, ".mcp.json"),
          });
          const elapsedMs = Date.now() - startedAt;

          // Estimate the cost when the CLI reported none — which is every
          // Codex run. Looked up by the model the engine resolved, priced by
          // the pure `priceRun`, and stored in its OWN column: `cost_usd`
          // continues to mean "reported by the CLI, verbatim", so a reader can
          // always tell whose arithmetic they are looking at.
          //
          // A model we hold no price for stays null rather than becoming 0 —
          // "$0.00" reads as a free run, and `—` is the truth.
          let estCostUsd: number | null = null;
          if (res.usage && res.usage.costUsd == null && rt.model) {
            estCostUsd = priceRun(res.usage, await repo.getModelPrice(rt.model));
          }

          await repo.finishRun(run.id, {
            status: res.status, exitCode: res.exitCode, sessionId: res.usage?.sessionId ?? null,
            inputTokens: res.usage?.inputTokens ?? null, outputTokens: res.usage?.outputTokens ?? null,
            cacheReadTokens: res.usage?.cacheReadTokens ?? null,
            cacheCreationTokens: res.usage?.cacheCreationTokens ?? null,
            costUsd: res.usage?.costUsd ?? null, durationMs: res.usage?.durationMs ?? null,
            numTurns: res.usage?.numTurns ?? null,
            estCostUsd,
          });

          // A cost ceiling could not fire on a Codex run at all before this:
          // the runner checks budgets against the CLI's own reported figure,
          // and Codex reports none. Moving the org onto Codex therefore
          // removed the dollar cap from every agent, silently. The check runs
          // HERE, after the estimate exists, and says plainly that the figure
          // was ours — being stopped by an arithmetic nobody can see is worse
          // than not being stopped.
          if (res.status === "succeeded" && estCostUsd != null
              && budget?.maxCostUsd && estCostUsd > budget.maxCostUsd) {
            await repo.finishRun(run.id, {
              status: "over_budget", exitCode: res.exitCode,
              sessionId: res.usage?.sessionId ?? null,
              inputTokens: res.usage?.inputTokens ?? null, outputTokens: res.usage?.outputTokens ?? null,
              cacheReadTokens: res.usage?.cacheReadTokens ?? null,
              cacheCreationTokens: res.usage?.cacheCreationTokens ?? null,
              costUsd: null, durationMs: res.usage?.durationMs ?? null,
              numTurns: res.usage?.numTurns ?? null, estCostUsd,
            });
            await note(issue.id,
              `Agent \`${agentKey}\` is over its cost ceiling: **~$${estCostUsd.toFixed(4)} estimated** ` +
              `against a limit of $${budget.maxCostUsd.toFixed(2)}.\n\n` +
              `That figure is OURS, not the CLI's — \`${rt.model}\` reports no cost of its own, so it was ` +
              `computed from its token counts and the price recorded for it. Check the model catalogue ` +
              `if it looks wrong.`);
            // Returned rather than reassigned: `res` is the runner's own
            // result and stays exactly as the runner produced it.
            return { res: { ...res, status: "over_budget" as const }, elapsedMs };
          }

          return { res, elapsedMs };
        };

        let { res, elapsedMs } = await attemptOnce();

        // Stopped by a person, not failed. Checked before the retry logic
        // rather than left to it: `classifyFailure` also refuses to retry a
        // cancel, but reaching that path would still `block()` the issue —
        // overwriting the `paused`/`cancelled` status the request is about to
        // set, and telling the timeline the agent failed when it did not.
        if (res.status === "cancelled") {
          await note(issue.id, `Agent \`${agentKey}\` was stopped.`);
          return "stopped";
        }

        // Self-healing, once, and only when the first attempt demonstrably
        // spent nothing — see `classifyFailure` for why the test is "did it
        // cost anything" rather than "does the error text look transient".
        if (res.status !== "succeeded") {
          const verdict = classifyFailure(res, elapsedMs);
          if (verdict.retry) {
            await repo.addComment(issue.id,
              `Agent \`${agentKey}\` failed (exit ${res.exitCode}) — retrying once, because ` +
              `${verdict.reason}.\n\n\`\`\`\n${res.stderrTail}\n\`\`\``,
              { user: "orchestrator" });
            ({ res, elapsedMs } = await attemptOnce());
          }
        }

        if (res.status !== "succeeded") {
          const verdict = classifyFailure(res, elapsedMs);
          // Say whether this was the only attempt or the second, and why no
          // further one is coming. An operator staring at a blocked issue
          // should not have to infer the retry policy from the run list.
          const attempts = (await repo.listRuns(issue.id))
            .filter(r => r.step_index === issue.step_index).length;
          await block(issue.id,
            `Agent \`${agentKey}\` ${res.status} (exit ${res.exitCode}) after ` +
            `${attempts} attempt${attempts === 1 ? "" : "s"}. ` +
            `Not retrying: ${attempts > 1 ? "it already had its one retry" : verdict.reason}.` +
            `\n\n\`\`\`\n${res.stderrTail}\n\`\`\``);
          return "blocked";
        }

        const spend = res.usage?.costUsd;
        // The runtime's own duration when it reported one, wall clock only as a
        // fallback. Every other surface — the runs table, the run page — shows
        // `usage.durationMs`, and a timeline disagreeing with them about how
        // long the same run took is worse than no timeline.
        const shown = res.usage?.durationMs ?? elapsedMs;
        await note(issue.id,
          `**${agentRow?.name ?? agentKey}** finished ${step.phase} in ${humanDuration(shown)}` +
          (spend != null ? ` · $${spend.toFixed(4)}` : "") +
          (res.usage?.numTurns != null ? ` · ${res.usage.numTurns} turns` : "") + `.`);
        return "next";
      }

      case "attach": {
        const missing: string[] = [];
        for (const f of step.files) {
          const abs = resolve(workRoot, interpolate(f, vars));
          try { await access(abs); } catch { missing.push(f); }
        }
        if (missing.length) {
          // A human must never be asked to approve output that was not
          // produced: block HERE, before the gate step is ever reached, so
          // no gate row is created.
          await block(issue.id, `Expected output not produced:\n${missing.map(m => `- \`${m}\``).join("\n")}`);
          return "blocked";
        }
        const titles: string[] = [];
        for (const f of step.files) {
          const abs = resolve(workRoot, interpolate(f, vars));
          const title = abs.split("/").pop() ?? abs;
          titles.push(title);
          await repo.attachWorkProduct(issue.id, {
            type: "document", provider: "local", title, url: pathToFileURL(abs).href,
          });
        }
        await note(issue.id,
          `${where(issue, wf)} · attached ${titles.length} work product` +
          `${titles.length === 1 ? "" : "s"}: ${titles.map(t => `\`${t}\``).join(", ")}.`);
        return "next";
      }

      case "gate": {
        // Idempotent by artefact, not by status: a later, SEPARATE advance()
        // call on an already-parked issue (a retried HTTP call, a duplicate
        // wake — the in-memory lock above only protects calls that overlap
        // IN FLIGHT, and is released the instant the first call returns to
        // park) must not raise a second gate for the same step. `pending` is
        // the right filter, not "any gate at this step_index": after a
        // rejection rewinds and the step regenerates, the OLD gate is
        // `rejected`, and a genuinely new gate for the new pass must still be
        // allowed to raise.
        const alreadyRaised = (await repo.listGates(issue.id))
          .some(g => g.status === "pending" && g.payload.stepIndex === issue.step_index);
        if (!alreadyRaised) {
          const title = interpolate(step.title, vars);
          await repo.createGate(issue.id, {
            title,
            summary: step.summary ? interpolate(step.summary, vars) : "",
            stepIndex: issue.step_index,
          });
          // Only on the raise, never on the reassert below — a duplicate wake
          // must not post "awaiting your approval" a second time.
          await note(issue.id, `${where(issue, wf)} · **awaiting your approval** — ${title}`);
        }
        // Reasserted unconditionally (not just inside the `if`) so the
        // status still catches up even if a prior call somehow created the
        // gate but failed to persist the status change.
        await repo.updateIssue(issue.id, { status: "in_review" });
        return "wait";
      }

      case "flow": {
        // Fire the child issue and stop. The parent resumes once the child
        // flow completes (via a separate advance() call triggered by
        // whatever watches child completion) — not exercised by this task's
        // tests, but the shape is here so a workflow can compose others.
        //
        // Idempotent by artefact: a flow step has no status of its own to
        // guard re-entry with (unlike "gate", which parks at `in_review` —
        // deliberately not adding a new status for this; see the engine's
        // fix-round-1 notes). `params.parentStepIndex` on the CHILD issue is
        // what lets a later, separate advance() call recognise "this step
        // already spawned its child" and skip creating a second one, rather
        // than multiplying real agent runs on every duplicate wake.
        const already = (await repo.listIssues(issue.company_id, { parentId: issue.id }))
          .some(c => c.params.parentStepIndex === issue.step_index);
        if (!already) {
          await repo.createIssue({
            companyId: issue.company_id, parentId: issue.id,
            title: `${step.workflow} — ${vars.project ?? ""}`,
            workflowKey: step.workflow,
            params: { ...issue.params, ...(step.params ?? {}), parentStepIndex: issue.step_index },
            status: "todo",
          });
        }
        return "wait";
      }
    }
  }

  async function advance(issueId: string): Promise<void> {
    if (locks.has(issueId)) return;
    locks.add(issueId);
    try {
      for (;;) {
        const issue = await repo.getIssue(issueId);
        // `in_review` is a belt-and-braces halt alongside each wait step's
        // own artefact check (see "gate"/"flow" in runStep): the in-memory
        // lock only protects calls that overlap IN FLIGHT, and is released
        // the instant a call returns to park — a second, LATER call on an
        // already-parked issue is not caught by the lock at all, only by
        // this check (and, per step type, the artefact check besides).
        if (!issue) return;
        // Finished, one way or the other. Nothing — not even a control
        // request — moves an issue out of these.
        if (issue.status === "done" || issue.status === "cancelled") return;

        const wf = workflow(issue.workflow_key);
        const step = wf.steps[issue.step_index];

        // The control check comes BEFORE the parked-status returns below, and
        // that ordering is the whole point: an issue sitting at `in_review`
        // waiting for a human, or at `blocked` after a failure, is EXACTLY
        // what someone reaches for Cancel about. With the returns first, a
        // request against either was recorded and then silently never
        // honoured — the issue simply stayed where it was, looking ignored.
        //
        // A force-pause or a cancel has already killed the child by the time
        // we get here; what remains is to record where it stopped, and why.
        if (issue.control_request) {
          const verb = issue.control_request;
          const who = issue.control_requested_by
            ? await repo.describeUser(issue.control_requested_by)
            : "a user";
          const where = step
            ? `step ${issue.step_index} (\`${step.type}\`)`
            : `the end of ${wf.label}`;
          await repo.clearControl(issueId);
          await repo.updateIssue(issueId, { status: verb === "cancel" ? "cancelled" : "paused" });
          if (verb === "cancel") {
            // A gate left `pending` on a cancelled issue sits in every
            // "awaiting approval" list forever, inviting someone to approve
            // work that was called off.
            for (const g of await repo.listGates(issueId)) {
              if (g.status === "pending") await repo.decideGate(g.id, "cancelled", `Issue ${verb}led`, who);
            }
          }
          await note(issueId, verb === "cancel"
            ? `**Cancelled** by ${who} at ${where}. This issue will not resume.`
            : `**Paused** by ${who} at ${where}. Resume it to carry on from here — ` +
              `steps that already succeeded are not re-run.`);
          return;
        }

        // `in_review` is a belt-and-braces halt alongside each wait step's own
        // artefact check (see "gate"/"flow" in runStep): the in-memory lock
        // only protects calls that overlap IN FLIGHT and is released the
        // instant a call returns to park, so a second, LATER call on an
        // already-parked issue is caught only here.
        //
        // `paused` leaves only through resume(); `blocked` only through retry().
        if (issue.status === "blocked" || issue.status === "in_review" || issue.status === "paused") return;

        if (!step) {
          await repo.updateIssue(issueId, { status: "done" });
          // The closing line of the timeline. Cost is summed from the runs
          // rather than tracked as we go, so a resumed issue reports its whole
          // spend and not just this pass's.
          const runs = await repo.listRuns(issueId);
          await note(issueId, closingNote(runs, wf.label));
          return;
        }

        const vars: Record<string, string> = {
          ...(issue.params as Record<string, string>),
          // workRoot: `{workspace}` is interpolated into prompts and commands
          // that go on to name `projects/…`, so it must mean the project tree.
          workspace: workRoot,
          issueId,
        };

        let outcome: StepOutcome;
        try {
          outcome = await runStep(step, issue, wf, vars);
        } catch (err) {
          // Every other failure path leaves a comment explaining what went
          // wrong before blocking (bad exec exit, missing produces file,
          // unregistered adapter, agent failure) — a step that THROWS
          // (an interpolate() placeholder miss is the common case) must too,
          // rather than rejecting the caller's promise and leaving the issue
          // silently sitting at whatever status it already had, with no
          // trail explaining why nothing moved.
          await block(issueId, `Step ${issue.step_index} (\`${step.type}\`) threw: ${err instanceof Error ? err.message : String(err)}`);
          return;
        }
        if (outcome === "blocked" || outcome === "wait") {
          // A control request made WHILE this step was running has not been
          // seen: the loop only looks at the top, and this step is about to
          // park. Re-read once so a pause or cancel issued mid-step is
          // honoured, rather than left pending forever behind a blocked or
          // gate-parked issue.
          //
          // Observed live: an exec step failed, `block()` set the status, and
          // advance() returned — so a cancel sent seconds earlier stayed in
          // `control_request` unhonoured, the issue read `blocked`, and the
          // next resume quietly cleared the request. The cancel simply
          // vanished.
          //
          // This cannot loop: the control check at the top either honours the
          // request and returns, or the parked-status check below it does.
          const latest = await repo.getIssue(issueId);
          if (latest?.control_request) continue;
          return;
        }
        // Killed mid-step: go back to the top WITHOUT advancing, so the
        // control check records `paused`/`cancelled` and this step is the one
        // that re-runs if the issue is ever resumed.
        if (outcome === "stopped") continue;

        await repo.updateIssue(issueId, { stepIndex: issue.step_index + 1, status: "in_progress" });
      }
    } finally {
      locks.delete(issueId);
    }
  }

  return {
    async start(workflowKey, params, opts = {}) {
      const wf = workflow(workflowKey);
      // The CALLER's organisation, falling back to the configured one for an
      // internal caller with no principal. Resolving it from config here would
      // file every client's work under whichever organisation the config file
      // happens to name.
      const companyId = opts.companyId ?? await repo.ensureCompany(config.company ?? "Scyne");
      // The org chart is reconciled into the HOME organisation on boot, so an
      // agent lookup in any other organisation legitimately finds nothing. An
      // issue with no assignee is already a supported state — the engine
      // resolves the agent per step — so this is a null, not an error.
      const agent = await repo.getAgentByKey(companyId, wf.assignee)
        ?? await repo.getAgentByKey(await repo.ensureCompany(config.company ?? "Scyne"), wf.assignee);
      const title = wf.title
        ? interpolate(wf.title, params)
        : `${wf.label} — ${params.project ?? ""}`.trim();
      return repo.createIssue({
        companyId, title,
        workflowKey, params, assigneeAgentId: agent?.id ?? null, status: "todo",
        createdBy: opts.createdBy ?? null,
      });
    },

    advance,

    /**
     * Resume an issue that has stopped. `advance()` deliberately returns
     * immediately for a `blocked` issue — otherwise a failing step would spin —
     * so a human-initiated retry has to clear the block first. `step_index` is
     * left exactly where it was: the blocked step is the one worth re-running,
     * and rewinding further would duplicate an agent run that already
     * succeeded.
     */
    /**
     * Ask a running issue to stop.
     *
     * Graceful by default: the request is recorded and `advance()` honours it
     * the moment the in-flight step ends. That can take as long as an agent
     * run, which is the point — nothing is discarded and nothing is wasted.
     *
     * `force` additionally kills the live child NOW. Its run is recorded
     * `cancelled` rather than `failed`, which is what stops core/retry.ts
     * spending money undoing the very thing that was asked for.
     */
    async pause(issueId, opts = {}) {
      const issue = await repo.getIssue(issueId);
      if (!issue) throw new Error(`unknown issue ${issueId}`);
      if (issue.status === "done" || issue.status === "cancelled") {
        throw new Error(`issue ${issue.identifier} is ${issue.status} — there is nothing to pause`);
      }
      const updated = await repo.requestControl(issueId, opts.force ? "pause_now" : "pause", opts.by ?? null);

      if (opts.force) {
        const run = await repo.runningRunFor(issueId);
        if (run && killRun(run.id)) await note(issueId, `Stopping the running agent now, as asked.`);
      } else {
        await note(issueId,
          `Pause requested. The step in flight will finish first — nothing is discarded, ` +
          `and nothing further starts after it.`);
      }
      // A parked issue has no loop running to notice the request, so nudge it.
      // Awaited, not fired and forgotten: `advance()` returns immediately when
      // the issue is already locked by a running loop (which will honour the
      // request at its own next boundary) AND when the control check parks it,
      // so this never waits on an agent — but firing it in the background made
      // the status a race for anyone reading it straight afterwards.
      await advance(issueId).catch(() => { /* the request is recorded either way */ });
      return repo.getIssue(issueId) ?? updated;
    },

    async cancel(issueId, opts = {}) {
      const issue = await repo.getIssue(issueId);
      if (!issue) throw new Error(`unknown issue ${issueId}`);
      if (issue.status === "done") {
        throw new Error(`issue ${issue.identifier} is already done — there is nothing to cancel`);
      }
      if (issue.status === "cancelled") return issue;
      const updated = await repo.requestControl(issueId, "cancel", opts.by ?? null);
      const run = await repo.runningRunFor(issueId);
      if (run) killRun(run.id);
      await advance(issueId).catch(() => { /* the request is recorded either way */ });
      return repo.getIssue(issueId) ?? updated;
    },

    /**
     * Carry a paused issue on from where it stopped.
     *
     * `step_index` is left exactly where it is: a graceful pause parked BEFORE
     * an unstarted step, and a force-pause parked ON the step it killed. Either
     * way that step is the one worth running, and rewinding further would
     * duplicate work that already succeeded.
     */
    async resume(issueId) {
      const issue = await repo.getIssue(issueId);
      if (!issue) throw new Error(`unknown issue ${issueId}`);
      if (issue.status === "cancelled") {
        throw new Error(
          `issue ${issue.identifier} was cancelled and does not resume. ` +
          `Start the workflow again if it is still wanted.`);
      }
      if (issue.status === "done") throw new Error(`issue ${issue.identifier} is already done`);
      // Resuming WITHDRAWS any outstanding request — otherwise the issue would
      // park again on its very next iteration, which reads as "resume is broken".
      await repo.clearControl(issueId);
      if (issue.status === "paused" || issue.status === "blocked") {
        await repo.updateIssue(issueId, { status: "todo" });
      }
      await note(issueId, `Resumed.`);
      await advance(issueId);
    },

    async retry(issueId) {
      const issue = await repo.getIssue(issueId);
      if (!issue) throw new Error(`unknown issue ${issueId}`);
      if (issue.status === "done") {
        throw new Error(`issue ${issue.identifier} is already done — nothing to retry`);
      }
      if (issue.status === "blocked") await repo.updateIssue(issueId, { status: "todo" });
      await advance(issueId);
    },

    async decideGate(gateId, status, note, by, opts) {
      const shouldAdvance = opts?.advance !== false;
      const gate = await repo.getGate(gateId);
      if (!gate) throw new Error(`unknown gate ${gateId}`);
      await repo.decideGate(gateId, status, note ?? null, by ?? "orchestrator");
      if (note) {
        await repo.addComment(
          gate.issue_id,
          `**${status === "approved" ? "Approved" : "Rejected"}:** ${note}`,
          { user: by ?? "reviewer" });
      }

      if (status === "rejected") {
        const issue = await repo.getIssue(gate.issue_id);
        if (!issue) throw new Error(`unknown issue ${gate.issue_id}`);
        const wf = workflow(issue.workflow_key);
        // Rewind to the last agent step at or before the gate — a rejection
        // means "the generated output was wrong", so the natural resume
        // point is the step that generated it, not the gate itself.
        let i = issue.step_index;
        while (i > 0 && wf.steps[i]?.type !== "agent") i--;
        await repo.updateIssue(gate.issue_id, { stepIndex: i, status: "todo" });
        // Rewinding without advancing left the issue parked at `todo` forever:
        // nothing else in the system watches for one. The approve branch below
        // has always advanced; a rejection is no different in that respect, and
        // the chatbot's Reject and Request-changes buttons both depend on it.
        if (shouldAdvance) await advance(gate.issue_id);
        return { issueId: gate.issue_id };
      }

      const issue = await repo.getIssue(gate.issue_id);
      if (!issue) throw new Error(`unknown issue ${gate.issue_id}`);
      await repo.updateIssue(gate.issue_id, { stepIndex: issue.step_index + 1, status: "in_progress" });
      if (shouldAdvance) await advance(gate.issue_id);
      return { issueId: gate.issue_id };
    },

    /**
     * Marks every run row with no `finished_at` as `orphaned` and returns its
     * issue to `todo`. `listUnfinishedRuns()` has no age filter — it is
     * `finished_at is null`, full stop — so this must run exactly ONCE, at
     * process startup, BEFORE any `advance()` traffic is accepted. Calling it
     * while a genuine run is still in flight would mark that live run
     * `orphaned` and re-fire its issue out from under it. Safe at startup
     * (nothing is legitimately still running from a previous process); never
     * wire this to a recurring timer.
     */
    async recoverOrphans() {
      const stale = await repo.listUnfinishedRuns();
      for (const r of stale) {
        await repo.finishRun(r.id, { status: "orphaned", exitCode: null });
        await repo.updateIssue(r.issue_id, { status: "todo" });
      }
    },
  };
}
