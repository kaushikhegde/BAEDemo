import { describe, it, expect } from "vitest";
import { buildCodexArgs } from "../src/core/codex-runner.js";
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

  it("leaves no session files behind and ignores the developer's own config", () => {
    const a = buildCodexArgs(base, {});
    expect(a).toContain("--ephemeral");
    expect(a).toContain("--ignore-user-config");
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
