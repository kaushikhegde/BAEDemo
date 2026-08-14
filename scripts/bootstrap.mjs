#!/usr/bin/env node
// Idempotent first-boot provisioning for the Scyne stack.
//
// Runs as a one-shot compose service after Paperclip is healthy. It:
//   1. waits for the Paperclip API,
//   2. finds or creates the `Scyne` company,
//   3. disables board approval for new hires (so agents fire automatically),
//   4. provisions the 20-agent Scyne org (CEO → Delivery Lead/Bid Manager → …)
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
import { STAGES } from "./pipeline.mjs";

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
// The Atlassian MCP's ~45 tool schemas cost roughly 8-12k tokens of context on
// EVERY wake of an agent that loads them. Only the six agents that publish to
// Confluence or Jira in their Phase 2 ever call those tools; the rest are
// explicitly forbidden from touching Atlassian, so loading it for them was pure
// waste — 18 of 24 agents paying a five-figure token tax per wake for a toolset
// they must not use.
//
// `publishes: true` on a spec is what grants it. Nothing else should.
function adapterConfigFor(spec) {
  return {
    cwd: AGENT_CWD,
    // --strict-mcp-config so a stray user- or project-scope MCP cannot creep
    // back in and reintroduce the cost we just removed.
    ...(spec.publishes
      ? { extraArgs: ["--strict-mcp-config", "--mcp-config", `${AGENT_CWD}/.mcp.json`] }
      : { extraArgs: ["--strict-mcp-config"] }),
    // Default to Sonnet 4.6 (much cheaper than Opus). Override per-agent if a task
    // genuinely needs Opus reasoning. Available ids: claude-opus-4-7, claude-opus-4-6,
    // claude-sonnet-4-6, claude-haiku-4-6, claude-sonnet-4-5-20250929, claude-haiku-4-5-20251001.
    model: spec.model || process.env.PAPERCLIP_AGENT_MODEL || "claude-sonnet-4-6",
  };
}
const HEALTH_DEADLINE_MS = 120_000;

// Old report UUIDs hard-coded inside agent-instructions/pm.json. We string-
// replace these with the real hired IDs before pushing the Delivery Lead's bundle.
// archLead/dataModeler use obviously-fake placeholder UUIDs (distinct first
// segments so the prefix-replace below can't collide) that the Delivery Lead
// dispatches by — bootstrap swaps them for the real hired IDs.
const OLD_IDS = {
  ba: "7561c779-5c3f-4e3a-9dc2-0f13eb1851ec",
  ui: "f19feb64-3ccd-42b2-b0b7-f9dfe7273a94",
  ux: "43a9e518-99c5-4916-8b91-3ff89e0c00ba",
  archLead: "aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  dataModeler: "ddddddd1-dddd-4ddd-8ddd-dddddddddddd",
  capArchitect: "ccccccc1-cccc-4ccc-8ccc-cccccccccccc",
  solutionArchitect: "bbbbbbb1-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  qaArchitect: "eeeeeee1-eeee-4eee-8eee-eeeeeeeeeeee",
  serviceDesigner: "fffffff1-ffff-4fff-8fff-ffffffffffff",
  uxDesigner: "9999999a-9999-4999-8999-999999999999",
};

// The 24-agent Scyne org. `key` is the in-script identifier (also exposed under
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
// Paperclip validates `icon` against a fixed enum and rejects the hire with a
// 400 otherwise. Checking the whole list up front matters more than it looks:
// hires happen in spec order, so an invalid icon halfway down leaves the org
// PARTIALLY created — some agents hired, the rest not, and the next run has to
// converge from that. Kept in step with the server's enum by hand; when a hire
// starts 400ing on `icon`, the message names the exact valid list.
const VALID_ICONS = new Set([
  "bot", "cpu", "brain", "zap", "rocket", "code", "terminal", "shield", "eye",
  "search", "wrench", "hammer", "lightbulb", "sparkles", "star", "heart", "flame",
  "bug", "cog", "database", "globe", "lock", "mail", "message-square", "file-code",
  "git-branch", "package", "puzzle", "target", "wand", "atom", "circuit-board",
  "radar", "swords", "telescope", "microscope", "crown", "gem", "hexagon",
  "pentagon", "fingerprint",
]);

