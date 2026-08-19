#!/usr/bin/env node
// `scyne` — everything the web app can do, from a terminal.
//
// It lives at the repository root rather than inside packages/orchestrator
// because it is a CONSUMER of that library: it knows what a project, a feature
// and a stage are, and it reads scripts/pipeline.mjs to find out. The library
// deliberately knows none of that, and importing a consumer's files into it
// would end that separation (see CLAUDE.md).
//
// Every command goes over HTTP to the same API the browser uses, so parity is
// structural rather than maintained by hand.

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { createInterface } from "node:readline/promises";
import { createClient, resolveProject, targetProject, ApiError, type Client } from "./client.ts";
import { load, patch, machineId, configPath, DEFAULT_API_URL } from "./config.ts";
// @ts-expect-error — plain ESM with JSDoc types; no .d.ts and none warranted.
import * as pipeline from "../scripts/pipeline.mjs";

const argv = process.argv.slice(2);

// ------------------------------------------------------------------ helpers

function flag(name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}
const has = (name: string): boolean => argv.includes(`--${name}`);

/** Positional arguments, with every `--flag value` pair removed. */
function positionals(): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok.startsWith("--")) { if (!BOOLEAN_FLAGS.has(tok.slice(2))) i++; continue; }
    out.push(tok);
  }
  return out;
}
const BOOLEAN_FLAGS = new Set(["all", "follow", "json", "yes", "help", "quiet"]);

const out = (s = ""): void => { process.stdout.write(s + "\n"); };
const json = (v: unknown): void => out(JSON.stringify(v, null, 2));

/** Print rows as an aligned table — the CLI's whole presentation layer. */
function table(rows: Record<string, unknown>[], columns?: string[]): void {
  if (!rows.length) { out("  (none)"); return; }
  const cols = columns ?? Object.keys(rows[0]);
  const width = cols.map(c => Math.max(c.length, ...rows.map(r => String(r[c] ?? "—").length)));
  out("  " + cols.map((c, i) => c.toUpperCase().padEnd(width[i])).join("  "));
  for (const r of rows) {
    out("  " + cols.map((c, i) => String(r[c] ?? "—").padEnd(width[i])).join("  "));
  }
}

