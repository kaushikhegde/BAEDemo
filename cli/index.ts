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

import { basename } from "node:path";
import { createInterface } from "node:readline/promises";
import { createClient, resolveProject, targetProject, ApiError, type Client } from "./client.ts";
import { load, patch, machineId, configPath, DEFAULT_API_URL } from "./config.ts";
import {
  createProject, createFeature, uploadDocument, chatUrl, CATEGORY_DIR, type DualResult,
} from "./dual.ts";
// @ts-expect-error — plain ESM with JSDoc types; no .d.ts and none warranted.
import * as pipeline from "../scripts/pipeline.mjs";

const argv = process.argv.slice(2);

// ------------------------------------------------------------------ helpers

function flag(name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

/** Every value of a repeatable flag: `--doc a.md --doc b.pdf`. */
function flagAll(name: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === `--${name}` && argv[i + 1] !== undefined) values.push(argv[i + 1]);
  }
  return values;
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

/**
 * Read a secret from a terminal without echoing it.
 *
 * Written against raw stdin rather than readline, deliberately. The obvious
 * approach — override readline's `_writeToOutput` so keystrokes are swallowed
 * — is wrong twice over. It depends on an internal that Node 24 no longer
 * exposes (the method moved behind a symbol, so touching it throws
 * "Cannot read properties of undefined"), and even where it does exist,
 * muting it hides the PROMPT as well: readline clears the line and re-renders
 * `prompt + input` through that same method on every keystroke, so muting
 * leaves a bare cursor and the command looks like it has hung.
 *
 * Raw mode has neither problem and behaves the same on every Node version.
 * Backspace, Ctrl-C and Ctrl-D are handled here because raw mode means the
 * terminal no longer handles them for us.
 */
function readSecret(label: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const stdin = process.stdin;
    process.stdout.write(label);

    const wasRaw = stdin.isRaw === true;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");

    let value = "";
    const done = (finish: () => void): void => {
      stdin.removeListener("data", onData);
      stdin.setRawMode(wasRaw);
      stdin.pause();
      process.stdout.write("\n");
      finish();
    };

    const onData = (chunk: string): void => {
      for (const ch of chunk) {
        switch (ch) {
          case "\r": case "\n":
            return done(() => resolve(value));
          case "":                       // Ctrl-C
            return done(() => reject(new ApiError(130, "cancelled")));
          case "":                       // Ctrl-D
            return done(() => resolve(value));
          case "": case "\b":            // backspace
            value = value.slice(0, -1);
            break;
          default:
            // Ignore the remaining control characters — arrow keys arrive as
            // escape sequences and would otherwise land in the password.
            if (ch >= " ") value += ch;
        }
      }
    };

    stdin.on("data", onData);
  });
}

/** Ask a question. `silent` hides what is typed, for passwords. */
async function prompt(question: string, opts: { silent?: boolean } = {}): Promise<string> {
  // A terminal is the only place there is anyone to hide input from — and the
  // only place raw mode exists. Piped input (`printf 'pw\n' | scyne init`)
  // goes through readline unchanged.
  if (opts.silent && process.stdin.isTTY) {
    return (await readSecret(`${question.replace(/:\s*$/, "")} (hidden as you type): `)).trim();
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
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
      // Both sides: the folder tree agents read, and the database `scyne`
      // reads. Writing only the database — which this did — produced a project
      // that no agent could ever work on, and no branding.
      const r = await createProject(client, {
        name, description: flag("description"), website: flag("website"),
      });
      reportDual(name, r);
      if (flag("website")) out(`    branding pulled from ${flag("website")}`);

      // The client-wide documents. These are the ones every skill reads before
      // any feature's discovery material, and the capability map cannot start
      // without at least one — so creating a project and uploading its
      // documents is really one act, and the wizard treats it that way too.
      const docs = flagAll("doc");
      for (const file of docs) {
        try {
          const up = await uploadDocument(client, { project: name, feature: null, file });
          reportDual(String(up.extra?.path ?? file), up);
        } catch (err) {
          out(`  ✗ ${file}: ${(err as Error).message.split("\n")[0]}`);
        }
      }

      out(``);
      if (!flag("description")) {
        out(`  Next — the project definition. Every skill reads it before any document:`);
        out(`    scyne project describe ${name} "Who the client is, what they are regulated to do…"`);
      }
      if (!docs.length) {
        out(`  Next — the client-wide documents (policy, legislation, standards):`);
        out(`    scyne doc upload <file...> --project ${name}`);
        out(`    ${"(.docx and .pdf are converted to markdown on arrival)"}`);
      }
      out(`  Then a feature:  scyne feature add "<name>" --project ${name}`);
      return;
    }

    case "describe": {
      if (!name) throw new ApiError(400, `usage: scyne project describe <name> "<the definition>"`);
      const text = args.slice(2).join(" ") || flag("description");
      if (!text) throw new ApiError(400, `usage: scyne project describe <name> "<the definition>"`);
      const proj = await resolveProject(client, name);
      await client.patch(`/projects/${proj.id}`, { description: text });
      // The definition also has to reach description.md, which is what the
      // skills actually read.
      await fetch(`${chatUrl()}/api/project-description`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ project: name, description: text }),
      }).catch(() => null);
      out(`✓ definition saved for ${name}`);
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
      throw new ApiError(400, `unknown: scyne project ${verb}. Try list, create, describe, show.`);
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
      reportDual(`${project.name} / ${name}`,
        await createFeature(client, { project: project.name, feature: name }));
      return;
    }
    default:
      throw new ApiError(400, `unknown: scyne feature ${verb}. Try list, add.`);
  }
}

