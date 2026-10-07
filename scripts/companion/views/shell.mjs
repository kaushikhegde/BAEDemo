// The page around the tabs: head, header, tab bar, footer, slide-over, and the
// inline CSS + client script. Everything lands in ONE file — the page makes no
// network requests (logos are data URIs, diagrams inline SVG, no webfont).

import { html, raw, esc, jsonIsland } from "../html.mjs";

function themeCss(theme) {
  const decl = (o) => Object.entries(o).map(([k, v]) => `${k}:${v};`).join("");
  const vars = { ...theme.vars };
  // `panel` was the old name for the subtle surface; keep honouring it.
  if (vars["--panel"]) vars["--surface-2"] = vars["--panel"];
  // No webfont is loaded, so the client's face applies only where installed —
  // always keep a generic tail so text renders regardless.
  if (theme.fontStack) vars["--font"] = `${theme.fontStack},"Segoe UI",Arial,"Helvetica Neue",Helvetica,sans-serif`;
  const out = [];
  if (Object.keys(vars).length) out.push(`:root,:root[data-theme]{${decl(vars)}}`);
  if (Object.keys(theme.lightVars).length) out.push(`:root,:root[data-theme="light"]{${decl(theme.lightVars)}}`);
  if (Object.keys(theme.darkVars).length) out.push(`:root[data-theme="dark"]{${decl(theme.darkVars)}}`);
  return out.join("\n");
}

const ICON = {
  moon: "M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z",
  print: "M6 9V2h12v7M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2M6 14h12v8H6z",
  search: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4",
};
const svg = (d) => raw(`<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"/></svg>`);

/**
 * @param sections [{ id, label, count, html }]
 * @param defaults route → default child segment
 */
export function page({ project, featureCount, sections, defaults, theme, generatedOn, css, js }) {
  const trail = sections.slice(0, 4).map((s) => s.label).join(" · ") || "Solution guide";
  // Set before first paint so the page never flashes the wrong theme. Follows
  // the OS until the reader picks one with the toggle (remembered per browser).
  const boot = `(function(){var t;try{t=localStorage.getItem("scyne-theme")}catch(e){}if(t!=="light"&&t!=="dark"){t=window.matchMedia&&matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light"}document.documentElement.setAttribute("data-theme",t)})();`;

  return `<!doctype html>
<html lang="en-AU" data-theme="light">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${esc(project)} — Companion App</title>
<meta name="description" content="Companion app for ${esc(project)} — personas, journeys, capabilities, process, and the solution artefacts for ${featureCount} feature${featureCount === 1 ? "" : "s"}."/>
<script>${boot}</script>
<style>
${css}
${themeCss(theme)}
</style>
</head>
<body>
${html`<a class="skip" href="#main">Skip to content</a>
<header class="top">
  <div class="top-row">
    <a class="brandmark" href="#/${sections[0]?.id || ""}">
      ${theme.logoSrc ? html`<img class="logo-img" src="${raw(theme.logoSrc)}" alt="${theme.logoText}"/>` : html`<span class="logo-text">${theme.logoText}</span>`}
      <span class="rule" aria-hidden="true"></span>
      <span class="titles"><span class="project">${project}</span><span class="trail">${trail}</span></span>
    </a>
    <span class="spacer"></span>
    <label class="search">${svg(ICON.search)}<span class="sr-only">Search this page</span>
      <input id="q" type="search" placeholder="Search this page…" autocomplete="off"/></label>
    <button class="icon-btn" id="theme" type="button" aria-pressed="false" title="Dark mode">${svg(ICON.moon)}<span class="sr-only">Dark mode</span></button>
    <button class="icon-btn" id="printer" type="button" title="Print">${svg(ICON.print)}<span class="sr-only">Print</span></button>
  </div>
  <nav class="tabs" role="tablist" aria-label="Sections">
    ${sections.map((s) => html`<a class="tab" id="tab-${s.id}" href="#/${s.id}" data-tab="${s.id}" role="tab" aria-selected="false" aria-controls="panel-${s.id}" tabindex="-1">${s.label}${s.count != null && html`<span class="count">${s.count}</span>`}</a>`)}
  </nav>
</header>
<main id="main" tabindex="-1">
  ${sections.map((s) => html`<section class="panel" id="panel-${s.id}" role="tabpanel" aria-labelledby="tab-${s.id}" data-panel="${s.id}" hidden>${s.html}</section>`)}
</main>
<div class="so-scrim" id="so-scrim" hidden></div>
<aside class="slideover" id="so" hidden role="dialog" aria-modal="true" aria-label="Capability detail">
  <button class="icon-btn so-x" id="so-x" type="button" aria-label="Close panel">×</button>
  <div class="so-body" id="so-body"></div>
</aside>
<footer class="foot">Generated on ${generatedOn} · ${featureCount} feature${featureCount === 1 ? "" : "s"} · Self-contained: no network requests, no external assets.</footer>
`}
<script type="application/json" id="routes">${jsonIsland({ defaults, tabs: sections.map((s) => s.id) })}</script>
<script>
${js}
</script>
</body>
</html>
`;
}
