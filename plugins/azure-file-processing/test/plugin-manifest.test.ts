import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, readdirSync } from "node:fs";
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
    expect(existsSync(resolve(here, "../skills/scyne/SKILL.md"))).toBe(true);
  });

  it("the SKILL.md describes BOTH planes, since one skill now covers both", () => {
    const md = readFileSync(resolve(here, "../skills/scyne/SKILL.md"), "utf8");
    expect(md.startsWith("---")).toBe(true);
    expect(md).toMatch(/^name: scyne$/m);
    // The description is the only thing Codex matches on when deciding to load
    // it, so a merged skill whose description covers only one plane is a
    // merged skill that never fires for the other.
    const desc = /^description: (.+)$/m.exec(md)![1];
    expect(desc).toMatch(/pipeline|stage/i);
    expect(desc).toMatch(/large|PDF|document/i);
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

describe("the $scyne skill", () => {
  const skill = resolve(pluginDir, "skills", "scyne", "SKILL.md");

  it("ships inside the PLUGIN, so it travels with an install", () => {
    // Not `<repo>/.codex/skills/`. That works — it is where this was first
    // proved — but it is project-scoped: install the plugin anywhere else and
    // `$scyne` would simply not exist. A skill under the plugin ships with it.
    expect(existsSync(skill)).toBe(true);
  });

  it("is invoked with $, not /", () => {
    // Codex removed custom slash commands in 0.117.0 in favour of skills, and
    // invokes a skill with `$`. Three mechanisms were tried before this one
    // and none appeared in the composer: a plugin `commands/*.md` file (Claude
    // Code's convention), an MCP prompt, and the command→skill migration. The
    // heading is what a reader copies, so it must not say `/scyne`.
    const body = readFileSync(skill, "utf8");
    expect(body.split("\n").find((l) => l.startsWith("# "))).toBe("# $scyne");
    // No EXAMPLE may show the slash form. Prose that mentions `/scyne` in order
    // to say it does not exist is exactly what this file should contain, so the
    // check is on lines that read as something to type, not on any mention.
    const examples = body.split("\n").filter((l) => /^\s*[>|]?\s*\/scyne\b/.test(l));
    expect(examples).toEqual([]);
    // And it must say which prefix IS right, since three were tried.
    expect(body).toMatch(/\$scyne/);
    expect(body).toMatch(/`\$`, not `\/`/);
  });

  it("carries frontmatter Codex can index it by", () => {
    const body = readFileSync(skill, "utf8");
    expect(body.startsWith("---\n")).toBe(true);
    expect(body).toMatch(/^name: scyne$/m);
    // The description is the only thing shown in the `$` picker.
    expect(body).toMatch(/^description: .{60,}/m);
  });

  it("covers the verbs the client's brief shows", () => {
    const body = readFileSync(skill, "utf8");
    for (const verb of ["use", "run", "status", "gate approve", "spend"]) {
      expect(body, verb).toContain(`\`${verb}`);
    }
  });

  it("routes upload through the large-file path, not the in-memory one", () => {
    const body = readFileSync(skill, "utf8");
    expect(body).toContain("ingest_document");
    // The plugin's single hardest rule. Phrasing may change; the prohibition
    // may not.
    expect(body).toMatch(/never read a document yourself/i);
  });

  it("refuses to approve a gate on the user's behalf", () => {
    // Approving publishes a wiki page and a client's backlog.
    const body = readFileSync(skill, "utf8");
    expect(body).toMatch(/never approve on the person's behalf/i);
  });

  it("is the ONLY skill — one $scyne, not three", () => {
    // Was three: azure-file-processing (file plane), scyne-workspace
    // (workspace plane) and scyne (a verb table duplicating the second). The
    // first two were genuinely distinct; the third was duplication introduced
    // while chasing the slash-command mechanism. Merged so there is a single
    // thing to invoke and a single place the guidance lives.
    const dirs = readdirSync(resolve(pluginDir, "skills"), { withFileTypes: true })
      .filter((d) => d.isDirectory()).map((d) => d.name);
    expect(dirs).toEqual(["scyne"]);
  });

  it("no longer ships a commands/ directory", () => {
    // Retired once proved inert in Codex: a directory that looks like it
    // provides a command, and does not, is worse than none.
    expect(existsSync(resolve(pluginDir, "commands"))).toBe(false);
  });
});
