import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCodexArgs, createCodexRunner, readMcpServers } from "../src/core/codex-runner.js";
import type { RunRequest } from "../src/core/runner.js";

const base: RunRequest = {
  agent: { key: "dataModeler" },
  prompt: "irrelevant — the prompt goes on stdin",
  cwd: "/work",
  logPath: "/logs/run.jsonl",
};

describe("buildCodexArgs", () => {
  it("runs non-interactively, streams JSONL, and never puts the prompt on argv", () => {
    const a = buildCodexArgs(base, {});
    expect(a[0]).toBe("exec");
    expect(a).toContain("--json");
    expect(a.join(" ")).not.toContain("irrelevant");
  });

  it("sets the working root, the sandbox and the git-repo escape", () => {
    const a = buildCodexArgs({ ...base, cwd: "/work/projects" }, {});
    expect(a).toContain("--cd");
    expect(a[a.indexOf("--cd") + 1]).toBe("/work/projects");
    expect(a[a.indexOf("--sandbox") + 1]).toBe("workspace-write");
    expect(a).toContain("--skip-git-repo-check");
  });

  // `codex exec` pins approval_policy to `never` and an MCP tool call is
  // something it wants approved, so without this flag EVERY MCP call dies with
  // "MCP tool call requires approval, but approval policy is never" — measured
  // on run SCY-1, which was refused, said so in prose, exited 0, and closed the
  // issue `done` with no wiki page. Codex REFUSES `--sandbox` beside
  // `--approve-for-me`, so the two must never both be emitted.
  it("gives a publishing agent --approve-for-me instead of --sandbox, never both", () => {
    const pub = buildCodexArgs({ ...base, agent: { key: "ba", mcpEnabled: true } }, {});
    expect(pub).toContain("--approve-for-me");
    expect(pub).not.toContain("--sandbox");

    // An agent with no MCP has nothing to approve, so it keeps the plain box.
    const plain = buildCodexArgs({ ...base, agent: { key: "ux", mcpEnabled: false } }, {});
    expect(plain).not.toContain("--approve-for-me");
    expect(plain[plain.indexOf("--sandbox") + 1]).toBe("workspace-write");
  });

  it("leaves no session files behind and ignores the developer's own config", () => {
    const a = buildCodexArgs(base, {});
    expect(a).toContain("--ephemeral");
    expect(a).toContain("--ignore-user-config");
  });

  it("routes to no provider unless one is declared", () => {
    const a = buildCodexArgs(base, {});
    expect(a.join(" ")).not.toContain("model_provider");
  });

  it("declares the endpoint, so --ignore-user-config cannot silently redirect a run", () => {
    // The measured failure: config.toml named a proxied endpoint, the flag
    // discarded it, and every run went to api.openai.com and 401'd — while
    // interactive `codex` on the same machine worked.
    const a = buildCodexArgs(base, {}, {
      baseUrl: "http://127.0.0.1:8788/openai/v1", wireApi: "responses", envKey: "CODEX_API_KEY",
    });
    const joined = a.join(" ");
    expect(a).toContain("--ignore-user-config");
    expect(joined).toContain(`model_provider="scyne"`);
    expect(joined).toContain(`model_providers.scyne.base_url="http://127.0.0.1:8788/openai/v1"`);
    expect(joined).toContain(`model_providers.scyne.wire_api="responses"`);
  });

  it("names the key's VARIABLE, never the key — argv is readable through ps", () => {
    const a = buildCodexArgs(base, {}, { baseUrl: "https://x/v1", envKey: "CODEX_API_KEY" });
    const joined = a.join(" ");
    expect(joined).toContain(`model_providers.scyne.env_key="CODEX_API_KEY"`);
    expect(joined).not.toContain("api_key");
  });

  it("defaults the wire API and the display name rather than omitting them", () => {
    const joined = buildCodexArgs(base, {}, { baseUrl: "https://x/v1" }).join(" ");
    expect(joined).toContain(`model_providers.scyne.wire_api="responses"`);
    expect(joined).toContain(`model_providers.scyne.name="scyne"`);
    // No key named, so no env_key line at all — an empty one would point Codex
    // at a variable that does not exist.
    expect(joined).not.toContain("env_key");
  });

  it("passes a model only when one is configured", () => {
    expect(buildCodexArgs(base, {})).not.toContain("--model");
    const a = buildCodexArgs({ ...base, model: "gpt-5-codex" }, {});
    expect(a[a.indexOf("--model") + 1]).toBe("gpt-5-codex");
  });

  it("translates effort into the config override Codex understands", () => {
    const a = buildCodexArgs({ ...base, effort: "high" }, {});
    expect(a).toContain("-c");
    expect(a.join(" ")).toContain('model_reasoning_effort="high"');
  });

  it("expands MCP servers into -c overrides, but only when the agent has MCP", () => {
    const servers = { ado: { command: "npx", args: ["-y", "@azure-devops/mcp", "scyne"] } };
    expect(buildCodexArgs(base, servers).join(" ")).not.toContain("mcp_servers");

    const withMcp = buildCodexArgs({ ...base, agent: { key: "ba", mcpEnabled: true } }, servers);
    const joined = withMcp.join(" ");
    expect(joined).toContain('mcp_servers.ado.command="npx"');
    expect(joined).toContain('mcp_servers.ado.args=["-y","@azure-devops/mcp","scyne"]');
  });

  it("appends the agent's extraArgs last so an operator can override anything", () => {
    const a = buildCodexArgs({ ...base, agent: { key: "ba", extraArgs: ["--add-dir", "/extra"] } }, {});
    expect(a.slice(-2)).toEqual(["--add-dir", "/extra"]);
  });

  it("encodes an MCP server's env as a TOML inline table, not a JSON object", () => {
    const servers = { ado: { command: "npx", env: { ADO_PAT: "x" } } };
    const a = buildCodexArgs({ ...base, agent: { key: "ba", mcpEnabled: true } }, servers);
    const joined = a.join(" ");
    // TOML inline tables use `=`, not JSON's `:` — asserting the key is
    // present is not enough, since JSON.stringify({ADO_PAT:"x"}) also
    // contains the substring "ADO_PAT" but fails to parse as TOML.
    expect(joined).toContain('mcp_servers.ado.env={ ADO_PAT = "x" }');
    expect(joined).not.toContain('"ADO_PAT":"x"');
  });
});

