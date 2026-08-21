#!/usr/bin/env node
// `scyne` — everything the web app can do, from a terminal.
//
// It lives at the repository root rather than inside packages/orchestrator
// because it is a CONSUMER of that library: it knows what a project, a feature
// and a stage are. The library deliberately knows none of that, and importing
// a consumer's files into it would end that separation (see CLAUDE.md).
//
// Every command goes over HTTP to the same API the browser uses, so parity is
// structural rather than maintained by hand. That is also what lets this ship
// as a standalone package: nothing here imports from the repository and
// nothing here has an npm dependency, so `scripts/build-cli.mjs` can bundle
// cli/ alone into one file a user installs without a clone.

import { basename } from "node:path";
import { createClient, resolveProject, targetProject, ApiError, type Client } from "./client.ts";
import { load, patch, machineId, configPath, DEFAULT_API_URL } from "./config.ts";
import {
  createProject, createFeature, uploadDocument, saveProjectDefinition,
  deleteDocument, replaceDocument,
  CATEGORY_DIR, type DualResult,
} from "./dual.ts";
import { fetchStages, fetchWorkflowSteps, callerParams, type Stage } from "./stages.ts";
import { prompt } from "./prompt.ts";

/* Not a const, and not read straight from process.argv at each site.
   Every flag() / has() / positionals() call below reads THIS, so setting it is
   how the interactive session runs a command that was typed as a slash command
   rather than as an argv. Before that, the session had to tell people to open
   another terminal for two thirds of the CLI. */
let argv: string[] = process.argv.slice(2);

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
/**
 * Flags that take NO value.
 *
 * `positionals()` skips a flag and the token after it, so a boolean missing
 * from this set silently eats its neighbour: `issues --open --project SAPN`
 * parsed as `--open=--project` and left `SAPN` looking like a positional. It
 * only shows up when the flag is not last on the line — which is exactly what
 * the session does, since it appends the pinned `--project` after whatever was
 * typed. Adding a boolean flag means adding it here.
 */
const BOOLEAN_FLAGS = new Set([
  "all", "follow", "json", "yes", "help", "quiet", "clear", "force", "open",
]);

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

// readSecret() and prompt() moved to ./prompt.ts, so cli/repl.ts can offer
// /login with the same hidden-input handling rather than a second copy.

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
  out(`as its SUPERADMIN — the operator of the whole installation, who can`);
  out(`create organisations and see every one of them. It can only be done once.`);
  out(``);

  const email = flag("email") ?? await prompt("Superadmin email: ");
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

/**
 * Organisations. Superadmin territory — an ordinary administrator sees their
 * own as a list of one, which is the honest answer to "which may I act in"
 * and keeps a switcher from being an error state for most users.
 */
