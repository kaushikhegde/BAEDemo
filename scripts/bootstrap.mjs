#!/usr/bin/env node
// Idempotent first-boot provisioning for the Scyne stack.
//
// Runs as a one-shot compose service after Paperclip is healthy. It:
//   1. waits for the Paperclip API,
//   2. finds or creates the `Scyne` company,
//   3. disables board approval for new hires (so agents fire automatically),
//   4. provisions the 19-agent Scyne org (CEO → Delivery Lead/Bid Manager → …)
//      — hires anything missing by name, PATCHes everything back to spec
//      (title, icon, reportsTo, adapterConfig) on every run,
//   5. rewrites the Delivery Lead's instructions with the freshly-hired report IDs,
//   6. pushes the four shipped AGENTS.md bundles (Delivery Lead / BA / Developer
//      / UX Auditor); new org placeholders get no bundle on this pass,
//   7. writes <WORKSPACE>/.bootstrap/ids.json — top-level fields stay
//      backward-compatible; a new `org` map exposes every role by spec key.
//
// Safe to run repeatedly: every step looks up existing state by name and
// converges, so a container restart re-runs it harmlessly. Agents present in
// Paperclip but absent from the spec are left alone (no surprise deletions).

import fs from "node:fs/promises";
import path from "node:path";

const BASE = (process.env.PAPERCLIP_API_URL || "http://127.0.0.1:3100/api").replace(/\/$/, "");
const COMPANY_NAME = process.env.SCYNE_COMPANY_NAME || "Scyne";
const INSTRUCTIONS_DIR = process.env.AGENT_INSTRUCTIONS_DIR || "/seed/agent-instructions";
const WORKSPACE = process.env.WORKSPACE_PATH || "/workspace";
// ids.json lands under WORKSPACE so the chatbot (which reads ${WORKSPACE}/.bootstrap/
// ids.json) finds it. Must derive from WORKSPACE — hardcoding /workspace breaks the
// host-native run, where /workspace at the filesystem root isn't writable (EACCES).
const IDS_PATH = process.env.BOOTSTRAP_IDS_PATH || `${WORKSPACE}/.bootstrap/ids.json`;
const SKILLS_DIR = process.env.SKILLS_DIR || "/seed/skills";
// The directory each agent uses as its Claude Code cwd. In the all-in-Docker stack
// the agents run INSIDE the paperclip container, so this is the container path
// (/workspace). In host-Paperclip mode the agents run ON THE HOST, so it must be
// the host's absolute workspace path (AGENT_CWD = WORKSPACE_HOST_PATH) — otherwise
// the agent tries to mkdir /workspace at the host root and hits EACCES.
const AGENT_CWD = process.env.AGENT_CWD || WORKSPACE;
const adapterConfig = {
  cwd: AGENT_CWD,
  extraArgs: ["--mcp-config", `${AGENT_CWD}/.mcp.json`],
};
const HEALTH_DEADLINE_MS = 120_000;

// Old report UUIDs hard-coded inside agent-instructions/pm.json. We string-
// replace these with the real hired IDs before pushing the Delivery Lead's bundle.
const OLD_IDS = {
  ba: "7561c779-5c3f-4e3a-9dc2-0f13eb1851ec",
  ui: "f19feb64-3ccd-42b2-b0b7-f9dfe7273a94",
  ux: "43a9e518-99c5-4916-8b91-3ff89e0c00ba",
};

