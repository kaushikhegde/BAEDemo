// One agentic loop, many models.
//
// Claude Code is a whole agent: it reasons, it opens files, it invokes skills,
// and it reports what it spent. A raw model endpoint does none of that — it
// answers one question and, if you gave it tools, tells you which one it would
// like called. Everything between those two is this file, written once so that
// choosing Gemini or Azure changes WHICH MODEL thinks and nothing else about
// how a stage behaves.
//
// The load-bearing decision here is the event format. This loop emits exactly
// the stream-json envelopes core/transcript.ts already parses — `assistant`
// with text and tool_use blocks, `user` with tool_result blocks, and a final
// `result` carrying usage. That is not imitation for its own sake: it means
// the console transcript, the chatbot's Live Transcript pane, `orch log`,
// core/usage.ts and core/retry.ts all work against a Gemini run without one
// line changing. A bespoke format would have meant reimplementing five
// consumers to gain nothing.
//
// Skills are loaded here rather than named at the model. Claude Code discovers
// `.claude/skills/<slug>/SKILL.md` by itself; no other provider can, so the
// loop reads the file from the install root and puts it in the system prompt.
// The skill files themselves stay provider-neutral markdown and are untouched.

import { createWriteStream } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { buildSystemPrompt, loadSkill } from "./prompt.js";
import { runTool, TOOL_SCHEMAS, type ToolContext } from "./tools.js";
import type { RunRequest, RunResult, Runner } from "./runner.js";
import type { RunUsage } from "./usage.js";

export interface ProviderToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ProviderTurn {
  /** Prose the model produced this turn. May be empty when it only called tools. */
  text: string;
  toolCalls: ProviderToolCall[];
  usage?: { inputTokens: number; outputTokens: number; costUsd?: number | null };
}

/** One assistant turn, as the loop remembers it for the next request. */
export type LoopMessage =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string; toolCalls: ProviderToolCall[] }
  | { role: "tool"; results: { id: string; name: string; content: string; ok: boolean }[] };

export interface CompleteRequest {
  system: string;
  messages: LoopMessage[];
  tools: typeof TOOL_SCHEMAS;
  signal?: AbortSignal;
}

/**
 * What a provider must implement. Deliberately tiny: one call, one turn. The
 * multi-turn loop, the tools, the transcript and the accounting are shared, so
 * adding a vendor is a request/response mapping and nothing more.
 */
export interface ChatProvider {
  readonly name: string;
  readonly model: string;
  complete(req: CompleteRequest): Promise<ProviderTurn>;
}

/**
 * Ceiling on turns. A stage genuinely takes dozens — reading twenty documents
 * is twenty turns before any writing starts — so this is set where a real run
 * never reaches it and a loop that has started going in circles still stops.
 */
export const MAX_TURNS = 200;

export interface LoopOptions {
  provider: ChatProvider;
  installRoot: string;
  skillsDir?: string;
}

/** `{ts, stream, chunk}` — the same envelope createClaudeRunner writes. */
function envelope(stream: "stdout" | "stderr", chunk: string): string {
  return JSON.stringify({ ts: new Date().toISOString(), stream, chunk }) + "\n";
}

/** A stream-json line, wrapped in its envelope, ready to append to the log. */
function event(payload: unknown): string {
  return envelope("stdout", JSON.stringify(payload) + "\n");
}

/**
 * Run one agentic session to completion and return it in the same shape
 * createClaudeRunner does, so the engine cannot tell which adapter ran.
 */