async function prompt(question: string, opts: { silent?: boolean } = {}): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    if (!opts.silent) return (await rl.question(question)).trim();
    // No echo for a password. `rl.question` has no silent mode, so the output
    // stream is muted for the duration rather than the characters being
    // echoed and then cleared, which leaves them in a scrollback buffer.
    const outStream = process.stdout as NodeJS.WriteStream & { _writeToOutput?: unknown };
    process.stdout.write(question);
    const original = (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput;
    (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = () => {};
    const answer = await rl.question("");
    (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = original;
    void outStream;
    process.stdout.write("\n");
    return answer.trim();
  } finally {
    rl.close();
  }
}

const STAGES = pipeline.STAGES as Record<string, { label: string; level: string; skill?: string }>;

// ----------------------------------------------------------------- commands

async function cmdLogin(): Promise<void> {
  const apiUrl = flag("api") ?? load().apiUrl ?? DEFAULT_API_URL;
  const email = flag("email") ?? await prompt("Email: ");
  const password = flag("password") ?? await prompt("Password: ", { silent: true });

  const client = createClient({ apiUrl, token: undefined });
  const res = await client.post<{ token: string; user: { email: string; role: string } }>(
    "/auth/login", { email, password });

  // Trade the session for a long-lived API token: a session expires in hours,
  // which is right for a browser and wrong for a terminal that will be used
  // again tomorrow.
  const authed = createClient({ apiUrl, token: res.token });
  const tok = await authed.post<{ token: string }>("/auth/tokens", { name: `cli@${basename(process.env.HOME ?? "host")}` });

  patch({ apiUrl, token: tok.token });
  out(`✓ logged in as ${res.user.email} (${res.user.role})`);
  out(`  token saved to ${configPath()} (mode 0600)`);
}

async function cmdInit(): Promise<void> {
  // `load()` applies $SCYNE_API_URL and any saved config before falling back.
  // Reading only `--api` here, as this once did, meant `SCYNE_API_URL=… scyne
  // init` silently claimed whatever was on the DEFAULT address instead — which
  // is how a test against a throwaway server created an administrator on a
  // live one. An irreversible, install-wide action must never guess its target.
  const apiUrl = flag("api") ?? load().apiUrl ?? DEFAULT_API_URL;

  // Say which server, before asking for anything. `init` claims an entire
  // installation and cannot be undone by running it again.
  out(`This claims the Scyne installation at ${apiUrl}`);
  out(`as its first administrator. It can only be done once.`);
  out(``);

  const email = flag("email") ?? await prompt("Administrator email: ");
  const password = flag("password") ?? await prompt("Password: ", { silent: true });

  const client = createClient({ apiUrl, token: undefined });
  const res = await client.post<{ token: string; user: { email: string } }>(
    "/auth/bootstrap", { email, password, name: flag("name") });

  patch({ apiUrl, token: res.token });
  out(`✓ installation claimed by ${res.user.email}`);
  out(`  token saved to ${configPath()}`);
  out(``);
  out(`  Next: scyne project create <name>`);
}

async function cmdWhoami(client: Client): Promise<void> {
  const me = await client.get("/auth/whoami");
  const cfg = load();
  json({ ...me, apiUrl: cfg.apiUrl, project: cfg.project ?? null, feature: cfg.feature ?? null });
}

async function cmdUse(client: Client, args: string[]): Promise<void> {
  const [name, feature] = args;
  if (!name) throw new ApiError(400, "usage: scyne use <project> [feature]");
  const project = await resolveProject(client, name);
  if (feature) {
    const features = await client.get<{ name: string }[]>(`/projects/${project.id}/features`);
    if (!features.some(f => f.name === feature)) {
      throw new ApiError(404,
        `no feature '${feature}' in ${project.name}.\n` +
        `  It has: ${features.map(f => f.name).join(", ") || "(none yet)"}`);
    }
  }
  patch({ project: project.name, feature: feature ?? undefined });
  out(`✓ working on ${project.name}${feature ? ` / ${feature}` : ""}`);
}

async function cmdProject(client: Client, args: string[]): Promise<void> {
  const [verb, name] = args;
  switch (verb) {
    case "list": case undefined: {
      const projects = await client.get<any[]>("/projects");
      if (has("json")) return json(projects);
      return table(projects.map(p => ({
        name: p.name, description: (p.description ?? "").slice(0, 48), created: p.created_at?.slice(0, 10),
      })), ["name", "description", "created"]);
    }
    case "create": {
      if (!name) throw new ApiError(400, "usage: scyne project create <name> [--description ...] [--website ...]");
      const p = await client.post("/projects", {
        name, description: flag("description"), website: flag("website"),
      });
      out(`✓ created project ${name}`);
      if (has("json")) json(p);
      return;
    }
    case "show": {
      const project = await resolveProject(client, targetProject(client, name));
      const [full, features, members] = await Promise.all([
        client.get<any>(`/projects/${project.id}`),
        client.get<any[]>(`/projects/${project.id}/features`),
        client.get<any[]>(`/projects/${project.id}/members`).catch(() => []),
      ]);
      if (has("json")) return json({ ...full, features, members });
      out(`${full.name}   (your role: ${full.role})`);
      if (full.description) out(`  ${full.description}`);
      out(``); out(`Features:`); table(features.map(f => ({ name: f.name })), ["name"]);
      out(``); out(`Members:`); table(members.map(m => ({ email: m.email, role: m.role })), ["email", "role"]);
      return;
    }
    default:
      throw new ApiError(400, `unknown: scyne project ${verb}. Try list, create, show.`);
  }
}

async function cmdFeature(client: Client, args: string[]): Promise<void> {
  const [verb, name] = args;
  const project = await resolveProject(client, targetProject(client, flag("project")));
  switch (verb) {
    case "list": case undefined: {
      const features = await client.get<any[]>(`/projects/${project.id}/features`);
      return has("json") ? json(features) : table(features.map(f => ({ name: f.name })), ["name"]);
    }
    case "add": case "create": {
      if (!name) throw new ApiError(400, "usage: scyne feature add <name> [--project <p>]");
      await client.post(`/projects/${project.id}/features`, { name });
      out(`✓ added feature ${name} to ${project.name}`);
      return;
    }
    default:
      throw new ApiError(400, `unknown: scyne feature ${verb}. Try list, add.`);
  }
}

/** `--as` maps to the folder the pipeline expects, matching fileRouter.ts. */
const CATEGORY_DIR: Record<string, string> = {
  sop: "requirements/SOP", transcripts: "requirements/Transcripts",
  notes: "requirements/Notes", ui: "requirements/UI", template: "requirements/templates",
};

async function cmdDoc(client: Client, args: string[]): Promise<void> {
  const [verb, ...rest] = args;
  const project = await resolveProject(client, targetProject(client, flag("project")));
  const feature = flag("feature") ?? load().feature;

  switch (verb) {
    case "list": case undefined: {
      const q = new URLSearchParams();
      if (has("all")) q.set("all", "true");
      else if (feature) q.set("feature", feature);
      if (flag("category")) q.set("category", flag("category")!);
      const docs = await client.get<any[]>(`/projects/${project.id}/documents?${q}`);
      if (has("json")) return json(docs);
      return table(docs.map(d => ({
        path: d.path, category: d.category, v: d.version, bytes: d.bytes,
      })), ["path", "category", "v", "bytes"]);
    }

    case "upload": {
      const files = rest.filter(f => !f.startsWith("--"));
      if (!files.length) {
        throw new ApiError(400,
          `usage: scyne doc upload <file...> --as sop|transcripts|notes|ui|template [--feature <f>]`);
      }
      const as = flag("as");
      if (as && !CATEGORY_DIR[as]) {
        throw new ApiError(400, `--as must be one of ${Object.keys(CATEGORY_DIR).join(", ")}`);
      }
      // A typed upload is a feature-level document by definition — the folders
      // it routes into only exist under a feature.
      if (as && !feature) throw new ApiError(400, `--as ${as} needs a feature. Pass --feature or \`scyne use <p> <f>\`.`);

      for (const file of files) {
        const bytes = readFileSync(file);
        const name = basename(file);
        const path = as ? `${CATEGORY_DIR[as]}/${name}` : (feature ? `requirements/${name}` : `documents/${name}`);
        const res = await client.post<{ version: number; changed: boolean }>(
          `/projects/${project.id}/documents`, {
            feature: as || feature ? feature : undefined,
            path, category: as ?? null,
            content: bytes.toString("base64"), encoding: "base64",
          });
        out(res.changed
          ? `✓ ${name} → ${path} (v${res.version})`
          : `· ${name} unchanged — identical content already stored`);
      }
      return;
    }

    default:
      throw new ApiError(400, `unknown: scyne doc ${verb}. Try list, upload.`);
  }
}

/** Resolve an email to a user, reporting the addresses that do exist. */
async function findUser(client: Client, email: string): Promise<{ id: string; email: string }> {
  const users = await client.get<{ id: string; email: string }[]>("/users");
  const hit = users.find(u => u.email?.toLowerCase() === email.toLowerCase());
  if (!hit) {
    throw new ApiError(404,
      `no account for '${email}'.\n  Accounts: ${users.map(u => u.email).join(", ") || "(none)"}`);
  }
  return hit;
}

/**
 * Onboarding someone else. `init` claims the installation once; everything
 * after that is an administrator creating an account, and the new person
 * running `scyne login` on their own machine.
 */
async function cmdUser(client: Client, args: string[]): Promise<void> {
  const [verb, email, third] = args;
  switch (verb) {
    case "list": case undefined: {
      const users = await client.get<any[]>("/users");
      if (has("json")) return json(users);
      return table(users.map(u => ({
        email: u.email, name: u.name ?? "—", role: u.role ?? "—", status: u.status ?? "—",
      })), ["email", "name", "role", "status"]);
    }

    case "create": case "add": {
      if (!email) throw new ApiError(400, "usage: scyne user create <email> [--role member|admin|viewer] [--password ...]");
      // A generated password is offered rather than required: an administrator
      // creating ten accounts should not have to invent ten secrets, and one
      // printed once is better than one emailed around.
      const password = flag("password") ?? Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2, 6);
      const user = await client.post<{ id: string; email: string }>("/users", {
        email, password, name: flag("name"), role: flag("role") ?? "member",
      });
      out(`✓ created ${user.email} (${flag("role") ?? "member"})`);
      if (!flag("password")) {
        out(``);
        out(`  temporary password: ${password}`);
        out(`  Give it to them once, in person or over something private —`);
        out(`  it is not stored anywhere and will not be shown again.`);
      }
      out(``);
      out(`  They then run:  scyne login --api ${client.config.apiUrl}`);
      return;
    }

    case "role": {
      if (!email || !third) throw new ApiError(400, "usage: scyne user role <email> <admin|member|viewer>");
      const hit = await findUser(client, email);
      await client.patch(`/users/${hit.id}`, { role: third });
      out(`✓ ${email} is now ${third}`);
      return;
    }

    case "password": {
      if (!email) throw new ApiError(400, "usage: scyne user password <email> [--password ...]");
      const hit = await findUser(client, email);
      const next = flag("password") ?? await prompt(`New password for ${email}: `, { silent: true });
      if (!next) throw new ApiError(400, "a password is required");
      await client.patch(`/users/${hit.id}`, { password: next });
      out(`✓ password changed for ${email}`);
      out(`  Existing API tokens still work — revoke them with \`scyne user disable\` if that matters.`);
      return;
    }

    case "disable": case "enable": {
      if (!email) throw new ApiError(400, `usage: scyne user ${verb} <email>`);
      const hit = await findUser(client, email);
      await client.patch(`/users/${hit.id}`, { status: verb === "disable" ? "disabled" : "active" });
      out(`✓ ${email} ${verb}d`);
      if (verb === "disable") out(`  Their sessions and API tokens stop authenticating immediately.`);
      return;
    }

    default:
      throw new ApiError(400, `unknown: scyne user ${verb}. Try list, create, role.`);
  }
}

