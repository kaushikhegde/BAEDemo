/**
 * Shared Azure DevOps access for the publishing scripts.
 *
 * Auth is a Personal Access Token, Basic, as `":" + PAT` base64-encoded — the
 * form every ADO REST endpoint accepts. The token is read from the workspace
 * root `.env`, the same file the orchestrator config loads, so there is one
 * place for it and it is never inlined into `.mcp.json` (which is committed;
 * a PAT in that file is a PAT in the git history).
 */

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

// Resolved from THIS FILE rather than from process.cwd(): an agent may have
// cd'd anywhere, and a credentials lookup that depends on the working
// directory fails with a message about a path nobody chose.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export const API = "7.1";

export function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

async function readEnvFile(file) {
  const out = {};
  let raw = "";
  try { raw = await fs.readFile(path.join(REPO_ROOT, file), "utf8"); } catch { return out; }
  for (const line of raw.split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

/**
 * Credentials and target, from the environment first and `.env` second.
 *
 * `ADO_PAT` is the documented name; `MCP_TOKEN_FOR_AZURE` is accepted because
 * that is what the install already had, and renaming a working credential
 * buys nothing.
 */
export async function loadAdo(overrides = {}) {
  const env = { ...(await readEnvFile(".env")), ...process.env };
  const org = overrides.org || env.ADO_ORG;
  // No ADO_PROJECT fallback. The project comes from the Scyne project's own
  // `adoTarget` (see `readAdoTarget`) — one installation-wide target is what
  // that replaced, and defaulting to one would misfile a client's document.
  const project = overrides.project || null;
  const pat = env.ADO_PAT || env.MCP_TOKEN_FOR_AZURE;

  if (!pat) {
    fail(
      `No Azure DevOps token.\n` +
      `  Looked for ADO_PAT, then MCP_TOKEN_FOR_AZURE, in the environment and in\n` +
      `  ${path.join(REPO_ROOT, ".env")}.\n` +
      `  Create one at https://dev.azure.com/<org>/_usersSettings/tokens.`);
  }
  if (!org) fail(`No organisation. Pass --org, or set ADO_ORG in .env.`);

  return {
    org, project, pat,
    workItemType: overrides.workItemType || null,
    auth: "Basic " + Buffer.from(`:${pat}`).toString("base64"),
  };
}

/**
 * One REST call, with the failure modes named.
 *
 * A 401 from ADO is almost never "the token is wrong" — it is far more often
 * "the token is fine and lacks the SCOPE for this endpoint", because ADO
 * answers a scope failure with 401 rather than 403. Saying so is the
 * difference between checking one checkbox and regenerating a token that was
 * never the problem.
 */
export async function adoFetch(ado, url, init = {}) {
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: ado.auth,
      Accept: `application/json;api-version=${API}`,
      ...(init.headers ?? {}),
    },
  });

  const text = await res.text();
  if (!res.ok) {
    const scope = res.status === 401
      ? `\n  A 401 from Azure DevOps usually means the token is VALID but lacks the scope\n` +
        `  for this endpoint — it answers a missing scope with 401, not 403. Check the\n` +
        `  token's scopes at https://dev.azure.com/${ado.org}/_usersSettings/tokens.`
      : "";
    // ADO answers an unauthenticated browser request with an HTML sign-in
    // page, so a body that starts with '<' is the sign-in page, not an error
    // document — say that rather than printing a page of markup.
    const body = text.trimStart().startsWith("<")
      ? "(Azure DevOps returned its sign-in page, which is what it does for a request it cannot authenticate)"
      : text.slice(0, 400);
    throw new Error(`${init.method ?? "GET"} ${url}\n  → HTTP ${res.status}. ${body}${scope}`);
  }
  return text ? JSON.parse(text) : null;
}

export const projectPath = (ado) =>
  `https://dev.azure.com/${encodeURIComponent(ado.org)}/${encodeURIComponent(ado.project)}`;

export const orgPath = (ado) => `https://dev.azure.com/${encodeURIComponent(ado.org)}`;

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

/**
 * The Azure DevOps target a Scyne project publishes to.
 *
 * Written once, when the project is created, and read from
 * `projects/<project>/.published.json`. There is deliberately no environment
 * fallback: ONE target for the whole installation is exactly what per-project
 * targets replaced, and quietly falling back to one would publish a client's
 * document into another client's project.
 */
export async function readAdoTarget(publishedFile) {
  if (!publishedFile) return null;
  const target = (await readPublished(publishedFile))?.adoTarget;
  return target && typeof target.project === "string" && target.project ? target : null;
}

/**
 * The path an artefact's page is published at.
 *
 * `template` is where a FIRST publish goes. Once an artefact has been
 * published, its recorded `wikiPath` wins for good — a client has a link to
 * that page, and a change to the template must never silently move it and
 * leave the original orphaned.
 *
 * This is what `.published.json` has always been DESCRIBED as doing ("so a
 * later revision updates that page instead of creating a second one") and did
 * not do: `ado-publish.mjs` imported `readPublished` and then resolved the
 * path from `--path` alone. It was harmless only while the template never
 * changed, and stopped being harmless the moment it did.
 */
export async function resolvePagePath(template, publishedFile, artefactKey) {
  if (!publishedFile || !artefactKey) return template;
  const record = (await readPublished(publishedFile))?.ado?.[artefactKey];
  const recorded = record?.wikiPath;
  // A path that does not start with "/" is not one ADO can address, so it is a
  // corrupt record rather than an instruction — prefer the template.
  return typeof recorded === "string" && recorded.startsWith("/") ? recorded : template;
}

/** Record page identity so a REVISION updates rather than creating a second page. */
export async function recordPublished(file, key, value) {
  if (!file || !key) return;
  const current = await readPublished(file);
  current.ado = { ...(current.ado ?? {}), [key]: value };
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(current, null, 2) + "\n", "utf8");
}

/**
 * Record the Azure DevOps target a project publishes to.
 *
 * The counterpart to `readAdoTarget` above, kept beside it so the two halves of
 * `.published.json` cannot drift on shape. Written by the wizard when a project
 * is created, and by `ensure-ado-project.mts` when a run finds the project
 * missing and creates it — the same record either way, so nothing downstream
 * can tell which produced it.
 *
 * Merged rather than replaced: `.published.json` also carries the per-artefact
 * `ado.<key>` page identities, and losing those would make every later
 * revision create a second page.
 */
export async function recordAdoTarget(file, target) {
  if (!file || !target?.project) return;
  const current = await readPublished(file);
  current.adoTarget = { ...(current.adoTarget ?? {}), ...target };
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(current, null, 2) + "\n", "utf8");
}
