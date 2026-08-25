import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
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
    // TWO servers now, and the split is deliberate: `scyne` is the FILE plane
    // (large documents in, chunks out) and `scyne-workspace` is the WORKSPACE
    // plane (projects, documents, running pipeline stages). They are separate
    // processes on separate ports and either runs without the other.
    expect(Object.keys(mcp.mcpServers).sort()).toEqual(["scyne", "scyne-workspace"]);
    expect(mcp.mcpServers["scyne"].type).toBe("http");
    expect(mcp.mcpServers["scyne"].url).toBe("http://127.0.0.1:8080/mcp");
    expect(mcp.mcpServers["scyne-workspace"].url).toBe("http://127.0.0.1:8081/mcp");
  });

  it("is registered in the repo marketplace by a relative local path", () => {
    const m = JSON.parse(readFileSync(resolve(repoRoot, ".agents/plugins/marketplace.json"), "utf8"));
    const entry = m.plugins.find((p: any) => p.name === "azure-file-processing");
    expect(entry).toBeDefined();
    expect(entry.source).toEqual({ source: "local", path: "./plugins/azure-file-processing" });
  });
});

describe("the workspace plane is declared", () => {
  // `plugin.json` points at a DIRECTORY — `"skills": "./skills/"` — so there is
  // no array to register a name in. Codex discovers a skill by its folder.
  it("ships the skill where the manifest says skills live", () => {
    const manifest = JSON.parse(readFileSync(resolve(here, "../.codex-plugin/plugin.json"), "utf8"));
    expect(manifest.skills).toBe("./skills/");
    expect(existsSync(resolve(here, "../skills/scyne-workspace/SKILL.md"))).toBe(true);
  });

  it("the SKILL.md carries the frontmatter Codex matches on", () => {
    const md = readFileSync(resolve(here, "../skills/scyne-workspace/SKILL.md"), "utf8");
    expect(md.startsWith("---")).toBe(true);
    expect(md).toMatch(/^name: scyne-workspace$/m);
    expect(md).toMatch(/^description: Use when /m);
  });

  it("the manifest describes both planes, not only the file one", () => {
    const manifest = JSON.parse(readFileSync(resolve(here, "../.codex-plugin/plugin.json"), "utf8"));
    expect(manifest.interface.longDescription).toMatch(/workspace|pipeline|stage/i);
  });

  it("stack.sh knows how to start the workspace server", () => {
    const sh = readFileSync(resolve(here, "../scripts/stack.sh"), "utf8");
    expect(sh).toMatch(/src\/workspace\/server\.ts/);
    expect(sh).toMatch(/WORKSPACE_PORT/);
  });

  it("the README names the token every workspace tool needs", () => {
    const readme = readFileSync(resolve(here, "../README.md"), "utf8");
    expect(readme).toMatch(/SCYNE_ORCH_TOKEN/);
    expect(readme).toMatch(/8081/);
  });
});
