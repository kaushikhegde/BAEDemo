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
import { resolveRuntime } from "../config.js";
import type { OrchestratorConfig, Step, WorkflowDef } from "../config.js";
import type { createRepo, AgentRow, IssueRow } from "./repo.js";

/** The shape `createRepo(db)` returns. There is no separately exported `Repo` interface (Task 2). */
type Repo = ReturnType<typeof createRepo>;

export type ExecFn = (cmd: string, cwd: string, timeoutMs?: number)
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
  start(workflowKey: string, params: Record<string, string>): Promise<IssueRow>;
  advance(issueId: string): Promise<void>;
  retry(issueId: string): Promise<void>;
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
const defaultExec: ExecFn = (cmd, cwd, timeoutMs = 20 * 60_000) =>
  new Promise((res) => {
    nodeExec(cmd, { cwd, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout, stderr) => res({ code: err ? (err.code ?? 1) : 0, stdout, stderr }));
  });

type StepOutcome = "next" | "wait" | "blocked";

export function createEngine(deps: {
  repo: Repo; config: OrchestratorConfig; exec?: ExecFn;
}): Engine {
  const { repo, config } = deps;
  const exec = deps.exec ?? defaultExec;

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
   * `AgentRow`'s nullable columns (`model: string | null`, `effort: string |
   * null`) don't line up with `resolveRuntime`'s optional-field shape
   * (`model?: string`) — null and undefined are different types under
   * strict mode. Converted once, here, rather than at every call site.
   */
  function toRuntimeAgent(agent: AgentRow | null): { adapter?: string; model?: string; effort?: string } | null {
    if (!agent) return null;
    return { adapter: agent.adapter, model: agent.model ?? undefined, effort: agent.effort ?? undefined };
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
        const body = await readFile(resolve(config.workspace, rel), "utf8");
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
        const r = await exec(cmd, step.cwd ?? config.workspace, step.timeoutMs);
        if (r.code !== 0) {
          await block(issue.id, `Step \`${cmd}\` failed (exit ${r.code}).\n\n\`\`\`\n${r.stderr.slice(-2000)}\n\`\`\``);
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
        const rt = resolveRuntime(step, toRuntimeAgent(agentRow), config.defaults);
        const runner = config.adapters[rt.adapter];
        if (!runner) {
          await block(issue.id,
            `Agent \`${agentKey}\`: adapter '${rt.adapter}' is not registered. ` +
            `Available: ${Object.keys(config.adapters).join(", ") || "(none)"}.`);
          return "blocked";
        }

        // The attempt number is part of the filename because the runner opens
        // the log in APPEND mode: without it a retried step appends to the
        // previous attempt's log, two run rows point at one file, and the
        // console renders the failed attempt's events inside the successful
        // run's transcript. The first attempt keeps the plain name, so nothing
        // already on disk is orphaned.
        const attempt = (await repo.listRuns(issue.id))
          .filter(r => r.step_index === issue.step_index).length;
        const logPath = join(config.workspace, ".orchestrator", "runs",
          `${issue.id}-${issue.step_index}${attempt ? `-retry${attempt}` : ""}.jsonl`);
        const run = await repo.startRun({
          issueId: issue.id, agentId: agentRow?.id ?? null,
          stepIndex: issue.step_index, phase: step.phase, logPath,
        });

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

        const res = await runner.run({
          agent: {
            key: agentKey,
            bundlePath: agentRow?.bundle_path ? resolve(config.workspace, agentRow.bundle_path) : undefined,
            mcpEnabled: agentRow?.mcp_enabled ?? false,
            extraArgs: agentRow?.extra_args ?? [],
          },
          model: rt.model,
          effort: rt.effort,
          fallbackModel: agentRow?.fallback_model ?? [],
          prompt: buildPrompt(step, wf, { ...vars, ...read.vars }),
          cwd: config.workspace,
          logPath,
          budget,
          mcpConfigPath: join(config.workspace, ".mcp.json"),
        });

        await repo.finishRun(run.id, {
          status: res.status, exitCode: res.exitCode, sessionId: res.usage?.sessionId ?? null,
          inputTokens: res.usage?.inputTokens ?? null, outputTokens: res.usage?.outputTokens ?? null,
          cacheReadTokens: res.usage?.cacheReadTokens ?? null,
          cacheCreationTokens: res.usage?.cacheCreationTokens ?? null,
          costUsd: res.usage?.costUsd ?? null, durationMs: res.usage?.durationMs ?? null,
          numTurns: res.usage?.numTurns ?? null,
        });

        if (res.status !== "succeeded") {
          await block(issue.id, `Agent \`${agentKey}\` ${res.status} (exit ${res.exitCode}).\n\n\`\`\`\n${res.stderrTail}\n\`\`\``);
          return "blocked";
        }
        return "next";
      }

      case "attach": {
        const missing: string[] = [];
        for (const f of step.files) {
          const abs = resolve(config.workspace, interpolate(f, vars));
          try { await access(abs); } catch { missing.push(f); }
        }
        if (missing.length) {
          // A human must never be asked to approve output that was not
          // produced: block HERE, before the gate step is ever reached, so
          // no gate row is created.
          await block(issue.id, `Expected output not produced:\n${missing.map(m => `- \`${m}\``).join("\n")}`);
          return "blocked";
        }
        for (const f of step.files) {
          const abs = resolve(config.workspace, interpolate(f, vars));
          await repo.attachWorkProduct(issue.id, {
            type: "document", provider: "local",
            title: abs.split("/").pop() ?? abs, url: pathToFileURL(abs).href,
          });
        }
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
          await repo.createGate(issue.id, {
            title: interpolate(step.title, vars),
            summary: step.summary ? interpolate(step.summary, vars) : "",
            stepIndex: issue.step_index,
          });
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
        if (!issue || issue.status === "blocked" || issue.status === "done" || issue.status === "in_review") return;

        const wf = workflow(issue.workflow_key);
        const step = wf.steps[issue.step_index];
        if (!step) { await repo.updateIssue(issueId, { status: "done" }); return; }

        const vars: Record<string, string> = {
          ...(issue.params as Record<string, string>),
          workspace: config.workspace,
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
        if (outcome === "blocked" || outcome === "wait") return;

        await repo.updateIssue(issueId, { stepIndex: issue.step_index + 1, status: "in_progress" });
      }
    } finally {
      locks.delete(issueId);
    }
  }

  return {
    async start(workflowKey, params) {
      const wf = workflow(workflowKey);
      const companyId = await repo.ensureCompany(config.company ?? "Scyne");
      const agent = await repo.getAgentByKey(companyId, wf.assignee);
      const title = wf.title
        ? interpolate(wf.title, params)
        : `${wf.label} — ${params.project ?? ""}`.trim();
      return repo.createIssue({
        companyId, title,
        workflowKey, params, assigneeAgentId: agent?.id ?? null, status: "todo",
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
