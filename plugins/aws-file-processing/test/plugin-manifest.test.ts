import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const pluginDir = resolve(here, "..");
const repoRoot = resolve(pluginDir, "..", "..");

const manifest = () =>
  JSON.parse(readFileSync(resolve(pluginDir, ".claude-plugin/plugin.json"), "utf8"));

describe("Claude Code plugin packaging", () => {
  it("puts the manifest where Claude Code looks for it", () => {
    // `.claude-plugin/plugin.json`, not `.codex-plugin/`. The Codex build of
    // this plugin used the latter and nothing else would have told us: a
    // manifest in the wrong directory is a plugin that simply does not load,
    // with no error naming the path it wanted.
    expect(existsSync(resolve(pluginDir, ".claude-plugin/plugin.json"))).toBe(true);
    expect(existsSync(resolve(pluginDir, ".codex-plugin"))).toBe(false);
  });

  it("declares the fields the loader requires", () => {
    const m = manifest();
    expect(m.name).toBe("aws-file-processing");
    expect(typeof m.version).toBe("string");
    expect(m.description.length).toBeGreaterThan(40);
  });

  it("points at every surface it ships, by relative path", () => {
    const m = manifest();
    // Three entries, three surfaces, and all three have to exist on disk —
    // a manifest naming a directory that is not there loads silently and
    // provides nothing.
    expect(m.commands).toBe("./commands/");
    expect(m.skills).toBe("./skills/");
    expect(m.mcpServers).toBe("./.mcp.json");
    expect(existsSync(resolve(pluginDir, "commands"))).toBe(true);
    expect(existsSync(resolve(pluginDir, "skills"))).toBe(true);
    expect(existsSync(resolve(pluginDir, ".mcp.json"))).toBe(true);
  });

  it("declares the MCP servers under the names the skill refers to", () => {
    const mcp = JSON.parse(readFileSync(resolve(pluginDir, ".mcp.json"), "utf8"));
    // The key is the namespace every tool is prefixed with, so it is the one
    // string that decides whether a user sees scyne__upload_file or
    // aws_files__upload_file. Asserted here rather than left to the skill.
    // TWO servers, and the split is deliberate: `scyne` is the FILE plane
    // (large documents in, chunks out) and `scyne-workspace` is the WORKSPACE
    // plane (projects, documents, running pipeline stages). They are separate
    // processes on separate ports and either runs without the other.
    expect(Object.keys(mcp.mcpServers).sort()).toEqual(["scyne", "scyne-workspace"]);
    expect(mcp.mcpServers["scyne"].type).toBe("http");
    // Env-expanded with a DEFAULT, not a literal. The two plugins are meant to
    // run at the same time, and they both used to hardcode 8080/8081 — so
    // installing both gave two servers fighting for one port and a workspace
    // answering for the wrong cloud. The variable is namespaced per plugin for
    // the same reason: a shared ORCH_PORT in the root .env moved both at once.
    expect(mcp.mcpServers["scyne"].url)
      .toBe("http://127.0.0.1:${SCYNE_AWS_FILE_PORT:-8080}/mcp");
    expect(mcp.mcpServers["scyne-workspace"].url)
      .toBe("http://127.0.0.1:${SCYNE_AWS_WORKSPACE_PORT:-8081}/mcp");

    // The default in the manifest must be the default `stack.sh` binds, or the
    // client connects to a port nothing is listening on.
    const stack = readFileSync(resolve(pluginDir, "scripts/stack.sh"), "utf8");
    expect(stack).toContain("SCYNE_AWS_FILE_PORT:-8080");
    expect(stack).toContain("SCYNE_AWS_WORKSPACE_PORT:-8081");
  });

  it("is registered in the repo's Claude Code marketplace by a relative local path", () => {
    // `.claude-plugin/marketplace.json` at the REPO ROOT, which is what
    // `/plugin marketplace add ./` reads. The Codex build's
    // `.agents/plugins/marketplace.json` still exists and still points at the
    // Azure plugin; the two are separate registries and neither disturbs the
    // other, which is what lets both plugins be installed at once.
    const m = JSON.parse(
      readFileSync(resolve(repoRoot, ".claude-plugin/marketplace.json"), "utf8"));
    const entry = m.plugins.find((p: any) => p.name === "aws-file-processing");
    expect(entry).toBeDefined();
    expect(entry.source).toBe("./plugins/aws-file-processing");
  });

  it("names AWS, not Azure, in what a user reads before installing", () => {
    // The description and the long description are the only text shown before
    // anything runs. A port that leaves them naming the old cloud is a plugin
    // that tells its user the wrong thing about where their documents go.
    const m = manifest();
    const prose = [m.description, m.interface?.longDescription ?? "",
                   m.interface?.shortDescription ?? ""].join(" ");
    expect(prose).toMatch(/S3|AWS/);
    expect(prose).not.toMatch(/Azure Blob|Azurite/);
  });
});

