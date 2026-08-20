// How a non-Claude agent is told who it is and what method to follow.
//
// Claude Code discovers `.claude/skills/<slug>/SKILL.md` for itself. Nothing
// else can — not the loop-driven providers, not Codex CLI — so the SKILL.md is
// read here and put in the system prompt. The skill files themselves stay
// provider-neutral markdown and are never touched.
//
// Shared rather than duplicated per adapter so that a change to how a skill is
// framed reaches every provider that needs the framing at once.

import { readFile } from "node:fs/promises";
import { skillFilePath } from "./skills.js";

/**
 * Read the SKILL.md an agent step names, so it can be put in the system
 * prompt. A missing skill is fatal and says so in the same words Claude Code
 * uses — `Unknown skill: <slug>` is what every existing runbook, and this
 * repository's own troubleshooting table, tells someone to look for.
 */
export async function loadSkill(installRoot: string, skillsDir: string, name: string): Promise<string> {
  const path = skillFilePath(installRoot, skillsDir, name);
  if (!path) throw new Error(`Unknown skill: ${name}`);
  try {
    return await readFile(path, "utf8");
  } catch {
    throw new Error(`Unknown skill: ${name} (no SKILL.md at ${path})`);
  }
}

export function buildSystemPrompt(bundle: string, skill: { name: string; body: string } | null): string {
  const parts = [bundle.trim()];
  if (skill) {
    parts.push(
      ``,
      `# Skill: ${skill.name}`,
      ``,
      `The following is the method you must follow for this task. It is not`,
      `background reading — it defines the outputs you produce and their shape.`,
      ``,
      skill.body.trim());
  }
  parts.push(
    ``,
    `# Working rules`,
    ``,
    `- You are working inside a project directory. Every path you use is`,
    `  relative to it; paths outside it are refused.`,
    `- Use the tools to read and write files. Describing a file you have not`,
    `  written does not create it.`,
    `- Finish by writing the files the skill specifies, then stop and briefly`,
    `  summarise what you wrote.`,
    `- Do not call any API and do not change any issue status — the`,
    `  orchestrator owns all of that.`);
  return parts.filter(s => s !== undefined).join("\n");
}