// The 19-agent Scyne org. `key` is the in-script identifier (also exposed under
// ids.json's `org` map); `name` is the Paperclip display name and the lookup
// key for "does this agent already exist?". `title` / `icon` / `reportsToKey`
// are applied via PATCH on every run so re-titling, icon swaps, and re-parenting
// converge idempotently. `file` is the AGENTS.md bundle under
// INSTRUCTIONS_DIR — only set for agents whose instructions ship in this repo.
// `skills` is forwarded as `desiredSkills` on hire. Spec order is topologically
// sorted (CEO → leads → ICs) so `reportsToKey` always resolves before use.
//
// Note: the source org chart shows "Pricing Specalist" — kept as
// "Pricing Specialist" (correct spelling) since the source is clearly a typo.
const AGENTS = [
  { key: "ceo",              name: "CEO",                       title: "Chief Executive",         icon: "crown",          reportsToKey: null },
  { key: "pm",               name: "Delivery Lead",             title: "Delivery Lead",           icon: "rocket",         reportsToKey: "ceo",          file: "pm.json",         skills: [] },
  { key: "bidManager",       name: "Bid Manager",               title: "Bid Manager",             icon: "gem",            reportsToKey: "ceo" },
  { key: "archLead",         name: "Architecture Lead",         title: "Architecture Lead",       icon: "circuit-board",  reportsToKey: "pm" },
  { key: "businessLead",     name: "Business Lead",             title: "Business Lead",           icon: "lightbulb",      reportsToKey: "pm" },
  { key: "changeLead",       name: "Change Lead",               title: "Change Lead",             icon: "sparkles",       reportsToKey: "pm" },
  { key: "dataLead",         name: "Data Lead",                 title: "Data Lead",               icon: "database",       reportsToKey: "pm" },
  { key: "ux",               name: "UX Auditor",                title: "UX Auditor",              icon: "shield",         reportsToKey: "archLead",     file: "ux-auditor.json", skills: [] },
  { key: "architect",        name: "Architect",                 title: "Architect",               icon: "hammer",         reportsToKey: "archLead" },
  { key: "ui",               name: "Developer",                 title: "Developer",               icon: "code",           reportsToKey: "archLead",     file: "ui.json",         skills: [] },
  { key: "uxDesigner",       name: "UX Designer",               title: "UX Designer",             icon: "wand",           reportsToKey: "archLead" },
  { key: "ba",               name: "BA",                        title: "BA",                      icon: "search",         reportsToKey: "businessLead", file: "ba.json",         skills: ["requirement-generator"] },
  { key: "qaTester",         name: "QA Tester",                 title: "QA Tester",               icon: "bug",            reportsToKey: "businessLead" },
  { key: "contentWriter",    name: "Content Writer",            title: "Content Writer",          icon: "message-square", reportsToKey: "changeLead" },
  { key: "dataMigDev",       name: "Data Migration Developer",  title: "Data Migration Developer",icon: "git-branch",     reportsToKey: "dataLead" },
  { key: "solutionDesigner", name: "Solution Designer",         title: "Solution Designer",       icon: "puzzle",         reportsToKey: "bidManager" },
  { key: "creativeDesigner", name: "Creative Designer",         title: "Creative Designer",       icon: "star",           reportsToKey: "bidManager" },
  { key: "docFormatter",     name: "Document Formatter",        title: "Document Formatter",      icon: "file-code",      reportsToKey: "bidManager" },
  { key: "pricingSpec",      name: "Pricing Specialist",        title: "Pricing Specialist",      icon: "target",         reportsToKey: "bidManager" },
];

const PLACEHOLDER_CAPABILITIES = "Placeholder Scyne org role — to be expanded.";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, p, body) {
  const res = await fetch(BASE + p, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${p} -> ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

async function waitForHealth() {
  const deadline = Date.now() + HEALTH_DEADLINE_MS;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(BASE + "/health");
      if (res.ok) { console.log("[bootstrap] paperclip healthy"); return; }
      lastErr = `status ${res.status}`;
    } catch (e) {
      lastErr = e.message;
    }
    await sleep(2000);
  }
  throw new Error(`paperclip not healthy within ${HEALTH_DEADLINE_MS}ms (last: ${lastErr})`);
}

async function getOrCreateCompany() {
  const list = await api("GET", "/companies");
  const arr = Array.isArray(list) ? list : (list.companies || list.items || []);
  const existing = arr.find((c) => c.name === COMPANY_NAME);
  if (existing) {
    console.log(`[bootstrap] company '${COMPANY_NAME}' exists: ${existing.id}`);
    return existing.id;
  }
  const created = await api("POST", "/companies", { name: COMPANY_NAME });
  console.log(`[bootstrap] created company '${COMPANY_NAME}': ${created.id}`);
  return created.id;
}

async function listAgents(companyId) {
  const list = await api("GET", `/companies/${companyId}/agents`);
  return Array.isArray(list) ? list : (list.agents || list.items || []);
}

async function readBundle(file) {
  const raw = await fs.readFile(path.join(INSTRUCTIONS_DIR, file), "utf8");
  const parsed = JSON.parse(raw); // { path: "AGENTS.md", content: "..." }
  return parsed;
}

// Agents are hired with `desiredSkills` (e.g. the BA needs `requirement-generator`).
// Paperclip rejects the hire (422 "unknown references") unless that skill is a
// registered company skill. The all-in-Docker image syncs skills from disk, but a
// natively-installed (host) Paperclip has none — so we register them here from the
// SKILL.md files shipped in this repo. Idempotent: skips any skill already present.
async function ensureCompanySkills(companyId) {
  const needed = [...new Set(AGENTS.flatMap((a) => a.skills ?? []))];
  if (needed.length === 0) return;

  const existing = await api("GET", `/companies/${companyId}/skills`);
  const have = new Set(
    (Array.isArray(existing) ? existing : existing.items || existing.skills || [])
      .map((s) => s.slug)
      .filter(Boolean),
  );

  for (const slug of needed) {
    if (have.has(slug)) {
      console.log(`[bootstrap] company skill '${slug}' already present`);
      continue;
    }
    const skillPath = path.join(SKILLS_DIR, slug, "SKILL.md");
    let markdown;
    try {
      markdown = await fs.readFile(skillPath, "utf8");
    } catch {
      console.warn(
        `[bootstrap] WARN: skill '${slug}' missing and no SKILL.md at ${skillPath} — ` +
        `the hire that needs it will fail. Mount the skill or install it in Paperclip.`,
      );
      continue;
    }
    await api("POST", `/companies/${companyId}/skills`, { name: slug, slug, markdown });
    console.log(`[bootstrap] registered company skill '${slug}' from ${skillPath}`);
  }
}