async function cmdOrg(client: Client, args: string[]): Promise<void> {
  const [verb, name] = args;
  switch (verb) {
    case "list": case undefined: {
      const orgs = await client.get<Array<{
        id: string; name: string; slug: string; status: string;
        stats: { users: string; projects: string; features: string; issues: string };
      }>>("/orgs");
      if (has("json")) return json(orgs);
      const pinned = load().org;
      table(orgs.map(o => ({
        "": o.slug === pinned ? "*" : " ",
        name: o.name, slug: o.slug, status: o.status,
        users: o.stats.users, projects: o.stats.projects,
        features: o.stats.features, issues: o.stats.issues,
      })));
      return;
    }
    case "create": {
      if (!name) throw new ApiError(400, "usage: scyne org create <name> [--slug <slug>]");
      const org = await client.post<{ name: string; slug: string }>(
        "/orgs", { name, ...(flag("slug") ? { slug: flag("slug") } : {}) });
      out(`✓ created ${org.name} (${org.slug})`);
      out(`  Work in it with \`scyne org use ${org.slug}\``);
      return;
    }
    case "use": {
      if (has("clear")) { patch({ org: undefined }); out("✓ acting as your own organisation"); return; }
      if (!name) throw new ApiError(400, "usage: scyne org use <slug> | scyne org use --clear");
      // Resolved BEFORE it is pinned: a typo discovered on the next command
      // looks like a permissions problem rather than like a typo.
      const orgs = await client.get<Array<{ slug: string; name: string }>>("/orgs");
      const hit = orgs.find(o => o.slug === name.toLowerCase());
      if (!hit) {
        throw new ApiError(404,
          `no organisation '${name}'.\n` +
          `  You can act as: ${orgs.map(o => o.slug).join(", ") || "(none)"}`);
      }
      patch({ org: hit.slug });
      out(`✓ acting as ${hit.name} (${hit.slug})`);
      return;
    }
    case "show": {
      const slug = name ?? load().org;
      if (!slug) throw new ApiError(400, "usage: scyne org show <slug>");
      const orgs = await client.get<Array<{ id: string; slug: string }>>("/orgs");
      const hit = orgs.find(o => o.slug === slug.toLowerCase());
      if (!hit) throw new ApiError(404, `no organisation '${slug}'`);
      return json(await client.get(`/orgs/${hit.id}`));
    }
    case "archive": {
      if (!name) throw new ApiError(400, "usage: scyne org archive <slug>");
      const orgs = await client.get<Array<{ id: string; slug: string; name: string }>>("/orgs");
      const hit = orgs.find(o => o.slug === name.toLowerCase());
      if (!hit) throw new ApiError(404, `no organisation '${name}'`);
      await client.del(`/orgs/${hit.id}`);
      // Archive, never delete — its issues, runs and spend are still referenced.
      out(`✓ archived ${hit.name}. Its history is kept and still reachable by id.`);
      if (load().org === hit.slug) { patch({ org: undefined }); out(`  Cleared your pin.`); }
      return;
    }
    default:
      throw new ApiError(400, `unknown: scyne org ${verb}. Try list, create, use, show, archive.`);
  }
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
      // Both sides. The database column is what `project show` prints; the file
      // at projects/<p>/description.md is what every SKILL reads. This wrote
      // the second with NO credential, and every /api route but /api/auth needs
      // one — so it 401'd, the bare `.catch` swallowed it, and the definition
      // reached no agent while reporting success.
      reportDual(`${name} — project definition`, await saveProjectDefinition(client, { project: name, description: text }));
      out(`  every skill reads this before any discovery document.`);
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
  // A detail can be several lines — `no project named 'X'.` carries a second
  // line listing the ones that do exist. Printing it raw put line two in column
  // zero, so the rest is indented under the block instead.
  const rest: string[] = [];
  const show = (s: DualResult["disk"]): string => {
    const [head, ...more] = (s.detail ?? "").split("\n");
    rest.push(...more.filter(l => l.trim()).map(l => l.trim()));
    switch (s.state) {
      case "created": return `✓ ${head || "created"}`;
      case "exists":  return head ? `· ${head}` : `· already there`;
      case "skipped": return `· ${head}`;
      case "failed":  return `✗ ${head}`;
    }
  };
  out(``);
  out(`  ${title}`);
  out(`    folder tree (agents read this)  ${show(r.disk)}`);
  out(`    database (scyne reads this)     ${show(r.db)}`);
  for (const line of rest) out(`      ${line}`);
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

      // Uncategorised INTO A FEATURE is almost always a slip: the file lands at
      // the root of requirements/ rather than in SOP/, Transcripts/, Notes/ or
      // UI/, and the BA is told what each of those folders means. Said once,
      // not refused — a loose file is legal, just rarely what was meant.
      if (!as && feature) {
        out(`  note: no --as, so this goes to requirements/ uncategorised.`);
        out(`        the BA treats ${Object.keys(CATEGORY_DIR).join(", ")} differently — pass one.`);
      }
      for (const file of files) {
        const r = await uploadDocument(client, { project: project.name, feature, file, as });
        reportDual(String(r.extra?.path ?? file), r);
      }
      return;
    }

    // A document that went to the wrong feature, or a policy the client has
    // superseded, used to be correctable only from the filesystem — and doing
    // it there left the database row behind. Both verbs go through the chatbot,
    // which owns the disk half and retires the row in the same request.
    case "delete": case "rm": {
      const paths = rest.filter(f => !f.startsWith("--"));
      if (!paths.length) {
        throw new ApiError(400,
          `usage: scyne doc delete <path...> [--feature <f>]\n` +
          `  <path> is what \`scyne doc list\` prints, e.g. requirements/SOP/handling.md`);
      }
      for (const docPath of paths) {
        const r = await deleteDocument(client, { project: project.name, feature, path: docPath });
        reportDual(docPath, r);
        // Said explicitly: the archived source goes too, because leaving it
        // means the next conversion pass rebuilds the document.
        const removed = (r.extra?.removed as string[] | undefined) ?? [];
        if (removed.length > 1) out(`  also removed ${removed.slice(1).join(", ")}`);
      }
      return;
    }

    case "replace": {
      const [docPath, file] = rest.filter(f => !f.startsWith("--"));
      if (!docPath || !file) {
        throw new ApiError(400,
          `usage: scyne doc replace <path> <file> [--feature <f>]\n` +
          `  <path> is the document to replace, <file> the new one on this machine`);
      }
      const r = await replaceDocument(client, { project: project.name, feature, path: docPath, file });
      reportDual(String(r.extra?.path ?? docPath), r);
      return;
    }

    default:
      throw new ApiError(400, `unknown: scyne doc ${verb}. Try list, upload, replace, delete.`);
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

