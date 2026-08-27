import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildWorkspaceServer } from "../src/workspace/mcp.js";
import { buildMcpServer } from "../src/orchestrator/mcp.js";
import { loadConfig } from "../src/shared/config.js";

/**
 * The reported failure: asked to "list my projects", the model answered from
 * the shell instead of calling `list_projects`.
 *
 * The cause was that every piece of routing lived in the SKILL, and a skill
 * only loads when the client judges it relevant — which for that phrasing it
 * did not. So these tests guard the two surfaces that are present WHATEVER the
 * client decides about the skill: the server `instructions` (delivered with
 * the tool list at initialize) and the tool descriptions themselves.
 *
 * They assert routing rather than prose. A description may be rewritten
 * freely; it may not stop naming the question it answers.
 */

const cfg = () => loadConfig({});
const wsInstructions = () =>
  ((buildWorkspaceServer({ cfg: cfg() }) as any).server?._instructions
    ?? (buildWorkspaceServer({ cfg: cfg() }) as any)._instructions) as string;
const filePlaneInstructions = () =>
  ((buildMcpServer({ cfg: cfg(), storage: {} as any }) as any).server?._instructions
    ?? (buildMcpServer({ cfg: cfg(), storage: {} as any }) as any)._instructions) as string;
const descriptionOf = (name: string): string => {
  const tools = (buildWorkspaceServer({ cfg: cfg() }) as any)._registeredTools ?? {};
  return tools[name]?.description ?? "";
};

const skill = readFileSync(resolve(
  dirname(fileURLToPath(import.meta.url)), "../skills/scyne/SKILL.md"), "utf8");

describe("server instructions — the only guidance that is always present", () => {
  it("the workspace plane declares them at all", () => {
    // Without this the tool list arrives with no guidance whatsoever, and the
    // routing exists only in a skill that may never load.
    expect(wsInstructions()).toBeTruthy();
  });

  it("the file plane declares them too, carrying the never-read rule", () => {
    const i = filePlaneInstructions();
    expect(i).toBeTruthy();
    expect(i.toLowerCase()).toContain("never read");
  });

  it("routes every phrasing from the reported failure to a named tool", () => {
    const i = wsInstructions();
    for (const [phrase, tool] of [
      ["list my projects", "list_projects"],
      ["create a project", "create_project"],
      ["use project", "list_projects"],
      ["what features", "list_features"],
      ["what documents", "list_documents"],
      ["run extract", "extract_status"],
      ["is extract done", "extract_status"],
      ["what can I run", "stages"],
      ["issues", "list_issues"],
    ] as const) {
      expect(i, `no route for "${phrase}"`).toContain(phrase);
      expect(i, `"${phrase}" names no tool`).toContain(tool);
    }
  });

  it("forbids answering a workspace question from the local machine", () => {
    // The whole point. `ls` on an end user's laptop reports their own folders
    // as Scyne projects — a wrong answer, delivered confidently.
    const i = wsInstructions();
    expect(i).toMatch(/\bls\b/);
    expect(i.toLowerCase()).toContain("filesystem");
    expect(i.toLowerCase()).toMatch(/not (in|the caller)|never/);
  });

  it("says what to do when the service is down, instead of falling back", () => {
    // An outage that degrades to a filesystem guess is worse than an outage.
    expect(wsInstructions().toLowerCase()).toContain("unreachable");
  });

  it("scopes the prohibition to workspace questions, not all shell use", () => {
    // A blanket "never use the shell" would be wrong for a coding agent and
    // would simply be ignored, taking the rest of the rule with it.
    expect(wsInstructions()).not.toMatch(/never use (the )?(shell|bash)/i);
  });
});

describe("tool descriptions — self-sufficient without the skill", () => {
  it("list_projects names the question it answers", () => {
    const d = descriptionOf("list_projects");
    expect(d.toLowerCase()).toContain("list my projects");
    // It was four words ("Every project on the workspace.") and lost every
    // time to a fully-loaded Bash tool sitting next to it.
    expect(d.length).toBeGreaterThan(120);
  });

  it("list_features and issue_status do too", () => {
    expect(descriptionOf("list_features").length).toBeGreaterThan(120);
    expect(descriptionOf("issue_status").toLowerCase()).toContain("status of");
  });

  it("keeps 'run extract' pointed at status, not at start_stage", () => {
    // Extraction begins by itself on upload. A model that reads "run" as a job
    // to start burns an agent run per document to re-do finished work.
    // Asserted as MEANING, not as a chosen word: the description is free to
    // say "starts by itself" or "automatic", but it must not stop saying that
    // there is nothing to start.
    const d = descriptionOf("extract_status").toLowerCase();
    expect(d).toMatch(/starts by itself|automatic/);
    expect(d).toMatch(/no step to run|nothing to run|there is no/);
    expect(wsInstructions().toLowerCase()).toMatch(/automatic|starts by itself/);
  });
});

describe("SKILL.md — the second surface, for when it does load", () => {
  it("carries the workspace routing rule before the verb table", () => {
    const rule = skill.indexOf("The second rule");
    expect(rule).toBeGreaterThan(-1);
    expect(rule).toBeLessThan(skill.indexOf("## Verbs"));
  });

  it("has a verb for listing projects and features", () => {
    expect(skill).toMatch(/\| `projects` \|/);
    expect(skill).toMatch(/\| `features \[project\]` \|/);
  });

  it("fires on the plain phrasings, not only on /scyne and PDFs", () => {
    const d = skill.split("\n").find((l) => l.startsWith("description: ")) ?? "";
    for (const t of ["list projects", "create a project", "run extract", "what documents are in"]) {
      expect(d, t).toContain(t);
    }
  });
});
