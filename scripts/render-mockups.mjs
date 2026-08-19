#!/usr/bin/env node
// Render a feature's UI mockups into self-contained, themed HTML — one page per
// screen, plus an index. Used by the `ui-mockup-generator` skill, which authors
// the JSON and then shells out to this script.
//
//   node scripts/render-mockups.mjs <project> <feature>
//
// Reads   projects/<project>/<feature>/solutions/UI/outputs/mockups.json
//         projects/<project>/design/style-guides/theme.json  (optional, project-level)
// Writes  generated-apps/<project>/mockups/<feature>/index.html
//         generated-apps/<project>/mockups/<feature>/<screen-id>.html
//
// Exits non-zero naming the offending screen and field when the data is
// unusable — the agent fixes the JSON and re-runs rather than hand-writing HTML.
//
// THEME — the tokens below mirror scripts/render-companion-app.mjs so a mockup
// sits beside the companion app without looking like a different product. They
// are duplicated rather than imported because the companion app builds its CSS
// inline inside a template literal; if that is ever extracted into a module,
// both should read it from there instead.

import fs from "node:fs/promises";
import path from "node:path";
import { WORK_ROOT } from "./lib/roots.mjs";

// The project tree this run operates on. See scripts/lib/roots.mjs for why
// this is not the same question as "where does this code live".
const WORKSPACE = WORK_ROOT;
const SAFE_NAME = /^[A-Za-z0-9._ &-]+$/;
const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

const die = (msg) => { console.error(`\n[render-mockups] ${msg}\n`); process.exit(1); };
const rel = (p) => path.relative(WORKSPACE, p) || ".";
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const str = (v) => (typeof v === "string" && v.trim() ? v.trim() : "");
const list = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string" && x.trim()) : []);
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

// --------------------------------------------------------------------- theme

const FALLBACK = { brand: "#464e7e", brandDeep: "#363c63", accent: "#b4795a", logoText: "Scyne", logoSrc: "" };

