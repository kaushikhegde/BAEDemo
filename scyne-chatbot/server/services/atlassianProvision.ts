// Atlassian provisioning — CREATE the Jira project / Confluence space the MCP can't.
// Runs at the approval step, just before the BA pushes.
//
// Auth, in priority order (no client setup needed for the first one):
//   1. The OAuth login the client ALREADY did for the MCP — token cached in
//      ~/.mcp-auth/. We reuse it as a Bearer token against api.atlassian.com (3LO).
//   2. An explicit API token (Basic auth) if ATLASSIAN_EMAIL + ATLASSIAN_API_TOKEN
//      + ATLASSIAN_SITE_URL are set — useful when the MCP grant lacks create scope.
//
// Failure policy is deliberately SOFT: if we can't authenticate or can't tell
// whether a target exists, we skip and let the BA's verify-and-block be the safety
// net (so a stale token never blocks approvals where the target already exists).
// We only HARD-fail when a target is definitively missing AND creation was rejected.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const SITE = (process.env.ATLASSIAN_SITE_URL || "").replace(/\/$/, "");
const EMAIL = process.env.ATLASSIAN_EMAIL || "";
const TOKEN = process.env.ATLASSIAN_API_TOKEN || "";
const JIRA_TEMPLATE = process.env.ATLASSIAN_JIRA_TEMPLATE_KEY || "com.pyxis.greenhopper.jira:gh-simplified-kanban";
const JIRA_TYPE = process.env.ATLASSIAN_JIRA_PROJECT_TYPE || "software";

const hasApiToken = Boolean(SITE && EMAIL && TOKEN);

/** Newest OAuth access token cached by mcp-remote (the client's MCP login). */
function findMcpAccessToken(): string | null {
  try {
    const root = path.join(os.homedir(), ".mcp-auth");
    const files: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (/tokens?\.json$/.test(e.name)) files.push(p);
      }
    };
    walk(root);
    files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    for (const f of files) {
      try {
        const j = JSON.parse(fs.readFileSync(f, "utf8"));
        const at = j.access_token || j.accessToken;
        if (at) return at;
      } catch { /* skip bad file */ }
    }
  } catch { /* no ~/.mcp-auth */ }
  return null;
}

export function provisioningConfigured(): boolean {
  return hasApiToken || Boolean(findMcpAccessToken());
}

type Endpoints = { jiraBase: string; confBase: string; headers: Record<string, string> };

