/**
 * The pieces both publishing back ends need, and the switch between them.
 *
 * There are two: Azure DevOps (wiki pages + work items) and Atlassian
 * (Confluence pages + Jira issues). Both are live. `scripts/lib/ado.mjs` and
 * `scripts/lib/atlassian.mjs` are the two adapters; this module holds what is
 * genuinely common — argument parsing, `.published.json` access, and the rule
 * that decides which adapter a given project publishes through.
 *
 * `ado.mjs` deliberately keeps its own copies of `parseArgs` and
 * `readPublished` rather than importing them from here. It is the older,
 * tested path and rewriting it to reach into a new module buys nothing but a
 * chance to break it; the duplication is twelve lines and both are pure.
 */

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { INSTALL_ROOT } from "./roots.mjs";

export function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

/** The workspace-root `.env`, parsed. Every process in this stack reads that
 *  one file and no other, so credentials live in exactly one place. */
export async function readEnvFile(file = ".env") {
  const out = {};
  let raw = "";
  try { raw = await fs.readFile(path.join(INSTALL_ROOT, file), "utf8"); } catch { return out; }
  for (const line of raw.split("\n")) {
    if (line.trimStart().startsWith("#")) continue;
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

/** `--flag value` and `--flag` (boolean), plus the leading positionals. */
export function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (!tok.startsWith("--")) { positional.push(tok); continue; }
    const name = tok.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) { flags[name] = true; }
    else { flags[name] = next; i++; }
  }
  return { flags, positional };
}

/** Read `.published.json`, or an empty object. */
export async function readPublished(file) {
  try { return JSON.parse(await fs.readFile(file, "utf8")); } catch { return {}; }
}

/** Merge a patch into `.published.json`, preserving everything else in it.
 *  Merged rather than replaced because that file carries BOTH the per-artefact
 *  page identities and the project's publish target, and losing either half
 *  makes every later revision create a second page. */
export async function mergePublished(file, patch) {
  if (!file) return;
  const current = await readPublished(file);
  const next = { ...current };
  for (const [k, v] of Object.entries(patch)) {
    next[k] = v && typeof v === "object" && !Array.isArray(v)
      ? { ...(current[k] ?? {}), ...v }
      : v;
  }
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(next, null, 2) + "\n", "utf8");
}

/** The back ends a project can publish THROUGH. `none` is not one of them —
 *  it is a statement about the installation, handled separately below. */
export const TARGETS = ["atlassian", "ado"];

/** Every accepted `PUBLISH_TARGET` value, including the opt-out. */
export const CONFIGURABLE_TARGETS = [...TARGETS, "none"];

/**
 * Which back end a project publishes through.
 *
 * The order is deliberate and the first rule is the important one:
 *
 *   1. What the PROJECT has already published through. A project carrying an
 *      `adoTarget` in `.published.json` keeps publishing to Azure DevOps even
 *      when the install's default is Atlassian, and vice versa. This is the
 *      same principle `resolvePagePath` already applies to a single page — a
 *      client has links to those documents, and flipping an environment
 *      variable must not silently strand a delivered pack half in one system
 *      and half in another.
 *
 *   2. `PUBLISH_TARGET` in the environment, for a NEW project.
 *
 *   3. Atlassian, the default.
 *
 * An explicit override always wins, so a caller who genuinely wants to move a
 * project can say so.
 *
 * `PUBLISH_TARGET=none` turns publishing off for the installation, and it is
 * deliberately checked AFTER rule 1. A project that has already delivered a
 * pack into Confluence still has a page there and a client with links to it;
 * an operator running `confluence-publish.mjs` by hand against that project is
 * updating a document that exists, and refusing them because a new install
 * default says "we do not publish" would be the environment variable stranding
 * a delivered pack all over again. What `none` does refuse is a FIRST publish —
 * a project with no recorded target, where the only thing naming a destination
 * is the setting that just said there isn't one.
 */
export async function resolvePublishTarget({ publishedFile, env = process.env, override } = {}) {
  if (override) {
    if (!TARGETS.includes(override)) {
      fail(`unknown publish target '${override}' — expected one of ${TARGETS.join(", ")}`);
    }
    return override;
  }
  if (publishedFile) {
    const p = await readPublished(publishedFile);
    if (p?.atlassianTarget?.space) return "atlassian";
    if (p?.adoTarget?.project) return "ado";
  }
  const configured = env.PUBLISH_TARGET;
  if (configured) {
    if (!CONFIGURABLE_TARGETS.includes(configured)) {
      fail(`PUBLISH_TARGET='${configured}' is not a known target — expected one of ${CONFIGURABLE_TARGETS.join(", ")}`);
    }
    if (configured === "none") {
      fail(
        `publishing is disabled on this installation (PUBLISH_TARGET=none), and ` +
        `this project has no previously published target to fall back on.\n` +
        `  Nothing has been published. The artefacts are on disk and the companion ` +
        `app has them; only the push to a wiki is off.\n` +
        `  To publish, set PUBLISH_TARGET to ${TARGETS.join(" or ")} and restart the orchestrator, ` +
        `or pass --target explicitly to publish this one document.`);
    }
    return configured;
  }
  return "atlassian";
}
