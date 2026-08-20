// The Claude Code runner: spawns `claude -p ... --output-format stream-json`,
// tees its raw stdout/stderr to a JSONL log file, and extracts aggregate
// token/cost usage from the captured stdout once the process exits.
//
// This is the highest-risk piece of the orchestrator — everything above it
// (engine, repo, transcript filtering) is bookkeeping; this is where the
// orchestrator actually drives an agent process. Every flag below is
// confirmed against a real invocation of Claude Code 2.1.232, not assumed:
// see fixtures/result-event.jsonl (Task 4) and this task's own E2E run.

import { extractUsage, type RunUsage } from "./usage.js";
import { runChild } from "./spawn.js";

export interface RunRequest {
  agent: { key: string; bundlePath?: string; mcpEnabled?: boolean; extraArgs?: string[] };
  /**
   * The run row's id, so a live child can be found and stopped by one.
   *
   * Optional because a caller with nothing to address the run by is still a
   * valid caller — it simply cannot be interrupted, which is honest rather
   * than a silent half-registration under a made-up key.
   */
  runId?: string;
  /** Already resolved by the engine through step → agent → defaults. */
  model?: string;
  effort?: string;
  fallbackModel?: string[];
  prompt: string;
  cwd: string;
  logPath: string;
  mcpConfigPath?: string;
  /**
   * The skill this step invokes, when it names one.
   *
   * Claude Code needs no help here — it discovers `.claude/skills/<slug>/`
   * itself, which is why this was never passed before. No other provider can,
   * so the shared agent loop reads the SKILL.md and puts it in the system
   * prompt. createClaudeRunner ignores it, keeping its behaviour identical.
   */
  skill?: string;
  budget?: { maxTokens?: number; maxCostUsd?: number; maxDurationMs?: number };
}

export interface RunResult {
  exitCode: number;
  /**
   * `cancelled` is distinct from `failed` on purpose: a run a person stopped
   * did not fail on its own terms, and core/retry.ts must never spend money
   * re-running one. The dangerous case is precisely a cancel a few seconds in
   * with no usage recorded, which the transient-retry rule would otherwise
   * treat as a free failure worth retrying.
   */
  status: "succeeded" | "failed" | "over_budget" | "cancelled";
  usage: RunUsage | null;
  stderrTail: string;
}

export interface Runner {
  run(req: RunRequest): Promise<RunResult>;
}

/** Re-exported so existing importers of the backstop constant keep working. */
export { BACKSTOP_DURATION_MS, killRun, liveRuns } from "./spawn.js";

/**
 * Build the argv for a headless Claude Code invocation. Exported so the
 * flag surface can be tested without spawning a process.
 *
 * Confirmed against Claude Code 2.1.232:
 * - There is no `--cwd` flag; the working directory is set on `spawn()`.
 * - `--print` (`-p`) combined with `--output-format stream-json` REQUIRES
 *   `--verbose`, or the CLI refuses to start
 *   (`Error: When using --print, --output-format=stream-json requires
 *   --verbose` — discovered in Task 4's capture run). Not conditional: this
 *   runner only ever uses stream-json, so `--verbose` is always required.
 * - `--system-prompt-file <path>` IS accepted (verified: pointing it at a
 *   missing file fails fast with `System prompt file not found: <path>`,
 *   before any network call) — no need for `--append-system-prompt-file`.
 * - The prompt itself is deliberately NOT put on argv (avoids shell/arg-length
 *   limits and keeps it out of `ps` listings); the runner writes it to the
 *   child's stdin instead.
 */
export function buildArgs(req: RunRequest): string[] {
  const a = [
    "-p",
    "--output-format", "stream-json",
    "--verbose",
    "--permission-mode", "bypassPermissions",
    "--no-session-persistence",
    "--exclude-dynamic-system-prompt-sections",
    "--strict-mcp-config",
  ];
  if (req.model) a.push("--model", req.model);
  if (req.effort) a.push("--effort", req.effort);
  if (req.fallbackModel?.length) a.push("--fallback-model", req.fallbackModel.join(","));
  if (req.agent.bundlePath) a.push("--system-prompt-file", req.agent.bundlePath);
  if (req.agent.mcpEnabled && req.mcpConfigPath) a.push("--mcp-config", req.mcpConfigPath);
  if (req.agent.extraArgs?.length) a.push(...req.agent.extraArgs);
  return a;
}

export function createClaudeRunner(opts: { bin?: string } = {}): Runner {
  const bin = opts.bin ?? "claude";
  return {
    run(req: RunRequest): Promise<RunResult> {
      return runChild(req, { bin, args: buildArgs(req), extractUsage });
    },
  };
}