function expand(h) { const s = h.replace("#", ""); return s.length === 3 ? s.split("").map((c) => c + c).join("") : s; }
function lum(hex) {
  const h = expand(hex);
  const f = (v) => { const n = parseInt(v, 16) / 255; return n <= 0.03928 ? n / 12.92 : Math.pow((n + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(h.slice(0, 2)) + 0.7152 * f(h.slice(2, 4)) + 0.0722 * f(h.slice(4, 6));
}
const contrast = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const readableOn = (bg) => (contrast(bg, "#12151d") >= 4.5 ? "#12151d" : "#ffffff");
function mix(a, b, t) {
  const A = expand(a), B = expand(b);
  const c = (i) => Math.round(parseInt(A.slice(i, i + 2), 16) * (1 - t) + parseInt(B.slice(i, i + 2), 16) * t);
  return "#" + [0, 2, 4].map((i) => c(i).toString(16).padStart(2, "0")).join("");
}
/** Walk a colour toward readable until it clears 4.5:1 — same rule the companion app uses. */
function textColour(c, surface) {
  const target = readableOn(surface);
  for (let t = 0; t <= 1.0001; t += 0.05) { const m = mix(c, target, t); if (contrast(m, surface) >= 4.5) return m; }
  return target;
}

async function loadTheme(projectRoot) {
  const file = path.join(projectRoot, "design", "style-guides", "theme.json");
  let t = { ...FALLBACK };
  try { t = { ...FALLBACK, ...JSON.parse(await fs.readFile(file, "utf8")) }; } catch { /* defaults */ }
  const brand = HEX.test(t.brand || "") ? t.brand : FALLBACK.brand;
  const deep = HEX.test(t.brandDeep || "") ? t.brandDeep : brand;
  const accent = HEX.test(t.accent || "") ? t.accent : FALLBACK.accent;
  const logoSrc = /^data:image\/(png|jpeg|gif|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/.test(t.logoSrc || "") ? t.logoSrc : "";
  return {
    brand, deep, accent, logoSrc,
    logoText: str(t.logoText) || FALLBACK.logoText,
    brandFg: textColour(deep, "#f7f8fb"),
    accentFg: textColour(accent, "#f7f8fb"),
    selFg: readableOn(brand),
  };
}

// ------------------------------------------------------------------ validate

const BLOCKS = new Set(["header", "banner", "stepper", "tabs", "form", "table", "detail", "cards", "list", "timeline", "buttons", "placeholder", "note"]);

function validate(doc) {
  const screens = Array.isArray(doc?.screens) ? doc.screens : null;
  if (!screens) die(`mockups.json: missing the "screens" array.`);
  if (!screens.length) die(`mockups.json: "screens" is empty — nothing to render.`);
  const seen = new Set();
  screens.forEach((s, i) => {
    const at = `screens[${i}]${str(s?.id) ? ` (${s.id})` : ""}`;
    if (!str(s?.id)) die(`${at}: "id" is required (e.g. "SCR-001").`);
    if (seen.has(s.id)) die(`${at}: duplicate id.`);
    seen.add(s.id);
    if (!str(s?.name)) die(`${at}: "name" is required.`);
    const states = Array.isArray(s.states) ? s.states : null;
    if (!states || !states.length) die(`${at}: "states" must be a non-empty array (use one state for a simple screen).`);
    states.forEach((st, j) => {
      const atS = `${at}.states[${j}]`;
      if (!str(st?.id)) die(`${atS}: "id" is required.`);
      if (!Array.isArray(st?.blocks) || !st.blocks.length) die(`${atS}: "blocks" must be a non-empty array.`);
      st.blocks.forEach((b, k) => {
        if (!BLOCKS.has(b?.type)) {
          die(`${atS}.blocks[${k}]: unknown type ${JSON.stringify(b?.type)}.\n  Allowed: ${[...BLOCKS].join(", ")}`);
        }
      });
    });
  });
  return screens;
}

// -------------------------------------------------------------------- blocks

const FIELD_TYPES = new Set(["text", "textarea", "number", "select", "date", "checkbox", "radio", "file", "readonly"]);

function field(f) {
  const label = esc(str(f?.label) || "Untitled field");
  const type = FIELD_TYPES.has(f?.type) ? f.type : "text";
  const req = f?.required ? `<abbr class="req" title="Required">*</abbr>` : "";
  const help = str(f?.help) ? `<span class="help">${esc(f.help)}</span>` : "";
  const err = str(f?.error) ? `<span class="err">${esc(f.error)}</span>` : "";
  const cls = `fld fld-${esc(str(f?.width) === "half" ? "half" : "full")}${str(f?.error) ? " is-error" : ""}`;
  const val = esc(str(f?.value));
  const ph = esc(str(f?.placeholder));
  let control;
  if (type === "textarea") control = `<div class="ctl ctl-area">${val || `<span class="ph">${ph}</span>`}</div>`;
  else if (type === "select") control = `<div class="ctl ctl-select">${val || `<span class="ph">${ph || "Select…"}</span>`}<span class="caret">▾</span></div>`;
  else if (type === "checkbox") control = `<div class="ctl-check"><span class="box${f?.value ? " on" : ""}"></span><span>${esc(str(f?.checkboxLabel) || label)}</span></div>`;
  else if (type === "radio") control = `<div class="ctl-radios">${list(f?.options).map((o, i) => `<span class="radio${String(f?.value) === o || (!str(f?.value) && i === 0) ? " on" : ""}"><i></i>${esc(o)}</span>`).join("")}</div>`;
  else if (type === "file") control = `<div class="ctl ctl-file"><span class="ph">${ph || "Choose files or drag them here"}</span></div>`;
  else if (type === "readonly") control = `<div class="ctl ctl-ro">${val || "—"}</div>`;
  else control = `<div class="ctl">${val || `<span class="ph">${ph}</span>`}</div>`;
  const hideLabel = type === "checkbox";
  return `<div class="${cls}">${hideLabel ? "" : `<span class="lbl">${label}${req}</span>`}${control}${err}${help}</div>`;
}

function block(b) {
  switch (b.type) {
    case "header":
      return `<div class="m-header"><div><h2>${esc(str(b.title))}</h2>${str(b.subtitle) ? `<p>${esc(b.subtitle)}</p>` : ""}</div>` +
        `${list(b.actions).length ? `<div class="acts">${list(b.actions).map((a, i) => `<span class="btn ${i === 0 ? "btn-primary" : "btn-secondary"}">${esc(a)}</span>`).join("")}</div>` : ""}</div>`;
    case "banner": {
      const tone = ["info", "success", "warning", "error"].includes(b.tone) ? b.tone : "info";
      return `<div class="m-banner tone-${tone}"><span class="dot"></span><span>${esc(str(b.text))}</span></div>`;
    }
    case "stepper": {
      const steps = list(b.steps), cur = Number.isInteger(b.current) ? b.current : 0;
      return `<ol class="m-stepper">${steps.map((s, i) =>
        `<li class="${i < cur ? "done" : i === cur ? "now" : ""}"><span class="n">${i < cur ? "✓" : i + 1}</span><span>${esc(s)}</span></li>`).join("")}</ol>`;
    }
    case "tabs": {
      const tabs = list(b.tabs), cur = Number.isInteger(b.current) ? b.current : 0;
      return `<div class="m-tabs">${tabs.map((t, i) => `<span class="${i === cur ? "on" : ""}">${esc(t)}</span>`).join("")}</div>`;
    }
    case "form":
      return `<section class="m-card">${str(b.title) ? `<h3>${esc(b.title)}</h3>` : ""}` +
        `<div class="m-form">${(Array.isArray(b.fields) ? b.fields : []).map(field).join("")}</div></section>`;
    case "table": {
      const cols = list(b.columns);
      const rows = Array.isArray(b.rows) ? b.rows : [];
      const body = rows.length
        ? rows.map((r) => `<tr>${cols.map((_, i) => `<td>${esc(Array.isArray(r) ? r[i] : "")}</td>`).join("")}</tr>`).join("")
        : `<tr><td class="empty" colspan="${Math.max(cols.length, 1)}">${esc(str(b.empty) || "Nothing to show.")}</td></tr>`;
      return `<section class="m-card">${str(b.title) ? `<h3>${esc(b.title)}</h3>` : ""}` +
        `<div class="m-scroll"><table class="m-table"><thead><tr>${cols.map((c) => `<th>${esc(c)}</th>`).join("")}</tr></thead><tbody>${body}</tbody></table></div></section>`;
    }
    case "detail": {
      const pairs = Array.isArray(b.pairs) ? b.pairs : [];
      return `<section class="m-card">${str(b.title) ? `<h3>${esc(b.title)}</h3>` : ""}` +
        `<dl class="m-detail">${pairs.map((p) => `<div><dt>${esc(str(p?.label))}</dt><dd>${esc(str(p?.value) || "—")}</dd></div>`).join("")}</dl></section>`;
    }
    case "cards": {
      const items = Array.isArray(b.items) ? b.items : [];
      return `<section class="m-card">${str(b.title) ? `<h3>${esc(b.title)}</h3>` : ""}` +
        `<div class="m-cards">${items.map((i) => `<article><h4>${esc(str(i?.title))}</h4>${str(i?.meta) ? `<span class="meta">${esc(i.meta)}</span>` : ""}${str(i?.body) ? `<p>${esc(i.body)}</p>` : ""}</article>`).join("")}</div></section>`;
    }
    case "list":
      return `<section class="m-card">${str(b.title) ? `<h3>${esc(b.title)}</h3>` : ""}` +
        `<ul class="m-list">${list(b.items).map((i) => `<li>${esc(i)}</li>`).join("")}</ul></section>`;
    case "timeline": {
      const entries = Array.isArray(b.entries) ? b.entries : [];
      return `<section class="m-card">${str(b.title) ? `<h3>${esc(b.title)}</h3>` : ""}` +
        `<ol class="m-timeline">${entries.map((e) => `<li><span class="when">${esc(str(e?.when))}</span><span class="what">${esc(str(e?.what))}</span>${str(e?.who) ? `<span class="who">${esc(e.who)}</span>` : ""}</li>`).join("")}</ol></section>`;
    }
    case "buttons": {
      const items = Array.isArray(b.items) ? b.items : [];
      return `<div class="m-buttons">${items.map((i) => {
        const v = ["primary", "secondary", "danger"].includes(i?.variant) ? i.variant : "secondary";
        return `<span class="btn btn-${v}">${esc(str(i?.label))}</span>`;
      }).join("")}</div>`;
    }
    case "placeholder": {
      const kind = ["map", "chart", "image", "document"].includes(b.kind) ? b.kind : "image";
      return `<div class="m-ph ph-${kind}"><span class="ph-k">${esc(kind)}</span><span>${esc(str(b.caption) || "Placeholder")}</span></div>`;
    }
    case "note":
      return `<p class="m-note">${esc(str(b.text))}</p>`;
    default:
      return "";
  }
}

// ---------------------------------------------------------------------- page

function css(t) {
  return `
:root{
  --ink:#1f2430; --muted:#5c6478; --line:#e2e5ee; --bg:#ffffff; --panel:#f7f8fb;
  --brand:${t.brand}; --brand-deep:${t.deep}; --brand-fg:${t.brandFg};
  --accent:${t.accent}; --accent-fg:${t.accentFg};
  --sel-bg:${t.brand}; --sel-fg:${t.selFg};
  --ok:#2f7d5d; --warn:#a8621b; --bad:#b3402f;
  --radius:12px; --pad:2rem;
  --shadow:0 1px 2px rgba(20,24,40,.06),0 8px 24px rgba(20,24,40,.06);
}
*{box-sizing:border-box} html,body{margin:0;padding:0}
body{background:var(--panel);color:var(--ink);font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif}
a{color:var(--brand-fg)}
.top{background:var(--bg);border-bottom:1px solid var(--line);position:sticky;top:0;z-index:20}
.top-row{height:4rem;display:flex;align-items:center;gap:1rem;padding:0 var(--pad)}
.logo-img{height:2.5rem;width:auto;border-radius:.375rem;display:block}
.logo-text{font-weight:800;font-size:1.05rem;color:var(--brand-fg)}
.rule{height:2rem;width:1px;background:var(--line)}
.titles h1{margin:0;font-size:1.15rem;font-weight:700;color:var(--brand-fg);line-height:1.1}
.eyebrow-sm{font-size:.625rem;text-transform:uppercase;letter-spacing:.2em;font-weight:700;color:var(--muted);margin-top:.25rem}
.spacer{flex:1}
.backnav{display:flex;align-items:center;gap:.5rem;flex-wrap:wrap}
.backlink{display:inline-flex;align-items:center;gap:.4rem;padding:.375rem .75rem;border:1px solid var(--line);border-radius:var(--radius);
  color:var(--muted);text-decoration:none;font-size:.8rem;font-weight:600;white-space:nowrap}
.backlink:hover{color:var(--brand-fg);border-color:var(--brand)}
.backlink-home{color:var(--brand-fg);border-color:var(--brand)}
.backlink-home:hover{background:var(--sel-bg);border-color:var(--sel-bg);color:var(--sel-fg)}
.wrap{padding:1.75rem var(--pad) 3rem}
.eyebrow{display:flex;align-items:center;gap:.6rem;font-size:.7rem;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--accent-fg);margin-bottom:.6rem}
.eyebrow::before{content:"";width:2rem;height:2px;background:var(--accent-fg)}
h2.page-h{margin:0 0 .5rem;font-size:1.7rem;color:var(--brand-fg);line-height:1.2}
.lede{margin:0 0 1.5rem;color:var(--muted);max-width:70ch}
.trace{display:flex;flex-wrap:wrap;gap:.4rem;margin-bottom:1.5rem}
.chip{font-size:.7rem;font-weight:600;padding:.15rem .5rem;border-radius:999px;background:var(--bg);border:1px solid var(--line);color:var(--muted)}
.chip-b{border-color:var(--brand);color:var(--brand-fg)}
.statebar{display:flex;flex-wrap:wrap;gap:.5rem;margin-bottom:1.25rem}
.statebtn{font:inherit;font-size:.8rem;font-weight:600;cursor:pointer;padding:.4rem .8rem;border-radius:999px;
  background:var(--bg);border:1px solid var(--line);color:var(--muted)}
.statebtn[aria-pressed="true"]{background:var(--sel-bg);border-color:var(--sel-bg);color:var(--sel-fg)}
.screen{background:var(--bg);border:1px solid var(--line);border-radius:16px;box-shadow:var(--shadow);padding:1.5rem;max-width:1100px}
.screen[hidden]{display:none}
.chrome{display:flex;align-items:center;gap:.4rem;padding-bottom:1rem;margin-bottom:1.25rem;border-bottom:1px solid var(--line)}
.chrome i{width:.6rem;height:.6rem;border-radius:50%;background:var(--line);display:block}
.chrome .url{margin-left:.6rem;font-size:.72rem;color:var(--muted);background:var(--panel);border:1px solid var(--line);border-radius:999px;padding:.2rem .7rem}
.m-header{display:flex;justify-content:space-between;align-items:flex-start;gap:1rem;flex-wrap:wrap;margin-bottom:1.25rem}
.m-header h2{margin:0;font-size:1.25rem;color:var(--brand-fg)}
.m-header p{margin:.3rem 0 0;color:var(--muted);font-size:.88rem}
.acts{display:flex;gap:.5rem}
.btn{display:inline-block;font-size:.8rem;font-weight:600;padding:.4rem .85rem;border-radius:8px;border:1px solid var(--line);background:var(--bg);color:var(--ink)}
.btn-primary{background:var(--sel-bg);border-color:var(--sel-bg);color:var(--sel-fg)}
.btn-danger{border-color:var(--bad);color:var(--bad)}
.m-banner{display:flex;align-items:flex-start;gap:.6rem;padding:.7rem .9rem;border-radius:9px;font-size:.85rem;margin-bottom:1.25rem;border:1px solid}
.m-banner .dot{width:.5rem;height:.5rem;border-radius:50%;margin-top:.4rem;flex:none}
.tone-info{background:var(--panel);border-color:var(--line)} .tone-info .dot{background:var(--brand)}
.tone-success{background:#f0faf5;border-color:#bfe5d3;color:#186748} .tone-success .dot{background:var(--ok)}
.tone-warning{background:#fdf7ef;border-color:#f0dcbf;color:#8a5214} .tone-warning .dot{background:var(--warn)}
.tone-error{background:#fdf2f2;border-color:#f3d0cd;color:#992d20} .tone-error .dot{background:var(--bad)}
.m-stepper{display:flex;flex-wrap:wrap;gap:.5rem;list-style:none;margin:0 0 1.25rem;padding:0}
.m-stepper li{display:flex;align-items:center;gap:.45rem;font-size:.78rem;color:var(--muted);padding:.3rem .7rem;border:1px solid var(--line);border-radius:999px}
.m-stepper .n{width:1.15rem;height:1.15rem;border-radius:50%;display:grid;place-items:center;font-size:.65rem;font-weight:700;background:var(--panel);color:var(--muted)}
.m-stepper li.now{border-color:var(--brand);color:var(--brand-fg);font-weight:700}
.m-stepper li.now .n{background:var(--sel-bg);color:var(--sel-fg)}
.m-stepper li.done .n{background:var(--ok);color:#fff}
.m-tabs{display:flex;gap:1.25rem;border-bottom:1px solid var(--line);margin-bottom:1.25rem}
.m-tabs span{padding:.5rem 0;font-size:.85rem;font-weight:700;color:var(--muted);border-bottom:2px solid transparent}
.m-tabs span.on{color:var(--brand-fg);border-bottom-color:var(--brand-fg)}
.m-card{border:1px solid var(--line);border-radius:12px;padding:1.1rem;margin-bottom:1.1rem;background:var(--bg)}
.m-card h3{margin:0 0 .9rem;font-size:.95rem;color:var(--brand-fg)}
.m-form{display:grid;grid-template-columns:1fr 1fr;gap:.9rem}
@media (max-width:700px){.m-form{grid-template-columns:1fr}}
.fld{display:flex;flex-direction:column;gap:.3rem}
.fld-full{grid-column:1/-1}
.lbl{font-size:.75rem;font-weight:700;color:var(--ink)}
.req{color:var(--bad);text-decoration:none;margin-left:.15rem}
.ctl{border:1px solid var(--line);border-radius:7px;background:var(--panel);padding:.5rem .6rem;font-size:.82rem;min-height:2.1rem}
.ctl-area{min-height:4.2rem}
.ctl-select{display:flex;justify-content:space-between;align-items:center}
.ctl-file{border-style:dashed;text-align:center;padding:1.1rem}
.ctl-ro{background:transparent;border-color:transparent;padding-left:0;font-weight:600}
.ph{color:var(--muted)}
.caret{color:var(--muted)}
.is-error .ctl{border-color:var(--bad);background:#fdf2f2}
.err{font-size:.72rem;color:var(--bad);font-weight:600}
.help{font-size:.72rem;color:var(--muted)}
.ctl-check{display:flex;align-items:flex-start;gap:.5rem;font-size:.82rem}
.ctl-check .box{width:1rem;height:1rem;border:1px solid var(--line);border-radius:4px;background:var(--panel);flex:none;margin-top:.15rem}
.ctl-check .box.on{background:var(--sel-bg);border-color:var(--sel-bg)}
.ctl-radios{display:flex;flex-wrap:wrap;gap:.9rem;font-size:.82rem}
.radio{display:inline-flex;align-items:center;gap:.35rem}
.radio i{width:.85rem;height:.85rem;border-radius:50%;border:1px solid var(--line);background:var(--panel);display:block}
.radio.on i{border:4px solid var(--sel-bg);background:var(--bg)}
.m-scroll{overflow-x:auto}
.m-table{width:100%;border-collapse:collapse;font-size:.8rem}
.m-table th{text-align:left;font-size:.68rem;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);padding:.5rem .6rem;border-bottom:1px solid var(--line)}
.m-table td{padding:.55rem .6rem;border-bottom:1px solid var(--line)}
.m-table td.empty{text-align:center;color:var(--muted);font-style:italic;padding:1.5rem}
.m-detail{display:grid;grid-template-columns:1fr 1fr;gap:.8rem;margin:0}
@media (max-width:700px){.m-detail{grid-template-columns:1fr}}
.m-detail dt{font-size:.7rem;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);font-weight:700}
.m-detail dd{margin:.15rem 0 0;font-size:.85rem}
.m-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:.8rem}
.m-cards article{border:1px solid var(--line);border-radius:9px;padding:.8rem;background:var(--panel)}
.m-cards h4{margin:0 0 .25rem;font-size:.85rem;color:var(--brand-fg)}
.m-cards .meta{font-size:.7rem;color:var(--muted)}
.m-cards p{margin:.4rem 0 0;font-size:.78rem;color:var(--muted)}
.m-list{margin:0;padding-left:1.1rem;font-size:.85rem}
.m-list li{margin-bottom:.35rem}
.m-timeline{list-style:none;margin:0;padding:0;border-left:2px solid var(--line)}
.m-timeline li{position:relative;padding:0 0 1rem 1rem;font-size:.82rem}
.m-timeline li::before{content:"";position:absolute;left:-5px;top:.45rem;width:8px;height:8px;border-radius:50%;background:var(--brand)}
.m-timeline .when{display:block;font-size:.7rem;color:var(--muted);font-weight:700}
.m-timeline .who{display:block;font-size:.72rem;color:var(--muted)}
.m-buttons{display:flex;flex-wrap:wrap;gap:.5rem;margin-bottom:1.1rem}
.m-ph{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:.4rem;min-height:9rem;
  border:1px dashed var(--line);border-radius:12px;background:var(--panel);color:var(--muted);font-size:.82rem;margin-bottom:1.1rem}
.ph-k{font-size:.62rem;text-transform:uppercase;letter-spacing:.12em;font-weight:700;color:var(--accent-fg)}
.m-note{font-size:.78rem;color:var(--muted);font-style:italic;border-left:3px solid var(--accent-fg);padding-left:.7rem;margin:0 0 1.1rem}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:1rem}
.card-link{display:block;text-decoration:none;color:inherit;background:var(--bg);border:1px solid var(--line);border-radius:12px;padding:1.1rem}
.card-link:hover{border-color:var(--brand);box-shadow:var(--shadow)}
.card-link h3{margin:0 0 .3rem;font-size:1rem;color:var(--brand-fg)}
.card-link .meta{font-size:.75rem;color:var(--muted)}
.card-link p{margin:.5rem 0 0;font-size:.82rem;color:var(--muted)}
footer{padding:1.5rem var(--pad);color:var(--muted);font-size:.78rem;border-top:1px solid var(--line)}
`;
}

// `links` is an array of {href,label} drawn top-right, nearest destination
// first. EVERY page carries a Companion app link — a reviewer who opens a
// single screen from an email must be able to get back to the pack. The hrefs
// are relative so they resolve both from disk (file://) and when the chatbot
// serves the tree under /api/companion-app/<project>/.
function shell(t, title, eyebrow, links, body) {
  const logo = t.logoSrc ? `<img class="logo-img" src="${t.logoSrc}" alt=""/>` : `<span class="logo-text">${esc(t.logoText)}</span>`;
  const nav = links
    .map((l, i) => `<a class="backlink${i === links.length - 1 ? " backlink-home" : ""}" href="${esc(l.href)}">${i === 0 ? "← " : ""}${esc(l.label)}</a>`)
    .join("");
  return `<!doctype html>
<html lang="en-AU"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${esc(title)}</title>
<style>${css(t)}</style></head>
<body>
<header class="top"><div class="top-row">
  ${logo}<div class="rule"></div>
  <div class="titles"><h1>${esc(title)}</h1><div class="eyebrow-sm">${esc(eyebrow)}</div></div>
  <span class="spacer"></span>
  <nav class="backnav" aria-label="Leave this mockup">${nav}</nav>
</div></header>
<main class="wrap">${body}</main>
<footer>Generated by <code>scripts/render-mockups.mjs</code>. Self-contained: no network requests. Wireframes, not final visual design.</footer>
</body></html>`;
}

function screenPage(t, doc, s) {
  const states = s.states;
  const bar = states.length > 1
    ? `<div class="statebar" role="group" aria-label="Screen states">${states.map((st, i) =>
        `<button class="statebtn" type="button" data-state="${esc(st.id)}" aria-pressed="${i === 0}">${esc(str(st.label) || st.id)}</button>`).join("")}</div>`
    : "";
  const panels = states.map((st, i) =>
    `<div class="screen" data-state="${esc(st.id)}"${i === 0 ? "" : " hidden"}>
       <div class="chrome"><i></i><i></i><i></i><span class="url">${esc(str(s.route) || s.name)}</span></div>
       ${st.blocks.map(block).join("\n")}
     </div>`).join("\n");

  const r = s.realises || {};
  const trace = [
    str(s.persona) ? `<span class="chip chip-b">${esc(s.persona)}</span>` : "",
    str(s.surface) ? `<span class="chip">${esc(s.surface)}</span>` : "",
    ...list(r.stories).map((x) => `<span class="chip">Story ${esc(x)}</span>`),
    ...list(r.capabilities).map((x) => `<span class="chip">Capability ${esc(x)}</span>`),
    str(r.journeyStep) ? `<span class="chip">Journey: ${esc(r.journeyStep)}</span>` : "",
  ].filter(Boolean).join("");

  const notes = list(s.notes).length
    ? `<section class="m-card" style="max-width:1100px"><h3>Notes for the reviewer</h3><ul class="m-list">${list(s.notes).map((n) => `<li>${esc(n)}</li>`).join("")}</ul></section>`
    : "";

  const body = `
<div class="eyebrow">${esc(s.id)}</div>
<h2 class="page-h">${esc(s.name)}</h2>
${str(s.purpose) ? `<p class="lede">${esc(s.purpose)}</p>` : ""}
${trace ? `<div class="trace">${trace}</div>` : ""}
${bar}
${panels}
${notes}
<script>
(function(){
  var btns = [].slice.call(document.querySelectorAll(".statebtn"));
  btns.forEach(function(b){
    b.addEventListener("click", function(){
      btns.forEach(function(x){ x.setAttribute("aria-pressed", String(x === b)); });
      [].slice.call(document.querySelectorAll(".screen")).forEach(function(p){
        p.hidden = p.dataset.state !== b.dataset.state;
      });
    });
  });
})();
</script>`;
  return shell(t, s.name, `${doc.project} · ${doc.feature} · mockup`, [
    { href: "index.html", label: "All screens" },
    { href: "../../index.html", label: "Companion app" },
  ], body);
}

function indexPage(t, doc, screens) {
  const cards = screens.map((s) => {
    const r = s.realises || {};
    const meta = [str(s.persona), str(s.surface)].filter(Boolean).join(" · ");
    return `<a class="card-link" href="${esc(slug(s.id))}.html">
      <h3>${esc(s.id)} — ${esc(s.name)}</h3>
      ${meta ? `<span class="meta">${esc(meta)}</span>` : ""}
      ${str(s.purpose) ? `<p>${esc(s.purpose)}</p>` : ""}
      <p class="meta">${s.states.length} state${s.states.length === 1 ? "" : "s"}${list(r.stories).length ? ` · ${list(r.stories).length} stor${list(r.stories).length === 1 ? "y" : "ies"}` : ""}</p>
    </a>`;
  }).join("");
  const body = `
<div class="eyebrow">UI mockups</div>
<h2 class="page-h">${esc(str(doc.title) || `${doc.feature} — UI Mockups`)}</h2>
<p class="lede">${screens.length} screen${screens.length === 1 ? "" : "s"} derived from this feature's requirements, personas, capabilities, data model and test cases. These are wireframes for review — layout and content, not final visual design.</p>
<div class="grid">${cards}</div>`;
  return shell(t, `${doc.feature} — UI Mockups`, `${doc.project} · ${doc.feature}`, [
    { href: "../../index.html", label: "Companion app" },
  ], body);
}

// ---------------------------------------------------------------------- main

async function main() {
  const [project, feature] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  if (!project || !feature) die(`usage: node scripts/render-mockups.mjs <project> <feature>`);
  if (!SAFE_NAME.test(project) || !SAFE_NAME.test(feature)) die(`project and feature must match ${SAFE_NAME}`);

  const featureRoot = path.join(WORKSPACE, "projects", project, feature);
  const src = path.join(featureRoot, "solutions", "UI", "outputs", "mockups.json");
  let doc;
  try { doc = JSON.parse(await fs.readFile(src, "utf8")); }
  catch (e) {
    if (e.code === "ENOENT") die(`not found: ${rel(src)}\nRun the ui-mockup-generator skill first — it writes this file.`);
    die(`${rel(src)} is not valid JSON: ${e.message}`);
  }
  const screens = validate(doc);
  doc.project = str(doc.project) || project;
  doc.feature = str(doc.feature) || feature;

  const theme = await loadTheme(path.join(WORKSPACE, "projects", project));
  const outDir = path.join(WORKSPACE, "generated-apps", project, "mockups", slug(feature));
  await fs.mkdir(outDir, { recursive: true });

  for (const s of screens) {
    await fs.writeFile(path.join(outDir, `${slug(s.id)}.html`), screenPage(theme, doc, s), "utf8");
  }
  await fs.writeFile(path.join(outDir, "index.html"), indexPage(theme, doc, screens), "utf8");

  const personas = [...new Set(screens.map((s) => str(s.persona)).filter(Boolean))];
  const stories = [...new Set(screens.flatMap((s) => list(s.realises?.stories)))];
  console.log(JSON.stringify({
    ok: true,
    index: rel(path.join(outDir, "index.html")),
    screens: screens.length,
    states: screens.reduce((n, s) => n + s.states.length, 0),
    personas,
    storiesCovered: stories.length,
    theme: theme.logoSrc ? { brand: theme.brand, logo: "embedded" } : { brand: theme.brand, logo: "text" },
  }, null, 2));
  console.log(`\n[render-mockups] now re-render the companion app so its UI tab picks these up:\n  node scripts/render-companion-app.mjs ${project}\n`);
}

main().catch((e) => die(e?.stack || e?.message || String(e)));
