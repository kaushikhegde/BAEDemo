// The interactive session — `scyne` with no arguments.
//
// You type plain English; a model decides what to do and does it. That model
// and its tools are NOT reimplemented here: the session posts to the same
// `/api/chat` the React app posts to, and dispatches the same `tool_use`
// blocks to the same trigger endpoints. Rewriting the prompt and the tool
// declarations for the terminal would have produced a second assistant that
// drifted from the web one within a week — and the whole point of "everything
// the web can do" is that they are the same thing.
//
// So there are two servers behind this prompt, and that is deliberate rather
// than accidental: the orchestrator (:3100) owns projects, documents, gates
// and identity; the chatbot server (:4000) owns the conversation. A slash
// command goes to the first, a sentence goes to the second.

import { createInterface, type Interface } from "node:readline/promises";
import { load, patch, DEFAULT_API_URL } from "./config.ts";
import { createClient, ApiError, type Client } from "./client.ts";
import {
  createProject, createFeature, uploadDocument, saveProjectDefinition, extractBrand,
  chatAuth, CATEGORY_DIR, type DualResult,
} from "./dual.ts";
import { c, out, markdown, spinner, banner, promptLabel, tick, cross, dot } from "./ui.ts";
import { readSecret, setPromptReader } from "./prompt.ts";

/** Anthropic-shaped blocks, which is what `/api/chat` returns. */
interface Block { type: string; text?: string; name?: string; input?: Record<string, unknown> }
interface ChatTurn { role: "user" | "assistant"; content: Block[] | string }

export const DEFAULT_CHAT_URL = "http://127.0.0.1:4000";

/**
 * Tool name → the chatbot endpoint that fires it. Mirrors the table in
 * App.tsx; kept as data rather than a switch so a stage added there is one
 * line here, and a mismatch is visible instead of buried in a branch.
 */
const TRIGGERS: Record<string, { path: string; label: string }> = {
  trigger_requirement_generation: { path: "/api/trigger", label: "Requirements" },
  trigger_data_model: { path: "/api/data-model/trigger", label: "Data Model" },
  trigger_solution_design: { path: "/api/solution-design/trigger", label: "Solution Design" },
  trigger_capability_map: { path: "/api/capability-map/trigger", label: "Capability Map" },
  trigger_solution_architecture: { path: "/api/solution-architecture/trigger", label: "Solution Architecture" },
  trigger_test_cases: { path: "/api/test-cases/trigger", label: "Test Cases" },
  trigger_personas: { path: "/api/personas/trigger", label: "Personas & Journeys" },
  trigger_ui_mockups: { path: "/api/ui-mockups/trigger", label: "UI Mockups" },
  trigger_ui_build: { path: "/api/ui-agent/trigger", label: "Companion App" },
};

/**
 * Names a project or feature may not take.
 *
 * `stage.mjs` resolves the LEVEL before the name, so a single trailing token is
 * read as a stage rather than as a feature — which makes a feature called
 * `personas` unreachable from the CLI and makes it appear as a stage in the
 * target picker. The rest are the project's own folder names. `/api/features`
 * refuses the same list; checking here too means the wizard says so before
 * asking three more questions.
 */
const RESERVED = new Set([
  "capabilities", "personas", "app", "all", "baseline",
  "solutions", "documents", "design", "original-files", "outputs",
]);

/** The palette, as both `/api/projects` and `/api/brand/extract` report it. */
interface BrandTheme {
  brand?: string; brandDeep?: string; accent?: string;
  logoText?: string; fontFamily?: string; hasLogo?: boolean;
}

/** 409 codes the backend returns for an unmet prerequisite, in plain words. */
const GATE_REASONS: Record<string, string> = {
  no_product_summary: "there is no product summary yet — run the requirements stage first",
  no_data_model: "there is no data model yet — run the data model stage first",
  no_capability_map: "there is no capability map yet — run the capability map first",
  no_documents: "that feature has no documents yet — upload an SOP or a transcript",
  no_artefacts: "nothing has been generated for this project yet",
  missing_inputs: "some required input folders are empty",
  not_generated: "that artefact has not been generated yet, so there is nothing to revise",
};