const AGENTS = [
  { key: "ceo",              name: "CEO",                       title: "Chief Executive",         icon: "crown",          reportsToKey: null },
  { key: "pm",               name: "Delivery Lead",             title: "Delivery Lead",           icon: "rocket",         reportsToKey: "ceo",          file: "pm.json",         skills: [] },
  { key: "bidManager",       name: "Bid Manager",               title: "Bid Manager",             icon: "gem",            reportsToKey: "ceo" },
  { key: "archLead",         name: "Architecture Lead",         title: "Architecture Lead",       icon: "circuit-board",  reportsToKey: "pm",           file: "architect-lead.json", skills: ["solution-design-document"] , publishes: true },
  { key: "businessLead",     name: "Business Lead",             title: "Business Lead",           icon: "lightbulb",      reportsToKey: "pm" },
  { key: "changeLead",       name: "Change Lead",               title: "Change Lead",             icon: "sparkles",       reportsToKey: "pm" },
  { key: "dataLead",         name: "Data Lead",                 title: "Data Lead",               icon: "database",       reportsToKey: "pm" },
  { key: "ux",               name: "UX Auditor",                title: "UX Auditor",              icon: "shield",         reportsToKey: "archLead",     file: "ux-auditor.json", skills: [] },
  { key: "architect",        name: "Architect",                 title: "Architect",               icon: "hammer",         reportsToKey: "archLead" },
  { key: "dataModeler",      name: "Data Modeler",              title: "Data Modeler",            icon: "database",       reportsToKey: "archLead",     file: "data-modeler.json",   skills: ["salesforce-data-modeler"] , publishes: true },
  { key: "capArchitect",     name: "Capabilities Process Architect", title: "Capabilities Process Architect", icon: "hexagon",       reportsToKey: "archLead", file: "capabilities-process-architect.json", skills: ["capability-process-map"] , publishes: true },
  { key: "solutionArchitect", name: "Solution Architect",        title: "Solution Architect",      icon: "package",        reportsToKey: "archLead",     file: "solution-architect.json", skills: ["salesforce-service-cloud-architecture"] , publishes: true },
  { key: "ui",               name: "Developer",                 title: "Developer",               icon: "code",           reportsToKey: "archLead",     file: "ui.json",         skills: [] },
  { key: "uxDesigner",       name: "UX Designer",               title: "UX Designer",             icon: "wand",           reportsToKey: "archLead",     file: "ux-designer.json", skills: ["ui-mockup-generator"] },
  { key: "serviceDesigner",  name: "Service Designer",          title: "Service Designer",        icon: "heart",          reportsToKey: "archLead",     file: "service-designer.json", skills: ["persona-journey-map"] , publishes: true },
  { key: "ba",               name: "BA",                        title: "BA",                      icon: "search",         reportsToKey: "businessLead", file: "ba.json",         skills: ["requirement-generator"] , publishes: true },
  { key: "qaTester",         name: "QA Tester",                 title: "QA Tester",               icon: "bug",            reportsToKey: "businessLead" },
  { key: "qaArchitect",      name: "QA Architect",              title: "QA Architect",            icon: "microscope",     reportsToKey: "businessLead", file: "qa-architect.json", skills: ["requirements-test-case-generator"] , publishes: true },
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

// Non-throwing API call: returns {ok, data} or {ok:false, error} so we can probe
// candidate routes without aborting the bootstrap on the first 404/405.
async function tryApi(method, p, body) {
  try {
    return { ok: true, data: await api(method, p, body) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Refresh an already-registered skill in place so edits to SKILL.md propagate.
// Paperclip's skill-update route isn't pinned across versions, so probe the
// likely shapes (by slug, then by id) and stop at the first that the server
// accepts. Never falls back to POST — that would risk a duplicate skill.
async function refreshCompanySkill(companyId, slug, markdown, existing) {
  const full = { name: slug, slug, markdown };
  const candidates = [
    ["PUT",   `/companies/${companyId}/skills/${slug}`, full],
    ["PATCH", `/companies/${companyId}/skills/${slug}`, { markdown }],
  ];
  if (existing?.id) {
    candidates.push(
      ["PUT",   `/companies/${companyId}/skills/${existing.id}`, full],
      ["PATCH", `/companies/${companyId}/skills/${existing.id}`, { markdown }],
    );
  }
  for (const [method, p, b] of candidates) {
    const res = await tryApi(method, p, b);
    if (res.ok) return { updated: true, via: `${method} ${p}` };
  }
  return { updated: false };
}

// Agents are hired with `desiredSkills` (e.g. the BA needs `requirement-generator`).
// Paperclip rejects the hire (422 "unknown references") unless that skill is a
// registered company skill. The all-in-Docker image syncs skills from disk, but a
// natively-installed (host) Paperclip has none — so we register them here from the
// SKILL.md files shipped in this repo. Idempotent and convergent: a missing skill
// is created; an existing one is refreshed in place so SKILL.md edits propagate on
// every bootstrap (no manual re-register needed). If no update route is accepted,
// we warn loudly rather than silently leaving stale content registered.
async function ensureCompanySkills(companyId) {
  const needed = [...new Set(AGENTS.flatMap((a) => a.skills ?? []))];
  if (needed.length === 0) return;

  const existing = await api("GET", `/companies/${companyId}/skills`);
  const bySlug = new Map(
    (Array.isArray(existing) ? existing : existing.items || existing.skills || [])
      .filter((s) => s && s.slug)
      .map((s) => [s.slug, s]),
  );

  for (const slug of needed) {
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

    const found = bySlug.get(slug);
    if (found) {
      const r = await refreshCompanySkill(companyId, slug, markdown, found);
      if (r.updated) {
        console.log(`[bootstrap] refreshed company skill '${slug}' (${r.via})`);
      } else {
        console.warn(
          `[bootstrap] WARN: company skill '${slug}' exists but no update route was ` +
          `accepted — the REGISTERED content is now STALE vs ${skillPath}. Update it ` +
          `manually (or delete+recreate the skill) in Paperclip to pick up the edits.`,
        );
      }
      continue;
    }

    await api("POST", `/companies/${companyId}/skills`, { name: slug, slug, markdown });
    console.log(`[bootstrap] registered company skill '${slug}' from ${skillPath}`);
  }
}

async function main() {
  // Validate the whole spec BEFORE touching Paperclip. Hires happen in spec
  // order, so a bad icon two-thirds down the list would otherwise leave the org
  // partially created.
  const badIcons = AGENTS.filter((a) => !VALID_ICONS.has(a.icon));
  if (badIcons.length) {
    console.error(`\n[bootstrap] ${badIcons.length} agent(s) have an icon Paperclip will reject:\n`);
    for (const a of badIcons) console.error(`  ${a.name.padEnd(36)} icon: "${a.icon}"`);
    console.error(`\nValid icons:\n  ${[...VALID_ICONS].join(", ")}\n`);
    process.exit(1);
  }

  // `publishes` here grants the Atlassian MCP; `publishes` in the pipeline graph
  // says whether that stage writes to Confluence/Jira. They are the same fact
  // stated twice, so verify they agree rather than discovering the mismatch as
  // an agent that cannot publish — or one quietly carrying 10k tokens of tools
  // it must never use.
  const shouldPublish = new Set(
    Object.values(STAGES).filter((d) => d.publishes).map((d) => d.agent),
  );
  const mcpMismatch = AGENTS.filter((a) => Boolean(a.publishes) !== shouldPublish.has(a.name));
  if (mcpMismatch.length) {
    console.error(`\n[bootstrap] ${mcpMismatch.length} agent(s) disagree with scripts/pipeline.mjs on publishing:\n`);
    for (const a of mcpMismatch) {
      const want = shouldPublish.has(a.name);
      console.error(`  ${a.name.padEnd(36)} bootstrap says ${a.publishes ? "publishes" : "does not"}, pipeline says ${want ? "publishes" : "does not"}`);
    }
    console.error(`\nThe Atlassian MCP is granted from this flag. Fix whichever is wrong.\n`);
    process.exit(1);
  }

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
        adapterConfig: adapterConfigFor(spec),
        // Paperclip 2026.525+ requires heartbeat enabled for queued wakes
        // (incl. interaction-accept continuations) to drain. Old advice was to
        // keep this disabled — that no longer works.
        // maxConcurrentRuns:1 serialises runs — without it, concurrent heartbeat
        // wakes race the "check for existing child" idempotency guard and create
        // duplicate child issues. Interval bumped to 120s to reduce idle cost.
        // Heartbeat OFF: tested 2026-05-28 — wake-on-event (status:todo, comment,
        // explicit /agents/:id/wakeup) fires reliably without heartbeat. Leaving
        // it on burns Claude tokens on idle no-op runs and triggers race conditions.
        // The chatbot explicitly calls wakeAgent after interaction-accept to cover
        // the one case where Paperclip's queued continuation doesn't auto-fire.
        runtimeConfig: { heartbeat: { enabled: false, maxConcurrentRuns: 1 } },
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
      adapterConfig: adapterConfigFor(spec),
      name: spec.name,
      title: spec.title,
      icon: spec.icon,
      reportsTo,
      runtimeConfig: { heartbeat: { enabled: false, maxConcurrentRuns: 1 } },
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
      // Replace BOTH the full UUID and the truncated prefix form (e.g. `f19feb64-`,
      // `f19feb64-...`) that appears in prose. Prefix-only mentions confuse DL
      // because the deployed file ends up with the new full ID in dispatch sections
      // but stale prefix shorthand in the "## Your direct reports" descriptions.
      // Map-driven so adding an agent to OLD_IDS is the ONLY edit needed here.
      const prefix = (uuid) => uuid.split("-")[0];
      for (const key of Object.keys(OLD_IDS)) {
        if (!ids[key]) throw new Error(`pm.json swap: no hired id for OLD_IDS key '${key}'`);
        content = content
          .split(OLD_IDS[key]).join(ids[key])
          .split(prefix(OLD_IDS[key])).join(prefix(ids[key]));
      }
      // A surviving placeholder means pm.json references an agent OLD_IDS doesn't
      // cover (or vice versa) — fail loudly instead of deploying a dead dispatch id.
      const leftover = Object.values(OLD_IDS).find((u) => content.includes(u));
      if (leftover) throw new Error(`pm.json swap: placeholder ${leftover} survived the swap`);
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
