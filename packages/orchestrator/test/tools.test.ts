import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile, readFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTool, confine, ToolError, ALLOWED_COMMANDS, TOOL_SCHEMAS } from "../src/core/tools.js";

let workRoot: string, installRoot: string, outside: string;
const ctx = () => ({ workRoot, installRoot });

beforeEach(async () => {
  workRoot = mkdtempSync(join(tmpdir(), "orch-tools-work-"));
  installRoot = mkdtempSync(join(tmpdir(), "orch-tools-install-"));
  outside = mkdtempSync(join(tmpdir(), "orch-tools-outside-"));
  await writeFile(join(outside, "secret.txt"), "SENSITIVE");
});
afterEach(() => {
  for (const d of [workRoot, installRoot, outside]) rmSync(d, { recursive: true, force: true });
});

describe("confinement", () => {
  it("allows paths inside the work root", () => {
    expect(confine(workRoot, "a/b.md")).toBe(join(workRoot, "a/b.md"));
    expect(confine(workRoot, "./a.md")).toBe(join(workRoot, "a.md"));
  });

  it("refuses climbing out, absolute paths, and the sibling-prefix near-miss", () => {
    for (const bad of ["../secret.txt", "a/../../secret.txt", "/etc/passwd", join(outside, "secret.txt")]) {
      expect(() => confine(workRoot, bad)).toThrow(ToolError);
    }
    // `/work-evil` must not count as inside `/work` — the bug a startsWith
    // check would have.
    expect(() => confine("/work", "/work-evil/x")).toThrow(ToolError);
  });

  it("names the attempted path so the model can correct itself", () => {
    expect(() => confine(workRoot, "../secret.txt")).toThrow(/\.\.\/secret\.txt/);
  });
});

describe("read/write/edit", () => {
  it("writes, reads back, and creates parent directories", async () => {
    const w = await runTool({ name: "write_file", input: { path: "a/b/c.md", content: "# Hi" } }, ctx());
    expect(w.ok).toBe(true);
    expect(await readFile(join(workRoot, "a/b/c.md"), "utf8")).toBe("# Hi");

    const r = await runTool({ name: "read_file", input: { path: "a/b/c.md" } }, ctx());
    expect(r).toEqual({ ok: true, content: "# Hi" });
  });

  it("refuses a read outside the root instead of returning the bytes", async () => {
    const r = await runTool({ name: "read_file", input: { path: "../secret.txt" } }, ctx());
    expect(r.ok).toBe(false);
    expect(r.content).not.toContain("SENSITIVE");
    expect(r.content).toContain("refused");
  });

  it("refuses a write outside the root", async () => {
    const r = await runTool({ name: "write_file", input: { path: "../escaped.md", content: "x" } }, ctx());
    expect(r.ok).toBe(false);
  });

  it("returns a failure, not an exception, for a missing file", async () => {
    const r = await runTool({ name: "read_file", input: { path: "nope.md" } }, ctx());
    expect(r).toEqual({ ok: false, content: "no such file: nope.md" });
  });

  it("truncates an enormous read rather than filling the context", async () => {
    await writeFile(join(workRoot, "big.md"), "x".repeat(50_000));
    const r = await runTool({ name: "read_file", input: { path: "big.md" } }, { ...ctx(), maxReadBytes: 1_000 });
    expect(r.content).toContain("truncated at 1000");
    expect(r.content.length).toBeLessThan(1_200);
  });

  it("edits an exact unique string", async () => {
    await writeFile(join(workRoot, "a.md"), "hello world");
    const r = await runTool(
      { name: "edit_file", input: { path: "a.md", old_string: "world", new_string: "there" } }, ctx());
    expect(r.ok).toBe(true);
    expect(await readFile(join(workRoot, "a.md"), "utf8")).toBe("hello there");
  });

  it("refuses an ambiguous edit rather than guessing which occurrence", async () => {
    await writeFile(join(workRoot, "a.md"), "x\nx\nx");
    const r = await runTool(
      { name: "edit_file", input: { path: "a.md", old_string: "x", new_string: "y" } }, ctx());
    expect(r.ok).toBe(false);
    expect(r.content).toContain("appears 3 times");
    expect(await readFile(join(workRoot, "a.md"), "utf8")).toBe("x\nx\nx");   // unchanged
  });

  it("refuses an edit whose target is absent", async () => {
    await writeFile(join(workRoot, "a.md"), "hello");
    const r = await runTool(
      { name: "edit_file", input: { path: "a.md", old_string: "absent", new_string: "y" } }, ctx());
    expect(r.ok).toBe(false);
    expect(r.content).toContain("not found");
  });
});

