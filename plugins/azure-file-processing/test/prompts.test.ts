import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildWorkspaceServer } from "../src/workspace/mcp.js";
import { readCommandBody } from "../src/workspace/prompts.js";
import { loadConfig } from "../src/shared/config.js";

const registeredPrompts = (): Record<string, any> => {
  const server = buildWorkspaceServer({ cfg: loadConfig({}) });
  return (server as any)._registeredPrompts ?? {};
};

describe("the scyne MCP prompt (not how Codex surfaces it — see skills/scyne)", () => {
  it("registers /scyne as a prompt", () => {
    // Kept for MCP clients that surface prompts. Codex is NOT one of them:
    // it removed custom slash commands in 0.117.0 and invokes skills with `$`,
    // so `$scyne` comes from skills/scyne/SKILL.md. This serves the same file,
    // so the two cannot drift.
    expect(Object.keys(registeredPrompts())).toContain("scyne");
  });

  it("takes a free-form argument, so `/scyne run datamodel` reads as written", () => {
    const p = registeredPrompts()["scyne"];
    // An enum of verbs would force `$scyne --verb run --stage datamodel`.
    // The SDK wraps the declared shape into a Zod object, so the field names
    // live on `.shape` — Object.keys() on the wrapper returns Zod's own methods.
    expect(p.argsSchema).toBeDefined();
    expect(Object.keys(p.argsSchema.shape)).toEqual(["args"]);
    // Optional: `/scyne` on its own is a valid invocation and reports state.
    expect(p.argsSchema.shape.args.isOptional()).toBe(true);
  });

  it("names real verbs in its description, since that is all the composer shows", () => {
    const d = registeredPrompts()["scyne"].description as string;
    for (const verb of ["run", "status", "gate approve", "spend"]) {
      expect(d, verb).toContain(verb);
    }
  });
});

describe("the command body", () => {
  it("IS the skill file Codex reads, so the two cannot drift", () => {
    const body = readCommandBody();
    expect(body).toMatch(/^name: scyne$/m);
    expect(body).toContain("# $scyne");
    expect(body).toContain("ingest_document");
  });

  it("degrades to a usable message when the file is missing", () => {
    // A missing body must not take the command down with it.
    const dir = mkdtempSync(join(tmpdir(), "afp-cmd-"));
    try {
      const body = readCommandBody(join(dir, "nope.md"));
      expect(body).toMatch(/could not be read/i);
      // Still points at something actionable rather than a bare error.
      expect(body).toContain("stages");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prefers a real file over the fallback", () => {
    const dir = mkdtempSync(join(tmpdir(), "afp-cmd-"));
    try {
      const f = join(dir, "scyne.md");
      writeFileSync(f, "# $scyne\n\nhello\n");
      expect(readCommandBody(f)).toContain("hello");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
