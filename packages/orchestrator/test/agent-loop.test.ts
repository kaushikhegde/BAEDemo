import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLoopRunner, MAX_TURNS, type ChatProvider, type ProviderTurn, type CompleteRequest } from "../src/core/agent-loop.js";
import { filterRunLog } from "../src/core/transcript.js";
import { extractUsage } from "../src/core/usage.js";
import { classifyFailure } from "../src/core/retry.js";
import type { RunRequest } from "../src/core/runner.js";

let workRoot: string, installRoot: string, logPath: string;

/** A provider driven by a fixed script of turns — no network, no model. */
function scripted(turns: ProviderTurn[], onRequest?: (r: CompleteRequest) => void): ChatProvider {
  let i = 0;
  return {
    name: "fake", model: "fake-1",
    async complete(req) {
      onRequest?.(req);
      return turns[Math.min(i++, turns.length - 1)];
    },
  };
}

const say = (text: string): ProviderTurn => ({ text, toolCalls: [], usage: { inputTokens: 10, outputTokens: 5 } });
const call = (name: string, input: Record<string, unknown>, text = ""): ProviderTurn =>
  ({ text, toolCalls: [{ id: "c1", name, input }], usage: { inputTokens: 10, outputTokens: 5 } });

function request(over: Partial<RunRequest> = {}): RunRequest {
  return {
    agent: { key: "ba", bundlePath: join(installRoot, "agent-instructions", "ba.thin.md") },
    prompt: "Generate the data model.",
    cwd: workRoot,
    logPath,
    ...over,
  };
}

beforeEach(async () => {
  workRoot = mkdtempSync(join(tmpdir(), "orch-loop-work-"));
  installRoot = mkdtempSync(join(tmpdir(), "orch-loop-install-"));
  logPath = join(mkdtempSync(join(tmpdir(), "orch-loop-logs-")), "run.jsonl");

  await mkdir(join(installRoot, "agent-instructions"), { recursive: true });
  await writeFile(join(installRoot, "agent-instructions", "ba.thin.md"), "You are the BA.");
  await mkdir(join(installRoot, "skills", "salesforce-data-modeler"), { recursive: true });
  await writeFile(join(installRoot, "skills", "salesforce-data-modeler", "SKILL.md"),
    "# Data modeller\n\nWrite outputs/salesforce-data-model.md.");
});
afterEach(() => {
  for (const d of [workRoot, installRoot]) rmSync(d, { recursive: true, force: true });
});

