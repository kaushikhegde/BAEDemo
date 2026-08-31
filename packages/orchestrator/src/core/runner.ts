// The Claude Code runner: spawns `claude -p ... --output-format stream-json`,
// tees its raw stdout/stderr to a JSONL log file, and extracts aggregate
// token/cost usage from the captured stdout once the process exits.
//
// This is the highest-risk piece of the orchestrator — everything above it
// (engine, repo, transcript filtering) is bookkeeping; this is where the
// orchestrator actually drives an agent process. Every flag below is
// confirmed against a real invocation of Claude Code 2.1.232, not assumed:
// see fixtures/result-event.jsonl (Task 4) and this task's own E2E run.

import { existsSync } from "node:fs";
import { join } from "node:path";
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
  /**
   * The step's phase (`generate`, `publish`, …), for runners that must treat
   * them differently.
   *
   * Only the Codex runner reads it, and only to decide how a step is
   * sandboxed: a `publish` step's whole job is to hand an approved document to
   * an external system, which is exactly the shape a general-purpose safety
   * review refuses. Every other phase stays boxed. See buildCodexArgs.
   */
  phase?: string;
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

/**
 * Where Claude Code looks for a skill: `.claude/skills/<slug>/SKILL.md`, under
 * its own CWD. Nowhere else — not `skills/`, which is only what those entries
 * point at.
 */
const skillIsDiscoverable = (cwd: string, slug: string): boolean =>
  existsSync(join(cwd, ".claude", "skills", slug, "SKILL.md"));

export function createClaudeRunner(opts: { bin?: string } = {}): Runner {
  const bin = opts.bin ?? "claude";
  return {
    async run(req: RunRequest): Promise<RunResult> {
      /**
       * Checked BEFORE spawning, because an undiscoverable skill does not stop
       * the run — it changes what the run produces. Measured on SAPN's
       * capability map, verbatim from the transcript:
       *
       *     Unknown skill: capability-process-map
       *     The skill isn't available. Let me proceed with the task directly.
       *
       * The model then improvised the deliverable. That is the expensive
       * outcome: a full stage spent on a plausible document that followed none
       * of the discipline in the SKILL.md, gated by a human who has no way to
       * see which one they are reading. Failing here costs nothing and names
       * the fix.
       *
       * Only this runner needs the check. The Codex and shared agent loops load
       * the SKILL.md from the install themselves and already throw on a missing
       * one; Claude Code discovers it from the filesystem, and the filesystem
       * it discovers from is the step's scratch tree.
       */
      if (req.skill && !skillIsDiscoverable(req.cwd, req.skill)) {
        return {
          exitCode: 1,
          status: "failed",
          usage: null,
          // No path in the message: this text reaches a client-visible issue
          // comment, and an absolute path on our machine is neither actionable
          // nor theirs to see.
          stderrTail:
            `Unknown skill: ${req.skill}. Claude Code discovers a skill at ` +
            `.claude/skills/<slug>/SKILL.md under its working directory, and there is ` +
            `none for this one. Run \`npm run link-skills\` in the install — ` +
            `\`.claude/\` is gitignored, so a fresh clone has none.`,
        };
      }
      return runChild(req, { bin, args: buildArgs(req), extractUsage });
    },
  };
}