async function postChat(chatUrl: string, body: unknown): Promise<{ content: Block[] }> {
  const res = await fetch(chatUrl + "/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json", ...chatAuth() },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`chat → ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json() as Promise<{ content: Block[] }>;
}

async function postTrigger(chatUrl: string, path: string, body: unknown):
  Promise<{ id: string; identifier?: string }> {
  const res = await fetch(chatUrl + path, {
    method: "POST",
    headers: { "content-type": "application/json", ...chatAuth() },
    body: JSON.stringify(body ?? {}),
  });
  const text = await res.text();
  const parsed = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const err = new Error(parsed.error ?? res.statusText) as Error & { code?: string };
    err.code = parsed.code ?? parsed.error;
    throw err;
  }
  return parsed;
}

/**
 * Follow a running issue, printing each new comment as it appears.
 *
 * Comment-diffing rather than a fixed poll count: the engine narrates every
 * step to the issue timeline (which is exactly why that narration exists), so
 * following the comments is following the run. Stops at a gate rather than
 * spinning — the next thing needed is a human decision, not more waiting.
 */
async function follow(chatUrl: string, issueId: string): Promise<void> {
  const seen = new Set<string>();
  const spin = spinner("starting…");
  const started = Date.now();

  try {
    for (;;) {
      const res = await fetch(`${chatUrl}/api/status/${issueId}`,
        { headers: chatAuth() }).catch(() => null);
      if (!res?.ok) { spin.stop(`  ${cross} lost contact with the run`); return; }
      const status = await res.json() as {
        activity?: { id?: string; body?: string; author?: string }[];
        approvals?: { id: string; status: string; payload?: { title?: string } }[];
        stage?: string;
        tree?: { status?: string };
      };

      for (const a of status.activity ?? []) {
        const key = a.id ?? a.body ?? "";
        if (!key || seen.has(key)) continue;
        seen.add(key);
        const first = String(a.body ?? "").split("\n")[0].replace(/\*\*/g, "");
        if (first.trim()) {
          spin.stop();
          out(`  ${c.grey("│")} ${c.grey(first.slice(0, 100))}`);
          spin.update(status.stage ?? "working…");
        }
      }

      const pending = (status.approvals ?? []).filter(a => a.status === "pending");
      if (pending.length) {
        spin.stop();
        out();
        out(`  ${c.yellow("⏸")}  ${c.bold("Waiting for your approval")} ${c.grey(dot)} ${pending[0].payload?.title ?? ""}`);
        out(`     ${c.grey("approve with")} ${c.cyan(`/approve ${pending[0].id}`)}`);
        return;
      }

      const state = status.tree?.status;
      if (state === "done") { spin.stop(`  ${tick} ${c.green("complete")}`); return; }
      if (state === "blocked") {
        spin.stop(`  ${cross} ${c.red("blocked")} ${c.grey("— see /status for why")}`);
        return;
      }

      spin.update(`${status.stage ?? "working"} ${dot} ${Math.round((Date.now() - started) / 1000)}s`);
      await new Promise(r => setTimeout(r, 3000));
    }
  } finally {
    spin.stop();
  }
}

const HELP = `
  ${c.bold("Just type what you want.")}  "create a project for RTWSA", "run the data model",
  "what still needs doing?", "add a feature called Appeals".

  ${c.grey("Slash commands run instantly, with no model call and no cost.")}
  ${c.grey("Anything taking --project / --feature uses what you pinned.")}

  ${c.bold("Target")}
    ${c.cyan("/new")}                              new project, step by step
    ${c.cyan("/use")} <project> [feature]          pin what you are working on
    ${c.cyan("/projects")}                         projects in the database
    ${c.cyan("/whoami")}                           who you are, and what is pinned
    ${c.cyan("/login")}                            sign in, or as somebody else
    ${c.cyan("/logout")}                           forget the stored token

  ${c.bold("Documents")}
    ${c.cyan("/upload")} <file...> [--as TYPE]     ${c.grey("sop | transcripts | notes | ui | template")}
      ${c.grey("--as needs a feature. WITHOUT it a file lands in requirements/")}
      ${c.grey("uncategorised (feature pinned), or in the project's documents/")}
      ${c.grey("(no feature) — which is right for policy and legislation.")}
    ${c.cyan("/docs")}                             documents for the current target

  ${c.bold("Running")}
    ${c.cyan("/run")} <stage>                      ${c.grey("no stage lists them")}
    ${c.cyan("/run")} pause|cancel|resume <issue>  ${c.grey("pause --force stops the agent now")}
    ${c.cyan("/issues")} [--open] [--all]          ${c.grey("every issue, and what needs you")}
    ${c.cyan("/status")} [issue]                   activity, gates and work products
    ${c.cyan("/gates")}                            everything awaiting approval
    ${c.cyan("/approve")} <gateId>                 approve it
    ${c.cyan("/reject")} <gateId> [note]           send it back to be regenerated
    ${c.cyan("/logs")} <runId>                     an agent's transcript

  ${c.bold("People and organisations")}
    ${c.cyan("/user")} list ${c.grey("|")} create <email> [--role admin|member|viewer] [--password …]
    ${c.cyan("/user")} role <email> <role> ${c.grey("|")} password <email> ${c.grey("|")} disable ${c.grey("|")} enable
    ${c.cyan("/member")} list ${c.grey("|")} add <email> [--role owner|editor|viewer] ${c.grey("|")} remove <email>
    ${c.cyan("/org")} list ${c.grey("|")} create <name> ${c.grey("|")} use <slug> ${c.grey("|")} show ${c.grey("|")} archive <slug>
    ${c.cyan("/installs")}                         who installed the CLI, and where

  ${c.bold("Cost and configuration")}
    ${c.cyan("/spend")} [--by project|feature|user|agent|adapter|model] [--since D] [--json]
    ${c.cyan("/models")} list ${c.grey("|")} set <model> --input <n> --output <n> ${c.grey("|")} proposal ${c.grey("|")} apply
    ${c.cyan("/adapter")} list ${c.grey("|")} set <name> [--project P] ${c.grey("|")} unset
    ${c.cyan("/audit")} [--limit N]                who did what, across every project
    ${c.cyan("/actions")}                          who did what on this project

  ${c.bold("Session")}
    ${c.cyan("/clear")}   forget the conversation so far
    ${c.cyan("/help")}    ${c.cyan("/exit")}

  ${c.grey("Every scyne command works here — drop the prefix. --follow needs its")}
  ${c.grey("own terminal, since it would hold this prompt for a whole run.")}
`;

/**
 * Split a slash-command line into arguments the way a shell would.
 *
 * NOT `split(/\s+/)`. Every path in this workspace is a candidate argument and
 * a great many of them contain spaces — `projects/RTWSA/Review & Verify
 * Evidence/...` — so a naive split turned one file into four arguments, none
 * of which existed. Quoting it, which is what anyone would try next, was no
 * better: the quotes stayed in the token and `readFile` was handed a path
 * beginning with a literal `"`.
 *
 * Single and double quotes group; a backslash escapes the next character.
 * That is the whole grammar — enough for a filename, and deliberately not a
 * shell (no globs, no variables, no operators).
 */
export function tokenize(line: string): string[] {
  const tokens: string[] = [];
  let cur = "";
  let started = false;      // distinguishes "" (an empty argument) from no argument
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "\\" && i + 1 < line.length && quote !== "'") {
      cur += line[++i]; started = true; continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      started = true;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; started = true; continue; }
    if (/\s/.test(ch)) {
      if (started) { tokens.push(cur); cur = ""; started = false; }
      continue;
    }
    cur += ch; started = true;
  }
  if (started) tokens.push(cur);
  return tokens;
}

