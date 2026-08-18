// Console edits that outlive a restart.
//
// The org chart reconciles from the consumer's config file on EVERY boot
// (`createOrchestrator` upserts every agent it declares). That is decision 8 —
// files are the source of truth, so config travels with the repo — and it has
// one consequence that would otherwise make the console a liar: an agent's
// model changed through the API would be silently reverted by the next
// `npm run dev`.
//
// So the console does not write the config file. It writes an overlay here, and
// the overlay is merged over the file's org at boot, overrides winning. The
// committed file stays the readable default; the overlay records what an
// operator changed at runtime, and can be deleted to get back to it.
//
// A generated `.ts` file would be the alternative. Rewriting TypeScript that
// carries comments and imports, from a web form, is a worse failure mode than
// this one.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AgentSpec } from "./repo.js";

export interface Overrides {
  /** Agent key → the fields the console changed. Merged over the config's entry. */
  agents?: Record<string, Partial<AgentSpec>>;
  /** Agents added through the console, which have no entry in the config file. */
  added?: AgentSpec[];
  /** Keys disabled through the console. They stay in the database, out of the org. */
  removed?: string[];
}

export const overridesPath = (workspace: string): string =>
  join(workspace, ".orchestrator", "overrides.json");

export async function loadOverrides(workspace: string): Promise<Overrides> {
  try {
    return JSON.parse(await readFile(overridesPath(workspace), "utf8")) as Overrides;
  } catch {
    // Absent is the normal case — a workspace nobody has customised.
    return {};
  }
}

export async function saveOverrides(workspace: string, o: Overrides): Promise<void> {
  const p = overridesPath(workspace);
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, JSON.stringify(o, null, 2) + "\n");
}

/**
 * Merge an overlay over the config's org. Order is deliberate: config entries
 * first (so the file's ordering still drives the chart), then anything the
 * console added, then removals applied last — a key can be added and later
 * removed without leaving a ghost.
 */
export function applyOverrides(org: AgentSpec[], o: Overrides): AgentSpec[] {
  const patched = org.map(a => (o.agents?.[a.key] ? { ...a, ...o.agents[a.key], key: a.key } : a));
  const known = new Set(patched.map(a => a.key));
  const added = (o.added ?? [])
    .filter(a => !known.has(a.key))
    .map(a => (o.agents?.[a.key] ? { ...a, ...o.agents[a.key], key: a.key } : a));
  const removed = new Set(o.removed ?? []);
  return [...patched, ...added].filter(a => !removed.has(a.key));
}

/** Record one agent's changed fields, preserving everything already overridden. */
export function withAgentPatch(o: Overrides, key: string, patch: Partial<AgentSpec>): Overrides {
  return { ...o, agents: { ...(o.agents ?? {}), [key]: { ...(o.agents?.[key] ?? {}), ...patch } } };
}
