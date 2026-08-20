// Live run-log → filtered transcript.
//
// Paperclip's /heartbeat-runs/:id/log endpoint returns the agent process's raw
// stdout as JSONL where each outer line is {ts, stream, chunk}. The `chunk`
// payload is what the agent actually printed — usually one (or part of one)
// inner JSON event from Claude Code's stream-json format.
//
// This module joins all chunks back into one byte stream, splits on newlines,
// parses each inner JSON line, and emits client-safe transcript events. It
// also redacts known sensitive tokens before returning anything.

export type TranscriptEvent =
  | { ts: string; kind: "assistant"; text: string }
  | { ts: string; kind: "tool_use"; tool: string; preview: string }
  | { ts: string; kind: "tool_result"; preview: string }
  | { ts: string; kind: "skill"; name: string }
  | { ts: string; kind: "framing"; text: string }; // Paperclip's own '[paperclip] …' lines

const SENSITIVE_PATTERNS: Array<[RegExp, string]> = [
  [/ATATT3xFf[A-Za-z0-9_\-=]+/g, "[ATLASSIAN_TOKEN]"],
  [/AIza[A-Za-z0-9_\-]{30,}/g, "[GEMINI_KEY]"],
  [/Bearer\s+[A-Za-z0-9._\-]{20,}/g, "Bearer [TOKEN]"],
  [/sk-ant-[A-Za-z0-9_\-]{20,}/g, "[ANTHROPIC_KEY]"],
];

function scrub(s: string): string {
  let out = s;
  for (const [re, sub] of SENSITIVE_PATTERNS) out = out.replace(re, sub);
  return out;
}

// Trim to a single line, strip excessive whitespace, cap length.
function summarise(s: string, max = 240): string {
  const cleaned = s.replace(/\s+/g, " ").trim();
  return cleaned.length > max ? cleaned.slice(0, max - 1) + "…" : cleaned;
}

function localTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toISOString().slice(11, 19); // HH:MM:SS
  } catch {
    return iso.slice(11, 19) ?? iso;
  }
}

// Describe a tool_use input concisely. We special-case the common ones the
// agents use; everything else gets a JSON one-liner.
function describeToolInput(name: string, input: unknown): string {
  const x = (input ?? {}) as Record<string, any>;
  switch (name) {
    case "Bash":
      return summarise(x.command ?? x.description ?? "");
    case "Read":
      return summarise(x.file_path ?? x.path ?? "");
    case "Write":
      return summarise(`${x.file_path ?? ""} (${(x.content ?? "").length} chars)`);
    case "Edit":
      return summarise(x.file_path ?? "");
    case "Glob":
    case "Grep":
      return summarise(x.pattern ?? x.path ?? "");
    case "TodoWrite":
      return summarise(`${(x.todos ?? []).length} tasks`);
    case "Skill":
      return summarise(x.skill ?? "");
    case "WebFetch":
    case "WebSearch":
      return summarise(x.url ?? x.query ?? "");
    default:
      try { return summarise(JSON.stringify(x)); } catch { return ""; }
  }
}

// Walk the joined raw log text and emit transcript events. The text may end
// mid-line (we're polling incrementally) — return how many bytes we successfully
// consumed so the next poll can resume from there.
export interface FilterResult {
  events: TranscriptEvent[];
  consumed: number; // length of joined text actually parsed; leftover is left for next call
}

export function filterRunLog(rawLog: string, adapter?: string | null): FilterResult {
  // 1. Outer pass: each line is {ts, stream, chunk}. Re-assemble the inner stream.
  const outerLines = rawLog.split("\n");
  // Last line may be partial — process all but the last (unless rawLog ends with \n).
  const endsClean = rawLog.endsWith("\n");
  const upto = endsClean ? outerLines.length : outerLines.length - 1;

  // Track how many bytes of rawLog correspond to the lines we keep.
  let consumed = 0;
  const innerSegments: { ts: string; chunk: string }[] = [];
  for (let i = 0; i < upto; i++) {
    const line = outerLines[i];
    consumed += line.length + (i < outerLines.length - 1 ? 1 : 0); // include the \n
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (typeof obj.chunk === "string") {
        innerSegments.push({ ts: obj.ts ?? "", chunk: obj.chunk });
      }
    } catch {
      // Garbled outer line — skip, but still count as consumed so we don't loop.
    }
  }

  // 2. Concatenate inner chunks (Paperclip emits inner lines across multiple
  //    outer lines), then split into inner lines. Associate each inner line
  //    with the timestamp of the FIRST chunk that contributed to it.
  let buffer = "";
  let bufferTs = "";
  const innerLines: { ts: string; line: string }[] = [];
  for (const seg of innerSegments) {
    if (!buffer) bufferTs = seg.ts;
    buffer += seg.chunk;
    while (true) {
      const nl = buffer.indexOf("\n");
      if (nl < 0) break;
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (line.trim()) innerLines.push({ ts: bufferTs, line });
      bufferTs = seg.ts;
    }
  }
  // Anything still in `buffer` is a partial inner line — we leave it; the next
  // poll's fetch will include its remaining bytes again from `consumed` onwards.

  // 3. Inner pass: classify each inner line and produce TranscriptEvents.
  const events: TranscriptEvent[] = [];
  for (const { ts, line } of innerLines) {
    const tsLocal = localTime(ts);

    // Plain-text framing line ("[paperclip] …", "[event] …", etc.) — the engine
    // writes these regardless of which adapter ran, so they are checked ahead of
    // the JSON parse for both decoders.
    if (line.startsWith("[paperclip]") || line.startsWith("[orchestrator]") ||
        line.startsWith("[event]") || line.startsWith("Status:") || line.startsWith("Run ")) {
      const text = scrub(summarise(line, 200));
      // We keep framing as a low-noise breadcrumb (just 'paperclip:' / 'event:')
      events.push({ ts: tsLocal, kind: "framing", text });
      continue;
    }

    let obj: any;
    try { obj = JSON.parse(line); } catch { continue; } // skip non-JSON noise
    if (adapter === "codex") decodeCodexLine(tsLocal, obj, events);
    else decodeClaudeLine(tsLocal, obj, events);
  }

  return { events, consumed };
}