/** Who may see one project. Distinct from `user` — that is the account, this is the access. */
async function cmdMember(client: Client, args: string[]): Promise<void> {
  const [verb, email] = args;
  const project = await resolveProject(client, targetProject(client, flag("project")));

  switch (verb) {
    case "list": case undefined: {
      const members = await client.get<any[]>(`/projects/${project.id}/members`);
      if (has("json")) return json(members);
      return table(members.map(m => ({ email: m.email, name: m.name ?? "—", role: m.role })),
        ["email", "name", "role"]);
    }

    case "add": case "grant": {
      if (!email) throw new ApiError(400, "usage: scyne member add <email> [--role owner|editor|viewer]");
      const users = await client.get<any[]>("/users");
      const hit = users.find(u => u.email?.toLowerCase() === email.toLowerCase());
      if (!hit) {
        throw new ApiError(404,
          `no account for '${email}'.\n  Create one first: scyne user create ${email}`);
      }
      const role = flag("role") ?? "editor";
      await client.put(`/projects/${project.id}/members/${hit.id}`, { role });
      out(`✓ ${email} can now access ${project.name} as ${role}`);
      return;
    }

    case "remove": case "revoke": {
      if (!email) throw new ApiError(400, "usage: scyne member remove <email>");
      const members = await client.get<any[]>(`/projects/${project.id}/members`);
      const hit = members.find(m => m.email?.toLowerCase() === email.toLowerCase());
      if (!hit) throw new ApiError(404, `${email} is not a member of ${project.name}`);
      await client.del(`/projects/${project.id}/members/${hit.user_id}`);
      out(`✓ removed ${email} from ${project.name}`);
      return;
    }

    default:
      throw new ApiError(400, `unknown: scyne member ${verb}. Try list, add, remove.`);
  }
}

