#!/usr/bin/env node
// Render a feature's capability map + process model into ONE self-contained HTML
// page. Used by the Capabilities Process Architect (Step 5 of the
// `capability-process-map` skill), which authors the two JSON files and then
// shells out to this script — the same split the reference implementation uses
// (agent/author writes data, a deterministic script renders the view), so the
// page looks identical run to run.
//
//   node scripts/render-capability-map.mjs <project> <feature>
//
// Reads   projects/<project>/<feature>/solutions/Capabilities/outputs/
//           capability-map.json   { capabilities: [...] }
//           process-model.json    { activities: [...] }
// Writes  …/outputs/capability-process.html   (inline CSS + JS + data island;
//                                              zero network requests)
//
// Exits non-zero with the offending file + field when the data is unusable —
// the agent is expected to fix the JSON and re-run rather than hand-write HTML.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const WORKSPACE = process.env.WORKSPACE_PATH || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SAFE_NAME = /^[A-Za-z0-9._-]+$/;
const MATURITY = ["None", "Foundational", "Operational", "Optimised", "Transformational"];

function die(msg) {
  console.error(`[render-capability-map] ${msg}`);
  process.exit(1);
}

async function readJson(file, label) {
  let raw;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    die(`${label} not found: ${file}\nRun the capability-process-map skill first — it writes this file.`);
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    die(`${label} is not valid JSON (${file}): ${e.message}`);
  }
}

const str = (v) => (typeof v === "string" ? v.trim() : "");
const list = (v) => (Array.isArray(v) ? v.map(str).filter(Boolean) : []);

// Validate + normalise. Every rejection names the file, the row and the field so
// the agent can fix the data without guessing what the renderer wanted.
function normaliseCapabilities(doc) {
  const rows = Array.isArray(doc?.capabilities) ? doc.capabilities : null;
  if (!rows) die(`capability-map.json: missing the "capabilities" array.`);
  if (rows.length === 0) die(`capability-map.json: "capabilities" is empty — nothing to render.`);

  const seen = new Set();
  const caps = rows.map((c, i) => {
    const at = `capability-map.json capabilities[${i}]`;
    const id = str(c?.id);
    if (!id) die(`${at}: "id" is required (e.g. "2.1.3").`);
    if (seen.has(id)) die(`${at}: duplicate id "${id}".`);
    seen.add(id);
    const name = str(c?.name);
    if (!name) die(`${at} (${id}): "name" is required.`);
    const level = Number(c?.level);
    if (!Number.isInteger(level) || level < 1 || level > 4) die(`${at} (${id}): "level" must be an integer 1–4, got ${JSON.stringify(c?.level)}.`);
    const parentId = str(c?.parentId) || null;
    for (const key of ["currentMaturity", "targetMaturity"]) {
      const v = str(c?.[key]);
      if (v && !MATURITY.includes(v)) die(`${at} (${id}): "${key}" must be one of ${MATURITY.join(" | ")} (or empty), got "${v}".`);
    }
    return {
      id,
      name,
      level,
      parentId,
      stage: str(c?.stage),
      currentMaturity: str(c?.currentMaturity),
      targetMaturity: str(c?.targetMaturity),
      description: str(c?.description),
      sourceDocs: list(c?.sourceDocs),
    };
  });

  for (const c of caps) {
    if (c.parentId && !seen.has(c.parentId)) die(`capability-map.json (${c.id}): parentId "${c.parentId}" does not exist.`);
    if (c.parentId === c.id) die(`capability-map.json (${c.id}): parentId points at itself.`);
  }
  return caps;
}

function normaliseActivities(doc, capIds) {
  const rows = Array.isArray(doc?.activities) ? doc.activities : null;
  if (!rows) die(`process-model.json: missing the "activities" array.`);
  if (rows.length === 0) die(`process-model.json: "activities" is empty — nothing to render.`);

  return rows.map((a, i) => {
    const at = `process-model.json activities[${i}]`;
    const l1 = str(a?.l1), l2 = str(a?.l2), l3 = str(a?.l3);
    if (!l1) die(`${at}: "l1" (lifecycle phase) is required.`);
    if (!l2) die(`${at} (${l1}): "l2" (process step) is required.`);
    if (!l3) die(`${at} (${l1} / ${l2}): "l3" (activity) is required.`);
    const capabilityIds = list(a?.capabilityIds);
    for (const id of capabilityIds) {
      if (!capIds.has(id)) die(`${at} (${l3}): capabilityIds references "${id}", which is not in capability-map.json.`);
    }
    return {
      l1, l2, l3,
      description: str(a?.description),
      actor: str(a?.actor) || "—",
      serviceTier: str(a?.serviceTier) || "All",
      components: list(a?.components),
      capabilityIds,
      sourceDocs: list(a?.sourceDocs),
    };
  });
}