/** Render what each half of the split did. Shared with the session's version. */
function reportDual(title: string, r: DualResult): void {
  const show = (s: DualResult["disk"]): string => {
    switch (s.state) {
      case "created": return `✓ ${s.detail ?? "created"}`;
      case "exists":  return `· already there`;
      case "skipped": return `· ${s.detail}`;
      case "failed":  return `✗ ${s.detail}`;
    }
  };
  out(``);
  out(`  ${title}`);
  out(`    folder tree (agents read this)  ${show(r.disk)}`);
  out(`    database (scyne reads this)     ${show(r.db)}`);
}

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
        const r = await uploadDocument(client, { project: project.name, feature, file, as });
        reportDual(String(r.extra?.path ?? file), r);
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

/**
 * The superadmin view: everything, in one screen.
 *
 * Admin visibility was previously spread across `user list`, `installs`,
 * `spend` and a per-project `actions` feed, with no way to see activity across
 * projects at all. Someone asking "what is going on here" should not have to
 * know which four commands to run and in which order.
 */
async function cmdAdmin(client: Client, args: string[]): Promise<void> {
  const view = args[0];
  const o = await client.get<any>("/admin/overview").catch((err: ApiError) => {
    if (err.status === 403) throw new ApiError(403, "administrators only — `scyne whoami` shows your role");
    throw err;
  });

  if (has("json")) return json(o);

  const bytes = (n: number): string =>
    n > 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.round(n / 1e3)} KB`;

  // A named section shows only that one, in full.
  const only = (name: string): boolean => !view || view === name;

  if (only("summary") && !view) {
    out(``);
    out(`  ${o.users.length} user(s)  ·  ${o.projects.length} project(s)  ·  ` +
        `${o.installations.filter((i: any) => !i.revoked_at).length} active install(s)`);
    out(`  ${o.documents.count} document(s), ${bytes(o.documents.bytes)}  ·  ` +
        `${o.totals.runs} run(s)  ·  $${o.totals.costUsd.toFixed(4)}`);
    const issues = Object.entries(o.issues) as [string, number][];
    if (issues.length) out(`  issues: ${issues.map(([s, n]) => `${n} ${s}`).join("  ·  ")}`);
  }

  if (only("people")) {
    out(``); out(`  PEOPLE`);
    table(o.users.map((u: any) => ({
      email: u.email, role: u.role, status: u.status, since: String(u.created_at).slice(0, 10),
    })), ["email", "role", "status", "since"]);
  }

  if (only("installs")) {
    out(``); out(`  INSTALLATIONS`);
    table(o.installations.map((i: any) => ({
      machine: i.hostname ?? i.machine_id.slice(0, 12), os: i.os ?? "—",
      version: i.plugin_version ?? "—",
      lastSeen: i.last_seen_at ? String(i.last_seen_at).slice(0, 16).replace("T", " ") : "never",
      state: i.revoked_at ? "revoked" : "active",
    })), ["machine", "os", "version", "lastSeen", "state"]);
  }

  if (only("projects")) {
    out(``); out(`  PROJECTS`);
    const cost = new Map<string, number>(
      o.spend.map((s: any) => [String(s.project_name), Number(s.cost_usd ?? 0)]));
    table(o.projects.map((p: any) => ({
      name: p.name, cost: `$${(cost.get(p.name) ?? 0).toFixed(4)}`,
      created: String(p.created_at).slice(0, 10),
    })), ["name", "cost", "created"]);
  }

  if (only("activity")) {
    out(``); out(`  RECENT ACTIVITY`);
    const byId = new Map<string, string>(o.users.map((u: any) => [u.id, u.email]));
    table(o.recentActions.map((a: any) => ({
      when: String(a.created_at).slice(0, 16).replace("T", " "),
      who: byId.get(a.user_id) ?? a.agent_key ?? "—",
      did: a.verb,
    })), ["when", "who", "did"]);
  }

  if (!view) {
    out(``);
    out(`  Narrow it:  scyne admin people | installs | projects | activity`);
    out(`  Full audit: scyne audit [--limit 200]`);
  }
}

/** Cross-project audit. The per-project feed is `scyne actions`. */
async function cmdAudit(client: Client): Promise<void> {
  const rows = await client.get<any[]>(`/actions?limit=${flag("limit") ?? 100}`)
    .catch((err: ApiError) => {
      if (err.status === 403) throw new ApiError(403, "administrators only — `scyne actions` shows one project");
      throw err;
    });
  if (has("json")) return json(rows);

  const users = await client.get<any[]>("/users").catch(() => []);
  const byId = new Map<string, string>(users.map(u => [u.id, u.email]));
  const projects = await client.get<any[]>("/projects").catch(() => []);
  const projName = new Map<string, string>(projects.map(p => [p.id, p.name]));

  table(rows.map(a => ({
    when: String(a.created_at).slice(0, 19).replace("T", " "),
    who: byId.get(a.user_id) ?? a.agent_key ?? "—",
    project: projName.get(a.project_id) ?? "—",
    did: a.verb,
    detail: JSON.stringify(a.detail ?? {}).slice(0, 40),
  })), ["when", "who", "project", "did", "detail"]);
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
  const [verb, name] = args;
  const info = await client.get<{
    settings: { scope: string; scope_key: string; key: string; value: string }[];
    available: string[]; configuredDefault: string; scopes: string[];
  }>("/settings");

  const adapterAt = (scope: string, key: string): string | undefined =>
    info.settings.find(s => s.scope === scope && s.scope_key === key && s.key === "adapter")?.value;

  switch (verb) {
    case "list": case undefined: {
      if (has("json")) return json(info);
      const org = adapterAt("company", "*");
      out(``);
      out(`  Registered on this server:`);
      for (const a of info.available) out(`    ${a}`);
      out(``);
      out(`  Organisation default:  ${org ?? info.configuredDefault}${org ? "" : "   (from the config file / $SCYNE_ADAPTER)"}`);

      const perProject = info.settings.filter(s => s.scope === "project" && s.key === "adapter");
      if (perProject.length) {
        out(``);
        out(`  Per project:`);
        table(perProject.map(s => ({ project: s.scope_key, adapter: s.value })), ["project", "adapter"]);
      }
      out(``);
      out(`  Set it:    scyne adapter set <name> [--project <p>]`);
      out(`  Unset it:  scyne adapter unset [--project <p>]`);
      out(`  Precedence: step → agent → project → organisation → config file`);
      return;
    }

    case "set": {
      if (!name) throw new ApiError(400, `usage: scyne adapter set <${info.available.join("|")}> [--project <p>]`);
      const project = flag("project") ?? load().project;
      const body = project
        ? { scope: "project", scopeKey: project, key: "adapter", value: name }
        : { scope: "company", key: "adapter", value: name };
      await client.put("/settings", body);
      out(project
        ? `✓ ${project} now runs on ${name}`
        : `✓ the whole organisation now runs on ${name}`);
      out(`  Takes effect on the next run — no restart needed.`);
      return;
    }

    case "unset": case "clear": {
      const project = flag("project") ?? load().project;
      const q = project
        ? `scope=project&scopeKey=${encodeURIComponent(project)}&key=adapter`
        : `scope=company&key=adapter`;
      await client.del(`/settings?${q}`);
      out(project
        ? `✓ ${project} falls back to the organisation default`
        : `✓ the organisation falls back to the config file`);
      return;
    }

    default:
      throw new ApiError(400, `unknown: scyne adapter ${verb}. Try list, set, unset.`);
  }
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
    user list
    user create <email> [--role admin|member|viewer] [--password …] [--name …]
    user role <email> <admin|member|viewer>
    user password <email>            change it (prompts, no echo)
    user disable <email> | enable <email>
    member list                      who can see the current project
    member add <email> [--role owner|editor|viewer]
    member remove <email>

  Projects
    project list | create <name> [--description "…"] [--website …] | describe <name> "…" | show
    feature list | add <name>

  Documents
    doc list [--all] [--category C]
    doc upload <file...> --as sop|transcripts|notes|ui|template   (needs --feature)
    doc upload <file...> --project P                              client-wide documents

  Running the pipeline
    run <stage>                      start a stage (run with no stage to list them)
    status <issue>                   activity, gates and work products
    gate list | approve <id> | reject <id> [--note "..."]
    logs <runId> [--follow]          an agent's transcript

  Superadmin  (administrators only)
    admin                            everything in one screen
    admin people | installs | projects | activity
    audit [--limit N]                who did what, across ALL projects

  Visibility
    actions [project] [--limit N]    who did what, newest first
    spend [--by project|agent|adapter]   cost, grouped. Default: project
    installs [list]                  who installed the plugin, and where
    installs register [--version V]  register this machine
    installs revoke <id>             stop that installation authenticating
    chat history
    adapter list                     what is registered, and what runs where
    adapter set <name> [--project P] switch a project, or the whole org
    adapter unset [--project P]      fall back to the next scope up

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
    case "admin":    return cmdAdmin(client, rest);
    case "audit":    return cmdAudit(client);
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
