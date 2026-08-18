// Which skills exist, and which agent invokes each one.
//
// The mapping is DERIVED, not declared. Every `agent` step may name a `skill`,
// and the agent running that step is `step.agent ?? workflow.assignee` — the
// same resolution the engine performs — so walking `config.workflows` answers
// "who uses this skill" exactly, and cannot drift from what actually runs. A
// hand-kept table would be wrong the first time a stage changed owner.
//
// Cross-referencing the derived usage against what is on disk is the point:
// the two ways this goes wrong in practice are a workflow naming a skill that
// is not there (every run of that stage dies with `Unknown skill: <slug>`,
// after the model has spawned) and a skill nobody invokes (dead weight that
// still reads like part of the pipeline).

import { readdirSync, statSync, readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { WorkflowDef } from "../config.js";

export interface SkillUsage {
  /** Directory name — the string an agent step invokes it by. */
  name: string;
  /** Workspace-relative path to its SKILL.md, or null when only referenced. */
  path: string | null;
  bytes: number | null;
  lines: number | null;
  /** First heading or frontmatter description, for a one-line summary. */
  summary: string | null;
  /** Agent keys that invoke it, derived from the workflows. */
  agents: string[];
  /** Workflow keys whose steps invoke it. */
  workflows: string[];
  /**
   * `ok`        — on disk and invoked by at least one workflow
   * `missing`   — a workflow invokes it, but there is no SKILL.md. Every run of
   *               that stage will fail with `Unknown skill`.
   * `unused`    — on disk, invoked by nothing.
   */
  status: "ok" | "missing" | "unused";
}

/** Resolve a skill name to its SKILL.md, or null if the name escapes the dir. */
export function skillFilePath(workspace: string, skillsDir: string, name: string): string | null {
  // `name` reaches here from a URL path segment, and the PUT handler writes to
  // whatever comes back. Confining it to the skills directory is the guard.
  const root = resolve(workspace, skillsDir);
  const abs = resolve(root, name, "SKILL.md");
  return abs.startsWith(root + sep) ? abs : null;
}

/** A one-line summary: the frontmatter `description`, else the first heading. */
function summarise(body: string): string | null {
  const fm = body.match(/^---\n([\s\S]*?)\n---/);
  if (fm) {
    const d = fm[1].match(/^description:\s*(.+)$/m);
    // A folded YAML description runs on over several lines; one line is all a
    // table row can show, and the full text is one click away in the editor.
    if (d) return d[1].trim().replace(/^["']|["']$/g, "").slice(0, 300);
  }
  const h = body.match(/^#\s+(.+)$/m);
  return h ? h[1].trim() : null;
}

/**
 * Every skill the workflows invoke, plus every skill sitting in `skillsDir`,
 * merged and cross-referenced. Sorted so problems surface first: `missing`,
 * then `unused`, then the rest alphabetically.
 */
export function listSkills(
  workspace: string, skillsDir: string | undefined, workflows: WorkflowDef[],
): SkillUsage[] {
  const rows = new Map<string, SkillUsage>();
  const row = (name: string): SkillUsage => {
    let r = rows.get(name);
    if (!r) {
      r = { name, path: null, bytes: null, lines: null, summary: null,
            agents: [], workflows: [], status: "unused" };
      rows.set(name, r);
    }
    return r;
  };

  for (const wf of workflows) {
    for (const step of wf.steps ?? []) {
      if (step.type !== "agent" || !step.skill) continue;
      const r = row(step.skill);
      const agent = step.agent ?? wf.assignee;
      if (agent && !r.agents.includes(agent)) r.agents.push(agent);
      if (!r.workflows.includes(wf.key)) r.workflows.push(wf.key);
    }
  }

  if (skillsDir) {
    const root = resolve(workspace, skillsDir);
    let entries: string[] = [];
    try {
      // `withFileTypes` would report a symlinked skill as a link rather than a
      // directory, and this repo's own skills are routinely symlinks.
      entries = readdirSync(root);
    } catch { entries = []; }
    for (const name of entries) {
      if (name.startsWith(".")) continue;
      const file = join(root, name, "SKILL.md");
      let body: string;
      try {
        if (!statSync(join(root, name)).isDirectory()) continue;
        body = readFileSync(file, "utf8");
      } catch { continue; }
      const r = row(name);
      r.path = [skillsDir, name, "SKILL.md"].join("/");
      r.bytes = Buffer.byteLength(body, "utf8");
      r.lines = body.split("\n").length;
      r.summary = summarise(body);
    }
  }

  for (const r of rows.values()) {
    r.status = r.path === null ? "missing" : (r.workflows.length ? "ok" : "unused");
  }

  const rank = { missing: 0, unused: 1, ok: 2 } as const;
  return [...rows.values()].sort((a, b) =>
    rank[a.status] - rank[b.status] || a.name.localeCompare(b.name));
}