/** Resolve `SCY-7` (what every command PRINTS) or a uuid to an issue. */
async function resolveIssue(client: Client, given: string): Promise<{ id: string; identifier: string; status: string }> {
  const issues = await client.get<Array<{ id: string; identifier: string; status: string }>>("/issues");
  const hit = issues.find(i => i.identifier === given || i.id === given);
  if (!hit) {
    throw new ApiError(404,
      `no issue '${given}'.\n  Open ones: ${issues.filter(i => i.status !== "done")
        .map(i => i.identifier).slice(0, 12).join(", ") || "(none)"}`);
  }
  return hit;
}

/**
 * Stop, or restart, an issue that is already going.
 *
 * Three verbs rather than two, because "stop" means two different things and
 * guessing wrong is expensive: pausing waits for the step in flight (nothing
 * is discarded), pausing with --force kills it now (its partial spend is
 * gone), and cancelling ends the issue for good.
 */
async function cmdRunControl(client: Client, verb: "pause" | "cancel" | "resume", args: string[]): Promise<void> {
  const [given] = args;
  if (!given) throw new ApiError(400, `usage: scyne run ${verb} <SCY-7>${verb === "pause" ? " [--force]" : ""}`);
  const issue = await resolveIssue(client, given);
  const force = verb === "pause" && has("force");

  if (verb === "cancel" && !has("yes")) {
    const answer = await prompt(`Cancel ${issue.identifier}? It cannot be resumed. [y/N] `);
    if (!/^y(es)?$/i.test(answer.trim())) { out("· left alone"); return; }
  }

  await client.post(`/issues/${issue.id}/${verb}`, force ? { force: true } : {});

  if (verb === "resume") { out(`✓ resuming ${issue.identifier} from where it stopped`); }
  else if (verb === "cancel") { out(`✓ cancelling ${issue.identifier} — it will not resume`); }
  else if (force) { out(`✓ stopping ${issue.identifier} now; it will park at the step it was on`); }
  else {
    out(`✓ pause requested for ${issue.identifier}`);
    // The one thing worth saying out loud: a graceful pause is not immediate,
    // and an agent step is measured in tens of minutes.
    out(`  The step in flight finishes first — that can take as long as an agent run.`);
    out(`  Use --force to stop it now, at the cost of that step's work.`);
  }
  out(`  watch: scyne status ${issue.identifier}`);
}

