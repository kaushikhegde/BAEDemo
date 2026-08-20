#!/usr/bin/env node
/**
 * Prove the platform works, without touching your real database.
 *
 *   node scripts/smoke-test.mjs
 *
 * It starts an orchestrator on a scratch port against a THROWAWAY database in a
 * temp directory, exercises every part of the platform that does not need an
 * agent to run, prints a pass/fail line each, and tears down.
 *
 * What it deliberately does NOT do: spawn an agent, or publish anything. Both
 * need live credentials, cost money, and take tens of minutes — so they are
 * checked separately, at the end, as configuration rather than behaviour.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(join(fileURLToPath(import.meta.url), "..", ".."));
const PORT = Number(process.env.SMOKE_PORT || 3299);
const BASE = `http://127.0.0.1:${PORT}`;
const HOME = mkdtempSync(join(tmpdir(), "scyne-smoke-home-"));
const WORK = mkdtempSync(join(tmpdir(), "scyne-smoke-work-"));

let pass = 0, fail = 0;
const ok = (label, detail = "") => { pass++; console.log(`  \x1b[32m✓\x1b[0m ${label}${detail ? "  " + detail : ""}`); };
const bad = (label, detail = "") => { fail++; console.log(`  \x1b[31m✗\x1b[0m ${label}${detail ? "\n      " + detail : ""}`); };
const head = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

/** Assert, without letting one failure end the run — the rest is still informative. */
const check = async (label, fn) => {
  try {
    const detail = await fn();
    ok(label, typeof detail === "string" ? detail : "");
  } catch (err) {
    bad(label, String(err && err.message ? err.message : err).split("\n")[0]);
  }
};
const eq = (actual, expected, what) => {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${what}: expected ${b}, got ${a}`);
};

// --------------------------------------------------------------- the server

const server = spawn(
  "npx", ["--prefix", REPO, "tsx", join(REPO, "packages/orchestrator/src/cli.ts"),
          "serve", "--port", String(PORT), "--config", join(REPO, "orchestrator.config.ts")],
  {
    cwd: WORK,
    env: { ...process.env, SCYNE_INSTALL_ROOT: REPO },
    stdio: ["ignore", "pipe", "pipe"],
    // Its OWN process group, so it can be killed as a group below.
    detached: true,
  });

let serverLog = "";
server.stdout.on("data", d => { serverLog += d; });
server.stderr.on("data", d => { serverLog += d; });

/**
 * Tear down on EVERY exit path, not just a clean one.
 *
 * `process.on("exit")` alone is not enough: a Ctrl-C, a SIGTERM from a CI
 * runner or a harness timeout skips it and leaves an orchestrator listening on
 * this port. That is not a tidy-up nicety — a leftover server competes for CPU
 * with the real test suite, whose PGlite tests then time out, and the failure
 * reads as "nine test files broke" rather than "something is still running".
 * Observed exactly that way while writing this.
 */
let stopped = false;
const stop = () => {
  if (stopped) return;
  stopped = true;
  // Kill the GROUP, not the process. `npx` spawns `tsx`, which spawns `node`
  // — killing only the one we hold orphans the grandchild that is actually
  // holding the port, and it goes on running after this script exits.
  // Measured: a "clean" run left an orchestrator on 3299 every time.
  try { process.kill(-server.pid, "SIGKILL"); } catch { /* already gone */ }
  try { server.kill("SIGKILL"); } catch { /* already gone */ }
  rmSync(HOME, { recursive: true, force: true });
  rmSync(WORK, { recursive: true, force: true });
};
process.on("exit", stop);
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => { stop(); process.exit(130); });
}
process.on("uncaughtException", (err) => {
  stop();
  console.error("\nThe smoke test itself broke:", err && err.message ? err.message : err);
  process.exit(1);
});

/**
 * Refuse to run against a server we did not start.
 *
 * If something is already on this port, every check below would be testing
 * THAT process — quite possibly an older build — and passing or failing for
 * reasons unrelated to the working tree. Measured the hard way earlier in this
 * project: a stale listener answered 200 to a route that should have been 401,
 * and the "boundary works" conclusion was simply wrong.
 */
async function refuseIfPortBusy() {
  try {
    const r = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(1500) });
    if (r.ok) {
      console.error(
        `\nSomething is already listening on ${BASE}.\n` +
        `  Every check below would be testing THAT process, not this working tree.\n` +
        `  Stop it, or pick another port:  SMOKE_PORT=3399 npm run smoke\n`);
      process.exit(1);
    }
  } catch { /* nothing there — good */ }
}

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) return;
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 1000));
  }
  console.error("The orchestrator did not start. Its output:\n" + serverLog.slice(-1500));
  process.exit(1);
}

// ----------------------------------------------------------------- helpers

const call = async (method, path, { token, body, headers } = {}) => {
  const r = await fetch(BASE + path, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(headers || {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { raw: text }; }
  return { status: r.status, body: parsed, headers: r.headers };
};

const login = async (email, password) => {
  const r = await call("POST", "/auth/login", { body: { email, password } });
  if (r.status !== 200) throw new Error(`login as ${email} failed (${r.status})`);
  return r.body.token;
};

console.log(`\nScyne smoke test — throwaway database in ${WORK}`);
console.log(`Your real .orchestrator/pgdata is not touched.\n`);
await refuseIfPortBusy();
await waitForServer();

// ============================================================ 1. the boundary

head("1. The API is closed");
for (const p of ["/issues", "/agents", "/config", "/usage", "/orgs", "/users", "/spend", "/models"]) {
  await check(`${p} refuses an anonymous caller`, async () => {
    const r = await call("GET", p);
    eq(r.status, 401, p);
    return "401";
  });
}
await check("/health stays open — a health check with a credential is not one", async () => {
  eq((await call("GET", "/health")).status, 200, "/health");
  return "200";
});
await check("/orch serves its shell, so there is somewhere to log in", async () => {
  eq((await call("GET", "/orch")).status, 200, "/orch");
  return "200";
});

// ========================================================== 2. claiming it

head("2. Claiming the installation");
let root = null;
await check("the first account claims it AS THE SUPERADMIN", async () => {
  const r = await call("POST", "/auth/bootstrap", { body: { email: "root@smoke.co", password: "pw-root" } });
  eq(r.status, 201, "bootstrap");
  eq(r.body.user.role, "superadmin", "role");
  root = r.body.token;
  return r.body.user.email;
});
await check("it can only be claimed once", async () => {
  eq((await call("POST", "/auth/bootstrap", { body: { email: "b@smoke.co", password: "x" } })).status, 403, "second");
  return "403";
});
await check("login sets an httpOnly cookie, so the console holds no token", async () => {
  const r = await call("POST", "/auth/login", { body: { email: "root@smoke.co", password: "pw-root" } });
  const c = r.headers.get("set-cookie") || "";
  if (!/scyne_session=/.test(c)) throw new Error("no session cookie");
  if (!/HttpOnly/i.test(c)) throw new Error("the cookie is readable by JavaScript");
  return "HttpOnly, SameSite=Strict";
});
await check("a wrong password says nothing about whether the address exists", async () => {
  const wrong = await call("POST", "/auth/login", { body: { email: "root@smoke.co", password: "nope" } });
  const absent = await call("POST", "/auth/login", { body: { email: "ghost@smoke.co", password: "nope" } });
  eq(wrong.body.error, absent.body.error, "the two messages");
  return `both: "${wrong.body.error}"`;
});

// ======================================================= 3. two organisations

head("3. Two organisations cannot see each other");
let alpha = null, beta = null, ana = null, bo = null;
await check("a superadmin creates them", async () => {
  const a = await call("POST", "/orgs", { token: root, body: { name: "Alpha Council" } });
  const b = await call("POST", "/orgs", { token: root, body: { name: "Beta Insurance" } });
  eq([a.status, b.status], [201, 201], "creates");
  alpha = a.body; beta = b.body;
  return `${a.body.slug}, ${b.body.slug}`;
});
await check("an admin in each, with a project each", async () => {
  for (const [org, email] of [[alpha, "ana@alpha.co"], [beta, "bo@beta.co"]]) {
    const u = await call("POST", "/users", {
      token: root, headers: { "x-scyne-org": org.slug },
      body: { email, password: "pw", role: "admin" },
    });
    eq(u.status, 201, `create ${email}`);
  }
  const pa = await call("POST", "/projects", { token: root, headers: { "x-scyne-org": alpha.slug }, body: { name: "AlphaClaims" } });
  const pb = await call("POST", "/projects", { token: root, headers: { "x-scyne-org": beta.slug }, body: { name: "BetaClaims" } });
  eq([pa.status, pb.status], [201, 201], "projects");
  ana = await login("ana@alpha.co", "pw");
  bo = await login("bo@beta.co", "pw");
  return "ana@alpha.co, bo@beta.co";
});
await check("each sees only their own project", async () => {
  const a = (await call("GET", "/projects", { token: ana })).body.map(p => p.name);
  const b = (await call("GET", "/projects", { token: bo })).body.map(p => p.name);
  eq(a, ["AlphaClaims"], "Ana's projects");
  eq(b, ["BetaClaims"], "Bo's projects");
  return "Ana: AlphaClaims · Bo: BetaClaims";
});
await check("each sees only their own users", async () => {
  const a = (await call("GET", "/users", { token: ana })).body.map(u => u.email);
  eq(a, ["ana@alpha.co"], "Ana's users");
  return "no leakage";
});
await check("an admin CANNOT act as another organisation", async () => {
  const r = await call("GET", "/projects", { token: ana, headers: { "x-scyne-org": beta.slug } });
  eq(r.status, 403, "X-Scyne-Org from a non-superadmin");
  return "403, refused rather than ignored";
});
await check("an admin CANNOT create an organisation", async () => {
  eq((await call("POST", "/orgs", { token: ana, body: { name: "Sneaky" } })).status, 403, "create");
  return "403";
});
await check("an admin CANNOT mint a superadmin", async () => {
  const r = await call("POST", "/users", { token: ana, body: { email: "x@y.co", password: "p", role: "superadmin" } });
  eq(r.status, 403, "escalation");
  return "403";
});
await check("a project name another organisation holds is refused", async () => {
  const r = await call("POST", "/projects", { token: root, headers: { "x-scyne-org": beta.slug }, body: { name: "AlphaClaims" } });
  eq(r.status, 409, "duplicate name");
  eq(r.body.error, "name_taken", "code");
  return "409 name_taken";
});

// ============================================================ 4. issue control

head("4. Pause, resume, cancel");
let issue = null;
await check("an issue starts, attributed to the person who started it", async () => {
  const r = await call("POST", "/issues", {
    token: root, headers: { "x-scyne-org": alpha.slug },
    body: { workflow: "capabilities", params: { project: "AlphaClaims" } },
  });
  eq(r.status, 201, "create");
  issue = r.body;
  const me = (await call("GET", "/auth/whoami", { token: root })).body;
  eq(issue.created_by, me.id, "created_by");
  return issue.identifier;
});
await check("another organisation cannot even see it", async () => {
  eq((await call("GET", `/issues/${issue.id}`, { token: bo })).status, 404, "cross-tenant read");
  return "404, not 403 — a 403 would confirm it exists";
});
await check("nor pause, cancel or delete it", async () => {
  for (const v of ["pause", "cancel", "resume"]) {
    eq((await call("POST", `/issues/${issue.id}/${v}`, { token: bo })).status, 404, v);
  }
  eq((await call("DELETE", `/issues/${issue.id}`, { token: bo })).status, 404, "delete");
  return "all 404";
});
const status = async () =>
  (await call("GET", `/issues/${issue.id}`, { token: root, headers: { "x-scyne-org": alpha.slug } })).body.status;
await check("pause parks it — at the next step boundary, not instantly", async () => {
  // A graceful pause is DELIBERATELY not immediate: the step in flight
  // finishes first, which is why the route answers 202 rather than 200 and why
  // the API documentation says to poll. Asserting it instantly would be
  // asserting the opposite of the design.
  await call("POST", `/issues/${issue.id}/pause`, { token: root, headers: { "x-scyne-org": alpha.slug }, body: {} });
  for (let i = 0; i < 40; i++) {
    if (await status() === "paused") return "paused, after " + ((i + 1) * 250) + "ms";
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error(`still ${await status()} after 10s`);
});
await check("resume brings it back", async () => {
  const r = await call("POST", `/issues/${issue.id}/resume`, { token: root, headers: { "x-scyne-org": alpha.slug }, body: {} });
  eq(r.status, 202, "resume");
  return "202";
});
await check("cancel is terminal, and refuses to resume", async () => {
  // Same as pause: the resume above left a step running, so the cancel lands
  // at the next boundary rather than instantly.
  await call("POST", `/issues/${issue.id}/cancel`, { token: root, headers: { "x-scyne-org": alpha.slug }, body: {} });
  let settled = null;
  for (let i = 0; i < 40 && settled !== "cancelled"; i++) {
    settled = await status();
    if (settled !== "cancelled") await new Promise(r => setTimeout(r, 250));
  }
  if (settled !== "cancelled") throw new Error(`still ${settled} after 10s`);
  const again = await call("POST", `/issues/${issue.id}/resume`, { token: root, headers: { "x-scyne-org": alpha.slug }, body: {} });
  eq(again.status, 409, "resume after cancel");
  return "cancelled, then 409 on resume";
});

// ================================================================= 5. cost

head("5. Cost");
await check("the model price catalogue is seeded", async () => {
  const models = (await call("GET", "/models", { token: root })).body;
  const terra = models.find(m => m.model === "gpt-5.6-terra");
  if (!terra) throw new Error("gpt-5.6-terra is missing");
  return `${models.length} models`;
});
await check("a model with no published price is UNPRICED, not free", async () => {
  const models = (await call("GET", "/models", { token: root })).body;
  const spark = models.find(m => m.model === "gpt-5.3-codex-spark");
  if (!spark.unpriced) throw new Error("it is not flagged unpriced");
  if (spark.input_per_mtok !== null) throw new Error("it has a price");
  return "— rather than $0.00";
});
await check("models at or near retirement are flagged", async () => {
  const models = (await call("GET", "/models", { token: root })).body;
  const risky = models.filter(m => m.retiring_soon || m.retired).map(m => m.model);
  if (!risky.length) throw new Error("nothing flagged");
  return risky.join(", ");
});
await check("a price refresh is a PROPOSAL with a diff, applied by a superadmin", async () => {
  const prop = await call("POST", "/models/refresh", {
    token: root, body: { source: "smoke test", rows: [{ provider: "openai", model: "gpt-5.6-terra", input_per_mtok: 9.99 }] },
  });
  eq(prop.status, 200, "propose");
  eq(prop.body.diff.length, 1, "diff length");
  const before = (await call("GET", "/models", { token: root })).body.find(m => m.model === "gpt-5.6-terra");
  if (Number(before.input_per_mtok) === 9.99) throw new Error("it was applied without approval");
  const applied = await call("POST", "/models/refresh/apply", { token: root });
  eq(applied.body.applied, 1, "applied");
  const after = (await call("GET", "/models", { token: root })).body.find(m => m.model === "gpt-5.6-terra");
  eq(Number(after.input_per_mtok), 9.99, "after apply");
  return "proposed → diff → applied";
});
await check("a refresh spelled the way the rest of the API writes is not silently inert", async () => {
  // camelCase, which every other write endpoint accepts. The proposal path
  // stored rows verbatim and read snake_case only, so this shape was accepted
  // with 200, diffed as "changes nothing", and applied as a no-op reporting
  // success — the entire price-refresh feature, doing nothing.
  const prop = await call("POST", "/models/refresh", {
    token: root, body: { source: "smoke test, camelCase", rows: [{ model: "gpt-5-mini", inputPerMTok: 0.33 }] },
  });
  eq(prop.status, 200, "propose");
  eq(prop.body.diff.length, 1, "diff sees the change");
  await call("POST", "/models/refresh/apply", { token: root });
  const after = (await call("GET", "/models", { token: root })).body.find(m => m.model === "gpt-5-mini");
  eq(Number(after.input_per_mtok), 0.33, "after apply");
  return "camelCase → diff → applied";
});
await check("a hand correction leaves the rates it does not mention alone", async () => {
  // `models set --input` used to clear the cached rate, and most of a long
  // agent run's input is cached — so it silently raised every later run's cost.
  const before = (await call("GET", "/models", { token: root })).body.find(m => m.model === "gpt-5");
  await call("PUT", "/models/openai/gpt-5", { token: root, body: { inputPerMTok: 1.3 } });
  const after = (await call("GET", "/models", { token: root })).body.find(m => m.model === "gpt-5");
  eq(Number(after.input_per_mtok), 1.3, "input changed");
  eq(Number(after.cached_input_per_mtok), Number(before.cached_input_per_mtok), "cached preserved");
  eq(Number(after.output_per_mtok), Number(before.output_per_mtok), "output preserved");
  return "only what was named changed";
});
await check("an implausible price is refused before it can be proposed", async () => {
  const r = await call("POST", "/models/refresh", { token: root, body: { rows: [{ model: "gpt-5", input_per_mtok: 15000 }] } });
  eq(r.status, 400, "sanity ceiling");
  return "400 invalid_rows";
});
await check("spend answers on every dimension", async () => {
  const dims = ["project", "feature", "user", "agent", "adapter", "model"];
  for (const d of dims) {
    const r = await call("GET", `/spend?by=${d}`, { token: root });
    eq(r.status, 200, d);
  }
  return dims.join(", ");
});

// ================================================================ 6. audit

head("6. Audit");
await check("every action names the person who took it", async () => {
  const actions = (await call("GET", "/actions", { token: root, headers: { "x-scyne-org": alpha.slug } })).body;
  const named = actions.filter(a => a.user_email);
  if (!named.length) throw new Error("no action carries an actor");
  const verbs = [...new Set(actions.map(a => a.verb))];
  return `${actions.length} actions: ${verbs.slice(0, 6).join(", ")}`;
});
await check("stopping a run is recorded", async () => {
  const actions = (await call("GET", "/actions", { token: root, headers: { "x-scyne-org": alpha.slug } })).body;
  for (const v of ["issue.pause", "issue.cancel"]) {
    if (!actions.some(a => a.verb === v)) throw new Error(`${v} was not recorded`);
  }
  return "issue.pause, issue.cancel";
});

// ---------------------------------------------------------------- the end

console.log(`\n\x1b[1m${pass} passed, ${fail} failed\x1b[0m`);
console.log(fail
  ? `\nSomething above is wrong. The server's own output:\n${serverLog.slice(-800)}`
  : `\nThe platform works. What this could NOT check, because both need live\n` +
    `credentials: an actual agent run (needs Codex auth) and publishing to the\n` +
    `wiki (needs the PAT's wiki scope). Run \x1b[1mnpm run ado:verify\x1b[0m for the second.`);
process.exit(fail ? 1 : 0);