async function cmdRun(client: Client, args: string[]): Promise<void> {
  const [stage] = args;
  if (!stage || !STAGES[stage]) {
    out(`usage: scyne run <stage> [--project <p>] [--feature <f>]`);
    out(``); out(`Stages:`);
    return table(Object.entries(STAGES).map(([k, s]) => ({ stage: k, level: s.level, produces: s.label })),
      ["stage", "level", "produces"]);
  }
  const projectName = targetProject(client, flag("project"));
  const feature = flag("feature") ?? load().feature;
  if (STAGES[stage].level === "feature" && !feature) {
    throw new ApiError(400, `stage '${stage}' runs per feature. Pass --feature or \`scyne use <p> <f>\`.`);
  }

  const issue = await client.post<{ id: string; identifier: string }>("/issues", {
    workflow: stage,
    params: {
      project: projectName,
      ...(STAGES[stage].level === "feature" ? { feature } : {}),
      ...(flag("confluenceSpace") ? { confluenceSpace: flag("confluenceSpace") } : {}),
      ...(flag("jiraProjectKey") ? { jiraProjectKey: flag("jiraProjectKey") } : {}),
    },
  });
  out(`✓ started ${STAGES[stage].label} — ${issue.identifier}`);
  out(`  watch:   scyne status ${issue.identifier}`);
  out(`  approve: scyne gate list`);
}

