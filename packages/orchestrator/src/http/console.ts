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
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Crect width='16' height='16' fill='%23363C63'/%3E%3Crect x='4' y='4' width='8' height='8' fill='%23C8A878'/%3E%3C/svg%3E">
<style>
${themeCss(theme)}
/* ---------------------------------------------------------------------------
   Instrument panel, not dashboard.

   This console's whole job is to answer two questions an operator has while the
   agents run without them: is anything waiting for me, and what has it cost.
   Everything below serves that.

   Two typefaces, and the split carries meaning: MONO is used for every machine
   fact — agent keys, issue ids, states, durations, money, transcripts — and the
   UI sans only for prose a human wrote. If it is monospaced, the system is
   asserting it. Both are system stacks: the page makes zero network requests,
   so a web font is not available and a fake one would just be Arial.

   Brass (--accent) is the attention colour and is spent nowhere else. If
   something on screen is brass, it wants you.
--------------------------------------------------------------------------- */
:root {
  --mono: ui-monospace, "SF Mono", SFMono-Regular, Menlo, "Cascadia Mono", "Roboto Mono", monospace;
  --ui: ui-sans-serif, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", ${theme.fontFamily};
  --rule: color-mix(in srgb, var(--border) 70%, transparent);
  --pad: clamp(1rem, 2vw, 1.75rem);
}
body { font-family: var(--ui); font-size: 14px; -webkit-font-smoothing: antialiased; }
.mono, .num { font-family: var(--mono); font-variant-numeric: tabular-nums; }

