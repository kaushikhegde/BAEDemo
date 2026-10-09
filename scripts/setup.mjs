#!/usr/bin/env node
/**
 * One-time setup for a fresh clone, so that afterwards `npm run dev` is all
 * anyone types.
 *
 *   npm run setup
 *   npm run setup -- --gemini-key K --email E --password P   # no questions
 *
 * Does, in order: checks Node and the Claude Code CLI, installs the three
 * package trees, links the skills into `.claude/skills/`, writes a `.env` for
 * running entirely on this machine (no Docker, no Postgres, no publishing), and
 * creates the first login.
 *
 * Safe to re-run, and safe while `npm run dev` runs. An existing `.env` is
 * kept as it is, installs are no-ops when nothing changed, and the login is
 * asked for only while the installation has none.
 *
 * Imports nothing but Node built-ins at the top: it runs BEFORE `npm install`,
 * so a dependency imported here would not exist yet.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const WIN = process.platform === "win32";

const step = (n, text) => console.log(`\n[${n}/5] ${text}`);
const ok = (text) => console.log(`  ✓ ${text}`);
const stop = (text) => {
  console.error(`\n  ✗ ${text}\n`);
  process.exit(1);
};

// ─── 1. Prerequisites ───────────────────────────────────────────────────────
step(1, "Checking Node and Claude Code");

// 22.18 is the first release that runs TypeScript files directly, which is how
// `npm run scyne` and the setup's own prompt helper are loaded.
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 18)) {
  stop(`Node ${process.versions.node} is too old. Install Node 24 (https://nodejs.org) and run this again.`);
}
ok(`Node ${process.versions.node}`);

// The agents ARE Claude Code processes. Without the CLI every run fails at its
// first step, long after the person who could fix it has walked away.
const claude = spawnSync("claude", ["--version"], { encoding: "utf8", shell: WIN });
if (claude.status !== 0) {
  stop("Claude Code is not installed. Install it, sign in once, then run this again:\n" +
    "      npm install -g @anthropic-ai/claude-code\n" +
    "      claude          (follow the sign-in, then type /exit)");
}
ok(`Claude Code ${claude.stdout.trim()} — make sure you have signed in once by running \`claude\``);

// ─── 2. Packages ────────────────────────────────────────────────────────────
step(2, "Installing packages (the first time takes a few minutes)");
for (const dir of [".", "packages/orchestrator", "scyne-chatbot"]) {
  const r = spawnSync("npm", ["install", "--no-fund", "--no-audit"], {
    cwd: path.join(ROOT, dir), stdio: "inherit", shell: WIN,
  });
  if (r.status !== 0) stop(`npm install failed in ${dir}`);
  ok(dir === "." ? "workspace" : dir);
}

// ─── 3. Skills ──────────────────────────────────────────────────────────────
step(3, "Linking the skills");
// `.claude/` is gitignored, so a fresh clone has no skills and every agent run
// would die with `Unknown skill: <slug>`.
const link = spawnSync("npm", ["run", "-s", "link-skills"], {
  cwd: ROOT, stdio: ["ignore", "ignore", "inherit"], shell: WIN,
});
if (link.status !== 0) stop("linking the skills failed");
ok(".claude/skills");

const { prompt } = await import("../cli/prompt.ts");

// ─── 4. .env ────────────────────────────────────────────────────────────────
step(4, "Writing .env");
const envFile = path.join(ROOT, ".env");
if (existsSync(envFile)) {
  ok(".env already exists — kept as it is");
} else {
  const gemini = flag("gemini-key") ??
    await prompt("  Gemini API key for the chat (Enter to add it to .env later): ");
  writeFileSync(envFile, envTemplate(gemini), { mode: 0o600 });
  ok(gemini ? ".env written" : ".env written — add GEMINI_API_KEY to it before using the chat");
}

// ─── 5. First login, and the key background jobs use ───────────────────────
step(5, "Admin login");
loadEnvFile(envFile);
const { admin, restart } = await withServer(async (base, running) => {
  let admin = null;
  let session = null;

  // Asked of the server rather than guessed from what is on disk: an install
  // whose `npm run dev` ran before setup has a database and still no login.
  // `/auth/bootstrap` makes the FIRST account only, so a claimed install is
  // told so instead of being asked for a login that could never be saved.
  // Null from a server started before `/auth/status` existed — a `npm run dev`
  // left running across a pull — and then the bootstrap's own 403 says it.
  const status = await fetch(`${base}/auth/status`)
    .then((r) => (r.ok ? r.json() : null)).catch(() => null);
  if (status?.claimed) {
    ok("this install already has its admin — sign in with that login");
    console.log("    To add a person: the console's Users tab, or, while `npm run dev` runs:\n" +
                "    npm run scyne -- user create <email>");
  } else {
    const { email, password } = await credentials("Admin email: ", "Admin password: ");
    if (email) {
      const res = await post(`${base}/auth/bootstrap`, { email, password, name: flag("name") });
      if (res.status === 403) {
        ok("not created — this install already has its admin. Sign in with that login");
      } else if (!res.ok) {
        stop(`could not create the login: ${res.body.error ?? res.status}`);
      } else {
        admin = res.body.user?.email ?? email;
        session = res.body.token;
        ok(`admin login created for ${admin}${running ? " (on your running `npm run dev`)" : ""}`);
      }
    } else {
      ok("skipped — run setup again to create it");
    }
  }

  // Document extraction runs as a background step and reports its progress —
  // one comment and one run row per document — through the orchestrator's API,
  // which needs a key. Without one the work still happens but nothing moves on
  // screen until all of it is done, which reads as stuck.
  if (process.env.SCYNE_ORCH_TOKEN) return { admin, restart: false };
  if (!session) {
    console.log("  Background jobs need a key to report their progress. Sign in once to make it:");
    const { email, password } = await credentials("Email: ", "Password: ");
    if (!email) {
      ok("skipped — run setup again to add it; extraction will show no progress until then");
      return { admin, restart: false };
    }
    const res = await post(`${base}/auth/login`, { email, password });
    if (!res.ok) stop(`could not sign in: ${res.body.error ?? res.status}`);
    session = res.body.token;
  }
  const minted = await post(`${base}/auth/tokens`, { name: "background jobs (setup)" }, session);
  if (!minted.ok || !minted.body.token) stop(`could not create the key: ${minted.body.error ?? minted.status}`);
  setEnvVar(envFile, "SCYNE_ORCH_TOKEN", minted.body.token,
    "# Lets background jobs (document extraction) report progress. Made by `npm run setup`.");
  ok("progress key saved to .env");
  return { admin, restart: running };
});

console.log(`
  Setup done.

  Start Scyne (every time):   npm run dev
  Then open:                  http://localhost:5173${admin ? `   — sign in as ${admin}` : ""}
  Operator console:           http://127.0.0.1:3100/orch
${restart ? "\n  `npm run dev` is running: stop it (Ctrl+C) and start it again so it reads the new .env.\n" : ""}`);
// A prompt leaves stdin open, which would keep the process alive.
process.exit(0);


// ─── helpers ────────────────────────────────────────────────────────────────

/**
 * Run `fn` against an orchestrator: the one `npm run dev` already has on :3100
 * if it is up, otherwise one started for the purpose on a spare port and
 * stopped afterwards. Going through the real server — the routes `scyne init`
 * uses — keeps password hashing and the audit entry in one place.
 *
 * Starting a second server while dev runs is what this avoids: it would hit the
 * built-in database's lock, or on Postgres mark the running one's in-flight
 * runs orphaned.
 */