async function cmdStatus(client: Client, args: string[]): Promise<void> {
  const [id] = args;
  if (!id) throw new ApiError(400, "usage: scyne status <issue>");
  const issues = await client.get<any[]>("/issues");
  const issue = issues.find(i => i.identifier === id || i.id === id);
  if (!issue) throw new ApiError(404, `no issue '${id}'`);

  const [comments, gates, products] = await Promise.all([
    client.get<any[]>(`/issues/${issue.id}/comments`),
    client.get<any[]>(`/issues/${issue.id}/gates`),
    client.get<any[]>(`/issues/${issue.id}/work-products`),
  ]);
  if (has("json")) return json({ issue, comments, gates, products });

  out(`${issue.identifier}  ${issue.title}`);
  out(`  status: ${issue.status}   step: ${issue.step_index}`);
  out(``); out(`Activity:`);
  for (const c of comments.slice(-20)) out(`  · ${String(c.body).split("\n")[0].slice(0, 110)}`);
  const pending = gates.filter(g => g.status === "pending");
  if (pending.length) {
    out(``); out(`Awaiting approval:`);
    for (const g of pending) out(`  ${g.id}  ${g.payload?.title ?? ""}`);
    out(``); out(`  scyne gate approve ${pending[0].id}`);
  }
  if (products.length) {
    out(``); out(`Work products:`);
    for (const w of products) out(`  ${w.title}  ${w.url}`);
  }
}