// JSON embedded in a <script> must not be able to close the tag early.
const jsonIsland = (data) => JSON.stringify(data).replace(/</g, "\\u003c");
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function renderHtml({ title, project, feature, generatedOn, sources, capabilities, activities }) {
  const data = jsonIsland({ capabilities, activities });
  const phases = [...new Set(activities.map((a) => a.l1))];
  const leafCount = capabilities.filter((c) => c.level >= 3).length;
  return `<!doctype html>
<html lang="en-AU">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${esc(title)}</title>
<style>
  :root {
    --ink:#464E7E; --deep:#363C63; --line:#E7E9F0; --ink-50:#EEF0F7; --ink-100:#D9DDEB;
    --ink-200:#B6BDD6; --ink-500:#5C6593; --glow:#7C82C8; --sand:#C8A878; --forest:#3E6B56;
    --ocean:#2F6B78; --paper:#FFFFFF; --bg:#F7F8FC; --text:#1F2437; --muted:#6B7191;
  }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--text);
         font:15px/1.55 Arial,"Helvetica Neue",Helvetica,sans-serif; }
  header { background:var(--ink); color:#fff; padding:18px 24px; }
  header h1 { margin:0 0 4px; font-size:19px; font-weight:700; letter-spacing:.01em; }
  header .meta { font-size:12.5px; color:var(--ink-100); }
  .wrap { max-width:1200px; margin:0 auto; padding:0 24px 56px; }
  nav { display:flex; gap:6px; margin:18px 0 14px; border-bottom:1px solid var(--line); }
  nav button { appearance:none; border:0; background:none; cursor:pointer; padding:9px 14px;
               font:inherit; font-weight:600; color:var(--muted); border-bottom:2px solid transparent; }
  nav button[aria-selected="true"] { color:var(--ink); border-bottom-color:var(--ink); }
  .bar { display:flex; flex-wrap:wrap; gap:8px; align-items:center; margin-bottom:14px; }
  .bar input, .bar select { font:inherit; padding:7px 10px; border:1px solid var(--line);
                            border-radius:8px; background:var(--paper); color:var(--text); }
  .bar input { min-width:240px; flex:1 1 240px; }
  .bar .note { font-size:12.5px; color:var(--muted); margin-left:auto; }
  .bar button { font:inherit; padding:7px 12px; border:1px solid var(--line); border-radius:8px;
                background:var(--paper); cursor:pointer; color:var(--ink); font-weight:600; }
  .stats { display:flex; flex-wrap:wrap; gap:10px; margin:0 0 16px; }
  .stat { background:var(--paper); border:1px solid var(--line); border-radius:10px; padding:10px 14px; min-width:120px; }
  .stat b { display:block; font-size:20px; color:var(--ink); }
  .stat span { font-size:11.5px; text-transform:uppercase; letter-spacing:.05em; color:var(--muted); }
  .card { background:var(--paper); border:1px solid var(--line); border-radius:12px; overflow:hidden; }
  details { border-bottom:1px solid var(--line); }
  details:last-child { border-bottom:0; }
  summary { cursor:pointer; list-style:none; padding:10px 14px; display:flex; gap:10px; align-items:center; }
  summary::-webkit-details-marker { display:none; }
  summary:hover { background:var(--ink-50); }
  .caret { color:var(--ink-200); transition:transform .15s; font-size:11px; }
  details[open] > summary .caret { transform:rotate(90deg); }
  .id { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; color:var(--ink-500);
        background:var(--ink-50); border-radius:5px; padding:2px 6px; }
  .nm { font-weight:600; }
  .l1 > summary { background:var(--ink-50); }
  .l1 > summary .nm { color:var(--deep); }
  .lvl { padding-left:16px; }
  .desc { padding:0 14px 12px 46px; color:var(--muted); font-size:13.5px; }
  .chip { font-size:11px; padding:2px 8px; border-radius:999px; border:1px solid var(--line);
          color:var(--muted); background:var(--paper); white-space:nowrap; }
  .chip.m-None { background:#FFF1F2; border-color:#FBD5DA; color:#B4283F; }
  .chip.m-Foundational { background:#FFFBEB; border-color:#F5E3B8; color:#8A6212; }
  .chip.m-Operational { background:#EFF6FF; border-color:#CFE0FB; color:#255CA8; }
  .chip.m-Optimised { background:#ECFDF5; border-color:#C6EBDA; color:#1E7A57; }
  .chip.m-Transformational { background:#EEF2FF; border-color:#D3D8FB; color:#4338CA; }
  .chip.link { cursor:pointer; border-color:var(--ink-200); color:var(--ink); }
  .chip.link:hover { background:var(--ink-50); }
  .spacer { flex:1; }
  table { width:100%; border-collapse:collapse; font-size:13.5px; }
  th, td { text-align:left; padding:9px 12px; border-bottom:1px solid var(--line); vertical-align:top; }
  th { font-size:11px; text-transform:uppercase; letter-spacing:.05em; color:var(--muted); background:var(--ink-50); }
  tr:last-child td { border-bottom:0; }
  td .sub { color:var(--muted); font-size:12.5px; margin-top:3px; }
  .src { font-size:11.5px; color:var(--ink-500); }
  .empty { padding:26px 14px; text-align:center; color:var(--muted); font-size:13.5px; }
  .warn { color:#B4283F; font-weight:600; }
  footer { color:var(--muted); font-size:12px; padding:18px 0 0; }
  @media print { nav, .bar { display:none; } body { background:#fff; } details { break-inside:avoid; } }
</style>
</head>
<body>
<header>
  <h1>${esc(title)}</h1>
  <div class="meta">${esc(project)} / ${esc(feature)} · generated ${esc(generatedOn)} · ${sources.length} source document${sources.length === 1 ? "" : "s"}</div>
</header>
<div class="wrap">
  <div class="stats">
    <div class="stat"><b>${capabilities.filter((c) => c.level === 1).length}</b><span>Domains</span></div>
    <div class="stat"><b>${leafCount}</b><span>Capabilities</span></div>
    <div class="stat"><b>${phases.length}</b><span>Lifecycle phases</span></div>
    <div class="stat"><b>${activities.length}</b><span>Activities</span></div>
  </div>

  <nav role="tablist">
    <button id="tab-cap" role="tab" aria-selected="true" aria-controls="view-cap">Capability map</button>
    <button id="tab-proc" role="tab" aria-selected="false" aria-controls="view-proc">Process model</button>
    <button id="tab-cov" role="tab" aria-selected="false" aria-controls="view-cov">Coverage</button>
    <button id="tab-src" role="tab" aria-selected="false" aria-controls="view-src">Sources</button>
  </nav>

  <section id="view-cap" role="tabpanel">
    <div class="bar">
      <input id="cap-q" type="search" placeholder="Search capabilities…" aria-label="Search capabilities"/>
      <select id="cap-maturity" aria-label="Filter by current maturity"><option value="">All maturity</option></select>
      <button id="cap-expand" type="button">Expand all</button>
      <button id="cap-collapse" type="button">Collapse all</button>
      <span class="note" id="cap-count"></span>
    </div>
    <div class="card" id="cap-tree"></div>
  </section>

  <section id="view-proc" role="tabpanel" hidden>
    <div class="bar">
      <input id="proc-q" type="search" placeholder="Search activities…" aria-label="Search activities"/>
      <select id="proc-actor" aria-label="Filter by actor"><option value="">All actors</option></select>
      <select id="proc-tier" aria-label="Filter by service tier"><option value="">All tiers</option></select>
      <select id="proc-cap" aria-label="Filter by capability"><option value="">All capabilities</option></select>
      <span class="note" id="proc-count"></span>
    </div>
    <div id="proc-list"></div>
  </section>

  <section id="view-cov" role="tabpanel" hidden>
    <div class="bar"><span class="note" id="cov-count"></span></div>
    <div class="card"><table id="cov-table">
      <thead><tr><th>Capability</th><th>Current → Target</th><th>Activities</th><th>Coverage</th></tr></thead>
      <tbody></tbody>
    </table></div>
  </section>

  <section id="view-src" role="tabpanel" hidden>
    <div class="card"><table>
      <thead><tr><th>Source document</th><th>Capabilities</th><th>Activities</th></tr></thead>
      <tbody id="src-body"></tbody>
    </table></div>
  </section>

  <footer>Generated by the Scyne <code>capability-process-map</code> skill. Data lives alongside this page as <code>capability-map.json</code> and <code>process-model.json</code>.</footer>
</div>

<script type="application/json" id="data">${data}</script>
<script>
(function () {
  var DATA = JSON.parse(document.getElementById("data").textContent);
  var caps = DATA.capabilities, acts = DATA.activities;
  var byId = {}; caps.forEach(function (c) { byId[c.id] = c; });
  var kids = {}; caps.forEach(function (c) { var p = c.parentId || "__root"; (kids[p] = kids[p] || []).push(c); });

  var actsByCap = {};
  acts.forEach(function (a) { (a.capabilityIds || []).forEach(function (id) { (actsByCap[id] = actsByCap[id] || []).push(a); }); });

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function uniq(arr) { return arr.filter(function (v, i) { return v && arr.indexOf(v) === i; }).sort(); }
  function fill(sel, values) {
    values.forEach(function (v) { var o = el("option", null, v); o.value = v; sel.appendChild(o); });
  }

  // ---- tabs -------------------------------------------------------------
  var tabs = [["tab-cap", "view-cap"], ["tab-proc", "view-proc"], ["tab-cov", "view-cov"], ["tab-src", "view-src"]];
  function show(viewId) {
    tabs.forEach(function (p) {
      var on = p[1] === viewId;
      document.getElementById(p[0]).setAttribute("aria-selected", on ? "true" : "false");
      document.getElementById(p[1]).hidden = !on;
    });
  }
  tabs.forEach(function (p) { document.getElementById(p[0]).addEventListener("click", function () { show(p[1]); }); });

  // ---- capability tree --------------------------------------------------
  var capQ = document.getElementById("cap-q");
  var capM = document.getElementById("cap-maturity");
  var capTree = document.getElementById("cap-tree");
  var capCount = document.getElementById("cap-count");
  fill(capM, uniq(caps.map(function (c) { return c.currentMaturity; })));

  function capMatches(c, q, m) {
    if (m && c.currentMaturity !== m) return false;
    if (!q) return true;
    return (c.id + " " + c.name + " " + c.description + " " + (c.stage || "")).toLowerCase().indexOf(q) > -1;
  }
  // A node is kept when it matches, or any descendant matches (so parents of a
  // hit stay visible and the hierarchy never breaks mid-branch).
  function keepSet(q, m) {
    var keep = {};
    function walk(c) {
      var self = capMatches(c, q, m);
      var any = (kids[c.id] || []).map(walk).some(Boolean);
      if (self || any) keep[c.id] = true;
      return self || any;
    }
    (kids["__root"] || []).forEach(walk);
    return keep;
  }
  function nodeEl(c, keep) {
    var d = el("details", c.level === 1 ? "l1" : "lvl");
    if (c.level <= 2) d.open = true;
    var s = el("summary");
    s.appendChild(el("span", "caret", "\\u25B6"));
    s.appendChild(el("span", "id", c.id));
    s.appendChild(el("span", "nm", c.name));
    s.appendChild(el("span", "spacer"));
    if (c.stage) s.appendChild(el("span", "chip", c.stage));
    if (c.currentMaturity) s.appendChild(el("span", "chip m-" + c.currentMaturity, c.currentMaturity));
    if (c.targetMaturity && c.targetMaturity !== c.currentMaturity) {
      s.appendChild(el("span", "chip m-" + c.targetMaturity, "\\u2192 " + c.targetMaturity));
    }
    var n = (actsByCap[c.id] || []).length;
    if (n) {
      var link = el("span", "chip link", n + " activit" + (n === 1 ? "y" : "ies"));
      link.title = "Show the process activities for " + c.name;
      link.addEventListener("click", function (e) {
        e.preventDefault(); e.stopPropagation();
        document.getElementById("proc-cap").value = c.id;
        renderProcess(); show("view-proc"); window.scrollTo(0, 0);
      });
      s.appendChild(link);
    }
    d.appendChild(s);
    if (c.description) {
      var desc = el("div", "desc", c.description);
      if (c.sourceDocs.length) desc.appendChild(el("div", "src", "Source: " + c.sourceDocs.join(", ")));
      d.appendChild(desc);
    }
    (kids[c.id] || []).forEach(function (k) { if (keep[k.id]) d.appendChild(nodeEl(k, keep)); });
    return d;
  }
  function renderCaps() {
    var q = capQ.value.trim().toLowerCase(), m = capM.value;
    var keep = keepSet(q, m);
    capTree.innerHTML = "";
    var roots = (kids["__root"] || []).filter(function (c) { return keep[c.id]; });
    if (!roots.length) { capTree.appendChild(el("div", "empty", "No capabilities match that filter.")); }
    else { roots.forEach(function (c) { capTree.appendChild(nodeEl(c, keep)); }); }
    var shown = Object.keys(keep).length;
    capCount.textContent = shown + " of " + caps.length + " shown";
  }
  capQ.addEventListener("input", renderCaps);
  capM.addEventListener("change", renderCaps);
  document.getElementById("cap-expand").addEventListener("click", function () {
    capTree.querySelectorAll("details").forEach(function (d) { d.open = true; });
  });
  document.getElementById("cap-collapse").addEventListener("click", function () {
    capTree.querySelectorAll("details").forEach(function (d) { d.open = false; });
  });

  // ---- process explorer -------------------------------------------------
  var procQ = document.getElementById("proc-q");
  var procActor = document.getElementById("proc-actor");
  var procTier = document.getElementById("proc-tier");
  var procCap = document.getElementById("proc-cap");
  var procList = document.getElementById("proc-list");
  var procCount = document.getElementById("proc-count");
  fill(procActor, uniq(acts.map(function (a) { return a.actor; })));
  fill(procTier, uniq(acts.map(function (a) { return a.serviceTier; })));
  caps.filter(function (c) { return (actsByCap[c.id] || []).length; })
      .forEach(function (c) {
        var o = el("option", null, c.id + " " + c.name);
        o.value = c.id; procCap.appendChild(o);
      });

  function actMatches(a, q, actor, tier, cap) {
    if (actor && a.actor !== actor) return false;
    if (tier && a.serviceTier !== tier) return false;
    if (cap && (a.capabilityIds || []).indexOf(cap) === -1) return false;
    if (!q) return true;
    var hay = (a.l1 + " " + a.l2 + " " + a.l3 + " " + a.description + " " + a.components.join(" ")).toLowerCase();
    return hay.indexOf(q) > -1;
  }
  function renderProcess() {
    var q = procQ.value.trim().toLowerCase();
    var actor = procActor.value, tier = procTier.value, cap = procCap.value;
    var rows = acts.filter(function (a) { return actMatches(a, q, actor, tier, cap); });
    procList.innerHTML = "";
    if (!rows.length) {
      var card = el("div", "card"); card.appendChild(el("div", "empty", "No activities match that filter."));
      procList.appendChild(card);
    } else {
      var phases = uniqOrder(rows.map(function (a) { return a.l1; }));
      phases.forEach(function (phase) {
        var inPhase = rows.filter(function (a) { return a.l1 === phase; });
        var card = el("div", "card"); card.style.marginBottom = "12px";
        var d = el("details", "l1"); d.open = true;
        var s = el("summary");
        s.appendChild(el("span", "caret", "\\u25B6"));
        s.appendChild(el("span", "nm", phase));
        s.appendChild(el("span", "spacer"));
        s.appendChild(el("span", "chip", inPhase.length + " activit" + (inPhase.length === 1 ? "y" : "ies")));
        d.appendChild(s);
        var t = el("table");
        t.innerHTML = "<thead><tr><th>Step</th><th>Activity</th><th>Actor</th><th>Tier</th><th>Components</th><th>Capabilities</th></tr></thead>";
        var tb = el("tbody");
        inPhase.forEach(function (a) {
          var tr = el("tr");
          tr.appendChild(el("td", null, a.l2));
          var td = el("td");
          td.appendChild(el("div", null, a.l3));
          if (a.description) td.appendChild(el("div", "sub", a.description));
          if (a.sourceDocs.length) td.appendChild(el("div", "src", "Source: " + a.sourceDocs.join(", ")));
          tr.appendChild(td);
          tr.appendChild(el("td", null, a.actor));
          tr.appendChild(el("td", null, a.serviceTier));
          tr.appendChild(el("td", null, a.components.join(", ") || "\\u2014"));
          var capTd = el("td");
          (a.capabilityIds || []).forEach(function (id) {
            var c = byId[id];
            var chip = el("span", "chip", id);
            chip.title = c ? c.name : id;
            capTd.appendChild(chip); capTd.appendChild(document.createTextNode(" "));
          });
          if (!(a.capabilityIds || []).length) capTd.textContent = "\\u2014";
          tr.appendChild(capTd);
          tb.appendChild(tr);
        });
        t.appendChild(tb); d.appendChild(t); card.appendChild(d); procList.appendChild(card);
      });
    }
    procCount.textContent = rows.length + " of " + acts.length + " shown";
  }
  function uniqOrder(arr) { var out = []; arr.forEach(function (v) { if (out.indexOf(v) === -1) out.push(v); }); return out; }
  [procQ, procActor, procTier, procCap].forEach(function (n) {
    n.addEventListener(n.tagName === "INPUT" ? "input" : "change", renderProcess);
  });

  // ---- coverage ---------------------------------------------------------
  var covBody = document.querySelector("#cov-table tbody");
  var leaves = caps.filter(function (c) { return !(kids[c.id] || []).length; });
  var uncovered = 0;
  leaves.forEach(function (c) {
    var n = (actsByCap[c.id] || []).length;
    if (!n) uncovered++;
    var tr = el("tr");
    var td = el("td");
    td.appendChild(el("span", "id", c.id));
    td.appendChild(document.createTextNode(" " + c.name));
    tr.appendChild(td);
    tr.appendChild(el("td", null, (c.currentMaturity || "\\u2014") + " \\u2192 " + (c.targetMaturity || "\\u2014")));
    tr.appendChild(el("td", null, String(n)));
    var cov = el("td", n ? null : "warn", n ? "Covered" : "No process evidence");
    tr.appendChild(cov);
    covBody.appendChild(tr);
  });
  document.getElementById("cov-count").textContent =
    leaves.length + " leaf capabilities \\u00b7 " + uncovered + " with no process evidence";

  // ---- sources ----------------------------------------------------------
  var srcBody = document.getElementById("src-body");
  var srcMap = {};
  caps.forEach(function (c) { c.sourceDocs.forEach(function (s) { (srcMap[s] = srcMap[s] || { c: 0, a: 0 }).c++; }); });
  acts.forEach(function (a) { a.sourceDocs.forEach(function (s) { (srcMap[s] = srcMap[s] || { c: 0, a: 0 }).a++; }); });
  Object.keys(srcMap).sort().forEach(function (s) {
    var tr = el("tr");
    tr.appendChild(el("td", null, s));
    tr.appendChild(el("td", null, String(srcMap[s].c)));
    tr.appendChild(el("td", null, String(srcMap[s].a)));
    srcBody.appendChild(tr);
  });
  if (!Object.keys(srcMap).length) {
    var tr = el("tr"); var td = el("td", "empty", "No source documents recorded."); td.colSpan = 3;
    tr.appendChild(td); srcBody.appendChild(tr);
  }

  renderCaps();
  renderProcess();
})();
</script>
</body>
</html>
`;
}