export async function repl(): Promise<void> {
  const cfg = load();
  const chatUrl = process.env.SCYNE_CHAT_URL || DEFAULT_CHAT_URL;
  // `let`, not `const`: /login and /logout replace it. createClient() snapshots
  // the config file at construction, so a client made before signing in keeps
  // sending the old (or no) credential for the rest of the session.
  let client: Client = createClient();
  let signedOut = false;

  let project = cfg.project ?? null;
  let feature = cfg.feature ?? null;

  /**
   * Ask the person a question, through the session's own line queue.
   *
   * NOT a second readline (it never sees input this one has already buffered —
   * observed hanging on "Email:" forever) and not rl.question() either, for
   * the reason nextLine's own comment gives.
   *
   * A password still gets raw mode when there is a terminal to hide it from.
   * On a pipe there is nobody to hide it from, so it arrives like every other
   * line, which is what makes signing in scriptable.
   */
  async function ask(label: string, silent = false): Promise<string> {
    if (silent && process.stdin.isTTY) {
      rl.pause();
      try {
        return (await readSecret(label.replace(/:\s*$/, "") + " (hidden as you type): ")).trim();
      } finally {
        rl.resume();
      }
    }
    process.stdout.write(label);
    const line = ((await nextLine()) ?? "").trim();
    // A pipe echoes nothing, so without this the next label lands on the same
    // line and reads as "Email:   Password:".
    if (!process.stdin.isTTY) process.stdout.write("\n");
    return line;
  }

  /**
   * Confirm the pinned target still exists on THIS server, and drop it if not.
   *
   * The pin lives in ~/.scyne/config.json and survives everything: a database
   * reset, a different server, signing in as somebody else. It was never
   * checked, so the prompt read "SAPN / customer-data" against an installation
   * that had no projects at all — and every command that defaulted to the pin
   * failed with a message about SAPN rather than about the pin.
   *
   * A network error leaves it alone. Discarding somebody's target because the
   * server blinked would be worse than showing one that is briefly wrong.
   */
  async function retarget(): Promise<void> {
    if (!project) return;
    let projects: { name: string }[];
    try {
      projects = await client.get<{ name: string }[]>("/projects");
    } catch {
      return;
    }
    if (projects.some(p => p.name === project)) return;
    const names = projects.map(p => p.name).join(", ");
    out(`  ${cross} pinned project ${c.brand(project)} is not on this server — unpinned.`);
    out(`     ${names ? "you have: " + names : "no projects here yet — try: create a project called Acme"}`);
    project = null;
    feature = null;
    patch({ project: undefined, feature: undefined });
  }

  // Who am I — and is the orchestrator even up? Both are worth knowing before
  // the first prompt rather than as a failure three commands later.
  let user: string | undefined;
  let adapter: string | undefined;
  try {
    const me = await client.get<{ email: string }>("/auth/whoami");
    user = me.email;
    adapter = (await client.get<{ defaults?: { adapter?: string } }>("/config")).defaults?.adapter;
  } catch (err) {
    // A 401 is no longer fatal: the session opens anyway so /login can be
    // typed into it. Returning here is why signing in was impossible from the
    // one screen that told you to sign in.
    if (!(err instanceof ApiError && err.status === 401)) {
      banner({ apiUrl: client.config.apiUrl, chatUrl });
      out(`  ${cross} ${(err as Error).message.split("\n")[0]}`);
      out();
      return;
    }
    signedOut = true;
  }

  banner({ apiUrl: client.config.apiUrl, chatUrl, user, adapter });
  if (signedOut) out(`  ${cross} not signed in — type ${c.cyan("/login")}`);
  else await retarget();

  const rl: Interface = createInterface({
    input: process.stdin, output: process.stdout, historySize: 500,
  });

  // The conversation, in the shape /api/chat expects — the same array the
  // React app keeps in `apiHistory`.
  let history: ChatTurn[] = [];

  const say = (text: string): void => { out(); out(markdown(text)); };

  async function slash(line: string): Promise<boolean> {
    const [verb, ...rest] = tokenize(line.slice(1).trim());
    const arg = rest.join(" ");
    try {
      switch (verb) {
        case "exit": case "quit": return true;
        case "help": out(HELP); return false;
        case "clear": history = []; out(`  ${tick} conversation cleared`); return false;

        case "login": {
          const apiUrl = client.config.apiUrl || DEFAULT_API_URL;
          out(`  signing in to ${c.brand(apiUrl)}`);
          const email = await ask("  Email: ");
          const password = await ask("  Password: ", true);

          const anon = createClient({ apiUrl, token: undefined });
          const res = await anon.post<{ token: string; user: { email: string; role: string } }>(
            "/auth/login", { email, password });
          // Trade the session for a long-lived token, exactly as `scyne login`
          // does — a session expires in hours, which is wrong for a terminal.
          const authed = createClient({ apiUrl, token: res.token });
          const tok = await authed.post<{ token: string }>(
            "/auth/tokens", { name: "cli@repl" });
          patch({ apiUrl, token: tok.token });

          client = createClient();
          signedOut = false;
          history = [];   // a new person should not inherit the last one's conversation
          out(`  ${tick} signed in as ${c.brand(res.user.email)} (${res.user.role})`);
          await retarget();
          return false;
        }

        case "logout": {
          patch({ token: undefined });
          client = createClient();
          signedOut = true;
          history = [];
          project = null; feature = null;
          patch({ project: undefined, feature: undefined });
          out(`  ${tick} signed out. Type ${c.cyan("/login")} to sign in again.`);
          return false;
        }

        case "whoami": {
          const me = await client.get("/auth/whoami");
          out(); out(markdown("```\n" + JSON.stringify(me, null, 2) + "\n```"));
          return false;
        }

        case "new": {
          if (signedOut) { out(`  ${cross} sign in first: ${c.cyan("/login")}`); return false; }
          await wizard();
          return false;
        }

        case "use": {
          const [p, ...f] = rest;
          if (!p) { out(`  ${cross} usage: /use <project> [feature]`); return false; }
          const projects = await client.get<{ id: string; name: string }[]>("/projects");
          const hit = projects.find(x => x.name.toLowerCase() === p.toLowerCase());
          if (!hit) {
            out(`  ${cross} no project '${p}'. You have: ${projects.map(x => x.name).join(", ") || "(none)"}`);
            return false;
          }
          project = hit.name;
          feature = f.length ? f.join(" ") : null;
          patch({ project, feature: feature ?? undefined });
          out(`  ${tick} working on ${c.brand(project)}${feature ? " / " + c.brand(feature) : ""}`);
          return false;
        }

        case "projects": {
          const projects = await client.get<{ name: string; description?: string }[]>("/projects");
          out();
          for (const p of projects) {
            out(`  ${p.name === project ? c.brand("▸") : " "} ${c.bold(p.name)}  ${c.grey((p.description ?? "").slice(0, 50))}`);
          }
          if (!projects.length) out(`  ${c.grey("(none in the database yet)")}`);

          // The assistant reads the folder tree, this list reads the database,
          // and until the two are bridged they genuinely disagree. Saying
          // "no projects yet" while the assistant answers "SAPN already
          // exists" makes the tool look broken when it is merely split.
          const known = new Set(projects.map(p => p.name));
          const onDisk = await fetch(`${chatUrl}/api/features`, { headers: chatAuth() })
            .then(r => r.ok ? r.json() as Promise<Record<string, unknown>> : {})
            .catch(() => ({}));
          const missing = Object.keys(onDisk).filter(n => !known.has(n));
          if (missing.length) {
            out();
            out(`  ${c.yellow("!")} ${c.grey("also on disk, not in the database:")} ${missing.join(", ")}`);
            out(`    ${c.grey("The assistant can see these and will say they exist; scyne commands cannot")}`);
            out(`    ${c.grey("use them yet. Generated work from before this database was set up.")}`);
          }
          return false;
        }

        case "upload": {
          // The session had no way to add a document at all — the assistant
          // cannot read your filesystem, and the web UI's attach button has no
          // equivalent here. This is that button.
          const parts = rest.filter(Boolean);
          const asFlag = parts.indexOf("--as");
          const as = asFlag >= 0 ? parts[asFlag + 1] : undefined;
          // `asFlag + 1` is the flag's VALUE — but only when the flag is
          // present. With no `--as`, indexOf returns -1, so this guarded index
          // 0 and every plain `/upload <file>` silently lost its only file and
          // printed the usage line as though nothing had been typed.
          const files = parts.filter((p, i) =>
            !p.startsWith("--") && !(asFlag >= 0 && i === asFlag + 1));

          if (!files.length) {
            out(`  ${cross} usage: /upload <file...> [--as ${Object.keys(CATEGORY_DIR).join("|")}]`);
            out(`    ${c.grey("--as is optional. Without it a file lands in the project's documents/,")}`);
            out(`    ${c.grey("or in requirements/ uncategorised when a feature is pinned.")}`);
            return false;
          }
          if (!project) { out(`  ${cross} pin a project first: /use <project> [feature]`); return false; }
          if (as && !CATEGORY_DIR[as]) {
            out(`  ${cross} --as must be one of ${Object.keys(CATEGORY_DIR).join(", ")}`);
            return false;
          }
          if (as && !feature) { out(`  ${cross} --as ${as} needs a feature: /use ${project} <feature>`); return false; }

          // Uncategorised INTO A FEATURE is almost always a slip — the file
          // lands at the root of requirements/ rather than in SOP/,
          // Transcripts/, Notes/ or UI/, and the BA is told what each of those
          // means. Said once, not refused, exactly as `scyne doc upload` does.
          if (!as && feature) {
            out(`  ${dot} ${c.grey("no --as, so this goes to requirements/ uncategorised.")}`);
            out(`    ${c.grey("the BA treats " + Object.keys(CATEGORY_DIR).join(", ") + " differently — pass one.")}`);
          }

          for (const file of files) {
            try {
              const r = await uploadDocument(client, { project, feature, file, as });
              reportDual(String(r.extra?.path ?? file), r);
            } catch (err) {
              out(`  ${cross} ${file}: ${(err as Error).message.split("\n")[0]}`);
            }
          }
          return false;
        }

        case "docs": {
          if (!project) { out(`  ${cross} pin a project first: /use <project>`); return false; }
          const projects = await client.get<{ id: string; name: string }[]>("/projects");
          const hit = projects.find(x => x.name === project)!;
          const q = feature ? `?feature=${encodeURIComponent(feature)}` : "";
          const docs = await client.get<{ path: string; category: string; version: number }[]>(
            `/projects/${hit.id}/documents${q}`);
          out();
          if (!docs.length) out(`  ${c.grey("(no documents)")}`);
          for (const d of docs) out(`  ${c.grey(String(d.category ?? "—").padEnd(12))} ${d.path} ${c.grey("v" + d.version)}`);
          return false;
        }

        case "gates": {
          const issues = await client.get<{ id: string; identifier: string; status: string }[]>("/issues");
          let found = 0;
          out();
          for (const i of issues.filter(x => x.status === "in_review")) {
            for (const g of await client.get<any[]>(`/issues/${i.id}/gates`)) {
              if (g.status !== "pending") continue;
              found++;
              out(`  ${c.yellow("⏸")} ${c.bold(i.identifier)}  ${g.payload?.title ?? ""}`);
              out(`     ${c.cyan(`/approve ${g.id}`)}`);
            }
          }
          if (!found) out(`  ${c.grey("(nothing awaiting approval)")}`);
          return false;
        }

        case "approve": case "reject": {
          if (!arg) { out(`  ${cross} usage: /${verb} <gateId>`); return false; }
          await client.post(`/gates/${arg}/${verb}`, { by: "cli" });
          out(`  ${tick} ${verb}d ${c.grey(arg)}`);
          return false;
        }

        case "status": {
          const issues = await client.get<any[]>("/issues");
          const issue = arg ? issues.find(i => i.identifier === arg || i.id === arg) : issues[0];
          if (!issue) { out(`  ${cross} no issue '${arg}'`); return false; }
          out(); out(`  ${c.bold(issue.identifier)}  ${issue.title}`);
          out(`  ${c.grey(`status ${issue.status} ${dot} step ${issue.step_index}`)}`);
          for (const cm of (await client.get<any[]>(`/issues/${issue.id}/comments`)).slice(-12)) {
            out(`  ${c.grey("│")} ${c.grey(String(cm.body).split("\n")[0].slice(0, 96))}`);
          }
          return false;
        }

        case "actions": {
          if (!project) { out(`  ${cross} pin a project first: /use <project>`); return false; }
          const projects = await client.get<{ id: string; name: string }[]>("/projects");
          const hit = projects.find(x => x.name === project)!;
          out();
          for (const a of await client.get<any[]>(`/projects/${hit.id}/actions?limit=15`)) {
            out(`  ${c.grey(String(a.created_at).slice(0, 19).replace("T", " "))}  ${a.verb}`);
          }
          return false;
        }

        default: {
          // Anything this session does not implement itself is handed to the
          // ordinary command dispatcher, so /user, /member, /installs,
          // /adapter, /models, /audit, /org and the rest all work here. They
          // were never withheld for a reason — they simply had not been
          // written, and the help called that "run these in another terminal".
          //
          // Commands that PROMPT work here too — setPromptReader routes them
          // through this session's queue, so /user password and the y/N on
          // /run cancel ask inline instead of hanging on a readline that will
          // never be fed. (/login and /logout never reach here; the session
          // owns them, because they also replace the client.)
          const args = [verb, ...rest];
          // --follow polls until a run ends, which would hold the prompt for
          // the length of an agent run with no way to type /exit.
          const follow = args.indexOf("--follow");
          if (follow !== -1) {
            args.splice(follow, 1);
            out(`  ${c.grey("(--follow needs its own terminal; showing the transcript so far)")}`);
          }
          // The pinned target, so /docs and /run behave the same whether the
          // command was typed here or in a shell.
          if (project && args.indexOf("--project") === -1) args.push("--project", project);
          if (feature && args.indexOf("--feature") === -1) args.push("--feature", feature);
          try {
            const { runCommand } = await import("./index.ts");
            await runCommand(args);
          } catch (err) {
            out(`  ${cross} ${(err as Error).message.split("\n")[0]}`);
          }
          return false;
        }
      }
    } catch (err) {
      out(`  ${cross} ${(err as Error).message.split("\n")[0]}`);
      return false;
    }
  }

  /**
   * The New Project wizard, as four prompts.
   *
   * The browser has this and the terminal did not: a project could be created
   * here, but its DEFINITION and its BRANDING could only be supplied as flags
   * somebody had to know about, or by hoping the assistant asked. Both change
   * every artefact the pipeline goes on to produce — the definition is read by
   * every skill before any discovery document — so they are asked for at
   * creation time rather than chased afterwards.
   *
   * Deterministic and free: no model call, so it cannot decide to skip a step.
   * Every step takes enter for "skip", because a wizard that cannot be got out
   * of is one people avoid starting.
   */
  async function wizard(): Promise<void> {
    out();
    out(`  ${c.bold("New project")}  ${c.grey("— enter skips any step. ^C leaves it unfinished, not undone.")}`);

    out();
    out(`  ${c.bold("Step 1 — the client")}`);
    const name = (await ask("  Project name: ")).trim();
    if (!name) { out(`  ${cross} nothing entered — cancelled`); return; }
    if (!/^[A-Za-z0-9 ._&-]+$/.test(name)) {
      out(`  ${cross} letters, numbers, spaces and . _ & - only`);
      return;
    }
    if (RESERVED.has(name.toLowerCase())) {
      out(`  ${cross} '${name}' is a reserved name — the CLI reads it as a stage, not a project`);
      return;
    }

    out(`  ${c.grey("Who are they? What are they regulated or obliged to do, who are")}`);
    out(`  ${c.grey("their customers really, what can they not do? Every skill reads")}`);
    out(`  ${c.grey("this before any discovery document, so it is worth a paragraph.")}`);
    let description = (await ask("  > ")).trim();
    // The server refuses anything under 40 characters, and silently NOT writing
    // description.md is the one outcome nobody would notice until an agent
    // produced generic requirements. Say so and offer the retype once.
    if (description && description.length < 40) {
      out(`  ${c.yellow("!")} ${c.grey("that is too short to be a definition — a couple of sentences at least.")}`);
      const retry = (await ask("  > ")).trim();
      description = retry.length >= 40 ? retry : "";
      if (!description) out(`    ${c.grey("skipped — add it later with")} ${c.cyan(`project describe ${name} "…"`)}`);
    }

    out();
    out(`  ${c.bold("Step 2 — the branding")}`);
    out(`  ${c.grey("The companion app comes out in the client's colours. Without one it")}`);
    out(`  ${c.grey("falls back to the Scyne palette, which is perfectly presentable.")}`);
    const website = (await ask("  Their website? (enter to skip): ")).trim();

    // One call does all three: scaffolds the tree, writes description.md, and
    // runs extract-brand inline. Re-extracting afterwards to show the palette
    // would fetch the same site twice.
    const spin = spinner(website ? `creating ${name} and reading the brand…` : `creating ${name}…`);
    let created: DualResult;
    try {
      created = await createProject(client, { name, description, website });
    } finally {
      spin.stop();
    }
    reportDual(name, created);
    if (created.disk.state === "failed" && created.db.state === "failed") {
      out(`  ${cross} neither side was created — stopping here.`);
      return;
    }

    if (description) {
      out(`    ${created.extra?.definitionWritten
        ? `${tick} ${c.grey("projects/" + name + "/description.md")}`
        : `${cross} ${c.grey("the definition was not written — retry with")} ${c.cyan(`project describe ${name} "…"`)}`}`);
    }
    if (website) reportBrand(name, created.extra?.brand as BrandTheme | null, created.extra?.brandError as string | null);

    project = name; feature = null;
    patch({ project: name, feature: undefined });

    out();
    out(`  ${c.bold("Step 3 — client-wide documents")}`);
    out(`  ${c.grey("Policy, legislation, standards, current-state architecture — what")}`);
    out(`  ${c.grey("describes the CLIENT rather than one feature. .docx and .pdf are")}`);
    out(`  ${c.grey("converted to markdown on arrival. Feature material comes later.")}`);
    const docLine = (await ask("  Paths, space separated (enter to skip): ")).trim();
    const docs = tokenize(docLine);
    // A glob reaches here unexpanded — the session is not a shell — and would
    // fail as a filename containing a literal asterisk, which reads like the
    // file is missing rather than like the pattern was never expanded.
    const globbed = docs.filter(d => /[*?]/.test(d));
    if (globbed.length) {
      out(`  ${c.yellow("!")} ${c.grey("globs are not expanded here: " + globbed.join(", "))}`);
      out(`    ${c.grey("run")} ${c.cyan(`scyne doc upload ${globbed[0]} --project ${name}`)} ${c.grey("from your shell instead.")}`);
    }
    for (const file of docs.filter(d => !/[*?]/.test(d))) {
      try {
        const r = await uploadDocument(client, { project: name, feature: null, file });
        reportDual(String(r.extra?.path ?? file), r);
      } catch (err) {
        out(`  ${cross} ${file}: ${(err as Error).message.split("\n")[0]}`);
      }
    }

    out();
    out(`  ${c.bold("Step 4 — a first feature")}`);
    out(`  ${c.grey("One slice of work: 'Appeals & Reviews', 'Interim Benefit'.")}`);
    const featureName = (await ask("  Feature name (enter to skip): ")).trim();
    if (featureName && RESERVED.has(featureName.toLowerCase())) {
      out(`  ${cross} '${featureName}' is reserved — the CLI would read it as a stage`);
    } else if (featureName) {
      reportDual(`${name} / ${featureName}`, await createFeature(client, { project: name, feature: featureName }));
      feature = featureName;
      patch({ project: name, feature: featureName });
    }

    // What to do next depends on what they actually gave us, so it is computed
    // rather than a fixed list. A "next" step whose prerequisite is missing is
    // how someone gets a 409 on their first command.
    out();
    out(`  ${c.bold("Next")}`);
    // Padded on the RAW text: c.cyan() wraps it in escape codes that padEnd
    // counts as visible width, so colouring first indents every row differently.
    const nextStep = (cmd: string, hint: string): void => {
      out(`    ${c.cyan(cmd)}${" ".repeat(Math.max(2, 34 - cmd.length))}${c.grey(hint)}`);
    };
    if (!docs.length && !featureName) {
      out(`    ${c.grey("nothing to run yet — every stage reads documents.")}`);
      nextStep("/upload <file...>", "client-wide policy and legislation");
    }
    if (docs.length) nextStep("/run capabilities", "capability map — reads what you just uploaded");
    if (featureName) {
      nextStep("/upload <file...> --as transcripts", `discovery material for ${featureName}`);
      nextStep("/run requirements", "once that feature has documents");
    }
    if (!description) nextStep(`project describe ${name} "…"`, "the definition, which every skill reads");
  }

  /**
   * One palette block, whichever route fetched it.
   *
   * `forProject` is passed rather than read off the pin: the wizard reports the
   * palette BEFORE it pins the new project, so reading the pin printed the
   * previous target's path — or `<project>` on a first run.
   */
  function reportBrand(forProject: string, theme: BrandTheme | null, error: string | null): void {
    if (error || !theme) {
      out(`    ${cross} ${c.grey("no branding: " + (error ?? "nothing readable on that page"))}`);
      out(`      ${c.grey("some sites build their CSS in the browser, so there is nothing")}`);
      out(`      ${c.grey("to read server-side. The Scyne palette is used instead.")}`);
      return;
    }
    const row = (label: string, value?: string): void => {
      if (value) out(`    ${c.grey(label.padEnd(9))} ${value}`);
    };
    row("brand", theme.brand);
    row("deep", theme.brandDeep);
    row("accent", theme.accent);
    row("wordmark", theme.logoText);
    row("logo", theme.hasLogo ? "found and inlined" : "none found");
    row("type", theme.fontFamily);
    out(`    ${c.grey("read off the site's own CSS — a first pass. Correct a wrong colour")}`);
    out(`    ${c.grey("in projects/" + forProject + "/design/style-guides/theme.json")}`);
  }

  /** Render what each half of the split did. */
  function reportDual(title: string, r: DualResult): void {
    // A detail can be several lines — `no project named 'X'.` carries a second
    // line listing the ones that do exist. Printing it raw put line two in
    // column zero and broke the two-row block into something that read like
    // output from a different command, so the rest is indented under it.
    const rest: string[] = [];
    const show = (s: DualResult["disk"]): string => {
      const [head, ...more] = (s.detail ?? "").split("\n");
      rest.push(...more.filter(l => l.trim()).map(l => l.trim()));
      switch (s.state) {
        case "created": return `${tick} ${c.grey(head || "created")}`;
        case "exists":  return `${dot} ${c.grey("already there")}`;
        case "skipped": return `${dot} ${c.grey(head)}`;
        case "failed":  return `${cross} ${head}`;
      }
    };
    out();
    out(`  ${c.bold(title)}`);
    out(`    ${c.grey("folder tree (agents read this)")}  ${show(r.disk)}`);
    out(`    ${c.grey("database (scyne reads this)   ")}  ${show(r.db)}`);
    for (const line of rest) out(`      ${c.grey(line)}`);
  }

  async function createBoth(tool: string, args: Record<string, string>): Promise<void> {
    const name = String(args.project ?? "");
    if (!name) { out(`  ${cross} the assistant did not say which project`); return; }

    if (tool === "create_project") {
      reportDual(name, await createProject(client, {
        name, description: args.description, website: args.website,
      }));
      if (args.website) out(`    ${c.grey("branding pulled from")} ${args.website}`);
      project = name; feature = null;
      patch({ project: name, feature: undefined });
      return;
    }

    const featureName = String(args.feature ?? "");
    if (!featureName) { out(`  ${cross} the assistant did not say which feature`); return; }
    reportDual(`${name} / ${featureName}`, await createFeature(client, { project: name, feature: featureName }));
    project = name; feature = featureName;
    patch({ project: name, feature: featureName });
  }

  async function converse(text: string): Promise<void> {
    history.push({ role: "user", content: text });
    const spin = spinner("thinking…");
    let blocks: Block[];
    try {
      const res = await postChat(chatUrl, { messages: history, target: { project, feature } });
      blocks = res.content ?? [];
      spin.stop();
    } catch (err) {
      spin.stop();
      const message = (err as Error).message;
      out(`  ${cross} ${message}`);
      // A 401 came back FROM the server, so telling someone to start it sends
      // them to check a process that is already running. The two failures look
      // nothing alike and must not share a hint.
      if (/\b401\b|not_authenticated/.test(message)) {
        out(`     ${c.grey("The chatbot server is running; it did not accept the credential.")}`);
        out(`     ${c.grey("Sign in with")} ${c.cyan("/login")}${c.grey(" — the session forwards that token to it.")}`);
      } else {
        out(`     ${c.grey("The conversation runs on the chatbot server at " + chatUrl + ".")}`);
        out(`     ${c.grey("Start it with")} ${c.cyan("npm run dev")}${c.grey(", or set $SCYNE_CHAT_URL.")}`);
      }
      history.pop();
      return;
    }

    history.push({ role: "assistant", content: blocks });

    const text_ = blocks.filter(b => b.type === "text").map(b => b.text ?? "").join("");
    const tool = blocks.find(b => b.type === "tool_use");
    if (text_.trim()) say(text_);

    if (!tool?.name) return;
    const args = (tool.input ?? {}) as Record<string, string>;

    // The model can move the target without firing anything.
    if (tool.name === "set_target") {
      if (args.project) project = String(args.project);
      feature = args.feature ? String(args.feature) : null;
      patch({ project: project ?? undefined, feature: feature ?? undefined });
      if (!text_.trim()) out(`  ${tick} target set to ${c.brand(project ?? "?")}${feature ? " / " + c.brand(feature) : ""}`);
      return;
    }

    // Creating a project or feature has to land in BOTH places, because the
    // two halves of this system currently disagree about what exists: the
    // assistant's tools write the folder tree that agents read, while
    // `/projects` and every `scyne` command read the database. Writing only
    // one is what produces "SAPN already exists" directly above
    // "(no projects yet)".
    if (tool.name === "create_project" || tool.name === "create_feature") {
      await createBoth(tool.name, args);
      return;
    }

    // The two SYNCHRONOUS tools. Neither raises an issue, so neither is in
    // TRIGGERS — and until now that meant the fall-through below dropped both
    // silently: the assistant asked for the client's description and their
    // website exactly as it does in the browser, said it had saved them, and
    // nothing was written. A tool call the session cannot act on must not be
    // reported as done.
    if (tool.name === "save_project_definition") {
      const name = String(args.project ?? project ?? "");
      const description = String(args.description ?? "");
      if (name) { project = name; patch({ project: name }); }
      if (!name || description.trim().length < 40) {
        out(`  ${cross} I need a project and a couple of sentences to save.`);
        return;
      }
      try {
        reportDual(`${name} — project definition`, await saveProjectDefinition(client, { project: name, description }));
        out(`    ${c.grey("every skill reads this before any discovery document.")}`);
      } catch (err) {
        out(`  ${cross} ${(err as Error).message.split("\n")[0]}`);
      }
      return;
    }

    if (tool.name === "extract_brand") {
      const name = String(args.project ?? project ?? "");
      const url = String(args.url ?? "");
      if (name) { project = name; patch({ project: name }); }
      // Branding is per PROJECT — one companion app, one palette. A feature is
      // neither needed nor asked for.
      if (!name || !url) {
        out(`  ${cross} I need a URL plus a project to pull the branding into.`);
        return;
      }
      const spin = spinner(`reading the brand from ${url}…`);
      try {
        const r = await extractBrand({ project: name, url });
        spin.stop();
        out();
        out(`  ${c.bold(`branding applied to ${name}`)}`);
        reportBrand(name, r.theme, null);
        out(`    ${c.grey(r.rerendered
          ? "the companion app has been re-rendered with it."
          : "no companion app built yet — the theme applies on the first build.")}`);
      } catch (err) {
        spin.stop();
        reportBrand(name, null, `couldn't read ${url}: ${(err as Error).message.split("\n")[0]}`);
      }
      return;
    }

    const trigger = TRIGGERS[tool.name];
    if (!trigger) return;   // set_target aside, anything else is informational

    if (args.project) project = String(args.project);
    if (args.feature) feature = String(args.feature);
    patch({ project: project ?? undefined, feature: feature ?? undefined });

    out();
    out(`  ${c.brand("▸")} ${c.bold(trigger.label)} ${c.grey(dot)} ${c.grey(`${project ?? ""}${feature ? " / " + feature : ""}`)}`);

    try {
      const issue = await postTrigger(chatUrl, trigger.path, args);
      out(`  ${tick} ${c.grey("issue")} ${c.bold(issue.identifier ?? issue.id)}`);
      await follow(chatUrl, issue.id);
    } catch (err) {
      const code = (err as { code?: string }).code ?? "";
      // A refused prerequisite is the normal case, not a fault: say why in the
      // same words the web UI would, rather than surfacing a 409.
      out(`  ${cross} ${GATE_REASONS[code] ?? (err as Error).message}`);
    }
  }

  // Ctrl-C once cancels the line; Ctrl-D or /exit ends the session. Killing
  // the process on the first Ctrl-C would lose a half-typed instruction, which
  // is exactly when people press it.
  rl.on("SIGINT", () => { out(`  ${c.grey("(^C — type /exit to leave)")}`); });

  /**
   * Lines, queued.
   *
   * NOT `await rl.question()` in a loop. That works at a TTY and silently
   * drops input from a pipe: readline delivers every buffered line as soon as
   * the stream is readable and then closes it, so a second `question()` finds
   * the stream already ended and the rest of the script vanishes. Measured —
   * piping six commands ran only the first.
   *
   * Queueing every 'line' event and handing them out one at a time makes both
   * cases identical, which also makes the session scriptable:
   *   printf '/use RTWSA\\n/gates\\n/exit\\n' | scyne
   */
  const pending: string[] = [];
  let waiting: ((line: string | null) => void) | null = null;
  let closed = false;

  rl.on("line", (l) => {
    if (waiting) { const w = waiting; waiting = null; w(l); }
    else pending.push(l);
  });
  rl.on("close", () => {
    closed = true;
    if (waiting) { const w = waiting; waiting = null; w(null); }
  });

  const nextLine = (): Promise<string | null> => {
    if (pending.length) return Promise.resolve(pending.shift()!);
    if (closed) return Promise.resolve(null);
    return new Promise(resolve => { waiting = resolve; });
  };

  // From here on, any command that prompts — `user password`, `run cancel` —
  // asks through this session rather than opening a readline that would find
  // stdin already drained. Installed only now, because ask() needs the queue.
  setPromptReader(ask);

  for (;;) {
    // Hand the prompt to readline rather than writing it ourselves. In
    // terminal mode readline re-renders its OWN prompt after every line, so
    // printing one here produced two: the real label first, then readline's
    // default "> " on every turn afterwards, with the typed line echoed under
    // it. Setting it means there is one prompt and readline owns it.
    if (process.stdin.isTTY) {
      rl.setPrompt(promptLabel(project, feature));
      rl.prompt();
    }
    const raw = await nextLine();
    if (raw === null) break;

    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("/")) { if (await slash(line)) break; continue; }
    await converse(line);
  }

  rl.close();
  out();
  out(`  ${c.grey("bye")}`);
}
