#!/usr/bin/env node
// Idempotent first-boot provisioning for the Scyne stack.
//
// Runs as a one-shot compose service after Paperclip is healthy. It:
//   1. waits for the Paperclip API,
//   2. finds or creates the `Scyne` company,
//   3. disables board approval for new hires (so agents fire automatically),
//   4. hires the 4 agents (PM / BA / UI / UX) if they don't already exist,
//   5. wires reportsTo = PM for the three reports,
//   6. rewrites PM's instructions with the freshly-hired report IDs,
//   7. pushes every agent's AGENTS.md instruction bundle,
//   8. writes /workspace/.bootstrap/ids.json for the chatbot to read.
//
// Safe to run repeatedly: every step looks up existing state by name and
// converges, so a container restart re-runs it harmlessly.

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
// replace these with the real hired IDs before pushing PM's bundle.
const OLD_IDS = {
  ba: "7561c779-5c3f-4e3a-9dc2-0f13eb1851ec",
  ui: "f19feb64-3ccd-42b2-b0b7-f9dfe7273a94",
  ux: "43a9e518-99c5-4916-8b91-3ff89e0c00ba",
};

// The four agents. `key` maps to OLD_IDS / the ids.json fields; `file` is the
// AGENTS.md bundle under INSTRUCTIONS_DIR.
const AGENTS = [
  { key: "pm", name: "Project Manager", file: "pm.json", reportsToPm: false, skills: [] },
  { key: "ba", name: "Business Analyst", file: "ba.json", reportsToPm: true, skills: ["requirement-generator"] },
  { key: "ui", name: "UI Engineer", file: "ui.json", reportsToPm: true, skills: [] },
  { key: "ux", name: "UX Auditor", file: "ux-auditor.json", reportsToPm: true, skills: [] },
];

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
  const needed = [...new Set(AGENTS.flatMap((a) => a.skills))];
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

  // First pass: ensure each agent exists; collect ids by key.
  const ids = {};
  let existing = await listAgents(companyId);
  for (const spec of AGENTS) {
    const found = existing.find((a) => a.name === spec.name);
    if (found) {
      ids[spec.key] = found.id;
      console.log(`[bootstrap] agent '${spec.name}' exists: ${found.id}`);
      continue;
    }
    const hire = await api("POST", `/companies/${companyId}/agent-hires`, {
      name: spec.name,
      role: "general",
      adapterType: "claude_local",
      adapterConfig,
      runtimeConfig: { heartbeat: { enabled: false } },
      desiredSkills: spec.skills,
    });
    // Hire responses vary in shape; resolve the id defensively.
    ids[spec.key] = hire.id || hire.agentId || (hire.agent && hire.agent.id);
    console.log(`[bootstrap] hired '${spec.name}': ${ids[spec.key]}`);
  }

  if (!ids.pm) throw new Error("PM agent id missing after hire");

  // Converge every agent's working dir to AGENT_CWD. This fixes agents that were
  // already hired with a stale cwd (e.g. a previous run that baked /workspace on a
  // host where that path isn't writable). Idempotent — a no-op when already correct.
  for (const spec of AGENTS) {
    await api("PATCH", `/agents/${ids[spec.key]}`, { adapterConfig });
    console.log(`[bootstrap] ${spec.name} cwd=${AGENT_CWD}`);
  }

  // Wire reportsTo = PM for the three reports (idempotent).
  for (const spec of AGENTS) {
    if (!spec.reportsToPm) continue;
    await api("PATCH", `/agents/${ids[spec.key]}`, { reportsTo: ids.pm });
    console.log(`[bootstrap] ${spec.name} reportsTo PM`);
  }

  // Push instruction bundles. PM's content gets the real report IDs swapped in.
  for (const spec of AGENTS) {
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

  // Hand the resolved ids to the chatbot.
  const out = {
    companyId,
    pmAgentId: ids.pm,
    baAgentId: ids.ba,
    uiAgentId: ids.ui,
    uxAgentId: ids.ux,
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