/* ---- masthead ---- */
header { display: flex; align-items: center; gap: .9rem;
         padding: .75rem var(--pad); background: var(--brand-deep); color: #fff; }
header .mark { font-family: var(--mono); font-weight: 700; font-size: .82rem;
               letter-spacing: .14em; text-transform: uppercase; }
header .rule { flex: 1; height: 1px; background: rgba(255,255,255,.18); }
header .env { font-family: var(--mono); font-size: .7rem; letter-spacing: .04em;
              color: rgba(255,255,255,.6); }

/* ---- the status rail: the signature element ----
   Always present, on every tab. Brass the moment a human is needed — the one
   state that cannot be discovered by waiting. */
.rail { display: flex; align-items: stretch; gap: 0; background: var(--surface);
        border-bottom: 1px solid var(--rule); overflow-x: auto; }
.rail .stat { padding: .5rem var(--pad) .5rem 0; margin-left: var(--pad);
              display: flex; align-items: baseline; gap: .45rem; white-space: nowrap; }
.rail .stat + .stat { margin-left: 0; padding-left: var(--pad);
                      border-left: 1px solid var(--rule); }
.rail .v { font-family: var(--mono); font-variant-numeric: tabular-nums;
           font-size: 1.05rem; font-weight: 600; }
.rail .l { font-size: .7rem; letter-spacing: .09em; text-transform: uppercase; color: var(--ink-500); }
.rail .stat.live .v, .rail .stat.live .l { color: var(--accent); }
.rail .stat.live .l { font-weight: 700; }
/* A fault is red, not brass. Brass is reserved for the one state that will
   never resolve without a person; a blocked issue is a problem, not a request. */
.rail .stat.fault .v, .rail .stat.fault .l { color: var(--danger); }

/* ---- tabs ---- */
nav { display: flex; gap: 0; padding: 0 var(--pad); border-bottom: 1px solid var(--rule);
      overflow-x: auto; }
nav a { padding: .6rem .85rem; color: var(--ink-500); text-decoration: none;
        font-size: .74rem; letter-spacing: .1em; text-transform: uppercase; font-weight: 600;
        border-bottom: 2px solid transparent; white-space: nowrap; }
nav a:hover { color: var(--fg); }
nav a.on { color: var(--fg); border-bottom-color: var(--accent); }
nav a:focus-visible, .node:focus-visible, button:focus-visible, a:focus-visible {
  outline: 2px solid var(--accent); outline-offset: 2px; }

main { padding: var(--pad); max-width: 1500px; }
h2 { font-size: .74rem; letter-spacing: .12em; text-transform: uppercase;
     color: var(--ink-500); margin: 0 0 .7rem; font-weight: 700; }
h2 + h2 { margin-top: 1.6rem; }

/* ---- tables: hairlines and aligned numerals, no zebra ---- */
table { width: 100%; border-collapse: collapse; font-size: .84rem; }
th { text-align: left; padding: .4rem .7rem .4rem 0; border-bottom: 1px solid var(--fg);
     font-size: .68rem; letter-spacing: .09em; text-transform: uppercase; color: var(--ink-500);
     position: sticky; top: 0; background: var(--bg); }
td { padding: .45rem .7rem .45rem 0; border-bottom: 1px solid var(--rule); vertical-align: baseline; }
td.num, th.num { text-align: right; font-family: var(--mono); font-variant-numeric: tabular-nums; }
tr.clickable:hover td { background: var(--surface); cursor: pointer; }

/* ---- state as an LED, not a pill ----
   A filled square reads as an instrument at a glance and keeps the state word
   in the same monospace column as everything else the machine asserts. Rounded
   pills push the label around and make every row a different width. */
.st { display: inline-flex; align-items: center; gap: .45rem; font-family: var(--mono);
      font-size: .74rem; letter-spacing: .02em; white-space: nowrap; }
.st::before { content: ""; width: .5rem; height: .5rem; flex: none; background: var(--ink-200); }
.st.in_progress::before, .st.running::before { background: var(--info); }
.st.in_review::before { background: var(--accent); }
.st.done::before, .st.succeeded::before { background: var(--success); }
.st.blocked::before, .st.failed::before, .st.over_budget::before, .st.orphaned::before { background: var(--danger); }
.st.in_review { color: var(--accent); font-weight: 600; }
@media (prefers-reduced-motion: no-preference) {
  .st.running::before, .st.in_progress::before { animation: blink 1.6s steps(2, start) infinite; }
  .rail .stat.live .v { animation: blink 1.9s steps(2, start) infinite; }
}
@keyframes blink { 50% { opacity: .35; } }

/* ---- surfaces ---- */
.card { border: 1px solid var(--rule); border-left: 2px solid var(--rule);
        background: var(--surface); padding: .85rem 1rem; margin-bottom: .7rem; }
.card h3 { margin: 0 0 .45rem; font-size: .8rem; letter-spacing: .04em; }
.card.attention { border-left-color: var(--accent); }
.card pre { white-space: pre-wrap; font-family: var(--mono); font-size: .76rem;
            color: var(--ink-500); margin: .4rem 0 .8rem; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: .7rem; }
.metric { border: 1px solid var(--rule); padding: .7rem .85rem; }
.metric .l { font-size: .66rem; letter-spacing: .1em; text-transform: uppercase; color: var(--ink-500); }
.metric .v { font-family: var(--mono); font-variant-numeric: tabular-nums;
             font-size: 1.4rem; font-weight: 600; margin-top: .15rem; }
.muted { color: var(--ink-500); }
.hint { font-size: .74rem; color: var(--ink-500); line-height: 1.55; max-width: 68ch; }
.card .hint, .card p { max-width: 68ch; }

/* ---- controls ---- */
button { font: inherit; font-size: .76rem; letter-spacing: .06em; text-transform: uppercase;
         font-weight: 600; padding: .38rem .85rem; border: 1px solid var(--brand);
         background: var(--brand); color: #fff; cursor: pointer; }
button:hover { background: var(--brand-deep); border-color: var(--brand-deep); }
button.ghost { background: transparent; color: var(--fg); border-color: var(--border); }
button.ghost:hover { border-color: var(--fg); background: transparent; }
button.danger { background: transparent; color: var(--danger); border-color: var(--danger); }
button.danger:hover { background: var(--danger); color: #fff; }
button:disabled { opacity: .4; cursor: default; }
label { display: block; font-size: .66rem; letter-spacing: .09em; text-transform: uppercase;
        font-weight: 700; color: var(--ink-500); margin: .7rem 0 .25rem; }
input, select { font-family: var(--mono); font-size: .82rem; padding: .4rem .5rem; width: 100%;
                border: 1px solid var(--border); background: var(--bg); color: var(--fg); }
input:focus, select:focus { outline: none; border-color: var(--accent); }
table input { max-width: 8rem; }
table td:first-child { width: 40%; }
.row { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 0 1.1rem; }
.actions { margin-top: 1rem; display: flex; gap: .5rem; align-items: center; flex-wrap: wrap; }
.saved { color: var(--success); font-size: .76rem; }
.err { color: var(--danger); font-size: .76rem; }

/* ---- org chart: connector rules, mono nodes ---- */
.split { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: var(--pad); align-items: start; }
@media (max-width: 1100px) { .split { grid-template-columns: 1fr; } }
.split > aside { position: sticky; top: var(--pad); }
.chart, .chart ul { list-style: none; margin: 0; padding-left: 1.4rem; }
.chart { padding-left: 0; }
.chart li { position: relative; padding: .16rem 0 .16rem 1.1rem; }
.chart li::before { content: ""; position: absolute; left: 0; top: 0; height: 1.05rem;
                    width: .8rem; border-left: 1px solid var(--border);
                    border-bottom: 1px solid var(--border); }
.chart li::after { content: ""; position: absolute; left: 0; top: 1.05rem; bottom: 0;
                   border-left: 1px solid var(--border); }
.chart li:last-child::after { display: none; }
.chart > li { padding-left: 0; }
.chart > li::before, .chart > li::after { display: none; }
.node { display: inline-flex; align-items: baseline; gap: .6rem; padding: .22rem .6rem;
        border: 1px solid var(--rule); background: var(--surface); cursor: pointer; text-align: left;
        /* .node is a <button> so it is keyboard reachable, which means it
           inherits the uppercase control styling above. A person's name is not
           a control label — reset it. */
        text-transform: none; letter-spacing: normal; font-weight: 400;
        font-family: var(--ui); color: var(--fg); }
.node:hover { border-color: var(--accent); }
.node.on { border-color: var(--accent); border-left-width: 2px; background: var(--bg); }
.node .n { font-weight: 600; font-size: .82rem; }
.node .k { font-family: var(--mono); font-size: .7rem; color: var(--ink-500); }
.node .meta { font-family: var(--mono); font-size: .68rem; color: var(--ink-500); }
.node.disabled { opacity: .4; }

/* ---- transcript ---- */
#transcript { font-family: var(--mono); font-size: .76rem; line-height: 1.6;
              white-space: pre-wrap; word-break: break-word; max-height: 62vh;
              overflow-y: auto; background: var(--surface);
              border: 1px solid var(--rule); border-left: 2px solid var(--brand); padding: .85rem; }
#transcript div { margin-bottom: .1rem; }
#transcript .ts { color: var(--ink-200); }
#transcript .tool_use { color: var(--brand); }
#transcript .tool_result { color: var(--ink-500); }
#transcript .skill { color: var(--accent); font-weight: 700; }
#transcript .framing { color: var(--ink-500); font-style: italic; }

.empty { padding: 3rem 0; color: var(--ink-500); font-size: .84rem; }
.empty b { display: block; font-size: .95rem; color: var(--fg); margin-bottom: .3rem; font-weight: 600; }
a { color: var(--brand); }
@media (prefers-color-scheme: dark) { a { color: var(--glow); } }
</style>
</head>
<body>
<header>
  <span class="mark">${theme.logoText}</span>
  <span class="rule"></span>
  <span class="env" id="env">connecting…</span>
</header>
<div class="rail" id="rail"></div>
<nav>${TABS.map(([id, label]) => `<a href="#${id}" data-tab="${id}">${label}</a>`).join("")}</nav>
<main id="view"><p class="empty"><b>Loading</b>Reading the orchestrator.</p></main>
<script>
const api = async (p) => {
  const r = await fetch(p, { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(p + " → " + r.status);
  return r.json();
};
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;" }[c]));
// State as an LED plus its word, in the same monospace column as every other
// machine fact on the row.
const st = (s) => '<span class="st ' + esc(s) + '">' + esc(String(s).replace(/_/g, " ")) + '</span>';
const pill = st;
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
// Trim a numeric-as-string to what a person would type back in.
const plain = (v) => (v === null || v === undefined || v === "") ? "" : String(Number(v));
const view = document.getElementById("view");

// One poll timer for the whole app: every route change clears it, so leaving a
// transcript open and navigating away cannot leak a second poller.
let poll = null;
const stopPolling = () => { if (poll) { clearInterval(poll); poll = null; } };

async function renderHealth() {
  const [h, u] = await Promise.all([api("/health"), api("/usage")]);
  const q = h.queue || {};
  const m = (l, v, tone) => '<div class="metric"><div class="l">' + l + '</div><div class="v"' +
    (tone ? ' style="color:var(--' + tone + ')"' : "") + '>' + v + '</div></div>';
  view.innerHTML =
    '<h2>Runtimes</h2><div class="grid">' +
      (h.adapters || []).map(a => m(a.key, '<span style="font-size:.9rem">' + esc(a.version) + '</span>')).join("") +
      m("database", '<span style="font-size:.9rem">' + esc(h.db) + '</span>') +
    '</div>' +
    '<h2>Queue</h2><div class="grid">' +
      m("awaiting you", num(q.awaitingApproval), q.awaitingApproval > 0 ? "accent" : null) +
      m("running", num(q.inProgress), q.inProgress > 0 ? "info" : null) +
      m("queued", num(q.todo)) +
      m("blocked", num(q.blocked), q.blocked > 0 ? "danger" : null) +
      m("unfinished runs", num(h.unfinishedRuns), h.unfinishedRuns > 0 ? "danger" : null) +
    '</div>' +
    '<p class="hint">An unfinished run is one whose process died. It is marked orphaned and its issue re-queued at the next boot.</p>' +
    '<h2>Consumption</h2><div class="grid">' +
      m("spent", money(u.costUsd)) + m("runs", num(u.runCount)) +
      m("tokens in", num(u.inputTokens)) + m("tokens out", num(u.outputTokens)) +
      m("cache read", num(u.cacheReadTokens)) +
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
  if (!runs.length) {
    view.innerHTML = '<p class="empty"><b>No runs yet</b>' +
      'A run appears here the moment a workflow reaches an agent step. Start one from the chatbot, ' +
      'or with <span class="mono">npm run orch -- run &lt;workflow&gt; --project &lt;P&gt;</span>.</p>';
    return;
  }
  view.innerHTML =
    '<table><thead><tr><th>Started</th><th>Issue</th><th>Agent</th><th>Phase</th>' +
    '<th>State</th><th class="num">Duration</th><th class="num">Tokens</th><th class="num">Cost</th></tr></thead><tbody>' +
    runs.map(r => '<tr class="clickable" data-run="' + esc(r.id) + '">' +
      '<td>' + ago(r.started_at) + '</td>' +
      '<td class="mono">' + esc(byId[r.issue_id]?.identifier ?? "—") + '</td>' +
      '<td class="mono">' + esc(agentName[r.agent_id] ?? "—") + '</td>' +
      '<td>' + esc(r.phase ?? "—") + '</td>' +
      '<td>' + pill(r.status) + '</td>' +
      '<td class="num">' + dur(r.duration_ms) + '</td>' +
      '<td class="num">' + num(r.input_tokens) + "+" + num(r.output_tokens) + '</td>' +
      '<td class="num">' + money(r.cost_usd) + '</td></tr>').join("") +
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
        return '<div class="' + e.kind + '"><span class="ts">' + esc(e.ts) + '</span>  ' + esc(text) + '</div>';
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
  if (!issues.length) {
    view.innerHTML = '<p class="empty"><b>Nothing in flight</b>' +
      'Each issue is one workflow run — a stage, a revision, or a project baseline.</p>';
    return;
  }
  view.innerHTML =
    '<table><thead><tr><th>Issue</th><th>Title</th><th>Workflow</th><th>Step</th>' +
    '<th>State</th><th>Updated</th><th></th></tr></thead><tbody>' +
    issues.map(i => '<tr>' +
      '<td class="mono">' + esc(i.identifier) + '</td>' +
      '<td>' + esc(i.title) + '</td>' +
      '<td class="mono">' + esc(i.workflow_key ?? "—") + '</td>' +
      '<td class="num">' + i.step_index + '</td>' +
      '<td>' + pill(i.status) + '</td>' +
      '<td>' + ago(i.updated_at ?? i.created_at) + '</td>' +
      '<td>' + (i.status === "blocked" || i.status === "todo"
        ? '<button data-advance="' + esc(i.id) + '">Resume</button> ' : "") +
        '<button class="ghost" data-del="' + esc(i.id) + '" data-ident="' + esc(i.identifier) + '">Delete</button>' +
      '</td></tr>').join("") +
    '</tbody></table>';
  view.querySelectorAll("button[data-advance]").forEach(b =>
    b.addEventListener("click", async () => {
      b.disabled = true;
      await fetch("/issues/" + b.dataset.advance + "/advance", { method: "POST" });
      setTimeout(route, 600);
    }));

  view.querySelectorAll("button[data-del]").forEach(b =>
    b.addEventListener("click", async () => {
      if (!confirm("Delete " + b.dataset.ident + " and everything under it? " +
                   "Its comments, work products, gates and run history go too. This cannot be undone.")) return;
      b.disabled = true;
      const r = await fetch("/issues/" + b.dataset.del, { method: "DELETE" });
      if (!r.ok) { alert((await r.json()).error); b.disabled = false; return; }
      route();
    }));
}

async function renderGates() {
  const issues = await api("/issues");
  const all = await Promise.all(issues.map(async i => {
    const gates = await api("/issues/" + i.id + "/gates").catch(() => []);
    return gates.filter(g => g.status === "pending").map(g => ({ g, i }));
  }));
  const pending = all.flat();

  view.innerHTML = '<h2>Awaiting your approval</h2>' + (pending.length
    ? pending.map(({ g, i }) =>
        '<div class="card attention"><h3>' + esc(g.payload.title) + '</h3>' +
        '<p class="muted mono" style="font-size:.74rem">' + esc(i.identifier) + " · " + esc(i.title) + '</p>' +
        '<pre>' + esc(g.payload.summary ?? "") + '</pre>' +
        '<button data-approve="' + esc(g.id) + '">Approve</button> ' +
        '<button class="ghost" data-reject="' + esc(g.id) + '">Reject</button></div>').join("")
    : '<p class="empty"><b>Nothing waiting for you</b>' +
      'Gates appear here when a stage has produced its files and needs a human before it publishes.</p>');

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

async function renderOrg(selected) {
  const [agents, cfg] = await Promise.all([api("/agents"), api("/config")]);
  const byId = Object.fromEntries(agents.map(a => [a.id, a]));
  const defModel = cfg.defaults.model, defAdapter = cfg.defaults.adapter;

  const children = {};
  const roots = [];
  for (const a of agents) {
    const parent = a.reports_to && byId[a.reports_to] ? byId[a.reports_to].key : null;
    if (parent) (children[parent] ??= []).push(a);
    else roots.push(a);
  }

  // Only what DIFFERS from the defaults. Printing "claude_local" beside twelve
  // agents that all use it is repetition dressed as information — and it buried
  // the one agent that had been switched to something else.
  const meta = (a) => {
    const bits = [];
    if (a.model && a.model !== defModel) bits.push(a.model);
    if (a.adapter && a.adapter !== defAdapter) bits.push(a.adapter);
    if (a.effort) bits.push(a.effort);
    return bits.length ? '<span class="meta">' + esc(bits.join(" · ")) + '</span>' : "";
  };

  const node = (a) =>
    '<li><button class="node' + (a.status === "disabled" ? " disabled" : "") +
      (a.key === selected ? " on" : "") + '" data-agent="' + esc(a.key) + '">' +
      '<span class="n">' + esc(a.name) + '</span>' +
      '<span class="k">' + esc(a.key) + '</span>' + meta(a) +
    '</button>' + (children[a.key]?.length ? '<ul>' + children[a.key].map(node).join("") + '</ul>' : "") + '</li>';

  view.innerHTML =
    '<div class="split"><div>' +
      '<div class="actions" style="margin:0 0 .8rem">' +
        '<button class="ghost" id="hire">+ Add agent</button>' +
        '<span class="muted mono" style="font-size:.72rem">' +
          agents.filter(a => a.status !== "disabled").length + ' active · ' +
          agents.filter(a => a.status === "disabled").length + ' disabled · ' +
          'defaults ' + esc(defModel ?? "—") + ' / ' + esc(defAdapter) + '</span>' +
      '</div>' +
      '<ul class="chart">' + roots.map(node).join("") + '</ul>' +
    '</div><aside id="detail">' +
      (selected ? "" : '<p class="empty"><b>Pick an agent</b>Its runtime, budget, spend and instructions open here.</p>') +
    '</aside></div>';

  view.querySelectorAll(".node[data-agent]").forEach(n =>
    n.addEventListener("click", () => { location.hash = "#agent/" + n.dataset.agent; }));
  document.getElementById("hire").addEventListener("click", renderHireForm);
  if (selected) await renderAgent(selected, document.getElementById("detail"));
}

function renderHireForm() {
  const d = document.getElementById("detail");
  d.scrollIntoView({ block: "nearest" });
  api("/agents").then(agents => {
    api("/runners").then(runners => {
      d.innerHTML = '<div class="card"><h3>Add an agent</h3>' +
        '<div class="row">' +
        '<div><label>Key</label><input id="f-key" placeholder="securityReviewer"></div>' +
        '<div><label>Name</label><input id="f-name" placeholder="Security Reviewer"></div>' +
        '<div><label>Title</label><input id="f-title"></div>' +
        '<div><label>Reports to</label><select id="f-reports"><option value="">— nobody —</option>' +
          agents.map(a => '<option value="' + esc(a.key) + '">' + esc(a.name) + '</option>').join("") +
        '</select></div>' +
        '<div><label>Adapter</label><select id="f-adapter">' +
          runners.map(r => '<option>' + esc(r) + '</option>').join("") + '</select></div>' +
        '<div><label>Model</label><input id="f-model" placeholder="claude-sonnet-4-6"></div>' +
        '<div><label>Effort</label><select id="f-effort"><option value="">default</option>' +
          ["low","medium","high","xhigh","max"].map(e => '<option>' + e + '</option>').join("") + '</select></div>' +
        '<div><label>Bundle path</label><input id="f-bundle" placeholder="agent-instructions/x.thin.md"></div>' +
        '</div>' +
        '<div class="actions"><button id="f-save">Add</button>' +
        '<button class="ghost" id="f-cancel">Cancel</button><span id="f-msg"></span></div></div>';

      document.getElementById("f-cancel").addEventListener("click", () => { d.innerHTML = ""; });
      document.getElementById("f-save").addEventListener("click", async () => {
        const val = (id) => document.getElementById(id).value.trim();
        const body = { key: val("f-key"), name: val("f-name") };
        if (val("f-title")) body.title = val("f-title");
        if (val("f-reports")) body.reportsTo = val("f-reports");
        if (val("f-adapter")) body.adapter = val("f-adapter");
        if (val("f-model")) body.model = val("f-model");
        if (val("f-effort")) body.effort = val("f-effort");
        if (val("f-bundle")) body.bundlePath = val("f-bundle");
        const r = await fetch("/agents", { method: "POST",
          headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        const out = await r.json();
        if (!r.ok) { document.getElementById("f-msg").innerHTML = '<span class="err">' + esc(out.error) + '</span>'; return; }
        location.hash = "#agent/" + out.key;
        route();
      });
    });
  });
}

/** One agent: its runtime config (editable), its bundle, its spend, its runs. */
async function renderAgent(key, target) {
  // target is the org tab's side pane. Falls back to the main view so the page
  // still works when someone lands on an agent hash directly from a link.
  // (No backticks in here: the whole page is one template literal.)
  const out = target || view;
  const [agent, cfg, runners, runs, budgets] = await Promise.all([
    api("/agents/" + key), api("/config"), api("/runners"),
    api("/agents/" + key + "/runs").catch(() => []),
    api("/budgets").catch(() => []),
  ]);
  const b = budgets.find(x => x.scope === "agent" && x.scope_key === key) || {};
  const spend = runs.reduce((n, r) => n + Number(r.cost_usd ?? 0), 0);
  const sel = (v, opts, cur) =>
    opts.map(o => '<option value="' + esc(o) + '"' + (o === cur ? " selected" : "") + '>' + esc(o || "default") + '</option>').join("");

  out.innerHTML =
    '<div class="card"><h3>' + esc(agent.name) + ' <span class="muted mono">' + esc(agent.key) + '</span>' +
      (agent.status === "disabled" ? ' <span class="st blocked">disabled</span>' : "") + '</h3>' +
      (agent.title && agent.title !== agent.name
        ? '<span class="muted">' + esc(agent.title) + '</span>' : "") +
      (agent.bundle_path
        ? (agent.title && agent.title !== agent.name ? " &middot; " : "") +
          '<a href="#bundle/' + esc(agent.key) + '">instructions</a>' : "") +
    '</div>' +

    '<div class="card"><h3>Runtime</h3>' +
      '<div class="row">' +
      '<div><label>Adapter</label><select id="a-adapter">' + sel("", runners, agent.adapter) + '</select></div>' +
      '<div><label>Model</label><input id="a-model" value="' + esc(agent.model ?? "") +
        '" placeholder="' + esc(cfg.defaults.model ?? "default") + '"></div>' +
      '<div><label>Effort</label><select id="a-effort">' +
        sel("", ["", "low", "medium", "high", "xhigh", "max"], agent.effort ?? "") + '</select></div>' +
      '<div><label>Fallback models (comma separated)</label>' +
        '<input id="a-fallback" value="' + esc((agent.fallback_model ?? []).join(", ")) + '"></div>' +
      '</div>' +
      '<h3 style="margin-top:.9rem">Budget — a ceiling, not a target</h3>' +
      '<div class="row">' +
      '<div><label>Max tokens</label><input id="a-tokens" type="number" value="' + esc(plain(b.max_tokens)) + '"></div>' +
      '<div><label>Max cost (USD)</label><input id="a-cost" type="number" step="0.01" value="' + esc(plain(b.max_cost_usd)) + '"></div>' +
      '<div><label>Max duration (minutes)</label><input id="a-mins" type="number" value="' +
        esc(b.max_duration_ms ? Math.round(Number(b.max_duration_ms) / 60000) : "") + '"></div>' +
      '</div>' +
      '<div class="actions"><button id="a-save">Save</button>' +
      (agent.status === "disabled" ? "" : '<button class="danger" id="a-disable">Disable agent</button>') +
      '<span id="a-msg"></span></div>' +
      '<p class="muted" style="font-size:.75rem;margin:.6rem 0 0">Saved to ' +
      '<span class="mono">.orchestrator/overrides.json</span>, which is merged over ' +
      '<span class="mono">orchestrator.config.ts</span> on every boot — so it survives a restart. ' +
      'Delete that file to go back to the committed defaults.</p>' +
    '</div>' +

    (runs.length
      ? '<div class="card"><h3>Spend</h3>' + money(spend) + ' across ' + num(runs.length) + ' run(s)</div>'
      : "") +
    (runs.length
      ? '<table><thead><tr><th>Started</th><th>Phase</th><th>State</th><th class="num">Duration</th><th class="num">Cost</th></tr></thead><tbody>' +
        runs.map(r => '<tr class="clickable" data-run="' + esc(r.id) + '"><td>' + ago(r.started_at) +
          '</td><td>' + esc(r.phase ?? "—") + '</td><td>' + pill(r.status) + '</td><td>' + dur(r.duration_ms) +
          '</td><td>' + money(r.cost_usd) + '</td></tr>').join("") + '</tbody></table>'
      : '<p class="empty"><b>Never run</b>Its spend and transcripts appear here after its first run.</p>');

  out.querySelectorAll("tr[data-run]").forEach(tr =>
    tr.addEventListener("click", () => { location.hash = "#run/" + tr.dataset.run; }));

  const msg = document.getElementById("a-msg");
  document.getElementById("a-save").addEventListener("click", async () => {
    const v = (id) => document.getElementById(id).value.trim();
    const body = {
      adapter: v("a-adapter"),
      model: v("a-model") || null,
      effort: v("a-effort") || null,
      fallbackModel: v("a-fallback") ? v("a-fallback").split(",").map(x => x.trim()).filter(Boolean) : [],
    };
    if (body.effort === null) delete body.effort;
    if (body.model === null) delete body.model;
    const r = await fetch("/agents/" + key, { method: "PATCH",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!r.ok) { msg.innerHTML = '<span class="err">' + esc((await r.json()).error) + '</span>'; return; }

    // The budget lives in its own table (the engine reads workflow-then-agent),
    // so it is a second call rather than a field on the agent.
    const tokens = v("a-tokens"), cost = v("a-cost"), mins = v("a-mins");
    const budget = { scope: "agent", scopeKey: key };
    if (tokens) budget.maxTokens = Number(tokens);
    if (cost) budget.maxCostUsd = Number(cost);
    if (mins) budget.maxDurationMs = Number(mins) * 60000;
    const rb = await fetch("/budgets", { method: "POST",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify(budget) });
    if (!rb.ok) { msg.innerHTML = '<span class="err">' + esc((await rb.json()).error) + '</span>'; return; }
    msg.innerHTML = '<span class="saved">Saved — applies to the next run.</span>';
  });

  const disable = document.getElementById("a-disable");
  if (disable) disable.addEventListener("click", async () => {
    // No backticks and no dollar-brace in here, comments included: this whole
    // page is itself one template literal, so a nested one closes it and the
    // interpolation is then evaluated at build time against variables that only
    // exist in the browser.
    if (!confirm("Disable " + agent.name + "? Its history is kept; it leaves the org chart.")) return;
    const r = await fetch("/agents/" + key, { method: "DELETE" });
    if (!r.ok) { msg.innerHTML = '<span class="err">' + esc((await r.json()).error) + '</span>'; return; }
    location.hash = "#org";
    route();
  });
}

async function renderBudgets() {
  const [agents, usage, cfg, budgets] = await Promise.all([
    api("/agents"), api("/usage"), api("/config"), api("/budgets")]);
  const limit = (scope, key) => budgets.find(b => b.scope === scope && b.scope_key === key) || {};

  const perAgent = await Promise.all(agents.map(async a => {
    const runs = await api("/agents/" + a.key + "/runs").catch(() => []);
    return { key: a.key, runs: runs.length,
             out: runs.reduce((n, r) => n + Number(r.output_tokens ?? 0), 0),
             cost: runs.reduce((n, r) => n + Number(r.cost_usd ?? 0), 0) };
  }));

  const mins = (ms) => ms ? Math.round(Number(ms) / 60000) : "";
  const limitRow = (scope, key, label, spendCell) => {
    const l = limit(scope, key);
    return '<tr data-scope="' + esc(scope) + '" data-key="' + esc(key) + '">' +
      '<td>' + esc(label) + '</td>' + spendCell +
      '<td><input class="b-tokens" type="number" style="width:9rem" value="' + esc(plain(l.max_tokens)) + '"></td>' +
      '<td><input class="b-cost" type="number" step="0.01" style="width:6rem" value="' + esc(plain(l.max_cost_usd)) + '"></td>' +
      '<td><input class="b-mins" type="number" style="width:5rem" value="' + esc(mins(l.max_duration_ms)) + '"></td>' +
      '<td><button class="ghost b-save" disabled>Save</button></td></tr>';
  };

  view.innerHTML =
    '<div class="card"><h3>Total spend</h3>' +
      '<span class="mono" style="font-size:1.2rem;font-weight:600">' + money(usage.costUsd) + '</span>' +
      '<span class="muted"> across ' + num(usage.runCount) + ' run(s)</span>' +
      '<div class="hint" style="margin-top:.5rem">A budget is a ceiling, not a target. Duration is enforced live ' +
      '(the process is killed); tokens and cost are checked when the run ends and flag it <span class="pill over_budget">over_budget</span>. ' +
      'The engine reads the WORKFLOW limit first and falls back to the one on the agent. Blank means no limit.</div></div>' +

    '<h2>Per agent</h2>' +
    '<table><thead><tr><th>Agent</th><th>Spent</th><th>Max tokens</th><th>Max $</th><th>Max min</th><th></th></tr></thead><tbody>' +
    agents.map(a => {
      const p = perAgent.find(x => x.key === a.key);
      return limitRow("agent", a.key, a.name,
        '<td>' + money(p.cost) + ' <span class="muted">(' + num(p.runs) + ')</span></td>');
    }).join("") +
    '</tbody></table>' +

    '<h2 style="margin-top:1rem">Per workflow</h2>' +
    '<table><thead><tr><th>Workflow</th><th></th><th>Max tokens</th><th>Max $</th><th>Max min</th><th></th></tr></thead><tbody>' +
    cfg.workflows.map(w => limitRow("workflow", w.key, w.key, '<td class="muted">' + esc(w.assignee) + '</td>')).join("") +
    '</tbody></table>';

  view.querySelectorAll("tr[data-scope] input").forEach(inp =>
    inp.addEventListener("input", () => {
      const b = inp.closest("tr").querySelector(".b-save");
      b.disabled = false;
      b.classList.remove("ghost");
    }));

  view.querySelectorAll(".b-save").forEach(btn =>
    btn.addEventListener("click", async () => {
      const tr = btn.closest("tr");
      const g = (cls) => tr.querySelector("." + cls).value.trim();
      const body = { scope: tr.dataset.scope, scopeKey: tr.dataset.key };
      if (g("b-tokens")) body.maxTokens = Number(g("b-tokens"));
      if (g("b-cost")) body.maxCostUsd = Number(g("b-cost"));
      if (g("b-mins")) body.maxDurationMs = Number(g("b-mins")) * 60000;
      btn.disabled = true;
      const r = await fetch("/budgets", { method: "POST",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      btn.disabled = false;
      btn.textContent = r.ok ? "Saved" : "Failed";
      if (r.ok) btn.classList.add("ghost");
      setTimeout(() => { btn.textContent = "Save"; btn.disabled = r.ok; }, 1500);
    }));
}

async function renderConfig() {
  const c = await api("/config");
  view.innerHTML =
    '<div class="card"><h3>Workspace</h3><span class="mono">' + esc(c.workspace) + '</span></div>' +
    '<div class="card"><h3>Adapters</h3>' + esc(c.adapters.join(", ")) + '</div>' +
    '<table><thead><tr><th>Workflow</th><th>Label</th><th>Assignee</th><th class="num">Steps</th></tr></thead><tbody>' +
    c.workflows.map(w => '<tr><td class="mono">' + esc(w.key) + '</td><td>' + esc(w.label) +
      '</td><td class="mono">' + esc(w.assignee) + '</td><td class="num">' + w.steps + '</td></tr>').join("") +
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
      || ((tab === "bundle" || tab === "agent") && a.dataset.tab === "org")));
  try {
    if (hash.startsWith("run/")) { await renderRun(hash.slice(4)); return; }
    if (hash.startsWith("bundle/")) { await renderBundle(hash.slice(7)); return; }
    if (hash.startsWith("agent/")) { await renderOrg(hash.slice(6)); return; }
    const fn = ROUTES[hash];
    if (!fn) { view.innerHTML = '<p class="empty">No such tab.</p>'; return; }
    await fn();
  } catch (e) {
    view.innerHTML = '<div class="card"><h3>Something went wrong</h3>' + esc(e.message) + '</div>';
  }
}

/**
 * The status rail. It is the one thing on this page that is true regardless of
 * which tab is open: what needs a human, what is running, what it has cost.
 * "Awaiting approval" turns brass because it is the only state that will never
 * resolve itself.
 */
async function renderRail() {
  const rail = document.getElementById("rail");
  try {
    const [h, u] = await Promise.all([api("/health"), api("/usage")]);
    const q = h.queue || {};
    const stat = (label, value, live) =>
      '<div class="stat' + (live ? " live" : "") + '"><span class="v">' + value +
      '</span><span class="l">' + label + '</span></div>';
    rail.innerHTML =
      stat("awaiting you", num(q.awaitingApproval), q.awaitingApproval > 0) +
      stat("running", num(q.inProgress), false) +
      stat("queued", num(q.todo), false) +
      '<div class="stat' + (q.blocked > 0 ? " fault" : "") + '"><span class="v">' +
        num(q.blocked) + '</span><span class="l">blocked</span></div>' +
      stat("spent", money(u.costUsd), false) +
      stat("runs", num(u.runCount), false);
    document.getElementById("env").textContent =
      (h.adapters || []).map(a => a.key + " " + a.version).join("  ·  ") + "  ·  " + h.db;
  } catch (e) {
    rail.innerHTML = '<div class="stat"><span class="v">—</span><span class="l">orchestrator unreachable</span></div>';
    document.getElementById("env").textContent = "offline";
  }
}

window.addEventListener("hashchange", route);
renderRail();
setInterval(renderRail, 5000);
route();
</script>
</body>
</html>`;
}
