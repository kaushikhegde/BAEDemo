import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, readFileSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listSkills, skillFilePath } from "../src/core/skills.js";
import type { WorkflowDef } from "../src/config.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "orch-skills-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const skill = (name: string, body: string): void => {
  mkdirSync(join(dir, "skills", name), { recursive: true });
  writeFileSync(join(dir, "skills", name, "SKILL.md"), body);
};

const wf = (key: string, assignee: string, steps: WorkflowDef["steps"]): WorkflowDef =>
  ({ key, label: key, assignee, steps });

describe("listSkills", () => {
  it("derives who invokes a skill from the workflows, not from a declaration", () => {
    skill("salesforce-data-modeler", "---\ndescription: Design a data model.\n---\n# Data modeller\n");
    const rows = listSkills(dir, "skills", [
      wf("datamodel", "dataModeler", [{ type: "agent", phase: "generate", skill: "salesforce-data-modeler" }]),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].agents).toEqual(["dataModeler"]);
    expect(rows[0].workflows).toEqual(["datamodel"]);
    expect(rows[0].status).toBe("ok");
    expect(rows[0].summary).toBe("Design a data model.");
  });

  it("credits the STEP's agent over the workflow assignee, as the engine does", () => {
    // `step.agent ?? wf.assignee` is the engine's own resolution. A skills view
    // that used the assignee unconditionally would name the wrong person for
    // every step a workflow delegates.
    skill("publisher", "# Publish\n");
    const rows = listSkills(dir, "skills", [
      wf("datamodel", "dataModeler", [
        { type: "agent", phase: "publish", agent: "solutionArchitect", skill: "publisher" },
      ]),
    ]);
    expect(rows[0].agents).toEqual(["solutionArchitect"]);
  });

  it("collects every agent and workflow that share one skill, without duplicates", () => {
    skill("shared", "# Shared\n");
    const rows = listSkills(dir, "skills", [
      wf("a", "ba", [{ type: "agent", phase: "generate", skill: "shared" },
                     { type: "agent", phase: "revise", skill: "shared" }]),
      wf("b", "qaArchitect", [{ type: "agent", phase: "generate", skill: "shared" }]),
    ]);
    expect(rows[0].agents).toEqual(["ba", "qaArchitect"]);
    expect(rows[0].workflows).toEqual(["a", "b"]);
  });

  it("flags a skill a workflow invokes but that is not on disk", () => {
    // The `Unknown skill: <slug>` failure, visible BEFORE it costs a run.
    const rows = listSkills(dir, "skills", [
      wf("qa", "qaArchitect", [{ type: "agent", phase: "generate", skill: "not-there" }]),
    ]);
    expect(rows[0].status).toBe("missing");
    expect(rows[0].path).toBe(null);
    expect(rows[0].agents).toEqual(["qaArchitect"]);
  });

  it("flags a skill on disk that nothing invokes", () => {
    skill("leftover", "# Leftover\n");
    expect(listSkills(dir, "skills", [])[0].status).toBe("unused");
  });

  it("sorts problems first: missing, then unused, then ok", () => {
    skill("zz-fine", "# Fine\n");
    skill("aa-orphan", "# Orphan\n");
    const rows = listSkills(dir, "skills", [
      wf("w", "ba", [{ type: "agent", phase: "generate", skill: "zz-fine" },
                     { type: "agent", phase: "revise", skill: "mm-gone" }]),
    ]);
    expect(rows.map(r => r.name)).toEqual(["mm-gone", "aa-orphan", "zz-fine"]);
  });

  it("sees a symlinked skill directory, which is how they are usually published", () => {
    mkdirSync(join(dir, "real", "linked"), { recursive: true });
    writeFileSync(join(dir, "real", "linked", "SKILL.md"), "# Linked\n");
    mkdirSync(join(dir, "skills"), { recursive: true });
    symlinkSync(join(dir, "real", "linked"), join(dir, "skills", "linked"));
    const rows = listSkills(dir, "skills", []);
    expect(rows.map(r => r.name)).toEqual(["linked"]);
    expect(rows[0].summary).toBe("Linked");
  });

  it("returns only referenced skills when no skillsDir is configured", () => {
    const rows = listSkills(dir, undefined, [
      wf("w", "ba", [{ type: "agent", phase: "generate", skill: "somewhere" }]),
    ]);
    expect(rows[0].status).toBe("missing");
  });

  it("ignores dotfiles and loose files in the skills directory", () => {
    mkdirSync(join(dir, "skills"), { recursive: true });
    writeFileSync(join(dir, "skills", "README.md"), "not a skill");
    mkdirSync(join(dir, "skills", ".git"), { recursive: true });
    expect(listSkills(dir, "skills", [])).toEqual([]);
  });
});

describe("skillFilePath", () => {
  it("resolves a name to its SKILL.md", () => {
    expect(skillFilePath("/w", "skills", "ba")).toBe("/w/skills/ba/SKILL.md");
  });

  it("refuses a name that escapes the skills directory", () => {
    // `name` arrives from a URL path segment and the PUT handler writes to
    // whatever this returns.
    expect(skillFilePath("/w", "skills", "../../etc")).toBe(null);
    expect(skillFilePath("/w", "skills", "..")).toBe(null);
  });
});

describe("writing a skill", () => {
  it("must not replace a symlink with a regular file", async () => {
    // A rename onto a symlink severs it from the source tree, so the team keeps
    // editing a file nothing reads. The router resolves realpath first; this
    // pins the property that matters.
    const { realpathSync, renameSync, writeFileSync: wf2 } = await import("node:fs");
    mkdirSync(join(dir, "real", "s"), { recursive: true });
    writeFileSync(join(dir, "real", "s", "SKILL.md"), "original\n");
    mkdirSync(join(dir, "skills"), { recursive: true });
    symlinkSync(join(dir, "real", "s"), join(dir, "skills", "s"));

    const abs = skillFilePath(dir, "skills", "s")!;
    const target = realpathSync(abs);
    const tmp = `${target}.tmp`;
    wf2(tmp, "edited\n");
    renameSync(tmp, target);

    expect(readFileSync(join(dir, "real", "s", "SKILL.md"), "utf8")).toBe("edited\n");
    expect(lstatSync(join(dir, "skills", "s")).isSymbolicLink()).toBe(true);
  });
});
