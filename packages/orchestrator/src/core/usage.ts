/**
 * Parse the aggregate usage figures out of a `claude -p --output-format
 * stream-json` transcript.
 *
 * The chatbot's runTranscript.ts has always discarded the `result` event
 * (`if (type === "result") continue;`), which is why this project has never
 * had cost visibility. This module is that missing parser.
 *
 * Field names below are confirmed against a real capture
 * (fixtures/result-event.jsonl, captured 2026-08-17 against Claude Code
 * 2.1.232 with --model claude-sonnet-4-6) rather than assumed from memory:
 * top-level `session_id`, `total_cost_usd`, `duration_ms`, `num_turns`, and
 * `usage.input_tokens` / `usage.output_tokens` /
 * `usage.cache_read_input_tokens` / `usage.cache_creation_input_tokens` all
 * matched on the first capture with no adjustment needed.
 */

export interface RunUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number | null;
  durationMs: number | null;
  numTurns: number | null;
  sessionId: string | null;
}

/** Narrow shape of the fields we read off a stream-json `result` event. */
interface ResultEvent {
  type: "result";
  session_id?: unknown;
  total_cost_usd?: unknown;
  duration_ms?: unknown;
  num_turns?: unknown;
  usage?: {
    input_tokens?: unknown;
    output_tokens?: unknown;
    cache_read_input_tokens?: unknown;
    cache_creation_input_tokens?: unknown;
  };
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const numOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const strOrNull = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

function isResultEvent(obj: unknown): obj is ResultEvent {
  return typeof obj === "object" && obj !== null
    && (obj as { type?: unknown }).type === "result";
}

/**
 * Scan a stream-json transcript line by line and return the usage figures
 * from the LAST `result` event found (a transcript can carry more than one
 * across retried turns; the last is the run's final aggregate).
 *
 * Returns `null` when no `result` event is present — e.g. a transcript that
 * was truncated before the run finished. A malformed or truncated final
 * line (the log may be read mid-write) is skipped rather than thrown.
 */
export function extractUsage(streamJsonLines: string): RunUsage | null {
  let last: ResultEvent | null = null;

  for (const line of streamJsonLines.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue; // truncated or malformed line — skip, don't throw
    }

    if (isResultEvent(parsed)) last = parsed;
  }

  if (!last) return null;

  const usage = last.usage ?? {};
  return {
    inputTokens: num(usage.input_tokens),
    outputTokens: num(usage.output_tokens),
    cacheReadTokens: num(usage.cache_read_input_tokens),
    cacheCreationTokens: num(usage.cache_creation_input_tokens),
    costUsd: numOrNull(last.total_cost_usd),
    durationMs: numOrNull(last.duration_ms),
    numTurns: numOrNull(last.num_turns),
    sessionId: strOrNull(last.session_id),
  };
}

/**
 * Parse aggregate usage out of a `codex exec --json` transcript.
 *
 * Written against a real capture (test/fixtures/codex-run.jsonl), the same
 * discipline `extractUsage` above was written with — the field names are
 * observed, not remembered.
 *
 * `costUsd` is ALWAYS null: Codex reports tokens and does not price them, and
 * this repository deliberately holds no price table (see CLAUDE.md — a figure
 * in the console is the CLI's own arithmetic, never ours). Null renders as `—`;
 * returning 0 would render as `$0.0000` and read as a free run.
 */
export function extractCodexUsage(jsonlLines: string): RunUsage | null {
  let input = 0, output = 0, cachedInput = 0;
  let found = false;
  let sessionId: string | null = null;

  for (const line of jsonlLines.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;

    let o: any;
    try { o = JSON.parse(trimmed); } catch { continue; }

    // Session id. `thread.started` carries a top-level `thread_id` — observed in a
    // real capture. The others are fallbacks for versions that named it differently.
    sessionId ??= strOrNull(o.thread_id ?? o.session_id ?? o.msg?.session_id);

    // Token counts, carried on `turn.completed`. Codex has moved these between
    // shapes across versions, so every place it has put them is checked and the LAST
    // one wins — a transcript carries a running total, and the final one is the
    // aggregate. Only the ENVELOPE is confirmed against a real capture; the usage
    // key path is inferred, which is why the fallback chain is this wide.
    const u = o.usage ?? o.msg?.usage ?? o.info?.total_token_usage ?? o.item?.usage;
    if (u && typeof u === "object") {
      found = true;
      input = num(u.input_tokens ?? u.prompt_tokens ?? input);
      output = num(u.output_tokens ?? u.completion_tokens ?? output);
      cachedInput = num(u.cached_input_tokens ?? u.cache_read_input_tokens ?? cachedInput);
    }
  }

  if (!found) return null;
  return {
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: cachedInput,
    cacheCreationTokens: 0,   // Codex reports no cache-creation figure
    costUsd: null,            // see the header — deliberately not zero
    durationMs: null,         // the runner supplies wall clock instead
    numTurns: null,
    sessionId,
  };
}