async function withServer(fn) {
  if (await healthy("http://127.0.0.1:3100")) return fn("http://127.0.0.1:3100", true);

  const port = await freePort();
  const tsx = path.join(ROOT, "node_modules", ".bin", WIN ? "tsx.cmd" : "tsx");
  const server = spawn(tsx, ["packages/orchestrator/src/cli.ts", "serve", "--port", String(port)], {
    cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], shell: WIN,
  });
  let log = "";
  server.stdout.on("data", (d) => { log += d; });
  server.stderr.on("data", (d) => { log += d; });
  const exited = new Promise((res) => server.on("exit", res));
  const tail = () => log.trim().split("\n").slice(-15).join("\n");

  try {
    const base = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 120_000;
    while (!(await healthy(base))) {
      if (server.exitCode !== null) stop(`the orchestrator did not start:\n${tail()}`);
      if (Date.now() > deadline) stop(`the orchestrator did not answer within two minutes:\n${tail()}`);
      await new Promise((r) => setTimeout(r, 500));
    }
    return await fn(base, false);
  } finally {
    // SIGTERM, which `serve` handles by closing the database cleanly — killing
    // it outright could leave the built-in database's lock file behind.
    server.kill("SIGTERM");
    const timer = setTimeout(() => server.kill("SIGKILL"), 15_000);
    await exited;
    clearTimeout(timer);
  }
}

async function healthy(base) {
  try { return (await fetch(`${base}/health`)).ok; } catch { return false; }
}

function envTemplate(gemini) {
  return `# Written by \`npm run setup\` — everything runs on this machine.
# Every other setting, and what it does, is described in .env.example.

# The agents run on the Claude Code CLI, signed in as you.
SCYNE_ADAPTER=claude_local

# Documents are kept in .orchestrator/blobs. No Docker, and they survive restarts.
SCYNE_DOCUMENT_STORE=local

# Nothing is published to Confluence, Jira or Azure DevOps.
PUBLISH_TARGET=none

# The built-in database lives in .orchestrator/pgdata. To use your own Postgres
# instead, set this (and run setup again for its first login):
# DATABASE_URL=postgres://user:password@localhost:5432/scyne

# The chat's model.
GEMINI_API_KEY=${gemini ?? ""}
`;
}

/** Ask for an email, then — only if one was given — a password. Flags win. */
async function credentials(emailLabel, passwordLabel) {
  const email = flag("email") ?? await prompt(`  ${emailLabel}`);
  if (!email) return { email: "", password: "" };
  const password = flag("password") ?? await prompt(`  ${passwordLabel}`, { silent: true });
  if (!password) stop("a password is required");
  return { email, password };
}

async function post(url, body, token) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return { ok: res.ok, status: res.status, body: await res.json().catch(() => ({})) };
}

/** Set one variable in .env: replace its line (commented or not), else append. */
function setEnvVar(file, name, value, comment) {
  const text = existsSync(file) ? readFileSync(file, "utf8") : "";
  const line = new RegExp(`^#?\\s*${name}=.*$`, "m");
  const next = line.test(text)
    ? text.replace(line, `${name}=${value}`)
    : `${text.replace(/\n*$/, "\n")}\n${comment}\n${name}=${value}\n`;
  writeFileSync(file, next, { mode: 0o600 });
  process.env[name] = value;
}

function loadEnvFile(file) {
  try { process.loadEnvFile(file); } catch { /* no .env is fine */ }
}

function freePort() {
  return new Promise((res, rej) => {
    const s = createServer();
    s.once("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
  });
}