async function cmdGate(client: Client, args: string[]): Promise<void> {
  const [verb, id] = args;
  switch (verb) {
    case "list": case undefined: {
      const issues = await client.get<any[]>("/issues");
      const rows: Record<string, unknown>[] = [];
      for (const i of issues.filter(i => i.status === "in_review")) {
        for (const g of await client.get<any[]>(`/issues/${i.id}/gates`)) {
          if (g.status === "pending") rows.push({ gate: g.id, issue: i.identifier, title: g.payload?.title ?? "" });
        }
      }
      return has("json") ? json(rows) : table(rows, ["gate", "issue", "title"]);
    }
    case "approve": case "reject": {
      if (!id) throw new ApiError(400, `usage: scyne gate ${verb} <gateId> [--note "..."]`);
      await client.post(`/gates/${id}/${verb}`, { by: "cli", ...(flag("note") ? { note: flag("note") } : {}) });
      out(`✓ ${verb}d gate ${id}`);
      out(`  The workflow resumes in the background — poll with \`scyne status <issue>\`.`);
      return;
    }
    default:
      throw new ApiError(400, `unknown: scyne gate ${verb}. Try list, approve, reject.`);
  }
}

async function cmdLogs(client: Client, args: string[]): Promise<void> {
  const [runId] = args;
  if (!runId) throw new ApiError(400, "usage: scyne logs <runId> [--follow]");
  let offset = 0;
  for (;;) {
    const res = await client.get<{ content: string; nextOffset: number }>(`/runs/${runId}/log?offset=${offset}`);
    if (res.content) process.stdout.write(res.content);
    offset = res.nextOffset ?? offset;
    if (!has("follow")) break;
    const run = await client.get<any>(`/runs/${runId}`).catch(() => null);
    if (run?.finished_at) break;
    await new Promise(r => setTimeout(r, 3000));
  }
}

async function cmdActions(client: Client, args: string[]): Promise<void> {
  const project = await resolveProject(client, targetProject(client, args[0] ?? flag("project")));
  const rows = await client.get<any[]>(`/projects/${project.id}/actions?limit=${flag("limit") ?? 50}`);
  if (has("json")) return json(rows);
  table(rows.map(a => ({
    when: a.created_at?.slice(0, 19).replace("T", " "), verb: a.verb,
    target: a.target_type ?? "—", detail: JSON.stringify(a.detail).slice(0, 44),
  })), ["when", "verb", "target", "detail"]);
}

async function cmdSpend(client: Client): Promise<void> {
  const by = flag("by") ?? "project";
  const rows = await client.get<any[]>(`/spend?by=${by}`);
  if (has("json")) return json(rows);
  table(rows.map(r => ({
    [by]: r.project_name ?? r.agent_key ?? r.adapter ?? "—",
    runs: r.run_count,
    tokens: Number(r.input_tokens) + Number(r.output_tokens),
    cost: `$${Number(r.cost_usd).toFixed(4)}`,
  })), [by, "runs", "tokens", "cost"]);
}

async function cmdInstalls(client: Client, args: string[]): Promise<void> {
  const [verb, id] = args;
  if (verb === "revoke") {
    if (!id) throw new ApiError(400, "usage: scyne installs revoke <id>");
    await client.del(`/installations/${id}`);
    out(`✓ revoked installation ${id}`);
    return;
  }
  if (verb === "register") {
    const inst = await client.post<{ id: string }>("/installations", {
      machineId: machineId(), hostname: process.env.HOSTNAME ?? undefined,
      os: process.platform, pluginVersion: flag("version") ?? "dev",
    });
    out(`✓ registered this machine (${inst.id})`);
    return;
  }
  const rows = await client.get<any[]>("/installations");
  if (has("json")) return json(rows);
  table(rows.map(r => ({
    id: r.id.slice(0, 8), machine: r.hostname ?? r.machine_id.slice(0, 12), os: r.os,
    version: r.plugin_version, lastSeen: r.last_seen_at?.slice(0, 19).replace("T", " "),
    state: r.revoked_at ? "revoked" : "active",
  })), ["id", "machine", "os", "version", "lastSeen", "state"]);
}