async function cmdRun(client: Client, args: string[]): Promise<void> {
  const [stage] = args;
  // The control verbs live under `run` because that is the noun they act on:
  // `scyne run pause SCY-7` reads as pausing a run, and a top-level `pause`
  // would collide with the stage names in the same position.
  if (stage === "pause" || stage === "cancel" || stage === "resume") {
    return cmdRunControl(client, stage, args.slice(1));
  }
  // Asked of the server rather than read from a bundled copy — see stages.ts.
  const stages = await fetchStages(client);
  const def: Stage | undefined = stage ? stages[stage] : undefined;
  if (!def) {
    if (stage) out(`no stage '${stage}' on this server.`);
    out(`usage: scyne run <stage> [--project <p>] [--feature <f>]`);
    out(``); out(`Stages:`);
    // Variants are the same stage in another mode, so listing all eighteen
    // would bury the ten a caller picks from. They are still runnable, and the
    // line below says so rather than leaving them undiscoverable.
    table(Object.values(stages).filter(s => !s.variantOf)
      .map(s => ({ stage: s.key, level: s.level, produces: s.label })),
      ["stage", "level", "produces"]);
    out(``);
    out(`  revise an artefact: scyne run revise-<stage> --instruction "…"`);
    return;
  }
  const projectName = targetProject(client, flag("project"));
  const feature = flag("feature") ?? load().feature;
  if (def.level === "feature" && !feature) {
    throw new ApiError(400, `stage '${stage}' runs per feature. Pass --feature or \`scyne use <p> <f>\`.`);
  }

  // Everything else the workflow interpolates, taken from `--name value`.
  // Passing them through BY NAME rather than from a hard-coded list is what
  // lets a stage that starts reading a new variable work with no CLI change —
  // and is how `revise-*` receives its `--instruction`.
  //
  // Missing ones are refused here because the engine's own rule is that every
  // placeholder must resolve: `interpolate` throws `unknown placeholder`, and
  // it does so mid-run, after the issue exists. Refusing upfront turns that
  // into a usage error, which is what it is.
  const needed = callerParams(def);
  const missing = needed.filter(name => flag(name) === undefined);
  if (missing.length) {
    throw new ApiError(400,
      `stage '${stage}' needs ${missing.map(n => `--${n} <value>`).join(", ")}`);
  }
  const extra: Record<string, string> = {};
  for (const name of needed) extra[name] = flag(name)!;

  const issue = await client.post<{ id: string; identifier: string }>("/issues", {
    workflow: stage,
    params: {
      project: projectName,
      ...(def.level === "feature" ? { feature } : {}),
      ...extra,
    },
  });
  out(`✓ started ${def.label} — ${issue.identifier}`);
  out(`  watch:   scyne status ${issue.identifier}`);
  out(`  approve: scyne gate list`);
}