/** Claude Code's `stream-json` vocabulary — the original (and default) decoder. */
function decodeClaudeLine(tsLocal: string, obj: any, events: TranscriptEvent[]): void {
  // Anthropic stream-json: { type: 'assistant' | 'user' | 'system' | 'result', ... }
  const type = obj.type;

  if (type === "system") return; // hook_started / hook_response / init — too noisy
  if (type === "result") return; // usage is extracted separately by usage.ts

  if (type === "assistant") {
    const blocks = obj.message?.content ?? obj.content ?? [];
    if (!Array.isArray(blocks)) return;
    for (const b of blocks) {
      if (b?.type === "text" && typeof b.text === "string") {
        const text = scrub(summarise(b.text, 600));
        if (text) events.push({ ts: tsLocal, kind: "assistant", text });
      } else if (b?.type === "tool_use") {
        const tool = String(b.name || "Tool");
        if (tool === "Skill") {
          events.push({ ts: tsLocal, kind: "skill", name: scrub(summarise(String(b.input?.skill ?? ""), 80)) });
        } else {
          const preview = scrub(describeToolInput(tool, b.input));
          events.push({ ts: tsLocal, kind: "tool_use", tool, preview });
        }
      } else if (b?.type === "thinking") {
        // Surface extended thinking as assistant prose (clients asked for chatty).
        const text = scrub(summarise(String(b.thinking ?? ""), 600));
        if (text) events.push({ ts: tsLocal, kind: "assistant", text });
      }
    }
    return;
  }

  if (type === "user") {
    // tool_result blocks come back wrapped as user-role messages.
    const blocks = obj.message?.content ?? obj.content ?? [];
    if (!Array.isArray(blocks)) return;
    for (const b of blocks) {
      if (b?.type === "tool_result") {
        const raw = typeof b.content === "string"
          ? b.content
          : Array.isArray(b.content)
            ? b.content.map((c: any) => c?.text ?? "").join("\n")
            : "";
        const preview = scrub(summarise(raw, 240));
        if (preview) events.push({ ts: tsLocal, kind: "tool_result", preview });
      }
    }
    return;
  }
}

/**
 * Codex CLI's JSONL vocabulary.
 *
 * Written against a real capture, like the Claude decoder. Codex has moved
 * event names between versions, so anything unrecognised is emitted as text
 * rather than dropped: a version bump must degrade this transcript, never empty
 * it — an operator reading "nothing happened" for a working run is the failure
 * mode worth engineering against.
 */
function decodeCodexLine(ts: string, obj: any, events: TranscriptEvent[]): void {
  // Envelope confirmed against a real capture: thread.started / turn.started /
  // turn.completed / turn.failed / item.completed / error, with the payload of an
  // item nested under `item` and its own kind on `item.type` (agent_message,
  // command_execution, error). `msg` is a fallback for older builds.
  const kind = obj.type ?? obj.msg?.type ?? "";
  const body = obj.item ?? obj.msg ?? obj;

  // Assistant prose, wherever this version puts it.
  const text = body.text ?? body.message ?? body.delta ?? body.last_agent_message;
  if (typeof text === "string" && text.trim() && !/token|usage/i.test(kind)) {
    events.push({ ts, kind: "assistant", text: scrub(summarise(text, 600)) });
    return;
  }

  // Shell commands Codex ran. `run_command` is this repo's own tool vocabulary
  // in tools.ts, so the transcript reads the same across adapters.
  const command = body.command ?? body.cmd;
  if (command) {
    const shown = Array.isArray(command) ? command.join(" ") : String(command);
    events.push({ ts, kind: "tool_use", tool: "run_command", preview: scrub(summarise(shown)) });
    return;
  }

  // An error is worth showing — a failed run whose transcript is blank tells an
  // operator nothing about why.
  if (kind === "error" || body?.type === "error") {
    const m = scrub(summarise(String(obj.message ?? body?.message ?? ""), 300));
    if (m) events.push({ ts, kind: "framing", text: m });
    return;
  }

  if (/token_count|usage|turn\.completed/i.test(kind)) return;   // usage.ts owns these
  if (/^(session|thread|turn)[._]/i.test(kind)) return;           // lifecycle noise

  // Unrecognised: show it rather than lose it.
  const dump = scrub(summarise(JSON.stringify(obj), 240));
  if (dump) events.push({ ts, kind: "framing", text: dump });
}