export function createLoopRunner(opts: LoopOptions): Runner {
  const { provider, installRoot, skillsDir = "skills" } = opts;

  return {
    async run(req: RunRequest): Promise<RunResult> {
      const started = Date.now();
      const lines: string[] = [];
      const write = (s: string): void => { lines.push(s); };

      let inputTokens = 0, outputTokens = 0, costUsd: number | null = null, turns = 0;
      let stderrTail = "";

      const flush = async (): Promise<void> => {
        try {
          await mkdir(dirname(req.logPath), { recursive: true });
          await new Promise<void>((res, rej) => {
            const s = createWriteStream(req.logPath, { flags: "a" });
            s.on("error", rej);
            s.end(lines.join(""), () => res());
          });
        } catch (err) {
          // A log that cannot be written must not fail a run that worked.
          console.error(`[agent-loop] could not write ${req.logPath}:`, err);
        }
      };

      // A duration budget is enforced by aborting between turns AND by an
      // AbortSignal handed to the provider, because a single model call can
      // itself hang past the limit.
      const controller = new AbortController();
      const limitMs = req.budget?.maxDurationMs ?? 60 * 60_000;
      const timer = setTimeout(() => controller.abort(), limitMs);
      let killedForBudget = false;

      try {
        const bundle = req.agent.bundlePath
          ? await readFile(req.agent.bundlePath, "utf8").catch(() => {
              throw new Error(`System prompt file not found: ${req.agent.bundlePath}`);
            })
          : "";

        const skill = req.skill
          ? { name: req.skill, body: await loadSkill(installRoot, skillsDir, req.skill) }
          : null;

        // Surfaced as a `Skill` tool_use so the console renders a skill event
        // exactly as it does for Claude Code — same tab, same badge.
        if (skill) {
          write(event({
            type: "assistant",
            message: { content: [{ type: "tool_use", name: "Skill", input: { skill: skill.name } }] },
          }));
        }

        const system = buildSystemPrompt(bundle, skill);
        const messages: LoopMessage[] = [{ role: "user", text: req.prompt }];
        const toolCtx: ToolContext = { workRoot: req.cwd, installRoot };

        for (turns = 1; turns <= MAX_TURNS; turns++) {
          if (controller.signal.aborted) { killedForBudget = true; break; }

          const turn = await provider.complete({
            system, messages, tools: TOOL_SCHEMAS, signal: controller.signal,
          });

          if (turn.usage) {
            inputTokens += turn.usage.inputTokens;
            outputTokens += turn.usage.outputTokens;
            if (typeof turn.usage.costUsd === "number") costUsd = (costUsd ?? 0) + turn.usage.costUsd;
          }

          const blocks: unknown[] = [];
          if (turn.text.trim()) blocks.push({ type: "text", text: turn.text });
          for (const c of turn.toolCalls) blocks.push({ type: "tool_use", name: c.name, input: c.input });
          if (blocks.length) write(event({ type: "assistant", message: { content: blocks } }));

          // No tool call means the model considers itself finished.
          if (!turn.toolCalls.length) {
            messages.push({ role: "assistant", text: turn.text, toolCalls: [] });
            break;
          }

          messages.push({ role: "assistant", text: turn.text, toolCalls: turn.toolCalls });

          const results: { id: string; name: string; content: string; ok: boolean }[] = [];
          for (const call of turn.toolCalls) {
            const outcome = await runTool({ name: call.name, input: call.input }, toolCtx);
            results.push({ id: call.id, name: call.name, content: outcome.content, ok: outcome.ok });
            write(event({
              type: "user",
              message: { content: [{ type: "tool_result", content: outcome.content }] },
            }));
          }
          messages.push({ role: "tool", results });
        }

        if (turns > MAX_TURNS) {
          stderrTail = `agent loop stopped after ${MAX_TURNS} turns without finishing.`;
          write(envelope("stderr", stderrTail + "\n"));
        }
      } catch (err) {
        stderrTail = err instanceof Error ? err.message : String(err);
        write(envelope("stderr", stderrTail + "\n"));

        // A configuration failure produces NO result event, which is what
        // core/retry.ts reads to decide whether a retry could cost anything.
        // Emitting one here would make every missing-bundle failure look like
        // a run that had spent money.
        clearTimeout(timer);
        await flush();
        return { exitCode: 1, status: "failed", usage: null, stderrTail };
      }

      clearTimeout(timer);

      const durationMs = Date.now() - started;
      const usage: RunUsage = {
        inputTokens, outputTokens, cacheReadTokens: 0, cacheCreationTokens: 0,
        costUsd, durationMs, numTurns: turns, sessionId: null,
      };

      // The `result` event, in the shape core/usage.ts already parses.
      write(event({
        type: "result",
        session_id: null,
        total_cost_usd: costUsd,
        duration_ms: durationMs,
        num_turns: turns,
        usage: {
          input_tokens: inputTokens, output_tokens: outputTokens,
          cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
        },
      }));
      await flush();

      if (killedForBudget) {
        return { exitCode: -1, status: "over_budget", usage, stderrTail: "duration budget exceeded" };
      }

      // Post-hoc budget checks, on the same terms the Claude runner applies.
      let status: RunResult["status"] = stderrTail ? "failed" : "succeeded";
      if (req.budget?.maxTokens && inputTokens + outputTokens > req.budget.maxTokens) status = "over_budget";
      if (req.budget?.maxCostUsd && (costUsd ?? 0) > req.budget.maxCostUsd) status = "over_budget";

      return { exitCode: status === "succeeded" ? 0 : 1, status, usage, stderrTail };
    },
  };
}