async function cmdChat(client: Client, args: string[]): Promise<void> {
  if (args[0] === "history") {
    const convos = await client.get<any[]>("/conversations");
    if (!convos.length) return out("  (no conversations yet)");
    for (const c of convos.slice(0, 5)) {
      out(`--- ${c.title ?? c.id.slice(0, 8)}  ${c.updated_at?.slice(0, 19).replace("T", " ")}`);
      for (const m of await client.get<any[]>(`/conversations/${c.id}/messages`)) {
        const text = Array.isArray(m.content)
          ? m.content.map((b: any) => b?.text ?? "").join(" ")
          : String(m.content);
        out(`  ${m.role.padEnd(9)} ${text.slice(0, 100)}`);
      }
    }
    return;
  }
  throw new ApiError(400, "usage: scyne chat history");
}

async function cmdAdapter(client: Client, args: string[]): Promise<void> {
  const config = await client.get<any>("/config");
  if (args[0] === "list" || !args[0]) {
    out(`Registered adapters:`);
    for (const a of config.adapters) {
      out(`  ${a === config.defaults?.adapter ? "→" : " "} ${a}`);
    }
    out(``);
    out(`  The default is set by $SCYNE_ADAPTER at server start — every agent uses it.`);
    return;
  }
  throw new ApiError(400, "usage: scyne adapter list");
}

// --------------------------------------------------------------------- usage

const USAGE = `
scyne — the Scyne pipeline, from the command line

  scyne                            open the interactive session (talk to it in English)

  Setup
    init [--api URL]                 claim a new installation as its first administrator
    login [--api URL]                authenticate and store a CLI token
    whoami                           who you are, and what is currently pinned
    use <project> [feature]          pin what later commands act on

  People  (init is once for the whole installation, not once per person)
    user list | create <email> [--role admin|member|viewer] | role <email> <role>
    member list | add <email> [--role owner|editor|viewer] | remove <email>

  Projects
    project list | create <name> | show [name]
    feature list | add <name>

  Documents
    doc list [--all] [--category C]
    doc upload <file...> --as sop|transcripts|notes|ui|template

  Running the pipeline
    run <stage>                      start a stage (run with no stage to list them)
    status <issue>                   activity, gates and work products
    gate list | approve <id> | reject <id> [--note "..."]
    logs <runId> [--follow]          an agent's transcript

  Visibility
    actions [project]                who did what, newest first
    spend [--by project|agent|adapter]
    installs [list] | register | revoke <id>
    chat history
    adapter list

  Global flags
    --project <name>  --feature <name>  --json  --api <url>
`;

// ---------------------------------------------------------------------- main

async function main(): Promise<void> {
  const [verb, ...rest] = positionals();

  // Bare `scyne` opens the session. Commands stay reachable as one-shots so
  // scripting and CI never have to drive an interactive prompt.
  if (!verb && !has("help")) {
    const { repl } = await import("./repl.ts");
    return repl();
  }
  if (verb === "help" || has("help")) { out(USAGE); return; }
  if (verb === "init") return cmdInit();
  if (verb === "login") return cmdLogin();
  if (verb === "logout") { patch({ token: undefined }); out("✓ logged out"); return; }

  const client = createClient(flag("api") ? { apiUrl: flag("api") } : {});

  switch (verb) {
    case "whoami":   return cmdWhoami(client);
    case "use":      return cmdUse(client, rest);
    case "project":  return cmdProject(client, rest);
    case "feature":  return cmdFeature(client, rest);
    case "user":     return cmdUser(client, rest);
    case "member":   return cmdMember(client, rest);
    case "doc":      return cmdDoc(client, rest);
    case "run":      return cmdRun(client, rest);
    case "status":   return cmdStatus(client, rest);
    case "gate":     return cmdGate(client, rest);
    case "logs":     return cmdLogs(client, rest);
    case "actions":  return cmdActions(client, rest);
    case "spend":    return cmdSpend(client);
    case "installs": return cmdInstalls(client, rest);
    case "chat":     return cmdChat(client, rest);
    case "adapter":  return cmdAdapter(client, rest);
    default:
      throw new ApiError(400, `unknown command '${verb}'. Run \`scyne help\`.`);
  }
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`\nerror: ${message}\n\n`);
  process.exit(1);
});