describe("createCodexRunner", () => {
  it("prepends the bundle and the SKILL.md to the prompt, since Codex has no --system-prompt-file", async () => {
    const root = mkdtempSync(join(tmpdir(), "codex-"));
    mkdirSync(join(root, "skills", "salesforce-data-modeler"), { recursive: true });
    writeFileSync(join(root, "skills", "salesforce-data-modeler", "SKILL.md"),
      "## Method\nStandard objects first.");
    writeFileSync(join(root, "bundle.md"), "You are the Data Modeler.");

    // A stand-in for `codex` that writes its stdin to a file and exits 0, so
    // the test can assert on what the runner actually sent.
    const seen = join(root, "stdin.txt");
    const fake = join(root, "fake-codex");
    writeFileSync(fake, `#!/bin/sh\ncat > ${seen}\nexit 0\n`, { mode: 0o755 });

    const runner = createCodexRunner({ installRoot: root, bin: fake });
    const res = await runner.run({
      agent: { key: "dataModeler", bundlePath: join(root, "bundle.md") },
      skill: "salesforce-data-modeler",
      prompt: "Generate the data model.",
      cwd: root,
      logPath: join(root, "run.jsonl"),
    });

    expect(res.exitCode).toBe(0);
    const sent = readFileSync(seen, "utf8");
    expect(sent).toContain("You are the Data Modeler.");
    expect(sent).toContain("# Skill: salesforce-data-modeler");
    expect(sent).toContain("Generate the data model.");
    expect(sent.indexOf("You are the Data Modeler.")).toBeLessThan(sent.indexOf("Generate the data model."));
  });

  it("fails with Claude Code's own wording when the skill does not exist", async () => {
    const root = mkdtempSync(join(tmpdir(), "codex-"));
    const runner = createCodexRunner({ installRoot: root, bin: "/bin/true" });
    const res = await runner.run({
      agent: { key: "dataModeler" },
      skill: "no-such-skill",
      prompt: "x", cwd: root, logPath: join(root, "run.jsonl"),
    });
    expect(res.status).toBe("failed");
    // Every runbook in this repo greps for this exact string.
    expect(res.stderrTail).toContain("Unknown skill: no-such-skill");
  });
});