async function main() {
  const [project, feature] = process.argv.slice(2);
  if (!project || !feature) die(`usage: node scripts/render-capability-map.mjs <project> <feature>`);
  if (!SAFE_NAME.test(project) || !SAFE_NAME.test(feature)) die(`project and feature must match ${SAFE_NAME} — got "${project}" / "${feature}".`);

  const outDir = path.join(WORKSPACE, "projects", project, feature, "solutions", "Capabilities", "outputs");
  const capDoc = await readJson(path.join(outDir, "capability-map.json"), "capability-map.json");
  const procDoc = await readJson(path.join(outDir, "process-model.json"), "process-model.json");

  const capabilities = normaliseCapabilities(capDoc);
  const activities = normaliseActivities(procDoc, new Set(capabilities.map((c) => c.id)));

  const sources = [...new Set([
    ...list(capDoc.sources),
    ...capabilities.flatMap((c) => c.sourceDocs),
    ...activities.flatMap((a) => a.sourceDocs),
  ])].sort();

  const html = renderHtml({
    title: str(capDoc.title) || `${feature} — Capability & Process Map`,
    project: str(capDoc.project) || project,
    feature: str(capDoc.feature) || feature,
    generatedOn: str(capDoc.generatedOn) || new Date().toISOString().slice(0, 10),
    sources,
    capabilities,
    activities,
  });

  const outFile = path.join(outDir, "capability-process.html");
  await fs.writeFile(outFile, html, "utf8");

  const byLevel = capabilities.reduce((acc, c) => { acc[c.level] = (acc[c.level] || 0) + 1; return acc; }, {});
  console.log(JSON.stringify({
    ok: true,
    html: outFile,
    capabilities: capabilities.length,
    capabilitiesByLevel: byLevel,
    phases: [...new Set(activities.map((a) => a.l1))].length,
    activities: activities.length,
    sources: sources.length,
  }, null, 2));
}

main().catch((e) => die(e?.stack || e?.message || String(e)));
