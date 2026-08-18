// The orchestrator's console: ONE self-contained HTML page, inline CSS and JS,
// zero network requests beyond the local API. Same house pattern as the parent
// project's scripts/render-companion-app.mjs — no bundler, no build step, no
// version skew, and it works on a client's laptop with the wifi off.
//
// Tabs are hash-routed (#runs, #issues, …) so a reload lands where you were and
// a link to one run's transcript is shareable.

import type { Theme } from "../config.js";
import { themeCss } from "./theme.js";

const TABS: ReadonlyArray<readonly [string, string]> = [
  ["runs", "Runs"], ["issues", "Issues"], ["gates", "Gates"],
  ["org", "Org"], ["budgets", "Budgets"], ["config", "Config"], ["health", "Health"],
];

export function renderConsole(theme: Theme): string {
  return `<!doctype html>
<html lang="en-AU">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${theme.logoText}</title>
<style>
${themeCss(theme)}
header { display: flex; align-items: baseline; gap: .75rem; padding: .8rem 1.25rem;
         background: var(--brand-deep); color: #fff; }
header .mark { font-weight: 700; letter-spacing: .01em; }
header .spacer { flex: 1; }
header .health { font-size: .78rem; opacity: .8; }
nav { display: flex; gap: .15rem; padding: 0 1.25rem; background: var(--brand);
      border-bottom: 1px solid var(--border); flex-wrap: wrap; }
nav a { padding: .5rem .85rem; color: #fff; text-decoration: none; font-size: .88rem;
        opacity: .72; border-bottom: 2px solid transparent; }
nav a:hover { opacity: .95; }
nav a.on { opacity: 1; border-bottom-color: var(--accent); }
main { padding: 1.25rem; max-width: 1400px; }
h2 { font-size: 1rem; margin: 0 0 .75rem; }
table { width: 100%; border-collapse: collapse; font-size: .86rem; }
th { text-align: left; font-weight: 600; padding: .5rem .6rem; border-bottom: 1px solid var(--border);
     position: sticky; top: 0; background: var(--bg); }
td { padding: .45rem .6rem; border-bottom: 1px solid var(--border); vertical-align: top; }
tr.clickable:hover td { background: var(--surface); cursor: pointer; }
.pill { display: inline-block; padding: .08rem .5rem; border-radius: 999px; font-size: .72rem;
        font-weight: 600; color: #fff; background: var(--ink-500); }
.pill.todo, .pill.queued { background: var(--ink-200); color: #1a1c2b; }
.pill.in_progress, .pill.running { background: var(--info); }
.pill.in_review { background: var(--warning); color: #1a1c2b; }
.pill.done, .pill.succeeded { background: var(--success); }
.pill.blocked, .pill.failed, .pill.over_budget, .pill.orphaned { background: var(--danger); }
.muted { color: var(--ink-500); }
.card { background: var(--surface); border: 1px solid var(--border); border-radius: .5rem;
        padding: .9rem 1rem; margin-bottom: .7rem; }
.card h3 { margin: 0 0 .4rem; font-size: .92rem; }
.card pre { white-space: pre-wrap; font-size: .8rem; margin: .4rem 0 .7rem; color: var(--ink-500); }
button { font: inherit; font-size: .85rem; padding: .32rem .8rem; border-radius: .3rem;
         border: 1px solid var(--brand); background: var(--brand); color: #fff; cursor: pointer; }
button.ghost { background: transparent; color: var(--fg); border-color: var(--border); }
button:disabled { opacity: .45; cursor: default; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: .7rem; }
.mono, #transcript { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .78rem; }
#transcript { line-height: 1.55; white-space: pre-wrap; word-break: break-word;
              max-height: 64vh; overflow-y: auto; background: var(--surface);
              border: 1px solid var(--border); border-radius: .5rem; padding: .8rem; }
#transcript div { margin-bottom: .15rem; }
#transcript .tool_use { color: var(--brand); }
#transcript .tool_result { color: var(--ink-500); }
#transcript .skill { color: var(--accent); font-weight: 700; }
#transcript .framing { color: var(--ink-500); font-style: italic; }
.empty { padding: 2rem 0; text-align: center; color: var(--ink-500); }
</style>
</head>
<body>
<header>
  <span class="mark">${theme.logoText}</span>
  <span class="spacer"></span>
  <span class="health" id="health">…</span>
</header>
<nav>${TABS.map(([id, label]) => `<a href="#${id}" data-tab="${id}">${label}</a>`).join("")}</nav>
<main id="view"><p class="empty">Loading…</p></main>
<script>
const api = async (p) => {
  const r = await fetch(p, { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(p + " → " + r.status);
  return r.json();
};
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;" }[c]));
const pill = (s) => '<span class="pill ' + esc(s) + '">' + esc(s) + '</span>';
const ago = (iso) => {
  if (!iso) return "—";
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return Math.round(s) + "s ago";
  if (s < 3600) return Math.round(s / 60) + "m ago";
  if (s < 86400) return Math.round(s / 3600) + "h ago";
  return Math.round(s / 86400) + "d ago";
};
const dur = (ms) => ms == null ? "—" : (Number(ms) / 1000).toFixed(1) + "s";
const money = (n) => n == null ? "—" : "$" + Number(n).toFixed(4);
const num = (n) => Number(n ?? 0).toLocaleString("en-AU");
const view = document.getElementById("view");

// One poll timer for the whole app: every route change clears it, so leaving a
// transcript open and navigating away cannot leak a second poller.
let poll = null;
const stopPolling = () => { if (poll) { clearInterval(poll); poll = null; } };

async function renderHealth() {
  const [h, u] = await Promise.all([api("/health"), api("/usage")]);
  view.innerHTML = '<h2>Health</h2><div class="grid">' +
    '<div class="card"><h3>Database</h3>' + esc(h.db) + '</div>' +
    '<div class="card"><h3>Claude Code</h3>' + esc(h.claude) + '</div>' +
    '<div class="card"><h3>Runs</h3>' + num(u.runCount) + '</div>' +
    '<div class="card"><h3>Spend</h3>' + money(u.costUsd) + '</div>' +
    '<div class="card"><h3>Tokens in / out</h3>' + num(u.inputTokens) + " / " + num(u.outputTokens) + '</div>' +
    '<div class="card"><h3>Cache read</h3>' + num(u.cacheReadTokens) + '</div>' +
    '</div>';
}

async function allRuns() {
  const issues = await api("/issues");
  const byId = Object.fromEntries(issues.map(i => [i.id, i]));
  const lists = await Promise.all(issues.map(i => api("/issues/" + i.id + "/runs").catch(() => [])));
  const runs = lists.flat().sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)));
  return { runs, byId };
}

async function renderRuns() {
  const { runs, byId } = await allRuns();
  const agents = await api("/agents").catch(() => []);
  const agentName = Object.fromEntries(agents.map(a => [a.id, a.key]));
  if (!runs.length) { view.innerHTML = '<h2>Runs</h2><p class="empty">No runs yet.</p>'; return; }
  view.innerHTML = '<h2>Runs</h2>' +
    '<table><thead><tr><th>Started</th><th>Issue</th><th>Agent</th><th>Phase</th>' +
    '<th>Status</th><th>Duration</th><th>Tokens</th><th>Cost</th></tr></thead><tbody>' +
    runs.map(r => '<tr class="clickable" data-run="' + esc(r.id) + '">' +
      '<td>' + ago(r.started_at) + '</td>' +
      '<td>' + esc(byId[r.issue_id]?.identifier ?? "—") + '</td>' +
      '<td>' + esc(agentName[r.agent_id] ?? "—") + '</td>' +
      '<td>' + esc(r.phase ?? "—") + '</td>' +
      '<td>' + pill(r.status) + '</td>' +
      '<td>' + dur(r.duration_ms) + '</td>' +
      '<td>' + num(r.input_tokens) + "+" + num(r.output_tokens) + '</td>' +
      '<td>' + money(r.cost_usd) + '</td></tr>').join("") +
    '</tbody></table>';
  view.querySelectorAll("tr[data-run]").forEach(tr =>
    tr.addEventListener("click", () => { location.hash = "#run/" + tr.dataset.run; }));
}

/**
 * The live transcript. Polls /runs/:id/transcript with the offset the previous
 * poll returned, so each request carries only what is new — the same
 * incremental contract the chatbot's Live Transcript pane uses, against the
 * same filter module.
 */
async function renderRun(runId) {
  const run = await api("/runs/" + runId);
  view.innerHTML =
    '<div class="card"><h3>Run <span class="mono">' + esc(runId) + '</span></h3>' +
    pill(run.status) + ' &middot; ' + esc(run.phase ?? "—") + ' &middot; ' + dur(run.duration_ms) +
    ' &middot; ' + money(run.cost_usd) + ' &middot; ' + num(run.num_turns) + ' turns ' +
    '<button class="ghost" id="raw">raw log</button></div>' +
    '<div id="transcript"></div>';

  const box = document.getElementById("transcript");
  document.getElementById("raw").addEventListener("click", () => {
    window.open("/runs/" + runId + "/log", "_blank");
  });

  let offset = 0;
  const tick = async () => {
    const { events, nextOffset } = await api("/runs/" + runId + "/transcript?offset=" + offset);
    offset = nextOffset;
    if (events.length) {
      const stick = box.scrollTop + box.clientHeight >= box.scrollHeight - 40;
      box.insertAdjacentHTML("beforeend", events.map(e => {
        const text = e.kind === "tool_use" ? e.tool + ": " + e.preview
          : e.kind === "skill" ? "skill " + e.name
          : (e.text ?? e.preview ?? "");
        return '<div class="' + e.kind + '">' + esc(e.ts) + "  " + esc(text) + '</div>';
      }).join(""));
      if (stick) box.scrollTop = box.scrollHeight;
    }
    const fresh = await api("/runs/" + runId);
    if (fresh.finished_at) stopPolling();
  };
  await tick();
  if (!run.finished_at) poll = setInterval(() => { tick().catch(stopPolling); }, 3000);
}

async function renderIssues() {
  const issues = await api("/issues");
  if (!issues.length) { view.innerHTML = '<h2>Issues</h2><p class="empty">No issues yet.</p>'; return; }
  view.innerHTML = '<h2>Issues</h2>' +
    '<table><thead><tr><th>Issue</th><th>Title</th><th>Workflow</th><th>Step</th>' +
    '<th>Status</th><th>Updated</th><th></th></tr></thead><tbody>' +
    issues.map(i => '<tr>' +
      '<td>' + esc(i.identifier) + '</td>' +
      '<td>' + esc(i.title) + '</td>' +
      '<td>' + esc(i.workflow_key ?? "—") + '</td>' +
      '<td>' + i.step_index + '</td>' +
      '<td>' + pill(i.status) + '</td>' +
      '<td>' + ago(i.updated_at ?? i.created_at) + '</td>' +
      '<td>' + (i.status === "blocked" || i.status === "todo"
        ? '<button data-advance="' + esc(i.id) + '">Resume</button>' : "") +
      '</td></tr>').join("") +
    '</tbody></table>';
  view.querySelectorAll("button[data-advance]").forEach(b =>
    b.addEventListener("click", async () => {
      b.disabled = true;
      await fetch("/issues/" + b.dataset.advance + "/advance", { method: "POST" });
      setTimeout(route, 600);
    }));
}

async function renderGates() {
  const issues = await api("/issues");
  const all = await Promise.all(issues.map(async i => {
    const gates = await api("/issues/" + i.id + "/gates").catch(() => []);
    return gates.filter(g => g.status === "pending").map(g => ({ g, i }));
  }));
  const pending = all.flat();

  view.innerHTML = '<h2>Gates</h2>' + (pending.length
    ? pending.map(({ g, i }) =>
        '<div class="card"><h3>' + esc(g.payload.title) + '</h3>' +
        '<p class="muted">' + esc(i.identifier) + " · " + esc(i.title) + '</p>' +
        '<pre>' + esc(g.payload.summary ?? "") + '</pre>' +
        '<button data-approve="' + esc(g.id) + '">Approve</button> ' +
        '<button class="ghost" data-reject="' + esc(g.id) + '">Reject</button></div>').join("")
    : '<p class="empty">Nothing waiting for approval.</p>');

  const decide = async (id, verb) => {
    const note = verb === "reject" ? (prompt("What needs to change?") ?? "") : "";
    await fetch("/gates/" + id + "/" + verb, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ by: "console", note }),
    });
    setTimeout(route, 600);
  };
  view.querySelectorAll("button[data-approve]").forEach(b =>
    b.addEventListener("click", () => { b.disabled = true; decide(b.dataset.approve, "approve"); }));
  view.querySelectorAll("button[data-reject]").forEach(b =>
    b.addEventListener("click", () => { b.disabled = true; decide(b.dataset.reject, "reject"); }));
}

async function renderOrg() {
  const agents = await api("/agents");
  const keyById = Object.fromEntries(agents.map(a => [a.id, a.key]));
  view.innerHTML = '<h2>Org</h2><div class="grid">' + agents.map(a =>
    '<div class="card"><h3>' + esc(a.name) + ' <span class="muted mono">' + esc(a.key) + '</span></h3>' +
    '<div class="muted">' + esc(a.title ?? "") + '</div>' +
    '<div>reports to: ' + esc(a.reports_to ? (keyById[a.reports_to] ?? "—") : "—") + '</div>' +
    '<div>' + esc(a.adapter) + " · " + esc(a.model ?? "default model") + " · " + esc(a.effort ?? "default effort") + '</div>' +
    '<div>MCP: ' + (a.mcp_enabled ? "granted" : "none") + '</div>' +
    (a.bundle_path
      ? '<div><a href="#bundle/' + esc(a.key) + '">instructions</a></div>'
      : '<div class="muted">no bundle</div>') +
    '</div>').join("") + '</div>';
}

async function renderBundle(key) {
  const b = await api("/agents/" + key + "/bundle");
  view.innerHTML =
    '<div class="card"><h3>' + esc(key) + '</h3>' +
    '<span class="muted mono">' + esc(b.path ?? "no bundle declared") + '</span>' +
    (b.error ? '<p style="color:var(--danger)">' + esc(b.error) + '</p>' : "") +
    ' <a href="#org">back to org</a></div>' +
    '<div id="transcript">' + esc(b.content) + '</div>';
}

async function renderBudgets() {
  const [agents, usage, issues] = await Promise.all([api("/agents"), api("/usage"), api("/issues")]);
  const perAgent = await Promise.all(agents.map(async a => {
    const runs = await api("/agents/" + a.key + "/runs").catch(() => []);
    return {
      key: a.key,
      runs: runs.length,
      out: runs.reduce((n, r) => n + Number(r.output_tokens ?? 0), 0),
      cost: runs.reduce((n, r) => n + Number(r.cost_usd ?? 0), 0),
    };
  }));
  const busy = perAgent.filter(p => p.runs).sort((a, b) => b.cost - a.cost);
  view.innerHTML = '<h2>Budgets</h2>' +
    '<div class="card"><h3>Total</h3>' + money(usage.costUsd) + " across " + num(usage.runCount) +
    " run(s) and " + num(issues.length) + " issue(s)</div>" +
    (busy.length
      ? '<table><thead><tr><th>Agent</th><th>Runs</th><th>Output tokens</th><th>Spend</th></tr></thead><tbody>' +
        busy.map(p => '<tr><td>' + esc(p.key) + '</td><td>' + num(p.runs) + '</td><td>' +
          num(p.out) + '</td><td>' + money(p.cost) + '</td></tr>').join("") + '</tbody></table>'
      : '<p class="empty">No agent has run yet.</p>');
}

async function renderConfig() {
  const c = await api("/config");
  view.innerHTML = '<h2>Config</h2>' +
    '<div class="card"><h3>Workspace</h3><span class="mono">' + esc(c.workspace) + '</span></div>' +
    '<div class="card"><h3>Adapters</h3>' + esc(c.adapters.join(", ")) + '</div>' +
    '<table><thead><tr><th>Workflow</th><th>Label</th><th>Assignee</th><th>Steps</th></tr></thead><tbody>' +
    c.workflows.map(w => '<tr><td class="mono">' + esc(w.key) + '</td><td>' + esc(w.label) +
      '</td><td>' + esc(w.assignee) + '</td><td>' + w.steps + '</td></tr>').join("") +
    '</tbody></table>';
}

const ROUTES = { runs: renderRuns, issues: renderIssues, gates: renderGates,
                 org: renderOrg, budgets: renderBudgets, config: renderConfig, health: renderHealth };

async function route() {
  stopPolling();
  const hash = location.hash.slice(1) || "runs";
  const tab = hash.split("/")[0];
  document.querySelectorAll("nav a").forEach(a =>
    a.classList.toggle("on", a.dataset.tab === tab || (tab === "run" && a.dataset.tab === "runs")
      || (tab === "bundle" && a.dataset.tab === "org")));
  try {
    if (hash.startsWith("run/")) { await renderRun(hash.slice(4)); return; }
    if (hash.startsWith("bundle/")) { await renderBundle(hash.slice(7)); return; }
    const fn = ROUTES[hash];
    if (!fn) { view.innerHTML = '<p class="empty">No such tab.</p>'; return; }
    await fn();
  } catch (e) {
    view.innerHTML = '<div class="card"><h3>Something went wrong</h3>' + esc(e.message) + '</div>';
  }
}

window.addEventListener("hashchange", route);
api("/health")
  .then(h => { document.getElementById("health").textContent = h.claude + " · " + h.db; })
  .catch(() => { document.getElementById("health").textContent = "offline"; });
route();
</script>
</body>
</html>`;
}