describe("readMcpServers expands ${VAR}", () => {
  const write = (obj: unknown): string => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-"));
    const path = join(dir, ".mcp.json");
    writeFileSync(path, JSON.stringify(obj));
    return path;
  };

  it("substitutes an environment variable in an env value", async () => {
    // The bug this pins: Claude Code expands ${VAR} in .mcp.json itself, but
    // readMcpServers parses the JSON and re-encodes each value as TOML for
    // `codex -c`. Without expansion, a Codex run hands the MCP server the
    // LITERAL string "${MCP_TOKEN_FOR_AZURE}" and every call 401s with a
    // credential that looks present in the config.
    process.env.SCYNE_TEST_PAT = "a-real-token";
    const path = write({
      mcpServers: {
        "azure-devops": {
          command: "npx",
          args: ["-y", "@azure-devops/mcp", "Scyne-AI-Lab", "--authentication", "pat"],
          env: { PERSONAL_ACCESS_TOKEN: "${SCYNE_TEST_PAT}" },
        },
      },
    });
    const servers = await readMcpServers(path);
    expect(servers["azure-devops"].env!.PERSONAL_ACCESS_TOKEN).toBe("a-real-token");
    delete process.env.SCYNE_TEST_PAT;
  });

  it("expands inside args and the command too", async () => {
    process.env.SCYNE_TEST_ORG = "Scyne-AI-Lab";
    const path = write({
      mcpServers: { ado: { command: "npx", args: ["-y", "@azure-devops/mcp", "${SCYNE_TEST_ORG}"] } },
    });
    const servers = await readMcpServers(path);
    expect(servers.ado.args).toContain("Scyne-AI-Lab");
    delete process.env.SCYNE_TEST_ORG;
  });

  it("honours a ${VAR:-default}", async () => {
    delete process.env.SCYNE_TEST_MISSING;
    const path = write({
      mcpServers: { x: { command: "c", env: { A: "${SCYNE_TEST_MISSING:-fallback}" } } },
    });
    expect((await readMcpServers(path)).x.env!.A).toBe("fallback");
  });

  it("THROWS on a variable that resolves to nothing, naming it", async () => {
    // Silently substituting "" gives the server an empty credential and a 401
    // that reads like a permissions problem. Failing here names the variable
    // and the file, which is a thirty-second fix instead of an afternoon.
    delete process.env.SCYNE_TEST_ABSENT;
    const path = write({ mcpServers: { x: { command: "c", env: { A: "${SCYNE_TEST_ABSENT}" } } } });
    await expect(readMcpServers(path)).rejects.toThrow(/SCYNE_TEST_ABSENT/);
  });

  it("leaves a value with no placeholder exactly as it is", async () => {
    const path = write({ mcpServers: { x: { command: "npx", args: ["-y", "pkg"], env: { A: "plain" } } } });
    const servers = await readMcpServers(path);
    expect(servers.x.env!.A).toBe("plain");
    expect(servers.x.args).toEqual(["-y", "pkg"]);
  });

  it("still returns {} for a missing or malformed file", async () => {
    expect(await readMcpServers("/nowhere/.mcp.json")).toEqual({});
    expect(await readMcpServers(undefined)).toEqual({});
  });
});
