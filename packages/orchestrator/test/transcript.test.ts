import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { filterRunLog } from "../src/core/transcript.js";

const wrap = (inner: object) =>
  JSON.stringify({ ts: "2026-08-17T10:00:00Z", stream: "stdout", chunk: JSON.stringify(inner) + "\n" }) + "\n";

describe("filterRunLog", () => {
  it("emits assistant text", () => {
    const log = wrap({ type: "assistant", message: { content: [{ type: "text", text: "hello" }] } });
    const { events } = filterRunLog(log);
    expect(events).toEqual([{ ts: "10:00:00", kind: "assistant", text: "hello" }]);
  });

  it("emits skill invocations distinctly from tool calls", () => {
    const log = wrap({ type: "assistant", message: { content: [
      { type: "tool_use", name: "Skill", input: { skill: "requirement-generator" } },
      { type: "tool_use", name: "Bash",  input: { command: "ls" } },
    ] } });
    const { events } = filterRunLog(log);
    expect(events[0]).toMatchObject({ kind: "skill", name: "requirement-generator" });
    expect(events[1]).toMatchObject({ kind: "tool_use", tool: "Bash", preview: "ls" });
  });

  it("redacts secrets in both directions", () => {
    const log = wrap({ type: "assistant", message: { content: [
      { type: "text", text: "token ATATT3xFfABCDEFGHIJKLMNOP and key AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZ0123456" },
    ] } });
    const { events } = filterRunLog(log);
    const text = (events[0] as any).text as string;
    expect(text).not.toMatch(/ATATT3xFf[A-Za-z0-9]/);
    expect(text).toContain("[ATLASSIAN_TOKEN]");
    expect(text).not.toMatch(/AIzaSy[A-Za-z0-9]/);
    expect(text).toContain("[GEMINI_KEY]");
  });

  it("consumes exactly the complete outer line and leaves the partial tail", () => {
    const complete = wrap({ type: "assistant", message: { content: [{ type: "text", text: "a" }] } });
    const partial = `{"ts":"2026-08-17T10:00:01Z","stream":"stdout","chunk":"{\\"type\\":\\"assi`;
    const log = complete + partial;

    const { events, consumed } = filterRunLog(log);

    // Forward progress: the complete line was parsed.
    expect(events).toContainEqual({ ts: "10:00:00", kind: "assistant", text: "a" });
    // Exactness: consumed lands on the byte after the first newline, so the next
    // poll resumes at the partial line rather than re-reading or skipping it.
    expect(consumed).toBe(log.indexOf("\n") + 1);
    expect(log.slice(consumed)).toBe(partial);
  });

  it("recombines an inner line split across two outer chunks", () => {
    const inner = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "split across chunks" }] },
    }) + "\n";
    const head = inner.slice(0, 20);
    const tail = inner.slice(20);

    const log =
      JSON.stringify({ ts: "2026-08-17T10:00:00Z", stream: "stdout", chunk: head }) + "\n" +
      JSON.stringify({ ts: "2026-08-17T10:00:01Z", stream: "stdout", chunk: tail }) + "\n";

    const { events } = filterRunLog(log);
    // Timestamp comes from the FIRST chunk that contributed to the line.
    expect(events).toEqual([{ ts: "10:00:00", kind: "assistant", text: "split across chunks" }]);
  });
});