async function http(headers: Record<string, string>, method: string, url: string, body?: unknown) {
  const res = await fetch(url, {
    method,
    headers: { ...headers, "Content-Type": "application/json", Accept: "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  return { ok: res.ok, status: res.status, json, text };
}

// Resolve REST base URLs + auth headers. Throws on auth problems (caller treats as soft-skip).
async function resolveEndpoints(): Promise<Endpoints | null> {
  if (hasApiToken) {
    const basic = Buffer.from(`${EMAIL}:${TOKEN}`).toString("base64");
    return { jiraBase: SITE, confBase: `${SITE}/wiki`, headers: { Authorization: `Basic ${basic}` } };
  }
  const token = findMcpAccessToken();
  if (!token) return null;
  const headers = { Authorization: `Bearer ${token}` };
  const r = await http(headers, "GET", "https://api.atlassian.com/oauth/token/accessible-resources");
  if (!r.ok || !Array.isArray(r.json) || r.json.length === 0) {
    throw new Error(`MCP login can't reach Atlassian (accessible-resources → ${r.status}) — it may be expired; re-run \`npx mcp-remote https://mcp.atlassian.com/v1/mcp/authv2\`.`);
  }
  const host = SITE.replace(/^https?:\/\//, "");
  const site = (host && r.json.find((s: any) => String(s.url || "").includes(host))) || r.json[0];
  const cid = site.id;
  return {
    jiraBase: `https://api.atlassian.com/ex/jira/${cid}`,
    confBase: `https://api.atlassian.com/ex/confluence/${cid}/wiki`,
    headers,
  };
}

async function leadAccountId(ep: Endpoints): Promise<string> {
  const r = await http(ep.headers, "GET", `${ep.jiraBase}/rest/api/3/myself`);
  if (!r.ok || !r.json?.accountId) throw new Error(`Couldn't resolve the Atlassian account for project lead (/myself → ${r.status}).`);
  return r.json.accountId;
}

type One = { key: string; existed: boolean; created: boolean; uncertain?: boolean };

async function ensureJiraProject(ep: Endpoints, key: string, name: string): Promise<One> {
  const get = await http(ep.headers, "GET", `${ep.jiraBase}/rest/api/3/project/${encodeURIComponent(key)}`);
  if (get.ok) return { key, existed: true, created: false };
  if (get.status !== 404) {
    console.warn(`[provision] Jira project ${key} lookup → ${get.status}; leaving it to the BA's verify step.`);
    return { key, existed: false, created: false, uncertain: true };
  }
  const lead = await leadAccountId(ep);
  const create = await http(ep.headers, "POST", `${ep.jiraBase}/rest/api/3/project`, {
    key, name, leadAccountId: lead, projectTypeKey: JIRA_TYPE, projectTemplateKey: JIRA_TEMPLATE, assigneeType: "PROJECT_LEAD",
  });
  if (!create.ok) {
    throw new Error(`Couldn't create Jira project ${key} (→ ${create.status}). The login may lack project-create permission — create it once in Jira, or set ATLASSIAN_API_TOKEN. Detail: ${create.text.slice(0, 200)}`);
  }
  return { key, existed: false, created: true };
}

async function ensureConfluenceSpace(ep: Endpoints, key: string, name: string): Promise<One> {
  const get = await http(ep.headers, "GET", `${ep.confBase}/rest/api/space/${encodeURIComponent(key)}`);
  if (get.ok) return { key, existed: true, created: false };
  if (get.status !== 404) {
    console.warn(`[provision] Confluence space ${key} lookup → ${get.status}; leaving it to the BA's verify step.`);
    return { key, existed: false, created: false, uncertain: true };
  }
  const create = await http(ep.headers, "POST", `${ep.confBase}/rest/api/space`, { key, name });
  if (!create.ok) {
    throw new Error(`Couldn't create Confluence space ${key} (→ ${create.status}). The login may lack space-admin permission — create it once in Confluence, or set ATLASSIAN_API_TOKEN. Detail: ${create.text.slice(0, 200)}`);
  }
  return { key, existed: false, created: true };
}

export type EnsureResult = { skipped?: boolean; reason?: string; jira?: One; confluence?: One };

export async function ensureAtlassianTargets(opts: {
  // jiraKey is optional: the requirements flow ensures both targets, while the
  // Confluence-only downstream stages (data model, solution design) pass no
  // Jira key and only the space is ensured.
  jiraKey?: string; jiraName?: string; confluenceKey: string; confluenceName: string;
}): Promise<EnsureResult> {
  let ep: Endpoints | null;
  try {
    ep = await resolveEndpoints();
  } catch (e: any) {
    // Auth unavailable/expired — don't block the approval; the BA verifies + blocks if needed.
    console.warn("[provision] skipping (auth):", e?.message ?? e);
    return { skipped: true, reason: "auth" };
  }
  if (!ep) return { skipped: true, reason: "unconfigured" };

  // Run sequentially so a clear create-failure surfaces first. Create failures throw
  // (→ approval blocked with an actionable message); lookups failing soft-skip.
  const jira = opts.jiraKey
    ? await ensureJiraProject(ep, opts.jiraKey, opts.jiraName || opts.jiraKey)
    : undefined;
  const confluence = await ensureConfluenceSpace(ep, opts.confluenceKey, opts.confluenceName);
  return { jira, confluence };
}
