#!/usr/bin/env node
// Scaffold a Vite + React + Tailwind + shadcn/ui app for <project>/<feature>.
//
// Usage:
//   node scripts/scaffold-app.mjs <project> <feature>
//
// Behaviour:
//   - Creates generated-apps/<project>-<feature>/ if missing (Vite react-ts template).
//   - Installs deps. Adds Tailwind. Runs shadcn init -y -d.
//   - Allocates a free port (PAPERCLIP_PORT_BASE or 5174) and starts `npm run dev` detached.
//   - Polls the dev URL until it returns 200, then writes the registry entry and exits 0.
//   - Idempotent: if the app already exists and pid is alive, just re-prints the entry.
//
// Output: prints the registry entry JSON for this app on stdout.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const REGISTRY_PATH = join(ROOT, "generated-apps", "registry.json");
const PORT_BASE = Number(process.env.PAPERCLIP_PORT_BASE) || 5174;
const READY_TIMEOUT_MS = 60_000;
const INSTALL_TIMEOUT_MS = 120_000;

function usage() {
  console.error("usage: scaffold-app.mjs <project> <feature>");
  process.exit(2);
}

function readRegistry() {
  if (!existsSync(REGISTRY_PATH)) return {};
  try { return JSON.parse(readFileSync(REGISTRY_PATH, "utf8") || "{}"); } catch { return {}; }
}
function writeRegistry(reg) {
  writeFileSync(REGISTRY_PATH, JSON.stringify(reg, null, 2) + "\n");
}

function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function allocPort(reg, key) {
  if (reg[key]?.port) return reg[key].port;
  const used = new Set(Object.values(reg).map((e) => e.port).filter(Boolean));
  let p = PORT_BASE;
  while (used.has(p)) p += 1;
  return p;
}

function run(cmd, args, cwd, opts = {}) {
  const r = spawnSync(cmd, args, { cwd, stdio: "inherit", env: { ...process.env, ...(opts.env || {}) }, timeout: opts.timeout });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed (status=${r.status})`);
}

async function waitForReady(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { method: "GET" });
      if (res.status < 500) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function main() {
  const [, , project, feature] = process.argv;
  if (!project || !feature) usage();

  const key = `${project}-${feature}`;
  const appDir = join(ROOT, "generated-apps", key);
  const reg = readRegistry();
  const port = allocPort(reg, key);
  const devUrl = `http://127.0.0.1:${port}`;

  // 1. Scaffold Vite if missing.
  if (!existsSync(join(appDir, "package.json"))) {
    mkdirSync(appDir, { recursive: true });
    // npm create vite@latest <name> -- --template react-ts
    run("npm", ["create", "vite@latest", key, "--", "--template", "react-ts"], join(ROOT, "generated-apps"), { timeout: INSTALL_TIMEOUT_MS });
    run("npm", ["install"], appDir, { timeout: INSTALL_TIMEOUT_MS });
    // Tailwind + shadcn/ui deps.
    run("npm", ["install", "-D", "tailwindcss@^3", "postcss", "autoprefixer"], appDir, { timeout: INSTALL_TIMEOUT_MS });
    run("npx", ["tailwindcss", "init", "-p"], appDir);
    // Write minimal Tailwind config so shadcn init has something to extend.
    writeFileSync(join(appDir, "tailwind.config.js"),
      `/** @type {import('tailwindcss').Config} */\nexport default {\n  content: ["./index.html", "./src/**/*.{ts,tsx}"],\n  theme: { extend: {} },\n  plugins: [],\n};\n`);
    writeFileSync(join(appDir, "src", "index.css"),
      `@tailwind base;\n@tailwind components;\n@tailwind utilities;\n`);
    // shadcn init — try non-interactive; fall back to plain Tailwind if it fails.
    try {
      run("npx", ["-y", "shadcn@latest", "init", "-y", "-d"], appDir);
    } catch (e) {
      console.warn("[scaffold] shadcn init failed — continuing with plain Tailwind:", e.message);
    }
  }

  // 2. Start dev server on the chosen port, if not already alive.
  const existing = reg[key];
  if (existing?.pid && pidAlive(existing.pid)) {
    const okExisting = await waitForReady(devUrl, 2_000);
    if (okExisting) {
      console.log(JSON.stringify(existing, null, 2));
      return;
    }
  }

  // Detach the dev server so it survives this script exiting. Stream stdio directly to a
  // log file via file descriptors — piped streams would close when the parent exits.
  const logFile = join(appDir, "dev.log");
  const logFd = openSync(logFile, "a");
  // Bind 0.0.0.0 so the dev server is reachable through a published container
  // port (the browser still iframes devUrl = http://127.0.0.1:<port>). Override
  // with VITE_DEV_HOST for a host-only run.
  const devHost = process.env.VITE_DEV_HOST || "0.0.0.0";
  const out = spawn("npm", ["run", "dev", "--", "--host", devHost, "--port", String(port), "--strictPort"], {
    cwd: appDir,
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: { ...process.env },
  });
  out.on("error", (err) => { console.error("[scaffold] dev server spawn failed:", err.message); });
  out.unref();

  const ready = await waitForReady(devUrl, READY_TIMEOUT_MS);
  if (!ready) throw new Error(`dev server did not become ready at ${devUrl} within ${READY_TIMEOUT_MS}ms (see ${logFile})`);

  // 3. Update registry.
  const entry = {
    port,
    pid: out.pid,
    branch: existing?.branch || null,
    repoUrl: existing?.repoUrl || null,
    appPath: `generated-apps/${key}`,
    status: "running",
    devUrl,
    updatedAt: new Date().toISOString(),
  };
  const fresh = readRegistry();
  fresh[key] = entry;
  writeRegistry(fresh);

  console.log(JSON.stringify(entry, null, 2));
}

main().catch((e) => { console.error("[scaffold] error:", e.message); process.exit(1); });