describe("the workspace plane is declared", () => {
  it("ships the skill where the manifest says skills live", () => {
    // `plugin.json` points at a DIRECTORY — `"skills": "./skills/"` — so there
    // is no array to register a name in; a skill is discovered by its folder.
    expect(manifest().skills).toBe("./skills/");
    expect(existsSync(resolve(pluginDir, "skills/scyne/SKILL.md"))).toBe(true);
  });

  it("the SKILL.md describes BOTH planes, since one skill covers both", () => {
    const md = readFileSync(resolve(pluginDir, "skills/scyne/SKILL.md"), "utf8");
    expect(md.startsWith("---")).toBe(true);
    expect(md).toMatch(/^name: scyne$/m);
    // The description is the only thing matched on when deciding to load it, so
    // a merged skill whose description covers only one plane is a merged skill
    // that never fires for the other.
    const desc = /^description: (.+)$/m.exec(md)![1];
    expect(desc).toMatch(/pipeline|stage/i);
    expect(desc).toMatch(/large|PDF|document/i);
  });

  it("the manifest describes both planes, not only the file one", () => {
    expect(manifest().interface.longDescription).toMatch(/workspace|pipeline|stage/i);
  });

  it("stack.sh knows how to start the workspace server", () => {
    const sh = readFileSync(resolve(pluginDir, "scripts/stack.sh"), "utf8");
    expect(sh).toMatch(/src\/workspace\/server\.ts/);
    expect(sh).toMatch(/WORKSPACE_PORT/);
  });

  it("the README names the token every workspace tool needs", () => {
    const readme = readFileSync(resolve(pluginDir, "README.md"), "utf8");
    expect(readme).toMatch(/SCYNE_ORCH_TOKEN/);
    expect(readme).toMatch(/8081/);
  });
});

describe("the /scyne command and skill", () => {
  const skillPath = resolve(pluginDir, "skills", "scyne", "SKILL.md");

  it("ships inside the PLUGIN, so it travels with an install", () => {
    // Not `<repo>/.claude/skills/`. That works — it is where this was first
    // proved — but it is project-scoped: install the plugin anywhere else and
    // `/scyne` would simply not exist. A skill under the plugin ships with it.
    expect(existsSync(skillPath)).toBe(true);
  });

  it("provides BOTH a slash command and a skill", () => {
    // The Codex build had only a skill, because Codex removed custom slash
    // commands in 0.117.0. Claude Code has both mechanisms, so this ships both:
    // the command for somebody who types it, the skill for the far more common
    // case where somebody just mentions a large PDF.
    expect(existsSync(resolve(pluginDir, "commands/scyne.md"))).toBe(true);
    expect(existsSync(skillPath)).toBe(true);
  });

  it("the command delegates to the skill rather than restating it", () => {
    // Two copies of the verb table is two things to keep in step, and the one
    // that drifts is always the one nobody is looking at.
    const cmd = readFileSync(resolve(pluginDir, "commands/scyne.md"), "utf8");
    expect(cmd).toMatch(/skills\/scyne\/SKILL\.md/);
    expect(cmd).toMatch(/\$ARGUMENTS/);
    // Frontmatter, so the command shows a description and a hint in the picker.
    expect(cmd.startsWith("---\n")).toBe(true);
    expect(cmd).toMatch(/^description: .{40,}/m);
  });

  it("is invoked with /, and the heading says so", () => {
    // The heading is what a reader copies.
    const body = readFileSync(skillPath, "utf8");
    expect(body.split("\n").find((l) => l.startsWith("# "))).toBe("# /scyne");
  });

  it("carries frontmatter it can be indexed by", () => {
    const body = readFileSync(skillPath, "utf8");
    expect(body.startsWith("---\n")).toBe(true);
    expect(body).toMatch(/^name: scyne$/m);
    expect(body).toMatch(/^description: .{60,}/m);
  });

  it("covers the verbs the client's brief shows", () => {
    const body = readFileSync(skillPath, "utf8");
    for (const verb of ["use", "run", "status", "gate approve", "spend"]) {
      expect(body, verb).toContain(`\`${verb}`);
    }
  });

  it("routes upload through the large-file path, not the in-memory one", () => {
    const body = readFileSync(skillPath, "utf8");
    expect(body).toContain("ingest_document");
    // The plugin's single hardest rule. Phrasing may change; the prohibition
    // may not.
    expect(body).toMatch(/never read a document yourself/i);
  });

  it("refuses to approve a gate on the user's behalf", () => {
    // Approving publishes a wiki page and a client's backlog.
    const body = readFileSync(skillPath, "utf8");
    expect(body).toMatch(/never approve on the person's behalf/i);
  });

  it("is the ONLY skill — one /scyne, not three", () => {
    // Was three: file plane, workspace plane and a verb table duplicating the
    // second. The first two were genuinely distinct; the third was duplication.
    // Merged so there is a single thing to invoke and a single place the
    // guidance lives.
    const dirs = readdirSync(resolve(pluginDir, "skills"), { withFileTypes: true })
      .filter((d) => d.isDirectory()).map((d) => d.name);
    expect(dirs).toEqual(["scyne"]);
  });
});
