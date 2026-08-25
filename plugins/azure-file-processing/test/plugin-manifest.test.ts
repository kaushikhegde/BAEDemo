import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const pluginDir = resolve(here, "..");
const repoRoot = resolve(pluginDir, "..", "..");
const validator = resolve(
  process.env.HOME!, ".codex/skills/.system/plugin-creator/scripts/validate_plugin.py");

describe("codex plugin packaging", () => {
  it("passes Codex's own plugin validator", () => {
    // Exits non-zero and prints the offending field when the manifest is wrong.
    const out = execFileSync("python3", [validator, pluginDir], { encoding: "utf8" });
    expect(out).not.toMatch(/error/i);
  });

  it("declares the MCP server under the name the skill refers to", () => {
    const mcp = JSON.parse(readFileSync(resolve(pluginDir, ".mcp.json"), "utf8"));
    // The key is the namespace Codex prefixes every tool with, so it is the
    // one string that decides whether a user sees scyne__upload_file or
    // azure_files__upload_file. Asserted here rather than left to the skill.
    expect(Object.keys(mcp.mcpServers)).toEqual(["scyne"]);
    expect(mcp.mcpServers["scyne"].type).toBe("http");
    expect(mcp.mcpServers["scyne"].url).toBe("http://127.0.0.1:8080/mcp");
  });

  it("is registered in the repo marketplace by a relative local path", () => {
    const m = JSON.parse(readFileSync(resolve(repoRoot, ".agents/plugins/marketplace.json"), "utf8"));
    const entry = m.plugins.find((p: any) => p.name === "azure-file-processing");
    expect(entry).toBeDefined();
    expect(entry.source).toEqual({ source: "local", path: "./plugins/azure-file-processing" });
  });
});
