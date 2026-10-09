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
 * Safe to re-run. An existing `.env` is kept as it is, installs are no-ops when
 * nothing changed, and the login step is offered only on an install that has
 * no database yet.
 *
 * Imports nothing but Node built-ins at the top: it runs BEFORE `npm install`,
 * so a dependency imported here would not exist yet.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
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

// ─── 5. First login ─────────────────────────────────────────────────────────
step(5, "Admin login");
let admin = null;
// Only a brand-new install can have its first login made here:
// `/auth/bootstrap` refuses the moment any account exists. Neither a built-in
// database (.orchestrator/pgdata) nor a DATABASE_URL means nothing has been set
// up yet. Otherwise the install already has its logins, and booting a second
// orchestrator against its database would re-fire its unfinished runs — so it
// is left alone unless `--email` asks otherwise.
loadEnvFile(envFile);
const fresh = !process.env.DATABASE_URL && !existsSync(path.join(ROOT, ".orchestrator/pgdata"));

if (!fresh && !flag("email")) {
  ok("this install is already set up — sign in with the login you already have");
  console.log("    To add a person: the console's Users tab, or, while `npm run dev` runs:\n" +
              "    npm run scyne -- user create <email>");
} else {
  const email = flag("email") ?? await prompt("  Admin email: ");
  if (!email) {
    ok("skipped — run `npm run scyne -- init` while `npm run dev` is running to create it later");
  } else {
    const password = flag("password") ?? await prompt("  Admin password: ", { silent: true });
    if (!password) stop("a password is required");
    // A running stack on an existing database would hold the built-in
    // database's lock or, on Postgres, have its in-flight runs marked orphaned
    // by the second server's startup. A fresh install has nothing running.
    if (!fresh && await portInUse(3100)) {
      stop("`npm run dev` is running. Stop it (Ctrl+C), run setup again, then start it.");
    }
    admin = await claim(email, password, flag("name"));
  }
}

console.log(`
  Setup done.

  Start Scyne (every time):   npm run dev
  Then open:                  http://localhost:5173${admin ? `   — sign in as ${admin}` : ""}
  Operator console:           http://127.0.0.1:3100/orch
`);
// A prompt leaves stdin open, which would keep the process alive.
process.exit(0);


// ─── helpers ────────────────────────────────────────────────────────────────

/**
 * Create the first account through the orchestrator's own `/auth/bootstrap` —
 * the route `scyne init` uses — on a server started for the purpose on a spare
 * port, then stopped. The real code path, rather than writing the user row
 * here, so password hashing and the audit entry stay in one place.
 */
async function claim(email, password, name) {
  const port = await freePort();
  const tsx = path.join(ROOT, "node_modules", ".bin", WIN ? "tsx.cmd" : "tsx");
  const server = spawn(tsx, ["packages/orchestrator/src/cli.ts", "serve", "--port", String(port)], {
    cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], shell: WIN,
  });
  let log = "";
  server.stdout.on("data", (d) => { log += d; });
  server.stderr.on("data", (d) => { log += d; });
  const exited = new Promise((res) => server.on("exit", res));

  try {
    const base = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 120_000;
    for (;;) {
      if (server.exitCode !== null) stop(`the orchestrator did not start:\n${log.trim().split("\n").slice(-15).join("\n")}`);
      if (Date.now() > deadline) stop(`the orchestrator did not answer within two minutes:\n${log.trim().split("\n").slice(-15).join("\n")}`);
      try {
        if ((await fetch(`${base}/health`)).ok) break;
      } catch { /* not listening yet */ }
      await new Promise((r) => setTimeout(r, 500));
    }

    const res = await fetch(`${base}/auth/bootstrap`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password, name }),
    });
    const body = await res.json().catch(() => ({}));
    if (res.status === 403) {
      // Not saved: an install has exactly one first login, made once.
      ok("not created — this install already has its admin. Sign in with that login");
      return null;
    }
    if (!res.ok) stop(`could not create the login: ${body.error ?? res.status}`);
    ok(`admin login created for ${body.user?.email ?? email}`);
    return body.user?.email ?? email;
  } finally {
    // SIGTERM, which `serve` handles by closing the database cleanly — killing
    // it outright could leave the built-in database's lock file behind.
    server.kill("SIGTERM");
    const timer = setTimeout(() => server.kill("SIGKILL"), 15_000);
    await exited;
    clearTimeout(timer);
  }
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
# instead, set this (and run setup's login step again):
# DATABASE_URL=postgres://user:password@localhost:5432/scyne

# The chat's model.
GEMINI_API_KEY=${gemini ?? ""}
`;
}

function loadEnvFile(file) {
  try { process.loadEnvFile(file); } catch { /* no .env is fine */ }
}

function portInUse(port) {
  return new Promise((res) => {
    const s = createServer();
    s.once("error", () => res(true));
    s.once("listening", () => s.close(() => res(false)));
    s.listen(port, "127.0.0.1");
  });
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
