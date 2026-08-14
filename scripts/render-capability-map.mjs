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
//         projects/<project>/<feature>/design/style-guides/theme.json  (optional)
// Writes  …/outputs/capability-process.html   (inline CSS + JS + data island;
//                                              zero network requests)
//
// Exits non-zero with the offending file + field when the data is unusable —
// the agent is expected to fix the JSON and re-run rather than hand-write HTML.
//
// UI CONTRACT — this page mirrors the companion-app reference at
// ../companion-app/icwa-social-insurance-solution-guide (React 19 + Tailwind 4 +
// Framer Motion). That app is the house design system; this renderer reproduces
// it in vanilla CSS/JS because the output must stay a single file with no
// network requests, which rules out React, Tailwind's build and a webfont.
// Reproduced deliberately, with the reference's own numbers:
//   * sticky header — logo, rule, title + eyebrow, live count pill with a
//     pulsing accent dot; perspective nav underneath with a sliding underline
//     (the reference's `layoutId` shared-element transition)
//   * w-72 filter sidebar + scrolling main, per the reference's flex shell
//   * L1 section card -> L2 area card grid -> L3 tile, with maturity dots
//   * filters DIM to 30% rather than hiding — the reference's behaviour, so the
//     shape of the map never changes under the reader's hands
//   * motion: 0.2s fade/slide on view switch (exit-then-enter, `mode="wait"`),
//     0.22s accordion height, spring slide-over (damping 26 / stiffness 220,
//     approximated as a 0.36s overshoot curve), chevron rotate, 2s dot pulse
//   * every transition is disabled under prefers-reduced-motion
// Brand comes from the feature's own theme.json, so the reference's ICWA teal
// is not baked in — SAPN renders in SAPN blue, and a feature with no theme
// falls back to the Scyne palette.

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

// ---------------------------------------------------------------------------
// Brand. The companion app reads the same theme.json, so a feature branded once
// looks the same in both. Fallback is the Scyne palette.
// ---------------------------------------------------------------------------
const THEME_FALLBACK = {
  brand: "#464e7e",
  brandDeep: "#363c63",
  accent: "#b4795a",
  logoText: "Scyne",
  logoSrc: "",
  fontFamily: "",
};

async function readTheme(project, feature) {
  const file = path.join(WORKSPACE, "projects", project, feature, "design", "style-guides", "theme.json");
  try {
    const t = JSON.parse(await fs.readFile(file, "utf8"));
    return { ...THEME_FALLBACK, ...t, _file: file };
  } catch {
    return { ...THEME_FALLBACK, _file: null };
  }
}