describe("filterRunLog on a codex transcript", () => {
  // The runner wraps each child line in {ts, stream, chunk}; rebuild that shape
  // from the captured fixture so the test exercises the real outer format.
  const envelope = readFileSync(new URL("./fixtures/codex-run.jsonl", import.meta.url), "utf8")
    .split("\n").filter(Boolean)
    .map(l => JSON.stringify({ ts: "2026-08-20T01:02:03.000Z", stream: "stdout", chunk: l + "\n" }))
    .join("\n") + "\n";

  it("produces framing events for its error content, rather than an empty transcript", () => {
    // Fix round 1: every line in this fixture is an error/reconnect attempt (see
    // the fixture's own header comment) — before the fix for finding (b) below,
    // the text-extraction branch ran before the error check, so this line's
    // `message` field was misread as assistant prose. Correctly classified, this
    // fixture has no genuine agent prose to assert on; `framing` is what a
    // corrected decoder actually produces for it.
    const { events } = filterRunLog(envelope, "codex");
    expect(events.length).toBeGreaterThan(0);
    expect(events.some(e => e.kind === "framing")).toBe(true);
  });

  it("renders a command once, though codex reports it both started and completed", () => {
    // Codex emits the same command_execution item twice — `item.started` when
    // it is dispatched, `item.completed` when it returns — and BOTH carry
    // `command`. Both were decoded, so the console showed every shell line
    // twice, seconds apart, which reads as an agent running everything two
    // times. Measured on run d3b42b39: 41 commands rendered as 82 lines.
    const item = { id: "item_7", type: "command_execution", command: ["/bin/zsh", "-lc", "ls -la"] };
    const log = [
      { type: "item.started", item },
      { type: "item.completed", item: { ...item, status: "completed" } },
    ].map(o => JSON.stringify({
      ts: "2026-08-20T01:02:03.000Z", stream: "stdout", chunk: JSON.stringify(o) + "\n",
    })).join("\n") + "\n";

    const { events } = filterRunLog(log, "codex");
    const commands = events.filter(e => e.kind === "tool_use" && e.tool === "run_command");
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({ preview: expect.stringContaining("ls -la") });
  });

  it("still renders a command reported only as completed", () => {
    // The dedup drops `item.started` rather than `item.completed`, so a build
    // that reports only the completion keeps every command line. Dropping the
    // completion instead would lose all of them on such a build — the failure
    // this decoder exists to prevent.
    const log = JSON.stringify({
      ts: "2026-08-20T01:02:03.000Z", stream: "stdout",
      chunk: JSON.stringify({
        type: "item.completed",
        item: { id: "item_8", type: "command_execution", command: ["/bin/zsh", "-lc", "pwd"] },
      }) + "\n",
    }) + "\n";

    const { events } = filterRunLog(log, "codex");
    expect(events.filter(e => e.kind === "tool_use" && e.tool === "run_command")).toHaveLength(1);
  });

  it("keeps the Claude decoder as the default for callers that pass nothing", () => {
    const claudeLine = JSON.stringify({
      ts: "2026-08-20T01:02:03.000Z", stream: "stdout",
      chunk: JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "hello" }] },
      }) + "\n",
    }) + "\n";
    const { events } = filterRunLog(claudeLine);
    expect(events).toContainEqual(expect.objectContaining({ kind: "assistant", text: "hello" }));
  });

  it("renders the real captured envelope rather than an empty transcript", () => {
    // codex-envelope-unauthenticated.jsonl is a genuine capture: the run failed at
    // the model call, but a failed run whose transcript is blank is the worst
    // possible output — an operator cannot tell it from a run that did nothing.
    const real = readFileSync(
      new URL("./fixtures/codex-envelope-unauthenticated.jsonl", import.meta.url), "utf8")
      .split("\n").filter(Boolean)
      .map(l => JSON.stringify({ ts: "2026-08-20T01:02:03.000Z", stream: "stdout", chunk: l + "\n" }))
      .join("\n") + "\n";
    const { events } = filterRunLog(real, "codex");
    expect(events.length).toBeGreaterThan(0);
    expect(events.some(e => "text" in e && /401|Unauthorized/i.test(e.text))).toBe(true);
  });

  it("passes an unrecognised event through as text instead of dropping it", () => {
    // A Codex version bump must degrade the transcript, never empty it.
    const odd = JSON.stringify({
      ts: "2026-08-20T01:02:03.000Z", stream: "stdout",
      chunk: JSON.stringify({ type: "some_future_event", detail: "brand new thing" }) + "\n",
    }) + "\n";
    const { events } = filterRunLog(odd, "codex");
    expect(events.some(e => "text" in e && e.text.includes("brand new thing"))).toBe(true);
  });

  it("renders a bare turn.failed rather than dropping it as lifecycle noise", () => {
    // turn.failed is the one event that says WHY a run died. The lifecycle-noise
    // regex (/^(session|thread|turn)[._]/i) also matches it, which previously
    // swallowed it silently whenever it carried no top-level text/message/delta —
    // exactly the "nothing happened" failure mode this decoder exists to avoid.
    const failed = JSON.stringify({
      ts: "2026-08-20T01:02:03.000Z", stream: "stdout",
      chunk: JSON.stringify({ type: "turn.failed", error: { message: "model call failed" } }) + "\n",
    }) + "\n";
    const { events } = filterRunLog(failed, "codex");
    expect(events.length).toBeGreaterThan(0);
  });

  it("renders an error line as framing, not assistant", () => {
    // The text-extraction branch used to run before the explicit error check, so
    // every Codex error line carrying a `message` was tagged kind: "assistant" —
    // a UI that styles the two differently would show error text as agent prose.
    const err = JSON.stringify({
      ts: "2026-08-20T01:02:03.000Z", stream: "stdout",
      chunk: JSON.stringify({ type: "error", message: "Reconnecting... 1/5" }) + "\n",
    }) + "\n";
    const { events } = filterRunLog(err, "codex");
    expect(events).toContainEqual(expect.objectContaining({ kind: "framing" }));
    expect(events.some(e => e.kind === "assistant")).toBe(false);
  });
});