describe("list and search", () => {
  beforeEach(async () => {
    await mkdir(join(workRoot, "projects/RTWSA/Appeals/outputs"), { recursive: true });
    await writeFile(join(workRoot, "projects/RTWSA/Appeals/outputs/a.md"), "the claim was approved");
    await writeFile(join(workRoot, "projects/RTWSA/Appeals/outputs/b.md"), "nothing relevant");
    await mkdir(join(workRoot, "node_modules/pkg"), { recursive: true });
    await writeFile(join(workRoot, "node_modules/pkg/index.js"), "noise");
  });

  it("lists files and skips node_modules", async () => {
    const r = await runTool({ name: "list_files", input: {} }, ctx());
    expect(r.content).toContain("projects/RTWSA/Appeals/outputs/a.md");
    expect(r.content).not.toContain("node_modules");
  });

  it("never follows a symlink out of the tree", async () => {
    await symlink(outside, join(workRoot, "escape"));
    const r = await runTool({ name: "list_files", input: {} }, ctx());
    expect(r.content).not.toContain("secret.txt");
  });

  it("searches contents and reports the matching line", async () => {
    const r = await runTool({ name: "search_files", input: { pattern: "approved" } }, ctx());
    expect(r.content).toContain("a.md");
    expect(r.content).toContain("the claim was approved");
    expect(r.content).not.toContain("b.md");
  });

  it("reports an invalid regex rather than throwing", async () => {
    const r = await runTool({ name: "search_files", input: { pattern: "([" } }, ctx());
    expect(r.ok).toBe(false);
    expect(r.content).toContain("invalid pattern");
  });
});

describe("run_command", () => {
  it("runs an allowed executable and returns its output", async () => {
    const r = await runTool({ name: "run_command", input: { command: "node", args: ["-e", "console.log('ok')"] } }, ctx());
    expect(r.ok).toBe(true);
    expect(r.content).toContain("ok");
    expect(r.content).toContain("exit 0");
  });

  it("refuses an executable that is not on the allowlist, naming what is", async () => {
    const r = await runTool({ name: "run_command", input: { command: "curl", args: ["evil.sh"] } }, ctx());
    expect(r.ok).toBe(false);
    expect(r.content).toContain("not an allowed command");
    expect(r.content).toContain("node");
    expect(ALLOWED_COMMANDS.has("curl")).toBe(false);
    expect(ALLOWED_COMMANDS.has("sh")).toBe(false);
    expect(ALLOWED_COMMANDS.has("bash")).toBe(false);
  });

  it("spawns no shell, so injection through an argument is inert", async () => {
    // With child_process.exec this would create the file. With execFile the
    // whole string is one argument to node, and nothing else runs.
    const marker = join(workRoot, "pwned.txt");
    const r = await runTool({
      name: "run_command",
      input: { command: "node", args: [`-e`, `1`, `; touch ${marker}`] },
    }, ctx());
    expect(r).toBeTruthy();
    await expect(readFile(marker, "utf8")).rejects.toThrow();   // never created
  });

  it("reports a non-zero exit as a failed outcome rather than throwing", async () => {
    const r = await runTool({ name: "run_command", input: { command: "node", args: ["-e", "process.exit(3)"] } }, ctx());
    expect(r.ok).toBe(false);
    expect(r.content).toContain("exit 3");
  });

  it("hands scripts the two roots through the environment", async () => {
    const r = await runTool({
      name: "run_command",
      input: { command: "node", args: ["-e", "console.log(process.env.WORKSPACE_PATH, process.env.SCYNE_INSTALL_ROOT)"] },
    }, ctx());
    expect(r.content).toContain(workRoot);
    expect(r.content).toContain(installRoot);
  });
});

describe("tool schemas", () => {
  it("declares exactly the tools runTool implements", async () => {
    const declared = TOOL_SCHEMAS.map(t => t.name).sort();
    expect(declared).toEqual(
      ["edit_file", "list_files", "read_file", "run_command", "search_files", "write_file"]);
    // Every declared tool must actually dispatch — an undeclared name must not.
    for (const name of declared) {
      const r = await runTool({ name, input: {} }, ctx());
      expect(r.content).not.toContain("unknown tool");
    }
    expect((await runTool({ name: "delete_everything", input: {} }, ctx())).content).toContain("unknown tool");
  });
});