describe("agent loop", () => {
  it("runs tools the model asks for, and actually writes the file", async () => {
    const runner = createLoopRunner({
      provider: scripted([
        call("write_file", { path: "outputs/salesforce-data-model.md", content: "# Data model" }),
        say("Written."),
      ]),
      installRoot,
    });

    const res = await runner.run(request());
    expect(res.status).toBe("succeeded");
    expect(res.exitCode).toBe(0);
    expect(await readFile(join(workRoot, "outputs/salesforce-data-model.md"), "utf8")).toBe("# Data model");
  });

  it("emits a transcript the EXISTING parser renders — no console change needed", async () => {
    const runner = createLoopRunner({
      provider: scripted([
        call("write_file", { path: "a.md", content: "x" }, "I will write the file."),
        say("Done."),
      ]),
      installRoot,
    });
    await runner.run(request());

    const raw = await readFile(logPath, "utf8");
    const { events } = filterRunLog(raw);
    const kinds = events.map(e => e.kind);

    expect(kinds).toContain("assistant");
    expect(kinds).toContain("tool_use");
    expect(kinds).toContain("tool_result");
    expect(events.find(e => e.kind === "tool_use")).toMatchObject({ tool: "write_file" });
    expect(events.some(e => e.kind === "assistant" && e.text.includes("I will write the file"))).toBe(true);
  });

  it("loads the skill itself and shows it as a skill event", async () => {
    let seenSystem = "";
    const runner = createLoopRunner({
      provider: scripted([say("ok")], r => { seenSystem = r.system; }),
      installRoot,
    });
    await runner.run(request({ skill: "salesforce-data-modeler" }));

    // The SKILL.md content reached the model — no provider can discover it alone.
    expect(seenSystem).toContain("Write outputs/salesforce-data-model.md");
    expect(seenSystem).toContain("You are the BA.");      // the bundle too

    const { events } = filterRunLog(await readFile(logPath, "utf8"));
    expect(events.find(e => e.kind === "skill")).toMatchObject({ name: "salesforce-data-modeler" });
  });

  it("fails with the same words as Claude Code when the skill is missing", async () => {
    const runner = createLoopRunner({ provider: scripted([say("ok")]), installRoot });
    const res = await runner.run(request({ skill: "no-such-skill" }));
    expect(res.status).toBe("failed");
    expect(res.stderrTail).toContain("Unknown skill: no-such-skill");
  });

  it("fails with the same words as Claude Code when the bundle is missing", async () => {
    const runner = createLoopRunner({ provider: scripted([say("ok")]), installRoot });
    const res = await runner.run(request({
      agent: { key: "ba", bundlePath: join(installRoot, "agent-instructions", "absent.md") },
    }));
    expect(res.status).toBe("failed");
    expect(res.stderrTail).toContain("System prompt file not found");
  });

  it("records usage in the shape usage.ts already extracts", async () => {
    const runner = createLoopRunner({
      provider: scripted([call("read_file", { path: "a.md" }), say("done")]),
      installRoot,
    });
    const res = await runner.run(request());

    expect(res.usage).not.toBeNull();
    expect(res.usage!.inputTokens).toBe(20);          // two turns
    expect(res.usage!.outputTokens).toBe(10);

    // And the log itself parses through the existing extractor.
    const raw = await readFile(logPath, "utf8");
    const inner = raw.split("\n").filter(Boolean)
      .map(l => JSON.parse(l).chunk).join("");
    const usage = extractUsage(inner);
    expect(usage).not.toBeNull();
    expect(usage!.outputTokens).toBe(10);
  });

  it("produces NO result event on a config failure, so retry.ts sees a free failure", async () => {
    const runner = createLoopRunner({ provider: scripted([say("ok")]), installRoot });
    const res = await runner.run(request({ skill: "no-such-skill" }));

    // This is the contract retry.ts reads: usage === null means nothing was billed.
    expect(res.usage).toBeNull();
    const verdict = classifyFailure(res, 500);
    expect(verdict.retry).toBe(false);                // config errors are never retried
    expect(verdict.reason.length).toBeGreaterThan(0);
  });

  it("surfaces a refused tool call to the model instead of ending the run", async () => {
    const runner = createLoopRunner({
      provider: scripted([
        call("read_file", { path: "../../../etc/passwd" }),
        call("write_file", { path: "ok.md", content: "recovered" }),
        say("done"),
      ]),
      installRoot,
    });
    const res = await runner.run(request());

    expect(res.status).toBe("succeeded");
    expect(await readFile(join(workRoot, "ok.md"), "utf8")).toBe("recovered");
    const { events } = filterRunLog(await readFile(logPath, "utf8"));
    expect(events.some(e => e.kind === "tool_result" && e.preview.includes("refused"))).toBe(true);
  });

  it("feeds tool results back so the model can act on what it read", async () => {
    await writeFile(join(workRoot, "input.md"), "the source content");
    const seen: CompleteRequest[] = [];
    const runner = createLoopRunner({
      provider: scripted([call("read_file", { path: "input.md" }), say("done")], r => { seen.push(structuredClone(r)); }),
      installRoot,
    });
    await runner.run(request());

    const second = seen[1];
    const toolMsg = second.messages.find(m => m.role === "tool");
    expect(toolMsg).toBeTruthy();
    expect(JSON.stringify(toolMsg)).toContain("the source content");
  });

  it("stops at the turn ceiling rather than looping forever", async () => {
    // A model that never stops calling tools.
    const runner = createLoopRunner({
      provider: { name: "loop", model: "x", async complete() { return call("list_files", {}); } },
      installRoot,
    });
    const res = await runner.run(request());
    expect(res.status).toBe("failed");
    expect(res.stderrTail).toContain(`${MAX_TURNS} turns`);
  }, 30_000);

  it("flags a run that breaches its token budget", async () => {
    const runner = createLoopRunner({ provider: scripted([say("done")]), installRoot });
    const res = await runner.run(request({ budget: { maxTokens: 5 } }));
    expect(res.status).toBe("over_budget");
  });

  it("flags a run that breaches its cost budget", async () => {
    const runner = createLoopRunner({
      provider: scripted([{ text: "done", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, costUsd: 9 } }]),
      installRoot,
    });
    const res = await runner.run(request({ budget: { maxCostUsd: 1 } }));
    expect(res.status).toBe("over_budget");
  });

  it("runs with no bundle at all — an agent may have only the workflow prompt", async () => {
    const runner = createLoopRunner({ provider: scripted([say("done")]), installRoot });
    const res = await runner.run(request({ agent: { key: "ba" } }));
    expect(res.status).toBe("succeeded");
  });
});