/** How long ago, in a column narrow enough to sit beside five others. */
function ago(iso?: string | null): string {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return "—";
  // A clock skew between this machine and the server reads as a negative age.
  // "just now" is the honest rendering; a negative number looks like a bug.
  if (ms < 60_000) return "just now";
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** The statuses an issue can sit at without anyone noticing. */
const NEEDS_A_HUMAN: Record<string, string> = {
  in_review: "awaiting approval",
  blocked:   "blocked",
  paused:    "paused",
};

/**
 * Every issue, as a table.
 *
 * `status <id>` answers "what happened to this one" and `gate list` answers
 * "what needs approving", but there was nothing that answered "what is going
 * on" — the console has an Issues tab and the terminal had no equivalent, so
 * the only way to find an identifier was to remember it.
 *
 * Scoped to the pinned project by default, because that is the question being
 * asked nine times in ten; `--all` is how you see the rest.
 */
async function cmdIssues(client: Client, args: string[]): Promise<void> {
  if (args[0] && !args[0].startsWith("--")) {
    throw new ApiError(400,
      `usage: scyne issues [--open] [--status S] [--project P] [--feature F] [--all] [--limit N]\n` +
      `  For one issue's detail, use \`scyne status ${args[0]}\`.`);
  }

  // The server filters by status (it is indexed); project and feature live
  // inside `params` as JSON, so those are filtered here.
  const status = flag("status");
  const issues = await client.get<any[]>(`/issues${status ? `?status=${encodeURIComponent(status)}` : ""}`);

  const all = has("all");
  const wantProject = all ? undefined : (flag("project") ?? load().project);
  const wantFeature = all ? undefined : (flag("feature") ?? load().feature);
  const eq = (a: unknown, b?: string): boolean =>
    !b || String(a ?? "").toLowerCase() === b.toLowerCase();

  let rows = issues.filter(i =>
    eq(i.params?.project, wantProject) && eq(i.params?.feature, wantFeature));
  // `--open` is the triage view: everything that has not finished one way or
  // the other. Composed with --status rather than replacing it.
  if (has("open")) rows = rows.filter(i => i.status !== "done" && i.status !== "cancelled");

  if (has("json")) return json(rows);

  if (!rows.length) {
    const scope = [wantProject, wantFeature].filter(Boolean).join(" / ");
    out(`  (no issues${scope ? ` for ${scope}` : ""}${has("open") ? " still open" : ""})`);
    if (scope && !all) out(`  ${"Use --all to see every project's."}`);
    return;
  }

  // Newest LAST: the server orders ascending, and in a terminal the final row
  // is the one nearest the cursor. Reversing it would put the issue you just
  // started at the top of a screen you have to scroll back to.
  const limit = Number(flag("limit") ?? 30);
  const dropped = Math.max(0, rows.length - limit);
  const shown = dropped ? rows.slice(-limit) : rows;

  // One extra request, and only when there is something to annotate: without
  // it `step_index` is a number with no denominator.
  const steps = await fetchWorkflowSteps(client).catch(() => ({} as Record<string, { count: number; types: string[] }>));

  const table_ = shown.map(i => {
    const w = steps[i.workflow_key ?? ""];
    const at = w?.types?.[i.step_index];
    return {
      issue: i.identifier,
      status: i.status,
      // `5/6 gate` — where it is AND what that step does. A done issue has run
      // off the end of its own list, so it reads `6/6` with no step name.
      step: w ? `${Math.min(i.step_index + 1, w.count)}/${w.count}${at ? ` ${at}` : ""}` : String(i.step_index),
      workflow: i.workflow_key ?? "—",
      target: [i.params?.project, i.params?.feature].filter(Boolean).join(" / ") || "—",
      updated: ago(i.updated_at),
      // A control request is a REQUEST, not a status: it is honoured at the
      // engine's next step boundary, which can be twenty minutes away. An
      // issue reading `in_progress` half an hour after someone pressed Cancel
      // is the single most confusing state this system has, so it is named.
      note: i.control_request ? `${String(i.control_request).replace("_", " ")} requested` : "",
    };
  });

  const columns = ["issue", "status", "step", "workflow", "target", "updated"];
  if (table_.some(r => r.note)) columns.push("note");
  table(table_.map(r => ({ ...r, note: r.note || "—" })), columns);

  if (dropped) {
    out(``);
    out(`  ${dropped} older ${dropped === 1 ? "issue" : "issues"} not shown — pass --limit ${rows.length} for all of them.`);
  }

  // What to do next, and only about issues that are actually waiting. A list
  // that ends without saying which of twelve rows needs a person is a list
  // somebody has to re-read.
  //
  // Counted over `rows`, the whole scope — NOT `shown`. A pending gate hidden
  // because a display limit pushed it off the top is a gate nobody approves,
  // and the identifiers are named here anyway, so the footer stays actionable
  // whether or not its issue made the window.
  const waiting = rows.filter(i => NEEDS_A_HUMAN[i.status]);
  if (waiting.length) {
    out(``);
    for (const [status, label] of Object.entries(NEEDS_A_HUMAN)) {
      const these = waiting.filter(i => i.status === status);
      if (!these.length) continue;
      const ids = these.map(i => i.identifier).join(", ");
      out(`  ${String(these.length).padStart(2)} ${label.padEnd(18)} ${ids}`);
    }
    const gated = waiting.find(i => i.status === "in_review");
    const stuck = waiting.find(i => i.status === "blocked" || i.status === "paused");
    if (gated) out(`     ${"scyne gate list"}`);
    if (stuck) out(`     scyne status ${stuck.identifier}   ${"# then: scyne run resume " + stuck.identifier}`);
  }
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
      who: a.user_email ?? byId.get(a.user_id) ?? a.agent_key ?? "—",
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

  // The actor and the project come JOINED on the row. Resolving them here
  // against this organisation's own /users could not name a superadmin acting
  // in it from outside — and that is exactly the actor an audit trail most
  // needs to name. The maps are kept only as a fallback for rows written
  // before the join existed.
  const users = await client.get<any[]>("/users").catch(() => []);
  const byId = new Map<string, string>(users.map(u => [u.id, u.email]));
  const projects = await client.get<any[]>("/projects").catch(() => []);
  const projName = new Map<string, string>(projects.map(p => [p.id, p.name]));

  table(rows.map(a => ({
    when: String(a.created_at).slice(0, 19).replace("T", " "),
    who: a.user_email ?? byId.get(a.user_id) ?? a.agent_key ?? "—",
    project: a.project_name ?? projName.get(a.project_id) ?? "—",
    did: a.verb,
    detail: JSON.stringify(a.detail ?? {}).slice(0, 40),
  })), ["when", "who", "project", "did", "detail"]);
}

/**
 * Where the money went.
 *
 * Reported and estimated are shown as SEPARATE columns rather than added into
 * one. A merged total cannot be audited: nobody reading it can tell which half
 * came from a vendor's own billing and which half came from a price table
 * somebody typed. Codex reports no cost at all, so on a Codex-first install
 * the second column is most of the bill.
 */
async function cmdSpend(client: Client): Promise<void> {
  const by = flag("by") ?? "project";
  const q = new URLSearchParams({ by });
  for (const f of ["project", "feature", "user", "since", "until"]) {
    const v = flag(f);
    if (v) q.set(f, v);
  }
  const rows = await client.get<any[]>(`/spend?${q}`);
  if (has("json")) return json(rows);
  if (!rows.length) { out("  (nothing recorded yet)"); return; }

  const label = (r: any): string =>
    r.project_name ?? r.feature_name ?? r.user_email ?? r.agent_key ?? r.adapter ?? r.model ?? "—";
  const money = (v: unknown): string => (Number(v) ? `$${Number(v).toFixed(4)}` : "—");

  table(rows.map(r => ({
    [by]: label(r),
    runs: r.run_count,
    tokens: (Number(r.input_tokens) + Number(r.output_tokens)).toLocaleString("en-AU"),
    reported: money(r.reported_cost_usd),
    // `~` on sight: this figure is ours, not the CLI's.
    estimated: Number(r.estimated_cost_usd) ? `~${money(r.estimated_cost_usd)}` : "—",
    unpriced: r.unpriced_run_count === "0" ? "" : `${r.unpriced_run_count} run(s)`,
  })), [by, "runs", "tokens", "reported", "estimated", "unpriced"]);

  const totalReported = rows.reduce((n, r) => n + Number(r.reported_cost_usd), 0);
  const totalEstimated = rows.reduce((n, r) => n + Number(r.estimated_cost_usd), 0);
  const unpriced = rows.reduce((n, r) => n + Number(r.unpriced_run_count), 0);
  out("");
  out(`  $${totalReported.toFixed(4)} reported` +
      (totalEstimated ? ` + ~$${totalEstimated.toFixed(4)} estimated` : "") +
      (unpriced ? `   (${unpriced} run(s) carry no figure at all)` : ""));
}

/**
 * The model price catalogue.
 *
 * It matters more than a price list looks like it should: a Codex run reports
 * no cost, so these rows decide what every run is recorded as costing AND
 * whether a cost budget fires.
 */
/** `2026-08-31T00:00:00.000Z` → `2026-08-31`. */
const day = (v: unknown): string => (v ? String(v).slice(0, 10) : "—");

async function cmdModels(client: Client, args: string[]): Promise<void> {
  const [verb] = args;
  switch (verb) {
    case "list": case undefined: {
      const models = await client.get<any[]>("/models");
      if (has("json")) return json(models);
      table(models.map(m => ({
        model: m.model,
        provider: m.provider,
        "in $/M": m.input_per_mtok ?? "—",
        "cached": m.cached_input_per_mtok ?? "—",
        "out $/M": m.output_per_mtok ?? "—",
        runs: m.run_count,
        // A date, not a timestamp: `retires_on` is a DATE column and the
        // driver hands it back as an ISO instant, which reads as false
        // precision for something announced to the day.
        note: m.retired ? `RETIRED ${day(m.retires_on)}`
            : m.retiring_soon ? `retires ${day(m.retires_on)}`
            : m.unpriced ? "no published price" : "",
      })));
      const risky = models.filter(m => m.retiring_soon || m.retired);
      if (risky.length) {
        out("");
        // Worth saying loudly: a retired model is not a slow run, it is every
        // run dying on its first request.
        out(`  ${risky.length} model(s) at or near retirement. A run on a retired model fails immediately.`);
      }
      return;
    }
    case "set": {
      const model = args[1];
      if (!model) throw new ApiError(400, "usage: scyne models set <model> --input <n> --output <n> [--cached <n>]");
      const provider = flag("provider") ?? "openai";
      const num = (f: string) => (flag(f) === undefined ? undefined : Number(flag(f)));
      const row = await client.put<any>(`/models/${provider}/${encodeURIComponent(model)}`, {
        inputPerMTok: num("input"), cachedInputPerMTok: num("cached"),
        outputPerMTok: num("output"), retiresOn: flag("retires") ?? undefined,
      });
      out(`✓ ${row.provider}/${row.model}: in $${row.input_per_mtok ?? "—"}/M, out $${row.output_per_mtok ?? "—"}/M`);
      return;
    }
    case "proposal": {
      const pending = await client.get<any>("/models/refresh");
      if (!pending) { out("  (no proposal outstanding)"); return; }
      if (has("json")) return json(pending);
      out(`Proposed ${pending.created_at}${pending.source ? ` from ${pending.source}` : ""}`);
      out("");
      if (!pending.diff.length) { out("  (it changes nothing)"); }
      else table(pending.diff.map((d: any) => ({
        model: d.model, field: d.field, from: d.from ?? "—", to: d.to ?? "—",
      })));
      out("");
      out(`  apply:   scyne models apply       (superadmin)`);
      out(`  discard: scyne models discard`);
      return;
    }
    case "apply": {
      const res = await client.post<{ applied: number }>("/models/refresh/apply", {});
      out(`✓ applied ${res.applied} price row(s)`);
      return;
    }
    case "discard": {
      await client.del("/models/refresh");
      out("✓ discarded");
      return;
    }
    default:
      throw new ApiError(400, `unknown: scyne models ${verb}. Try list, set, proposal, apply, discard.`);
  }
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
    logout                           discard it
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
    doc replace <path> <file>                                     swap one document for another
    doc delete <path...>                                          remove it, and its archived original

  Running the pipeline
    run <stage>                      start a stage (run with no stage to list them)
    issues [--open] [--all]          every issue, where it is, what needs you
           [--status S] [--project P] [--feature F] [--limit N] [--json]
    status <issue>                   activity, gates and work products
    gate list | approve <id> | reject <id> [--note "..."]
    logs <runId> [--follow]          an agent's transcript

  Stopping and restarting
    run pause <SCY-7> [--force]      pause it — the step in flight finishes first,
                                      unless --force, which stops the agent now
    run cancel <SCY-7> [--yes]       stop for good; it does not resume
    run resume <SCY-7>               carry on from where it stopped

  Cost
    spend [--by project|feature|user|agent|adapter|model]
          [--project P] [--feature F] [--user email] [--since D] [--until D] [--json]
    models list [--json]             the price catalogue, retirements flagged
    models set <model> --input <n> --output <n> [--cached <n>] [--retires YYYY-MM-DD]
    models proposal                  the outstanding price proposal and its diff
    models apply | discard           apply (superadmin) or discard it

  Organisations  (superadmin)
    org list [--json]                every organisation, with its counts
    org create <name> [--slug s]     create one
    org use <slug> | --clear         act as one for every later command
    org show [<slug>]                one organisation in detail
    org archive <slug>               archive it — never a delete

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
    --project <name>  --feature <name>  --org <slug>  --json  --api <url>
`;

// ---------------------------------------------------------------------- main

/**
 * Run one command as if it had been typed on the command line.
 *
 * Exported for cli/repl.ts, which dispatches anything it does not handle
 * itself here — so every command is a slash command, and one added below is a
 * slash command for free rather than another line in a "run these elsewhere"
 * list that has to be maintained by hand.
 *
 * `init`, `login` and `logout` are the session's own: the first two prompt,
 * and a prompt built on a second readline cannot share stdin with the
 * session's line queue.
 */
export async function runCommand(args: string[]): Promise<void> {
  if (!args.length) throw new ApiError(400, "no command given");
  argv = args;
  return dispatch();
}

async function main(): Promise<void> {
  argv = process.argv.slice(2);

  // Bare `scyne` opens the session. Commands stay reachable as one-shots so
  // scripting and CI never have to drive an interactive prompt.
  if (!positionals().length && !has("help")) {
    const { repl } = await import("./repl.ts");
    return repl();
  }
  return dispatch();
}

async function dispatch(): Promise<void> {
  const [verb, ...rest] = positionals();

  if (verb === "help" || has("help")) { out(USAGE); return; }
  if (verb === "init") return cmdInit();
  if (verb === "login") return cmdLogin();
  if (verb === "logout") { patch({ token: undefined }); out("✓ logged out"); return; }

  const client = createClient({
    ...(flag("api") ? { apiUrl: flag("api") } : {}),
    // An explicit --org wins over whatever `scyne org use` pinned.
    ...(flag("org") ? { org: flag("org") } : {}),
  });

  switch (verb) {
    case "whoami":   return cmdWhoami(client);
    case "use":      return cmdUse(client, rest);
    case "org":      return cmdOrg(client, rest);
    case "project":  return cmdProject(client, rest);
    case "feature":  return cmdFeature(client, rest);
    case "user":     return cmdUser(client, rest);
    case "member":   return cmdMember(client, rest);
    case "doc":      return cmdDoc(client, rest);
    case "run":      return cmdRun(client, rest);
    case "issues":   return cmdIssues(client, rest);
    case "status":   return cmdStatus(client, rest);
    case "gate":     return cmdGate(client, rest);
    case "logs":     return cmdLogs(client, rest);
    case "actions":  return cmdActions(client, rest);
    case "admin":    return cmdAdmin(client, rest);
    case "audit":    return cmdAudit(client);
    case "spend":    return cmdSpend(client);
    case "models":   return cmdModels(client, rest);
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