async function main() {
  await waitForHealth();
  const companyId = await getOrCreateCompany();

  // Hires land `idle` (and auto-fire) only when board approval is off.
  await api("PATCH", `/companies/${companyId}`, { requireBoardApprovalForNewAgents: false });
  console.log("[bootstrap] board approval for new agents disabled");

  // Register any skills the agents reference before hiring (else the hire 422s).
  await ensureCompanySkills(companyId);

  // Single ordered pass: ensure each agent exists, then PATCH it to spec. Spec
  // order is topologically sorted (CEO → leads → ICs) so `ids[reportsToKey]` is
  // always available when we need it.
  const ids = {};
  const existing = await listAgents(companyId);
  for (const spec of AGENTS) {
    const found = existing.find((a) => a.name === spec.name);
    if (found) {
      ids[spec.key] = found.id;
      console.log(`[bootstrap] agent '${spec.name}' exists: ${found.id}`);
    } else {
      const reportsTo = spec.reportsToKey ? ids[spec.reportsToKey] : null;
      const hire = await api("POST", `/companies/${companyId}/agent-hires`, {
        name: spec.name,
        role: "general",
        title: spec.title,
        icon: spec.icon,
        reportsTo,
        capabilities: PLACEHOLDER_CAPABILITIES,
        adapterType: "claude_local",
        adapterConfig,
        // Paperclip 2026.525+ requires heartbeat enabled for queued wakes
        // (incl. interaction-accept continuations) to drain. Old advice was to
        // keep this disabled — that no longer works.
        runtimeConfig: { heartbeat: { enabled: true, intervalSeconds: 30, maxConcurrentRuns: 20 } },
        desiredSkills: spec.skills ?? [],
      });
      // Hire responses vary in shape; resolve the id defensively.
      ids[spec.key] = hire.id || hire.agentId || (hire.agent && hire.agent.id);
      console.log(`[bootstrap] hired '${spec.name}': ${ids[spec.key]}`);
    }

    // PATCH every agent (existing or fresh) back to spec. This is the convergence
    // step: renames, re-titling, icon swaps, re-parenting, and stale-cwd fixes
    // all happen here, idempotently — bodies match current state on a no-op run.
    // runtimeConfig is included so existing pre-2026.525 hires get migrated to
    // heartbeat-enabled on the next bootstrap.
    const reportsTo = spec.reportsToKey ? ids[spec.reportsToKey] : null;
    await api("PATCH", `/agents/${ids[spec.key]}`, {
      adapterConfig,
      name: spec.name,
      title: spec.title,
      icon: spec.icon,
      reportsTo,
      runtimeConfig: { heartbeat: { enabled: true, intervalSeconds: 30, maxConcurrentRuns: 20 } },
    });
    console.log(`[bootstrap] ${spec.name} title='${spec.title}' reportsTo=${reportsTo ?? "(none)"}`);
  }

  if (!ids.pm) throw new Error("Delivery Lead agent id missing after hire");

  // Push instruction bundles. The Delivery Lead's content gets the real report IDs swapped in.
  // Agents without a `file` (the new org placeholders) get no bundle on this pass.
  for (const spec of AGENTS) {
    if (!spec.file) continue;
    const bundle = await readBundle(spec.file);
    let content = bundle.content;
    if (spec.key === "pm") {
      content = content
        .split(OLD_IDS.ba).join(ids.ba)
        .split(OLD_IDS.ui).join(ids.ui)
        .split(OLD_IDS.ux).join(ids.ux);
    }
    await api("PUT", `/agents/${ids[spec.key]}/instructions-bundle/file`, {
      path: bundle.path || "AGENTS.md",
      content,
    });
    console.log(`[bootstrap] pushed instructions for '${spec.name}'`);
  }

  // Hand the resolved ids to the chatbot. `deliveryLeadAgentId` is the only
  // top-level convenience field (the chatbot routes parent issues to the
  // Delivery Lead); everything else is reachable via the `org` map.
  const out = {
    companyId,
    deliveryLeadAgentId: ids.pm,
    org: Object.fromEntries(AGENTS.map((a) => [a.key, ids[a.key]])),
  };
  await fs.mkdir(path.dirname(IDS_PATH), { recursive: true });
  await fs.writeFile(IDS_PATH, JSON.stringify(out, null, 2));
  console.log(`[bootstrap] wrote ${IDS_PATH}:`, out);
  console.log("[bootstrap] done");
}

main().catch((e) => {
  console.error("[bootstrap] FAILED:", e.message);
  process.exit(1);
});
