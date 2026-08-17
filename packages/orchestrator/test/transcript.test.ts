import { describe, it, expect } from "vitest";
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