const HEX = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;
function toRgb(hex) {
  let h = String(hex || "").replace("#", "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const toHex = (rgb) => "#" + rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("");
function relLum(hex) {
  const [r, g, b] = toRgb(hex).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const mix = (a, b, t) => toHex(toRgb(a).map((v, i) => v + (toRgb(b)[i] - v) * t));
// Text colour that stays legible on a brand-coloured surface, whatever the client's palette.
const onBrand = (hex) => (relLum(hex) > 0.45 ? "#0f172a" : "#ffffff");
const safeColour = (v, fallback) => (HEX.test(String(v || "")) ? (String(v).startsWith("#") ? v : "#" + v) : fallback);

function buildTheme(raw) {
  const brand = safeColour(raw.brand, THEME_FALLBACK.brand);
  const brandDeep = safeColour(raw.brandDeep, mix(brand, "#000000", 0.28));
  const accent = safeColour(raw.accent, THEME_FALLBACK.accent);
  return {
    brand,
    brandDeep,
    accent,
    onBrand: onBrand(brand),
    // Dark surfaces need a lifted brand or brand-coloured text disappears.
    brandLight: mix(brand, "#ffffff", 0.55),
    brandDeepLight: mix(brandDeep, "#ffffff", 0.7),
    accentLight: mix(accent, "#ffffff", 0.3),
    logoText: str(raw.logoText) || THEME_FALLBACK.logoText,
    logoSrc: typeof raw.logoSrc === "string" && raw.logoSrc.startsWith("data:") ? raw.logoSrc : "",
    fontFamily: str(raw.fontFamily),
  };
}

// JSON embedded in a <script> must not be able to close the tag early.
const jsonIsland = (data) => JSON.stringify(data).replace(/</g, "\\u003c");
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function renderHtml({ title, project, feature, generatedOn, sources, capabilities, activities, theme }) {
  const data = jsonIsland({ capabilities, activities, sources, project, feature, generatedOn, title });
  const leafCount = capabilities.filter((c) => c.level >= 3).length;
  const phaseCount = [...new Set(activities.map((a) => a.l1))].length;
  // A webfont would be a network request; fall back through the stack instead.
  const fontStack = (theme.fontFamily ? theme.fontFamily + "," : "") +
    'ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif';
  const logo = theme.logoSrc
    ? `<img class="logo-img" src="${esc(theme.logoSrc)}" alt="${esc(theme.logoText)}"/>`
    : `<span class="logo-text">${esc(theme.logoText)}</span>`;

  return `<!doctype html>
<html lang="en-AU">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${esc(title)}</title>
<meta name="description" content="Business capability map and L1/L2/L3 process model for ${esc(project)} / ${esc(feature)}."/>
<style>
:root{
  --brand:${theme.brand}; --brand-deep:${theme.brandDeep}; --accent:${theme.accent};
  --brand-fg:${theme.onBrand};
  --ink:#0f172a; --muted:#64748b; --faint:#94a3b8;
  --line:#e2e8f0; --line-soft:#f1f5f9;
  --bg:#f8fafc; --surface:#ffffff; --panel:#f1f5f9;
  --m-none:#cbd5e1; --m-foundational:#f59e0b; --m-operational:#0e7490;
  --m-optimised:#10b981; --m-transformational:var(--brand-deep);
  --bad:#b3402f;
  --radius:.5rem; --radius-lg:.75rem; --radius-xl:1rem;
  --shadow-sm:0 1px 2px rgba(15,23,42,.06);
  --shadow:0 1px 3px rgba(15,23,42,.08),0 8px 24px rgba(15,23,42,.06);
  --shadow-lg:0 10px 40px rgba(15,23,42,.18);
  --sidebar:18rem; --header-h:8.25rem;
  --dur-view:.2s; --dur-acc:.22s; --dur-slide:.36s;
  --ease-spring:cubic-bezier(.17,.89,.32,1.06);
}
@media (prefers-color-scheme: dark){
  :root:not([data-theme="light"]){
    --brand:${theme.brandLight}; --brand-deep:${theme.brandDeepLight}; --accent:${theme.accentLight};
    --brand-fg:#0b1220;
    --ink:#e2e8f0; --muted:#94a3b8; --faint:#64748b;
    --line:#1e293b; --line-soft:#172033;
    --bg:#020617; --surface:#0f172a; --panel:#1e293b;
    --m-none:#475569; --m-foundational:#fbbf24; --m-operational:#22d3ee;
    --m-optimised:#34d399; --m-transformational:${theme.brandDeepLight};
    --bad:#f87171;
    --shadow-sm:0 1px 2px rgba(0,0,0,.5);
    --shadow:0 1px 3px rgba(0,0,0,.6),0 8px 24px rgba(0,0,0,.45);
    --shadow-lg:0 10px 40px rgba(0,0,0,.7);
  }
}
:root[data-theme="dark"]{
  --brand:${theme.brandLight}; --brand-deep:${theme.brandDeepLight}; --accent:${theme.accentLight};
  --brand-fg:#0b1220;
  --ink:#e2e8f0; --muted:#94a3b8; --faint:#64748b;
  --line:#1e293b; --line-soft:#172033;
  --bg:#020617; --surface:#0f172a; --panel:#1e293b;
  --m-none:#475569; --m-foundational:#fbbf24; --m-operational:#22d3ee;
  --m-optimised:#34d399; --m-transformational:${theme.brandDeepLight};
  --bad:#f87171;
  --shadow-sm:0 1px 2px rgba(0,0,0,.5);
  --shadow:0 1px 3px rgba(0,0,0,.6),0 8px 24px rgba(0,0,0,.45);
  --shadow-lg:0 10px 40px rgba(0,0,0,.7);
}
*{box-sizing:border-box}
html,body{margin:0;padding:0;height:100%}
body{
  background:var(--bg); color:var(--ink);
  font:15px/1.6 ${fontStack};
  -webkit-font-smoothing:antialiased;
  display:flex; flex-direction:column;
  transition:background-color .2s ease,color .2s ease;
}
h1,h2,h3,h4{margin:0;letter-spacing:-.01em}
button{font:inherit;color:inherit}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:4px}
.tnum{font-variant-numeric:tabular-nums}
.skip{position:absolute;left:-9999px;top:0;background:var(--brand);color:var(--brand-fg);padding:.6rem 1rem;z-index:99;border-radius:0 0 var(--radius) 0}
.skip:focus{left:0;top:0}

/* ---------- header ---------- */
header.top{
  background:var(--surface);border-bottom:1px solid var(--line);
  box-shadow:var(--shadow-sm);position:sticky;top:0;z-index:30;flex-shrink:0;
  transition:background-color .2s ease,border-color .2s ease;
}
.top-row{height:4rem;display:flex;align-items:center;gap:1rem;padding:0 1.5rem}
.brandmark{display:flex;align-items:center;gap:.75rem;min-width:0}
.logo-img{height:2.5rem;width:auto;display:block;border-radius:.375rem}
/* Client logos are drawn for a light background — SAPN's wordmark is near-black.
   On a dark surface give the artwork its own light plate rather than filtering
   it, which would destroy the brand colours inside the mark. */
@media (prefers-color-scheme: dark){
  :root:not([data-theme="light"]) .logo-img{background:#fff;padding:.25rem .375rem}
}
:root[data-theme="dark"] .logo-img{background:#fff;padding:.25rem .375rem}
.logo-text{font-weight:800;font-size:1.05rem;color:var(--brand-deep);letter-spacing:.02em}
.rule{height:2rem;width:1px;background:var(--line);flex-shrink:0}
.titles{min-width:0}
.titles h1{font-size:1.25rem;font-weight:700;color:var(--brand-deep);line-height:1.1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.eyebrow-sm{font-size:.625rem;text-transform:uppercase;letter-spacing:.2em;font-weight:700;color:var(--faint);margin-top:.25rem}
.count-pill{
  display:inline-flex;align-items:center;gap:.375rem;flex-shrink:0;
  padding:.15rem .625rem;border-radius:999px;font-size:.75rem;font-weight:700;
  background:color-mix(in srgb,var(--brand) 8%,transparent);color:var(--brand-deep);
}
.dot-pulse{width:.375rem;height:.375rem;border-radius:999px;background:var(--accent);animation:pulse 2s cubic-bezier(.4,0,.6,1) infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
.spacer{flex:1}
.iconbtn{
  display:inline-flex;align-items:center;gap:.5rem;padding:.375rem .75rem;border-radius:var(--radius);
  background:transparent;border:1px solid var(--line);color:var(--muted);cursor:pointer;
  font-size:.8rem;font-weight:600;transition:color .15s ease,background-color .15s ease,border-color .15s ease;
}
.iconbtn:hover{color:var(--brand-deep);background:var(--panel)}
.iconbtn svg{width:16px;height:16px;stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}

/* perspective nav — sliding underline stands in for the reference's layoutId */
nav.perspectives{display:flex;align-items:center;gap:2rem;padding:0 1.5rem;position:relative;overflow-x:auto;scrollbar-width:none}
nav.perspectives::-webkit-scrollbar{display:none}
.pbtn{position:relative;padding:.5rem 0 .625rem;background:none;border:0;cursor:pointer;white-space:nowrap;display:flex;align-items:center;gap:.5rem}
.pbtn .lbl{font-size:.875rem;font-weight:700;letter-spacing:-.01em;color:var(--faint);transition:color .15s ease}
.pbtn:hover .lbl{color:var(--muted)}
.pbtn[aria-selected="true"] .lbl{color:var(--brand-deep)}
.pbtn .badge{font-size:.625rem;font-weight:700;padding:.05rem .375rem;border-radius:999px;background:var(--panel);border:1px solid var(--line);color:var(--faint)}
#underline{position:absolute;bottom:0;height:2px;background:var(--brand-deep);border-radius:999px;transition:transform .28s var(--ease-spring),width .28s var(--ease-spring);transform-origin:left}

/* ---------- shell ---------- */
.shell{display:flex;flex:1;min-height:0}
aside.filters{
  width:var(--sidebar);flex-shrink:0;background:var(--surface);border-right:1px solid var(--line);
  overflow-y:auto;padding-bottom:2rem;
}
/* The reference carries a sidebar on the capability perspective only; Process
   navigates by drill-down instead, so the filters would be dead weight there. */
body:not([data-view="capabilities"]) aside.filters,
body:not([data-view="capabilities"]) #filtersBtn{display:none}
.filters-head{
  position:sticky;top:0;z-index:10;background:color-mix(in srgb,var(--surface) 85%,transparent);
  backdrop-filter:blur(8px);padding:.875rem 1rem;border-bottom:1px solid var(--line);
  display:flex;align-items:center;gap:.5rem;font-weight:700;font-size:.9rem;
}
.filters-head svg{width:18px;height:18px;stroke:var(--brand);fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.fgroup{padding:1rem;border-bottom:1px solid var(--line-soft)}
.fgroup > h4{font-size:.7rem;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:var(--muted);margin-bottom:.625rem}
.search-wrap{position:relative}
.search-wrap svg{position:absolute;left:.625rem;top:50%;transform:translateY(-50%);width:15px;height:15px;stroke:var(--faint);fill:none;stroke-width:2}
input[type="search"],select{
  width:100%;font:inherit;font-size:.85rem;padding:.5rem .625rem;border:1px solid var(--line);
  border-radius:var(--radius);background:var(--bg);color:var(--ink);
}
input[type="search"]{padding-left:2rem}
input[type="search"]::-webkit-search-cancel-button{cursor:pointer}
.check{display:flex;align-items:flex-start;gap:.5rem;padding:.25rem 0;font-size:.8rem;cursor:pointer;color:var(--muted);line-height:1.4}
.check:hover{color:var(--ink)}
.check input{margin:.2rem 0 0;accent-color:var(--brand);flex-shrink:0}
.fgroup .sub{font-size:.7rem;color:var(--faint);margin-top:.625rem}
.fsection{
  display:flex;align-items:center;justify-content:space-between;width:100%;padding:0 0 .5rem;
  background:none;border:0;cursor:pointer;font-size:.8rem;font-weight:700;
  text-transform:uppercase;letter-spacing:.08em;color:var(--brand-deep);
}
.fsection .chev{width:16px;height:16px;stroke:var(--muted);fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;transition:transform .2s ease}
.fsection[aria-expanded="false"] .chev{transform:rotate(-90deg)}
/* dashed, like the reference's clear-filters control */
.clear{
  width:100%;padding:.5rem .75rem;border:1px dashed var(--line);border-radius:var(--radius);
  background:none;color:var(--muted);cursor:pointer;font-size:.8rem;font-weight:600;
  transition:color .15s ease,border-color .15s ease;
}
.clear:hover{color:var(--brand-deep);border-color:var(--brand)}
.covfilters{display:flex;gap:.5rem;flex-wrap:wrap}
.covfilters select{width:auto;min-width:9rem;font-size:.75rem}
.sidebar-toggle{display:none}

main{flex:1;min-width:0;overflow-y:auto;padding:1.5rem 2rem 4rem}
.view[hidden]{display:none}
@keyframes viewIn{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}
@keyframes viewOut{from{opacity:1;transform:none}to{opacity:0;transform:translateY(-10px)}}
.view-in{animation:viewIn var(--dur-view) ease}
.view-out{animation:viewOut var(--dur-view) ease forwards}
.inner{max-width:1400px;margin:0 auto}

/* ---------- panel headings ---------- */
.phead{display:flex;align-items:flex-end;justify-content:space-between;flex-wrap:wrap;gap:.75rem;margin-bottom:1.25rem}
.eyebrow{display:flex;align-items:center;gap:.5rem;margin-bottom:.25rem}
.eyebrow i{width:1.5rem;height:2px;background:var(--accent);display:block}
.eyebrow span{font-size:.625rem;font-weight:700;text-transform:uppercase;letter-spacing:.25em;color:var(--accent)}
.phead h2{font-size:1.5rem;font-weight:700;color:var(--brand-deep)}
.legend{display:flex;align-items:center;gap:.625rem;flex-wrap:wrap;padding:.375rem .75rem;background:var(--surface);border:1px solid var(--line);border-radius:var(--radius)}
.legend .cap{font-size:.625rem;font-weight:700;color:var(--faint);text-transform:uppercase;letter-spacing:.1em}
.legend span.it{display:inline-flex;align-items:center;gap:.3rem;font-size:.68rem;color:var(--muted);font-weight:500}
.dot{width:.5rem;height:.5rem;border-radius:999px;flex-shrink:0}
.m-None{background:var(--m-none)}.m-Foundational{background:var(--m-foundational)}
.m-Operational{background:var(--m-operational)}.m-Optimised{background:var(--m-optimised)}
.m-Transformational{background:var(--m-transformational)}

/* ---------- L1 section / L2 area / L3 tile ---------- */
.sections{display:flex;flex-direction:column;gap:1rem}
section.domain{border:1px solid var(--line);border-radius:var(--radius-xl);background:var(--surface);box-shadow:var(--shadow-sm);overflow:hidden}
.domain-head{
  width:100%;display:flex;align-items:center;gap:.75rem;padding:.875rem 1.25rem;text-align:left;
  background:color-mix(in srgb,var(--brand) 4%,transparent);border:0;cursor:pointer;transition:background-color .15s ease;
}
.domain-head:hover{background:color-mix(in srgb,var(--brand) 8%,transparent)}
.dbadge{
  width:1.75rem;height:1.75rem;border-radius:var(--radius);background:var(--brand);color:var(--brand-fg);
  display:grid;place-items:center;font-size:.75rem;font-weight:700;flex-shrink:0;
}
.domain-head .txt{flex:1;min-width:0}
.domain-head h3{font-size:.875rem;font-weight:700;color:var(--brand-deep)}
.domain-head p{margin:.1rem 0 0;font-size:.75rem;color:var(--faint);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.domain-head .n{font-size:.7rem;font-weight:600;color:var(--faint);flex-shrink:0}
.chev{width:18px;height:18px;stroke:var(--faint);fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;flex-shrink:0;transition:transform .22s ease}
.domain-head[aria-expanded="false"] .chev{transform:rotate(-90deg)}
.acc{overflow:hidden}
.areas{padding:1rem;display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:.75rem}
.area{border:1px solid var(--line);border-radius:var(--radius-lg);background:color-mix(in srgb,var(--panel) 60%,transparent);overflow:hidden;display:flex;flex-direction:column}
.area-head{padding:.5rem .75rem;border-bottom:1px solid var(--line);background:var(--surface)}
.area-head .id{font-size:.625rem;font-weight:700;color:var(--faint)}
.area-head .nm{font-size:.75rem;font-weight:700;color:var(--brand-deep);line-height:1.25}
.tiles{padding:.5rem;display:flex;flex-direction:column;gap:.375rem;flex:1}
.tile{
  text-align:left;border:1px solid var(--line);border-radius:var(--radius);padding:.5rem .625rem;
  background:var(--surface);cursor:pointer;width:100%;
  transition:border-color .15s ease,box-shadow .15s ease,opacity .2s ease,transform .15s ease;
}
.tile:hover{border-color:color-mix(in srgb,var(--brand) 40%,transparent);box-shadow:var(--shadow-sm)}
.tile[aria-pressed="true"]{border-color:var(--brand);box-shadow:0 0 0 2px var(--brand)}
.tile.dim{opacity:.3}
.tile .row1{display:flex;align-items:flex-start;gap:.375rem}
.tile .tid{font-size:.5625rem;font-weight:700;color:var(--faint);margin-top:.15rem;flex-shrink:0}
.tile .tnm{font-size:.6875rem;font-weight:600;line-height:1.35;flex:1}
.tile .row2{display:flex;align-items:center;gap:.375rem;margin-top:.375rem;padding-left:1.125rem;flex-wrap:wrap}
.tile .mat{font-size:.5625rem;font-weight:500;color:var(--faint)}
/* Stage names are lifecycle phases and can be long; wrap to their own line and
   ellipsis rather than spilling out of a narrow tile. */
.tile .stagechip{
  margin-left:auto;font-size:.5rem;font-weight:700;text-transform:uppercase;letter-spacing:.05em;
  color:color-mix(in srgb,var(--brand-deep) 70%,transparent);background:color-mix(in srgb,var(--brand) 6%,transparent);
  padding:.1rem .375rem;border-radius:.25rem;white-space:nowrap;
  max-width:100%;min-width:0;overflow:hidden;text-overflow:ellipsis;
}

/* ---------- process: three-level drill-down (phases -> steps -> activities) ---------- */
.crumbs{display:flex;align-items:center;gap:.375rem;flex-wrap:wrap;font-size:.875rem;margin-bottom:1.5rem}
.crumb{padding:.25rem .5rem;border-radius:.375rem;border:0;background:none;font-weight:600;cursor:pointer;
  color:var(--faint);transition:color .15s ease,background-color .15s ease;max-width:16rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.crumb:hover:not(:disabled){color:var(--brand-deep);background:var(--panel)}
.crumb:disabled{color:var(--brand-deep);cursor:default}
.crumbs .sep{width:14px;height:14px;stroke:var(--line);fill:none;stroke-width:2;stroke-linecap:round;flex-shrink:0}
.backbtn{display:inline-flex;align-items:center;gap:.375rem;background:none;border:0;padding:0;cursor:pointer;
  font-size:.75rem;font-weight:600;color:var(--muted);margin-bottom:1rem;transition:color .15s ease}
.backbtn:hover{color:var(--brand-deep)}
.backbtn svg{width:14px;height:14px;stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.lvlhead{margin-bottom:1.5rem}
.lvlhead h2{font-size:1.5rem;font-weight:700;color:var(--brand-deep)}
.lvlhead p{margin:.25rem 0 0;font-size:.875rem;color:var(--faint)}

/* Reference caps the drill-down at 3 / 2 columns inside max-w-7xl. */
#view-process .inner{max-width:80rem}
.grid3{display:grid;grid-template-columns:1fr;gap:1rem}
.grid2{display:grid;grid-template-columns:1fr;gap:1rem}
@media (min-width:640px){.grid3,.grid2{grid-template-columns:repeat(2,1fr)}}
@media (min-width:1024px){.grid3{grid-template-columns:repeat(3,1fr)}}
.stack{display:flex;flex-direction:column;gap:.75rem}

.phasecard{
  text-align:left;background:var(--surface);border:1px solid var(--line);border-radius:var(--radius-xl);
  padding:1.25rem;cursor:pointer;width:100%;
  transition:border-color .2s ease,box-shadow .2s ease,transform .2s ease;
}
.phasecard:hover{border-color:color-mix(in srgb,var(--brand) 40%,transparent);box-shadow:var(--shadow);transform:translateY(-2px)}
.phasecard .top{display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:1rem}
.icontile{
  width:2.75rem;height:2.75rem;border-radius:var(--radius-lg);display:grid;place-items:center;
  background:color-mix(in srgb,var(--brand) 8%,transparent);color:var(--brand);
  transition:background-color .2s ease,color .2s ease;
}
.phasecard:hover .icontile{background:var(--brand);color:var(--brand-fg)}
.icontile svg{width:22px;height:22px;stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.seqno{font-size:.6875rem;font-weight:700;color:var(--line)}
.phasecard h3{font-size:1rem;font-weight:700;color:var(--brand-deep);line-height:1.35;margin-bottom:.75rem}
.cardmeta{display:flex;align-items:center;gap:.75rem;font-size:.75rem;color:var(--faint);font-weight:500}
.cardmeta .bullet{width:.25rem;height:.25rem;border-radius:999px;background:var(--line)}
.go{width:15px;height:15px;margin-left:auto;stroke:var(--line);fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;transition:stroke .2s ease,transform .2s ease}
.phasecard:hover .go,.stepcard:hover .go{stroke:var(--accent);transform:translateX(2px)}

.stepcard{
  text-align:left;background:var(--surface);border:1px solid var(--line);border-radius:var(--radius-lg);
  padding:1.25rem;cursor:pointer;width:100%;display:flex;align-items:center;gap:1rem;
  transition:border-color .2s ease,box-shadow .2s ease;
}
.stepcard:hover{border-color:color-mix(in srgb,var(--accent) 50%,transparent);box-shadow:var(--shadow-sm)}
.stepnum{
  width:2.25rem;height:2.25rem;border-radius:var(--radius);flex-shrink:0;display:grid;place-items:center;
  background:color-mix(in srgb,var(--accent) 10%,transparent);color:var(--accent);font-size:.875rem;font-weight:700;
}
.stepcard .txt{flex:1;min-width:0}
.stepcard h3{font-size:.875rem;font-weight:700;color:var(--brand-deep);line-height:1.35}
.stepcard p{margin:.125rem 0 0;font-size:.75rem;color:var(--faint)}

.actcard{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius-lg);padding:1.25rem}
.actcard .head{display:flex;align-items:flex-start;gap:.75rem;margin-bottom:.5rem}
.actnum{
  width:1.5rem;height:1.5rem;border-radius:.375rem;flex-shrink:0;margin-top:.1rem;display:grid;place-items:center;
  background:color-mix(in srgb,var(--brand) 8%,transparent);color:var(--brand);font-size:.6875rem;font-weight:700;
}
.actcard h3{font-size:.875rem;font-weight:700;color:var(--brand-deep);line-height:1.35;flex:1}
.actcard .desc{font-size:.875rem;color:var(--muted);line-height:1.6;margin:0 0 .75rem;padding-left:2.25rem}
.actchips{display:flex;flex-wrap:wrap;align-items:center;gap:.5rem;padding-left:2.25rem}
.metagrid{margin-top:.75rem;padding-left:2.25rem;display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:.75rem}
.meta{display:flex;align-items:flex-start;gap:.5rem;font-size:.75rem}
.meta > svg{width:13px;height:13px;margin-top:.15rem;stroke:var(--faint);fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;flex-shrink:0}
.meta .k{font-size:.625rem;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--faint)}
.meta .v{color:var(--muted);line-height:1.4}
.chip{
  display:inline-flex;align-items:center;gap:.25rem;font-size:.6875rem;font-weight:600;
  padding:.125rem .5rem;border-radius:999px;border:1px solid var(--line);color:var(--muted);background:var(--panel);
}
.chip svg{width:11px;height:11px;stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.chip.a-Client{background:color-mix(in srgb,#0e7490 15%,transparent);color:#0e7490;border-color:color-mix(in srgb,#0e7490 30%,transparent)}
.chip.a-Front{background:color-mix(in srgb,var(--accent) 15%,transparent);color:var(--accent);border-color:color-mix(in srgb,var(--accent) 30%,transparent)}
.chip.a-Back{background:color-mix(in srgb,var(--brand) 10%,transparent);color:var(--brand-deep);border-color:color-mix(in srgb,var(--brand) 25%,transparent)}
.chip.a-Third{background:color-mix(in srgb,#7c3aed 12%,transparent);color:#7c3aed;border-color:color-mix(in srgb,#7c3aed 30%,transparent)}
:root[data-theme="dark"] .chip.a-Third{color:#c4b5fd}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]) .chip.a-Third{color:#c4b5fd}
  :root:not([data-theme="light"]) .chip.a-Client{color:#22d3ee;border-color:color-mix(in srgb,#22d3ee 30%,transparent);background:color-mix(in srgb,#22d3ee 12%,transparent)}}
:root[data-theme="dark"] .chip.a-Client{color:#22d3ee;border-color:color-mix(in srgb,#22d3ee 30%,transparent);background:color-mix(in srgb,#22d3ee 12%,transparent)}
.chip.cap{cursor:pointer;transition:background-color .15s ease,border-color .15s ease}
.chip.cap:hover{border-color:var(--brand);background:color-mix(in srgb,var(--brand) 10%,transparent)}
/* drill-down enter: phases rise, deeper levels slide in from the right */
@keyframes lvlUp{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:none}}
@keyframes lvlIn{from{opacity:0;transform:translateX(24px)}to{opacity:1;transform:none}}
@keyframes cardIn{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}
.lvl-up{animation:lvlUp .22s ease}
.lvl-in{animation:lvlIn .22s ease}
.stagger > *{animation:cardIn .28s ease backwards}

/* ---------- tables ---------- */
.tablecard{border:1px solid var(--line);border-radius:var(--radius-xl);background:var(--surface);box-shadow:var(--shadow-sm);overflow:hidden}
.scroller{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:.8125rem}
th,td{text-align:left;padding:.625rem .875rem;border-bottom:1px solid var(--line-soft);vertical-align:top}
th{font-size:.65rem;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);background:var(--panel);position:sticky;top:0;z-index:1;font-weight:700}
tbody tr{transition:background-color .12s ease,opacity .2s ease}
tbody tr:hover{background:color-mix(in srgb,var(--brand) 4%,transparent)}
tbody tr.dim{opacity:.3}
tr:last-child td{border-bottom:0}
td.num{font-weight:700;color:var(--brand-deep)}
.gapflag{color:var(--bad);font-weight:700}
.linkish{background:none;border:0;padding:0;cursor:pointer;color:var(--brand-deep);font-weight:600;text-align:left;text-decoration:underline;text-underline-offset:2px}

/* ---------- stats ---------- */
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:.75rem;margin-bottom:1.25rem}
.stat{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius-lg);padding:.75rem 1rem;box-shadow:var(--shadow-sm)}
.stat b{display:block;font-size:1.5rem;font-weight:800;color:var(--brand-deep);line-height:1.2}
.stat span{font-size:.625rem;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);font-weight:600}

/* ---------- slide-over ---------- */
.slideover{position:fixed;inset:0;z-index:50;pointer-events:none}
.slideover[hidden]{display:none}
.so-back{position:absolute;inset:0;background:rgba(15,23,42,.4);backdrop-filter:blur(4px);opacity:0;transition:opacity .25s ease;pointer-events:auto;border:0;width:100%;cursor:pointer}
.so-panel{
  position:absolute;right:0;top:0;bottom:0;width:min(100%,42rem);display:flex;flex-direction:column;
  background:var(--surface);border-left:1px solid var(--line);box-shadow:var(--shadow-lg);
  transform:translateX(100%);transition:transform var(--dur-slide) var(--ease-spring);pointer-events:auto;
}
.slideover.open .so-back{opacity:1}
.slideover.open .so-panel{transform:translateX(0)}
.so-head{
  display:flex;align-items:flex-start;justify-content:space-between;gap:1rem;padding:1.25rem 1.5rem;
  border-bottom:1px solid var(--line);position:sticky;top:0;
  background:color-mix(in srgb,var(--surface) 85%,transparent);backdrop-filter:blur(12px);z-index:10;
}
.so-head .ey{font-size:.625rem;font-weight:700;text-transform:uppercase;letter-spacing:.2em;color:var(--accent);display:block;margin-bottom:.25rem}
.so-head h2{font-size:1.0625rem;font-weight:700;color:var(--brand-deep);line-height:1.25}
.so-close{background:none;border:0;padding:.5rem;margin:-.5rem -.5rem 0 0;border-radius:999px;cursor:pointer;color:var(--muted);transition:background-color .15s ease}
.so-close:hover{background:var(--panel)}
.so-close svg{width:22px;height:22px;stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round}
.so-body{flex:1;overflow-y:auto;padding:1.5rem}
.so-body h4{font-size:.65rem;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:var(--muted);margin:1.25rem 0 .5rem}
.so-body h4:first-child{margin-top:0}
.so-body p{margin:0 0 .75rem;font-size:.875rem}
.so-body ul{margin:0;padding-left:1.1rem;font-size:.8125rem}
.so-body li{margin-bottom:.3rem}
.kv{display:grid;grid-template-columns:auto 1fr;gap:.375rem .875rem;font-size:.8125rem}
.kv dt{color:var(--muted);font-weight:600}
.kv dd{margin:0}
.solist{display:flex;flex-direction:column;gap:.375rem}
.solink{
  text-align:left;width:100%;border:1px solid var(--line);border-radius:var(--radius);background:var(--bg);
  padding:.5rem .625rem;cursor:pointer;font-size:.75rem;transition:border-color .15s ease,background-color .15s ease;
}
.solink:hover{border-color:var(--brand);background:color-mix(in srgb,var(--brand) 6%,transparent)}
.solink b{display:block;font-size:.8125rem;font-weight:600;margin-bottom:.1rem}
.empty{color:var(--muted);font-size:.8125rem;font-style:italic}

@media (max-width:1024px){
  .sidebar-toggle{display:inline-flex}
  aside.filters{
    position:fixed;inset-y:0;left:0;top:0;bottom:0;z-index:40;
    transform:translateX(-100%);transition:transform .25s ease;box-shadow:var(--shadow-lg);
  }
  body.filters-open aside.filters{transform:translateX(0)}
  main{padding:1.25rem 1rem 4rem}
  .titles h1{font-size:1rem}
}
@media (max-width:640px){
  .eyebrow-sm,.count-pill{display:none}
  nav.perspectives{gap:1.25rem}
}
@media print{
  header.top,aside.filters,.slideover,.legend,.iconbtn{display:none!important}
  .view[hidden]{display:block!important}
  .acc{height:auto!important}
  main{overflow:visible;padding:0}
  body{background:#fff}
}
@media (prefers-reduced-motion: reduce){
  *,*::before,*::after{animation-duration:.001ms!important;animation-iteration-count:1!important;transition-duration:.001ms!important}
}
</style>
</head>
<body>
<a class="skip" href="#main">Skip to content</a>

<header class="top">
  <div class="top-row">
    <div class="brandmark">${logo}<div class="rule" aria-hidden="true"></div>
      <div class="titles">
        <h1>${esc(title)}</h1>
        <div class="eyebrow-sm">Capabilities · Process · Coverage</div>
      </div>
    </div>
    <span class="count-pill tnum" id="countPill"><i class="dot-pulse" aria-hidden="true"></i><span id="countLabel">${leafCount} capabilities</span></span>
    <span class="spacer"></span>
    <button class="iconbtn sidebar-toggle" id="filtersBtn" aria-label="Show filters">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M7 12h10M10 18h4"/></svg><span>Filters</span>
    </button>
    <button class="iconbtn" id="themeBtn" aria-label="Switch to dark theme">
      <svg id="themeIcon" viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>
      <span id="themeLabel">Dark</span>
    </button>
  </div>
  <nav class="perspectives" role="tablist" aria-label="Perspectives">
    <button class="pbtn" role="tab" id="tab-capabilities" aria-controls="view-capabilities" aria-selected="true" data-view="capabilities">
      <span class="lbl">Capabilities</span><span class="badge tnum">${leafCount}</span></button>
    <button class="pbtn" role="tab" id="tab-process" aria-controls="view-process" aria-selected="false" data-view="process">
      <span class="lbl">Process</span><span class="badge tnum">${activities.length}</span></button>
    <button class="pbtn" role="tab" id="tab-coverage" aria-controls="view-coverage" aria-selected="false" data-view="coverage">
      <span class="lbl">Coverage</span></button>
    <button class="pbtn" role="tab" id="tab-sources" aria-controls="view-sources" aria-selected="false" data-view="sources">
      <span class="lbl">Sources</span><span class="badge tnum">${sources.length}</span></button>
    <span id="underline" aria-hidden="true"></span>
  </nav>
</header>

<div class="shell">
  <aside class="filters" id="filters" aria-label="Filters">
    <div class="filters-head">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 5h18l-7 8v6l-4 2v-8z"/></svg><span>Filters</span>
    </div>
    <div class="fgroup">
      <div class="search-wrap">
        <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>
        <input type="search" id="q" placeholder="Search capabilities…" aria-label="Search capabilities" autocomplete="off"/>
      </div>
    </div>
    <div class="fgroup">
      <button class="fsection" id="domainToggle" aria-expanded="true" aria-controls="domainChecks">
        <span>Domain</span>
        <svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>
      </button>
      <div id="domainChecks"></div>
    </div>
    <div class="fgroup">
      <button class="clear" id="clearBtn">Clear all filters</button>
      <p class="sub" id="matchNote">Non-matching rows dim rather than disappear.</p>
    </div>
  </aside>

  <main id="main">
    <div class="view" id="view-capabilities" role="tabpanel" aria-labelledby="tab-capabilities"><div class="inner">
      <div class="phead">
        <div>
          <div class="eyebrow"><i></i><span>${esc(project)} Business Capability Map</span></div>
          <h2>Capabilities</h2>
        </div>
        <div class="legend">
          <span class="cap">Current maturity</span>
          <span class="it"><i class="dot m-None"></i>None</span>
          <span class="it"><i class="dot m-Foundational"></i>Foundational</span>
          <span class="it"><i class="dot m-Operational"></i>Operational</span>
          <span class="it"><i class="dot m-Optimised"></i>Optimised</span>
        </div>
      </div>
      <div class="sections" id="capSections"></div>
    </div></div>

    <div class="view" id="view-process" role="tabpanel" aria-labelledby="tab-process" hidden><div class="inner">
      <nav class="crumbs" id="crumbs" aria-label="Process breadcrumb"></nav>
      <div id="procLevel"></div>
    </div></div>

    <div class="view" id="view-coverage" role="tabpanel" aria-labelledby="tab-coverage" hidden><div class="inner">
      <div class="phead">
        <div>
          <div class="eyebrow"><i></i><span>Capability ↔ Process</span></div>
          <h2>Coverage</h2>
        </div>
        <div class="covfilters">
          <select id="fMaturity" aria-label="Filter by current maturity"><option value="">All maturity</option></select>
          <select id="fGap" aria-label="Filter by maturity gap">
            <option value="">All gaps</option><option value="0">No gap</option>
            <option value="1">1 step</option><option value="2">2 steps</option><option value="3">3+ steps</option>
          </select>
          <select id="fCoverage" aria-label="Filter by process coverage">
            <option value="">All coverage</option><option value="rich">Rich — 3+ activities</option>
            <option value="partial">Partial — 1–2</option><option value="gap">No process evidence</option>
          </select>
        </div>
      </div>
      <div class="stats" id="covStats"></div>
      <div class="tablecard"><div class="scroller"><table>
        <thead><tr><th>ID</th><th>Capability</th><th>Current</th><th>Target</th><th>Activities</th><th>Coverage</th></tr></thead>
        <tbody id="covBody"></tbody>
      </table></div></div>
    </div></div>

    <div class="view" id="view-sources" role="tabpanel" aria-labelledby="tab-sources" hidden><div class="inner">
      <div class="phead">
        <div>
          <div class="eyebrow"><i></i><span>Evidence base</span></div>
          <h2>Sources</h2>
        </div>
      </div>
      <div class="tablecard"><div class="scroller"><table>
        <thead><tr><th>Source document</th><th>Capabilities</th><th>Activities</th></tr></thead>
        <tbody id="srcBody"></tbody>
      </table></div></div>
    </div></div>
  </main>
</div>

<div class="slideover" id="slideover" hidden>
  <button class="so-back" id="soBack" aria-label="Close panel" tabindex="-1"></button>
  <div class="so-panel" role="dialog" aria-modal="true" aria-labelledby="soTitle">
    <div class="so-head">
      <div><span class="ey" id="soEyebrow"></span><h2 id="soTitle"></h2></div>
      <button class="so-close" id="soClose" aria-label="Close">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6L6 18M6 6l12 12"/></svg>
      </button>
    </div>
    <div class="so-body" id="soBody"></div>
  </div>
</div>

<script id="data" type="application/json">${data}</script>
<script>
(function(){
"use strict";
var D = JSON.parse(document.getElementById("data").textContent);
var CAPS = D.capabilities, ACTS = D.activities;
var MATURITY = ${JSON.stringify(MATURITY)};
var reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
var $ = function(id){ return document.getElementById(id); };
function el(tag, cls, text){ var n=document.createElement(tag); if(cls) n.className=cls; if(text!=null) n.textContent=text; return n; }

// ---- indexes -------------------------------------------------------------
var byId={}, children={}, actsFor={};
CAPS.forEach(function(c){ byId[c.id]=c; (children[c.parentId||"__root"]=children[c.parentId||"__root"]||[]).push(c); });
ACTS.forEach(function(a,i){ a._i=i; a.capabilityIds.forEach(function(id){ (actsFor[id]=actsFor[id]||[]).push(a); }); });
var L1 = children["__root"]||[];
var leaves = CAPS.filter(function(c){ return c.level>=3; });
var phases = []; ACTS.forEach(function(a){ if(phases.indexOf(a.l1)<0) phases.push(a.l1); });
var uniq = function(arr){ var s=[]; arr.forEach(function(v){ if(v && s.indexOf(v)<0) s.push(v); }); return s.sort(); };
var maturities = uniq(leaves.map(function(c){return c.currentMaturity;}))
  .sort(function(a,b){ return MATURITY.indexOf(a)-MATURITY.indexOf(b); });
var descOf = function(id){ var out=[]; (children[id]||[]).forEach(function(c){ out.push(c); out=out.concat(descOf(c.id)); }); return out; };
var gapOf = function(c){
  var g = MATURITY.indexOf(c.targetMaturity) - MATURITY.indexOf(c.currentMaturity);
  return (c.currentMaturity && c.targetMaturity && g>0) ? g : 0;
};
var covOf = function(id){ var n=(actsFor[id]||[]).length; return n>=3?"rich":n>=1?"partial":"gap"; };

// ---- filters -------------------------------------------------------------
// Search + domain drive the capability map (the reference's sidebar); the
// maturity/gap/coverage cuts are analytical and live on the Coverage table.
var F = { q:"", domains:[], maturity:"", gap:"", coverage:"" };
function hay(){ return Array.prototype.join.call(arguments," ").toLowerCase(); }
function capMatches(c){
  if(F.domains.length && F.domains.indexOf(c.id.split(".")[0]+".0")<0) return false;
  if(F.q && hay(c.id,c.name,c.description,c.stage,c.sourceDocs.join(" ")).indexOf(F.q)<0) return false;
  return true;
}
function covMatches(c){
  if(!capMatches(c)) return false;
  if(F.maturity && c.currentMaturity!==F.maturity) return false;
  if(F.gap!==""){ var g=gapOf(c); if(F.gap==="3" ? g<3 : g!==+F.gap) return false; }
  if(F.coverage && covOf(c.id)!==F.coverage) return false;
  return true;
}
var mapActive = function(){ return !!(F.q||F.domains.length); };
var covActive = function(){ return !!(F.q||F.domains.length||F.maturity||F.gap!==""||F.coverage); };

// ---- accordion (reference: height 0 <-> auto, 0.22s) ---------------------
function setOpen(head, body, open){
  head.setAttribute("aria-expanded", open?"true":"false");
  if(reduced){ body.hidden=!open; body.style.height=""; return; }
  var from = open ? 0 : body.scrollHeight;
  if(open){ body.hidden=false; }
  var to = open ? body.scrollHeight : 0;
  body.style.height = from+"px"; body.style.opacity = open?"0":"1";
  requestAnimationFrame(function(){
    body.style.transition = "height .22s ease, opacity .22s ease";
    body.style.height = to+"px"; body.style.opacity = open?"1":"0";
  });
  var done = function(e){
    if(e.propertyName!=="height") return;
    body.removeEventListener("transitionend", done);
    body.style.transition=""; body.style.opacity="";
    if(open){ body.style.height="auto"; } else { body.hidden=true; body.style.height=""; }
  };
  body.addEventListener("transitionend", done);
}
function accordionSection(badge, title, subtitle, count, buildBody, openByDefault){
  var sec = el("section","domain");
  var head = el("button","domain-head");
  head.type="button"; head.setAttribute("aria-expanded", openByDefault?"true":"false");
  var b = el("span","dbadge tnum", badge); head.appendChild(b);
  var txt = el("div","txt");
  txt.appendChild(el("h3",null,title));
  if(subtitle) txt.appendChild(el("p",null,subtitle));
  head.appendChild(txt);
  if(count!=null) head.appendChild(el("span","n tnum",count));
  head.insertAdjacentHTML("beforeend",'<svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>');
  var body = el("div","acc");
  body.appendChild(buildBody());
  if(!openByDefault){ body.hidden=true; }
  head.addEventListener("click", function(){ setOpen(head, body, head.getAttribute("aria-expanded")!=="true"); });
  sec.appendChild(head); sec.appendChild(body);
  return sec;
}

// ---- capabilities view ---------------------------------------------------
function tileFor(c){
  var t = el("button","tile"); t.type="button"; t.setAttribute("data-cap", c.id);
  t.setAttribute("aria-pressed","false"); t.title = c.description||c.name;
  var r1 = el("div","row1");
  r1.appendChild(el("span","tid tnum", c.id));
  r1.appendChild(el("span","tnm", c.name));
  t.appendChild(r1);
  if(c.currentMaturity || c.targetMaturity){
    var r2 = el("div","row2");
    if(c.currentMaturity) r2.appendChild(el("i","dot m-"+c.currentMaturity));
    var lbl = c.currentMaturity || "—";
    if(c.targetMaturity && c.targetMaturity!==c.currentMaturity) lbl += " → "+c.targetMaturity;
    r2.appendChild(el("span","mat", lbl));
    if(c.stage) r2.appendChild(el("span","stagechip", c.stage));
    t.appendChild(r2);
  }
  t.addEventListener("click", function(){ openCapability(c.id); });
  return t;
}
function buildCapabilities(){
  var host = $("capSections"); host.textContent="";
  L1.forEach(function(d){
    var leafN = descOf(d.id).filter(function(c){ return !(children[c.id]||[]).length; }).length;
    host.appendChild(accordionSection(
      d.id.split(".")[0], d.name, d.description, leafN+" capabilities",
      function(){
        var grid = el("div","areas");
        (children[d.id]||[]).forEach(function(l2){
          var area = el("div","area");
          var ah = el("div","area-head");
          ah.appendChild(el("div","id tnum", l2.id));
          ah.appendChild(el("div","nm", l2.name));
          area.appendChild(ah);
          var tl = el("div","tiles");
          var kids = children[l2.id]||[];
          (kids.length?kids:[l2]).forEach(function(c){ tl.appendChild(tileFor(c)); });
          area.appendChild(tl);
          grid.appendChild(area);
        });
        return grid;
      }, true));
  });
}

// ---- process view: three-level drill-down, per the reference ---------------
var ICON = {
  inbox:'<svg viewBox="0 0 24 24"><path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/></svg>',
  filter:'<svg viewBox="0 0 24 24"><path d="M22 3H2l8 9.46V19l4 2v-8.54L22 3z"/></svg>',
  clipboardCheck:'<svg viewBox="0 0 24 24"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1"/><path d="M9 14l2 2 4-4"/></svg>',
  message:'<svg viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
  wallet:'<svg viewBox="0 0 24 24"><path d="M21 12V7H5a2 2 0 0 1 0-4h14v4"/><path d="M3 5v14a2 2 0 0 0 2 2h16v-5"/><path d="M18 12a2 2 0 0 0 0 4h4v-4z"/></svg>',
  search:'<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>',
  shield:'<svg viewBox="0 0 24 24"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M9 12l2 2 4-4"/></svg>',
  clipboardList:'<svg viewBox="0 0 24 24"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1"/><path d="M8 11h8M8 15h5"/></svg>',
  heart:'<svg viewBox="0 0 24 24"><path d="M20.8 5.6a5.5 5.5 0 0 0-7.8 0L12 6.6l-1-1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 22l7.8-7.6 1-1a5.5 5.5 0 0 0 0-7.8z"/></svg>',
  checkCircle:'<svg viewBox="0 0 24 24"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><path d="M22 4L12 14.01l-3-3"/></svg>',
  layers:'<svg viewBox="0 0 24 24"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>',
  user:'<svg viewBox="0 0 24 24"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>',
  headphones:'<svg viewBox="0 0 24 24"><path d="M3 18v-6a9 9 0 0 1 18 0v6"/><path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"/></svg>',
  building:'<svg viewBox="0 0 24 24"><path d="M3 21h18M5 21V7l8-4v18M19 21V11l-6-4M9 9v.01M9 12v.01M9 15v.01M9 18v.01"/></svg>',
  truck:'<svg viewBox="0 0 24 24"><path d="M1 3h15v13H1zM16 8h4l3 3v5h-7V8z"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/></svg>',
  cog:'<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6h.09A1.65 1.65 0 0 0 10 3.09V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9v.09a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
  tag:'<svg viewBox="0 0 24 24"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><path d="M7 7h.01"/></svg>',
  pkg:'<svg viewBox="0 0 24 24"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><path d="M3.27 6.96L12 12.01l8.73-5.05M12 22.08V12"/></svg>',
  file:'<svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M16 13H8M16 17H8"/></svg>',
  chevR:'<svg class="go" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 18l6-6-6-6"/></svg>',
};
// The reference keys icons off its own phase names; match on meaning instead so
// any feature's lifecycle gets a sensible icon, with a neutral fallback.
var PHASE_ICON_RULES = [
  [/discover|lodge|intake|submi|receipt/i, "inbox"],
  [/triage|registrat|alloc|routing|screen/i, "filter"],
  [/works|clearance|permit|safety|authoris/i, "shield"],
  [/technical|assess|eligib|determin|apprais/i, "clipboardCheck"],
  [/engage|communicat|contact|correspond/i, "message"],
  [/commercial|licen|fee|billing|financ|estimate|approval/i, "wallet"],
  [/detail|review|investigat|analys/i, "search"],
  [/care|health|support|wellbeing/i, "heart"],
  [/install|lifecycle|case manage|ongoing|maintain/i, "clipboardList"],
  [/final|clos|decommission|removal|exit|terminat/i, "checkCircle"],
];
function phaseIcon(name){
  for(var i=0;i<PHASE_ICON_RULES.length;i++) if(PHASE_ICON_RULES[i][0].test(name)) return PHASE_ICON_RULES[i][1];
  return "layers";
}
var ACTOR_ICON = { Client:"user", Front:"headphones", Back:"building", Third:"truck", System:"cog" };
var actorKey = function(a){ return String(a||"").split(/[ /]/)[0]; };

var subject = ((D.title||"").split("—")[0] || "").trim() || D.feature;
var proc = { phase:null, step:null };
var stepsOf = function(p){ var s=[]; ACTS.forEach(function(a){ if(a.l1===p && s.indexOf(a.l2)<0) s.push(a.l2); }); return s; };
var actsOf = function(p, s){ return ACTS.filter(function(a){ return a.l1===p && (!s || a.l2===s); }); };
function stagger(host, step){
  Array.prototype.forEach.call(host.children, function(c,i){ c.style.animationDelay = (i*step).toFixed(2)+"s"; });
}
function lvlHead(eyebrow, title, subtitle){
  var d = el("div","lvlhead");
  var e = el("div","eyebrow"); e.appendChild(el("i")); e.appendChild(el("span",null,eyebrow));
  d.appendChild(e); d.appendChild(el("h2",null,title));
  if(subtitle) d.appendChild(el("p",null,subtitle));
  return d;
}
function backBtn(fn){
  var b = el("button","backbtn"); b.type="button";
  b.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>';
  b.appendChild(document.createTextNode("Back"));
  b.addEventListener("click", fn);
  return b;
}
function metaBlock(icon, label, value){
  var d = el("div","meta"); d.innerHTML = ICON[icon];
  var w = el("div"); w.appendChild(el("div","k",label)); w.appendChild(el("div","v",value||""));
  d.appendChild(w); return d;
}
function levelPhases(){
  var f = document.createDocumentFragment();
  f.appendChild(lvlHead("L1 / L2 / L3 Process Model", subject+" lifecycle",
    "Select a lifecycle phase to drill into its process steps and activities."));
  var g = el("div","grid3 stagger");
  phases.forEach(function(p,i){
    var b = el("button","phasecard"); b.type="button";
    var top = el("div","top");
    var ic = el("span","icontile"); ic.innerHTML = ICON[phaseIcon(p)];
    top.appendChild(ic);
    top.appendChild(el("span","seqno tnum", ("0"+(i+1)).slice(-2)));
    b.appendChild(top);
    b.appendChild(el("h3",null,p));
    var m = el("div","cardmeta");
    m.appendChild(el("span",null, stepsOf(p).length+" steps"));
    m.appendChild(el("span","bullet"));
    m.appendChild(el("span",null, actsOf(p,null).length+" activities"));
    m.insertAdjacentHTML("beforeend", ICON.chevR);
    b.appendChild(m);
    b.addEventListener("click", function(){ proc.phase=p; proc.step=null; renderProcess(); });
    g.appendChild(b);
  });
  stagger(g,.04); f.appendChild(g); return f;
}
function levelSteps(){
  var f = document.createDocumentFragment();
  f.appendChild(backBtn(function(){ proc.phase=null; proc.step=null; renderProcess(); }));
  var st = stepsOf(proc.phase);
  f.appendChild(lvlHead("Process steps", proc.phase,
    st.length+" process steps · "+actsOf(proc.phase,null).length+" activities"));
  var g = el("div","grid2 stagger");
  st.forEach(function(s,i){
    var b = el("button","stepcard"); b.type="button";
    b.appendChild(el("span","stepnum tnum", String(i+1)));
    var t = el("div","txt");
    t.appendChild(el("h3",null,s));
    t.appendChild(el("p",null, actsOf(proc.phase,s).length+" activities"));
    b.appendChild(t);
    b.insertAdjacentHTML("beforeend", ICON.chevR);
    b.addEventListener("click", function(){ proc.step=s; renderProcess(); });
    g.appendChild(b);
  });
  stagger(g,.04); f.appendChild(g); return f;
}
function levelActs(){
  var f = document.createDocumentFragment();
  f.appendChild(backBtn(function(){ proc.step=null; renderProcess(); }));
  var mine = actsOf(proc.phase, proc.step);
  f.appendChild(lvlHead(proc.phase, proc.step, mine.length+" activit"+(mine.length===1?"y":"ies")));
  var g = el("div","stack stagger");
  mine.forEach(function(a,i){
    var c = el("div","actcard");
    var h = el("div","head");
    h.appendChild(el("span","actnum tnum", String(i+1)));
    h.appendChild(el("h3",null,a.l3));
    c.appendChild(h);
    if(a.description) c.appendChild(el("p","desc", a.description));
    var ch = el("div","actchips");
    var ac = el("span","chip a-"+actorKey(a.actor));
    ac.innerHTML = ICON[ACTOR_ICON[actorKey(a.actor)] || "cog"];
    ac.appendChild(document.createTextNode(a.actor));
    ch.appendChild(ac);
    if(a.serviceTier && a.serviceTier!=="All"){
      var tc = el("span","chip"); tc.innerHTML = ICON.tag;
      tc.appendChild(document.createTextNode(a.serviceTier)); ch.appendChild(tc);
    }
    c.appendChild(ch);
    var mg = el("div","metagrid");
    if(a.components.length) mg.appendChild(metaBlock("pkg","Components", a.components.join(", ")));
    if(a.sourceDocs.length) mg.appendChild(metaBlock("file","Source", a.sourceDocs.join(", ")));
    if(a.capabilityIds.length){
      var mb = metaBlock("layers","Realises", "");
      var v = mb.querySelector(".v"); v.textContent="";
      a.capabilityIds.forEach(function(id){
        var chip = el("span","chip cap", id+" "+((byId[id]||{}).name||""));
        chip.addEventListener("click", function(){
          setView("capabilities");
          setTimeout(function(){ openCapability(id); }, reduced?0:240);
        });
        v.appendChild(chip); v.appendChild(document.createTextNode(" "));
      });
      mg.appendChild(mb);
    }
    if(mg.children.length) c.appendChild(mg);
    g.appendChild(c);
  });
  stagger(g,.03); f.appendChild(g); return f;
}
function renderCrumbs(){
  var c = $("crumbs"); c.textContent="";
  var sep = '<svg class="sep" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 18l6-6-6-6"/></svg>';
  var mk = function(label, isActive, fn){
    var b = el("button","crumb",label); b.type="button"; b.disabled=isActive;
    if(!isActive) b.addEventListener("click", fn);
    return b;
  };
  c.appendChild(mk("Process", !proc.phase, function(){ proc.phase=null; proc.step=null; renderProcess(); }));
  if(proc.phase){
    c.insertAdjacentHTML("beforeend", sep);
    c.appendChild(mk(proc.phase, !proc.step, function(){ proc.step=null; renderProcess(); }));
  }
  if(proc.step){
    c.insertAdjacentHTML("beforeend", sep);
    c.appendChild(mk(proc.step, true, null));
  }
}
function renderProcess(){
  var host = $("procLevel");
  host.textContent = "";
  host.appendChild(!proc.phase ? levelPhases() : !proc.step ? levelSteps() : levelActs());
  host.classList.remove("lvl-up","lvl-in");
  if(!reduced){ void host.offsetWidth; host.classList.add(proc.phase ? "lvl-in" : "lvl-up"); }
  renderCrumbs();
}

// ---- coverage + sources --------------------------------------------------
function buildCoverage(){
  var counts = { rich:0, partial:0, gap:0 };
  leaves.forEach(function(c){ counts[covOf(c.id)]++; });
  var stats = $("covStats"); stats.textContent="";
  [[leaves.length,"L3 capabilities"],[ACTS.length,"Activities"],[counts.rich,"Rich coverage"],[counts.partial,"Partial"],[counts.gap,"No process evidence"]]
    .forEach(function(s){ var d=el("div","stat"); d.appendChild(el("b","tnum",String(s[0]))); d.appendChild(el("span",null,s[1])); stats.appendChild(d); });
  var tb = $("covBody"); tb.textContent="";
  leaves.forEach(function(c){
    var n = (actsFor[c.id]||[]).length;
    var tr = el("tr"); tr.setAttribute("data-cap", c.id);
    tr.appendChild(el("td","tnum", c.id));
    var td = el("td");
    var b = el("button","linkish", c.name);
    b.type="button"; b.addEventListener("click", function(){ openCapability(c.id); });
    td.appendChild(b); tr.appendChild(td);
    tr.appendChild(el("td",null,c.currentMaturity||"—"));
    tr.appendChild(el("td",null,c.targetMaturity||"—"));
    tr.appendChild(el("td","num tnum", String(n)));
    var last = el("td",null);
    if(n){ last.textContent = "Covered"; } else { last.className="gapflag"; last.textContent="No process evidence"; }
    tr.appendChild(last);
    tb.appendChild(tr);
  });
}
function buildSources(){
  var tb = $("srcBody"); tb.textContent="";
  D.sources.forEach(function(s){
    var nc = CAPS.filter(function(c){ return c.sourceDocs.indexOf(s)>=0; }).length;
    var na = ACTS.filter(function(a){ return a.sourceDocs.indexOf(s)>=0; }).length;
    var tr = el("tr"); tr.setAttribute("data-src", s);
    tr.appendChild(el("td",null,s));
    tr.appendChild(el("td","tnum", String(nc)));
    tr.appendChild(el("td","tnum", String(na)));
    tb.appendChild(tr);
  });
}

// ---- apply filters: dim, never hide (reference behaviour) -----------------
function applyFilters(){
  var on = mapActive();
  document.querySelectorAll(".tile").forEach(function(t){
    var c = byId[t.getAttribute("data-cap")];
    t.classList.toggle("dim", on && c && !capMatches(c));
  });
  document.querySelectorAll("#covBody tr").forEach(function(tr){
    var c = byId[tr.getAttribute("data-cap")];
    tr.classList.toggle("dim", covActive() && c && !covMatches(c));
  });
  document.querySelectorAll("#srcBody tr").forEach(function(tr){
    var s = tr.getAttribute("data-src");
    tr.classList.toggle("dim", !!F.q && s.toLowerCase().indexOf(F.q)<0);
  });
  var capN = leaves.filter(capMatches).length;
  $("countLabel").textContent =
    view==="process" ? ACTS.length+" activities"
    : view==="sources" ? D.sources.length+" sources"
    : on ? capN+" of "+leaves.length+" capabilities"
    : leaves.length+" capabilities";
  $("matchNote").textContent = on ? "Dimmed rows do not match the current filters." : "Non-matching rows dim rather than disappear.";
}

// ---- slide-over ----------------------------------------------------------
var lastFocus=null;
function openSlideover(eyebrow, title, build){
  var so=$("slideover");
  lastFocus = document.activeElement;
  $("soEyebrow").textContent = eyebrow;
  $("soTitle").textContent = title;
  var body=$("soBody"); body.textContent=""; body.appendChild(build()); body.scrollTop=0;
  so.hidden=false;
  requestAnimationFrame(function(){ so.classList.add("open"); });
  $("soClose").focus();
}
function closeSlideover(){
  var so=$("slideover");
  if(so.hidden) return;
  so.classList.remove("open");
  document.querySelectorAll('.tile[aria-pressed="true"]').forEach(function(t){ t.setAttribute("aria-pressed","false"); });
  var finish=function(){ so.hidden=true; };
  if(reduced) finish(); else setTimeout(finish, 360);
  if(lastFocus && lastFocus.focus) lastFocus.focus();
}
function defList(pairs){
  var dl=el("dl","kv");
  pairs.forEach(function(p){ if(p[1]==null||p[1]==="") return; dl.appendChild(el("dt",null,p[0])); dl.appendChild(el("dd",null,p[1])); });
  return dl;
}
function ulOf(items){ var u=el("ul"); items.forEach(function(i){ u.appendChild(el("li",null,i)); }); return u; }
function openCapability(id){
  var c = byId[id]; if(!c) return;
  document.querySelectorAll('.tile[aria-pressed="true"]').forEach(function(t){ t.setAttribute("aria-pressed","false"); });
  var tile = document.querySelector('.tile[data-cap="'+id+'"]');
  if(tile) tile.setAttribute("aria-pressed","true");
  openSlideover("Capability "+c.id, c.name, function(){
    var f = document.createDocumentFragment();
    if(c.description){ f.appendChild(el("h4",null,"Description")); f.appendChild(el("p",null,c.description)); }
    f.appendChild(el("h4",null,"Position"));
    var parent = c.parentId ? byId[c.parentId] : null;
    f.appendChild(defList([
      ["Level","L"+c.level],
      ["Parent", parent ? parent.id+" "+parent.name : "—"],
      ["Lifecycle stage", c.stage||"—"],
      ["Current maturity", c.currentMaturity||"Not assessed"],
      ["Target maturity", c.targetMaturity||"Not assessed"],
      ["Maturity gap", gapOf(c) ? gapOf(c)+" step"+(gapOf(c)>1?"s":"") : "None"]
    ]));
    var mine = actsFor[c.id]||[];
    f.appendChild(el("h4",null,"Realised by "+mine.length+" process activit"+(mine.length===1?"y":"ies")));
    if(!mine.length){
      f.appendChild(el("p","empty","No process evidence. This capability is asserted from the documents but no activity in the process model realises it — a finding, not a defect."));
    } else {
      var lst = el("div","solist");
      mine.forEach(function(a){
        var b = el("button","solink"); b.type="button";
        b.appendChild(el("b",null,a.l3));
        b.appendChild(el("span",null,a.l1+" › "+a.l2+" · "+a.actor));
        // Land the reader on the drill-down level that holds this activity.
        b.addEventListener("click", function(){
          closeSlideover();
          setTimeout(function(){ proc.phase=a.l1; proc.step=a.l2; renderProcess(); setView("process"); }, reduced?0:200);
        });
        lst.appendChild(b);
      });
      f.appendChild(lst);
    }
    if(c.sourceDocs.length){ f.appendChild(el("h4",null,"Sources")); f.appendChild(ulOf(c.sourceDocs)); }
    return f;
  });
}
// ---- view switching (reference: exit then enter, 0.2s) -------------------
var view = "capabilities";
function moveUnderline(){
  var btn = document.querySelector('.pbtn[data-view="'+view+'"]');
  var u = $("underline");
  if(!btn||!u) return;
  u.style.width = btn.offsetWidth+"px";
  u.style.transform = "translateX("+btn.offsetLeft+"px)";
}
function setView(next){
  if(next===view) return;
  var cur = $("view-"+view), tgt = $("view-"+next);
  document.querySelectorAll(".pbtn").forEach(function(b){ b.setAttribute("aria-selected", b.getAttribute("data-view")===next?"true":"false"); });
  view = next;
  document.body.setAttribute("data-view", next);
  moveUnderline();
  applyFilters();
  if(reduced){ cur.hidden=true; tgt.hidden=false; return; }
  cur.classList.add("view-out");
  setTimeout(function(){
    cur.hidden=true; cur.classList.remove("view-out");
    tgt.hidden=false; tgt.classList.remove("view-in");
    void tgt.offsetWidth;
    tgt.classList.add("view-in");
    setTimeout(function(){ tgt.classList.remove("view-in"); }, 220);
  }, 200);
}

// ---- wire up -------------------------------------------------------------
buildCapabilities(); renderProcess(); buildCoverage(); buildSources();

var dc = $("domainChecks");
L1.forEach(function(d){
  var lab = el("label","check");
  var cb = document.createElement("input"); cb.type="checkbox"; cb.value=d.id;
  cb.addEventListener("change", function(){
    F.domains = Array.prototype.slice.call(dc.querySelectorAll("input:checked")).map(function(i){return i.value;});
    applyFilters();
  });
  lab.appendChild(cb); lab.appendChild(el("span",null,d.id+" "+d.name));
  dc.appendChild(lab);
});
function fill(sel, values){ values.forEach(function(v){ var o=document.createElement("option"); o.value=v; o.textContent=v; sel.appendChild(o); }); }
fill($("fMaturity"), maturities);

$("q").addEventListener("input", function(e){ F.q = e.target.value.trim().toLowerCase(); applyFilters(); });
[["fMaturity","maturity"],["fGap","gap"],["fCoverage","coverage"]]
  .forEach(function(p){ $(p[0]).addEventListener("change", function(e){ F[p[1]] = e.target.value; applyFilters(); }); });
$("clearBtn").addEventListener("click", function(){
  F = { q:"", domains:[], maturity:"", gap:"", coverage:"" };
  $("q").value=""; ["fMaturity","fGap","fCoverage"].forEach(function(i){ $(i).value=""; });
  dc.querySelectorAll("input").forEach(function(i){ i.checked=false; });
  applyFilters();
});
$("domainToggle").addEventListener("click", function(){
  setOpen(this, dc, this.getAttribute("aria-expanded")!=="true");
});

document.querySelectorAll(".pbtn").forEach(function(b){
  b.addEventListener("click", function(){ setView(b.getAttribute("data-view")); });
  b.addEventListener("keydown", function(e){
    var order=["capabilities","process","coverage","sources"], i=order.indexOf(view);
    if(e.key==="ArrowRight"){ e.preventDefault(); setView(order[(i+1)%order.length]); focusTab(); }
    if(e.key==="ArrowLeft"){ e.preventDefault(); setView(order[(i+order.length-1)%order.length]); focusTab(); }
  });
});
function focusTab(){ var b=document.querySelector('.pbtn[data-view="'+view+'"]'); if(b) b.focus(); }

$("soClose").addEventListener("click", closeSlideover);
$("soBack").addEventListener("click", closeSlideover);
document.addEventListener("keydown", function(e){ if(e.key==="Escape"){ closeSlideover(); document.body.classList.remove("filters-open"); } });
$("filtersBtn").addEventListener("click", function(){ document.body.classList.toggle("filters-open"); });

// theme
function paintTheme(){
  var t = document.documentElement.getAttribute("data-theme");
  var dark = t==="dark" || (!t && window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
  $("themeLabel").textContent = dark ? "Light" : "Dark";
  $("themeBtn").setAttribute("aria-label", "Switch to "+(dark?"light":"dark")+" theme");
  $("themeIcon").innerHTML = dark
    ? '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'
    : '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>';
}
$("themeBtn").addEventListener("click", function(){
  var cur = document.documentElement.getAttribute("data-theme");
  var dark = cur==="dark" || (!cur && window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.setAttribute("data-theme", dark?"light":"dark");
  paintTheme();
});
paintTheme();

document.body.setAttribute("data-view", view);
moveUnderline();
window.addEventListener("resize", moveUnderline);
applyFilters();
})();
</script>
</body>
</html>
`;
}

async function main() {
  const argv = process.argv.slice(2);
  // --validate-only: run every check, write no page. The feature's single HTML
  // is now generated by render-companion-app.mjs, which assembles EVERY stage's
  // artefacts into one document; this script stays the contract guard for the
  // two Capabilities JSON files, which is the part the agent cannot self-check.
  const validateOnly = argv.includes("--validate-only");
  const [project, feature] = argv.filter((a) => !a.startsWith("--"));
  if (!project || !feature) die(`usage: node scripts/render-capability-map.mjs <project> <feature> [--validate-only]`);
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

  const byLevelEarly = capabilities.reduce((acc, c) => { acc[c.level] = (acc[c.level] || 0) + 1; return acc; }, {});
  if (validateOnly) {
    console.log(JSON.stringify({
      ok: true,
      validated: ["capability-map.json", "process-model.json"],
      capabilities: capabilities.length,
      capabilitiesByLevel: byLevelEarly,
      phases: [...new Set(activities.map((a) => a.l1))].length,
      activities: activities.length,
      sources: sources.length,
      html: null,
      note: "validate-only — render the feature's single page with: node scripts/render-companion-app.mjs " +
            `${project} ${feature}`,
    }, null, 2));
    return;
  }

  const rawTheme = await readTheme(project, feature);
  const theme = buildTheme(rawTheme);

  const html = renderHtml({
    title: str(capDoc.title) || `${feature} — Capability & Process Map`,
    project: str(capDoc.project) || project,
    feature: str(capDoc.feature) || feature,
    generatedOn: str(capDoc.generatedOn) || new Date().toISOString().slice(0, 10),
    sources,
    capabilities,
    activities,
    theme,
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
    theme: rawTheme._file ? { from: rawTheme._file, brand: theme.brand, accent: theme.accent, logo: theme.logoSrc ? "embedded" : "text" } : "default (no theme.json)",
  }, null, 2));
}

main().catch((e) => die(e?.stack || e?.message || String(e)));
