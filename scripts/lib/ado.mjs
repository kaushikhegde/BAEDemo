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
  const project = overrides.project || env.ADO_PROJECT;
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

/** Record page identity so a REVISION updates rather than creating a second page. */
export async function recordPublished(file, key, value) {
  if (!file || !key) return;
  const current = await readPublished(file);
  current.ado = { ...(current.ado ?? {}), [key]: value };
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(current, null, 2) + "\n", "utf8");
}
