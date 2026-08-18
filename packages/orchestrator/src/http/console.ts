// The orchestrator's console: ONE self-contained HTML page, inline CSS and JS,
// zero network requests beyond the local API. Same house pattern as the parent
// project's scripts/render-companion-app.mjs — no bundler, no build step, no
// version skew, and it works on a client's laptop with the wifi off.
//
// Tabs are hash-routed (#runs, #issues, …) so a reload lands where you were and
// a link to one issue or one run's transcript is shareable.
//
// TWO RULES THIS FILE LIVES OR DIES BY, both pinned by test/console.test.ts:
//
//   1. The whole page is ONE TypeScript template literal. A backtick or a
//      dollar-brace anywhere inside the browser <script> — comments included —
//      closes it early and gets interpolated at build time against variables
//      that only exist in the browser. It fails as a syntax error hundreds of
//      lines from the cause.
//   2. No external URLs. No CDN, no web font, no remote icon set. Icons are
//      inline SVG defined below; the type stack is the system stack.

import type { Theme } from "../config.js";
import { themeCss } from "./theme.js";

/**
 * Nav icons: inline SVG, one family, uniform 1.5 stroke on a 16-unit grid.
 *
 * Hand-rolled rather than pulled from an icon package because the page may
 * make no network requests and must not gain a build step — and because seven
 * glyphs is not worth a dependency. They are defined out here, OUTSIDE the
 * returned template literal, so the markup below can interpolate them without
 * the nested-template hazard described above.
 */
const I = (body: string): string =>
  `<svg class="ic" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" ` +
  `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

const ICONS: Record<string, string> = {
  runs:    I(`<path d="M1.5 8.5h3l2-5 3 10 2-5h3"/>`),
  issues:  I(`<rect x="2" y="2.5" width="12" height="11" rx="2"/><path d="M5 6h6M5 9h6M5 12h3"/>`),
  gates:   I(`<path d="M8 1.5 3 3.5v4c0 3.2 2 5.8 5 7 3-1.2 5-3.8 5-7v-4z"/><path d="M5.8 7.8 7.3 9.4l3-3.3"/>`),
  org:     I(`<rect x="6" y="1.5" width="4" height="3.2" rx="1"/><rect x="1.5" y="11.3" width="4" height="3.2" rx="1"/>` +
             `<rect x="10.5" y="11.3" width="4" height="3.2" rx="1"/><path d="M8 4.7v3.1M3.5 11.3V7.8h9v3.5"/>`),
  budgets: I(`<path d="M8 1.8v12.4M10.6 4.2H6.7a1.9 1.9 0 0 0 0 3.8h2.6a1.9 1.9 0 0 1 0 3.8H5"/>`),
  config:  I(`<path d="M2.5 4.5h5M10.5 4.5h3M2.5 11.5h3M8.5 11.5h5"/>` +
             `<circle cx="9" cy="4.5" r="1.6"/><circle cx="7" cy="11.5" r="1.6"/>`),
  health:  I(`<circle cx="8" cy="8" r="6.2"/><path d="M4.6 8h1.6l1-2.2 1.6 4.4 1-2.2h1.6"/>`),
};

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
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Crect width='16' height='16' rx='4' fill='%23363C63'/%3E%3Crect x='4.5' y='4.5' width='7' height='7' rx='2' fill='%23C8A878'/%3E%3C/svg%3E">
<style>
${themeCss(theme)}
/* ===========================================================================
   A control room, not a spreadsheet.

   The console answers two questions an operator has while twelve agents run
   without them: is anything waiting for me, and what has it cost. Everything
   here serves that, and the layout says it before you read a word — a fixed
   left rail you navigate by muscle memory, a status strip that is true on
   every screen, and one accent colour spent only on the state that will never
   resolve on its own.

   Colour has exactly one job here: encode state. Brand indigo is chrome and
   primary actions. Brass (--accent) means a human is required. Red means
   broken. Blue means moving. Green means finished. Nothing is coloured to be
   decorative, so any colour on screen is information.

   Type: system stacks only (zero network requests, so a web font would just
   be Arial with extra steps). MONO carries every machine fact — ids, keys,
   states, durations, money — and the UI stack carries prose a person wrote.
   If it is monospaced, the system is asserting it.
   =========================================================================== */

:root {
  --mono: ui-monospace, "SF Mono", SFMono-Regular, Menlo, "Cascadia Mono", "Roboto Mono", monospace;
  --ui: ui-sans-serif, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", ${theme.fontFamily};

  /* Surfaces, light. themeCss has already defined --bg/--surface/--fg/--border;
     these REDEFINE them onto a scale with enough steps to build cards that sit
     on cards, which the flat three-token set could not express. */
  --bg: #f6f7fb;
  --surface: #ffffff;
  --surface-2: #f1f3f9;
  --surface-3: #e8ebf4;
  --border: #e2e6f0;
  --border-strong: #cbd2e3;
  --fg: #161927;
  --muted: #5f6884;
  --shadow: 0 1px 2px rgba(22,25,39,.06), 0 4px 16px rgba(22,25,39,.05);
  --shadow-lg: 0 12px 40px rgba(22,25,39,.16);

  /* Semantic colours USED AS TEXT. The brand palette's success/danger/info/
     accent are tuned to sit on a dark ground, and on white they land between
     2.25:1 and 3.68:1 — brass on white is 2.25:1, which is not a colour, it is
     a suggestion. Darkened here for the light theme only, by the smallest
     amount that clears 4.5:1 against the page, a card AND the tinted chip
     background each one sits on (computed, not eyeballed). The DOT keeps
     currentColor, so it darkens with the word and the two never disagree.
     Dark mode restores the raw tokens below, where they already pass. */
  --on-accent:  color-mix(in srgb, var(--accent) 61%, black);
  --on-success: color-mix(in srgb, var(--success) 64%, black);
  --on-danger:  color-mix(in srgb, var(--danger) 76%, black);
  --on-info:    color-mix(in srgb, var(--info) 76%, black);

  --r: 10px;
  --r-sm: 7px;
  --r-lg: 14px;
  --pad: clamp(1rem, 2.2vw, 2rem);
  --rail-w: 216px;
}

@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0c0e15;
    --surface: #13161f;
    --surface-2: #191d29;
    --surface-3: #212636;
    --border: #232838;
    --border-strong: #333a4f;
    --fg: #e9ebf4;
    --muted: #8d95af;
    --shadow: 0 1px 2px rgba(0,0,0,.4), 0 4px 16px rgba(0,0,0,.3);
    --shadow-lg: 0 16px 48px rgba(0,0,0,.55);
    /* Raw again: on #13161f these clear 4.5:1 unmodified. */
    --on-accent: var(--accent); --on-success: var(--success);
    --on-danger: var(--danger); --on-info: var(--info);
  }
}

body { font-family: var(--ui); font-size: 14px; line-height: 1.5;
       -webkit-font-smoothing: antialiased; }
.mono, .num { font-family: var(--mono); font-variant-numeric: tabular-nums; }
.ic { width: 16px; height: 16px; flex: none; }

/* ---- app shell -----------------------------------------------------------
   Fixed rail, scrolling column. The rail is 216px because the longest label
   ("Budgets") plus its icon plus the brand mark fit without truncation. */
.app { display: grid; grid-template-columns: var(--rail-w) minmax(0, 1fr); min-height: 100dvh; }

.rail { background: var(--surface); border-right: 1px solid var(--border);
        display: flex; flex-direction: column; position: sticky; top: 0;
        height: 100dvh; overflow-y: auto; }

.brand { display: flex; align-items: center; gap: .6rem; padding: 1rem 1rem .9rem;
         border-bottom: 1px solid var(--border); }
.brand .glyph { width: 26px; height: 26px; border-radius: 8px; flex: none;
                background: linear-gradient(145deg, var(--brand), var(--brand-deep));
                display: grid; place-items: center; }
.brand .glyph::after { content: ""; width: 10px; height: 10px; border-radius: 3px; background: var(--accent); }
.brand .name { font-weight: 650; font-size: .84rem; letter-spacing: -.01em; line-height: 1.2; }

nav { display: flex; flex-direction: column; gap: 2px; padding: .7rem .6rem; flex: 1; }
nav a { display: flex; align-items: center; gap: .6rem; padding: .5rem .6rem;
        border-radius: var(--r-sm); color: var(--muted); text-decoration: none;
        font-size: .84rem; font-weight: 500; transition: background .12s, color .12s; }
nav a:hover { background: var(--surface-2); color: var(--fg); }
nav a.on { background: color-mix(in srgb, var(--brand) 14%, transparent); color: var(--fg); font-weight: 600; }
nav a.on .ic { color: var(--brand); }
@media (prefers-color-scheme: dark) { nav a.on .ic { color: var(--glow); } }
nav a .badge { margin-left: auto; font-family: var(--mono); font-size: .68rem; font-weight: 700;
               background: var(--accent); color: #241a08; border-radius: 999px;
               padding: .05rem .38rem; min-width: 1.15rem; text-align: center; }
nav a .badge.fault { background: var(--danger); color: #fff; }

/* The runtime provenance line. It belongs HERE, at the bottom of the rail,
   not shouted across the masthead: it is a support-call fact you read once,
   and the Health tab carries the full version of it. */
.railfoot { border-top: 1px solid var(--border); padding: .7rem .85rem; }
.railfoot .dot { width: 7px; height: 7px; border-radius: 999px; background: var(--success);
                 display: inline-block; margin-right: .45rem; }
.railfoot .dot.down { background: var(--danger); }
.railfoot .lbl { font-size: .76rem; font-weight: 600; }
.railfoot .env { font-family: var(--mono); font-size: .64rem; color: var(--muted);
                 margin-top: .3rem; line-height: 1.45; word-break: break-word; }

/* ---- topbar --------------------------------------------------------------
   Page title on the left; the status strip and the one primary action on the
   right. The strip is the only element repeated on every screen, because it is
   the only information that is true on every screen. */
.top { position: sticky; top: 0; z-index: 20; background: color-mix(in srgb, var(--bg) 88%, transparent);
       backdrop-filter: blur(10px); border-bottom: 1px solid var(--border);
       padding: .8rem var(--pad); display: flex; align-items: center; gap: 1rem; flex-wrap: wrap; }
.top h1 { margin: 0; font-size: 1.02rem; font-weight: 650; letter-spacing: -.015em; }
.top .sub { font-size: .78rem; color: var(--muted); margin-top: .1rem; }
.strip { margin-left: auto; display: flex; align-items: center; gap: .4rem; flex-wrap: wrap; }
.chip { display: flex; align-items: baseline; gap: .38rem; padding: .3rem .6rem;
        border: 1px solid var(--border); border-radius: 999px; background: var(--surface); }
.chip .v { font-family: var(--mono); font-variant-numeric: tabular-nums;
           font-size: .84rem; font-weight: 650; }
.chip .l { font-size: .68rem; color: var(--muted); letter-spacing: .02em; }
/* Brass the moment a human is needed — the one state that cannot resolve by
   waiting. A fault is red, not brass: a blocked issue is a problem, not a
   request. */
.chip.live { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 13%, transparent); }
.chip.live .v, .chip.live .l { color: var(--on-accent); }
.chip.live .l { font-weight: 650; }
.chip.fault { border-color: var(--danger); background: color-mix(in srgb, var(--danger) 12%, transparent); }
.chip.fault .v, .chip.fault .l { color: var(--on-danger); }

main { padding: var(--pad); max-width: 1560px; }

/* ---- headings and helpers ---- */
h2 { font-size: .72rem; letter-spacing: .1em; text-transform: uppercase;
     color: var(--muted); margin: 0 0 .75rem; font-weight: 700; }
h2:not(:first-child) { margin-top: 1.9rem; }
.muted { color: var(--muted); }
.hint { font-size: .8rem; color: var(--muted); line-height: 1.6; max-width: 72ch; }
.stack { display: flex; flex-direction: column; gap: .6rem; }
.wrap { display: flex; gap: .5rem; align-items: center; flex-wrap: wrap; }
.scroll-x { overflow-x: auto; }

/* ---- state, as a tinted chip ---------------------------------------------
   A dot carries the colour and the word carries the meaning, so the state is
   never conveyed by colour alone. */
.st { display: inline-flex; align-items: center; gap: .4rem; font-family: var(--mono);
      font-size: .72rem; font-weight: 600; white-space: nowrap; padding: .16rem .5rem;
      border-radius: 999px; border: 1px solid var(--border);
      background: var(--surface-2); color: var(--muted); }
.st::before { content: ""; width: .45rem; height: .45rem; border-radius: 999px;
              flex: none; background: currentColor; }
.st.todo { color: var(--muted); }
.st.in_progress, .st.running { color: var(--on-info);
  border-color: color-mix(in srgb, var(--info) 42%, transparent);
  background: color-mix(in srgb, var(--info) 13%, transparent); }
.st.in_review { color: var(--on-accent);
  border-color: color-mix(in srgb, var(--accent) 48%, transparent);
  background: color-mix(in srgb, var(--accent) 15%, transparent); }
.st.done, .st.succeeded, .st.approved { color: var(--on-success);
  border-color: color-mix(in srgb, var(--success) 40%, transparent);
  background: color-mix(in srgb, var(--success) 12%, transparent); }
.st.blocked, .st.failed, .st.over_budget, .st.orphaned, .st.rejected, .st.disabled { color: var(--on-danger);
  border-color: color-mix(in srgb, var(--danger) 42%, transparent);
  background: color-mix(in srgb, var(--danger) 12%, transparent); }
.st.pending { color: var(--on-accent);
  border-color: color-mix(in srgb, var(--accent) 48%, transparent);
  background: color-mix(in srgb, var(--accent) 15%, transparent); }
@media (prefers-reduced-motion: no-preference) {
  .st.running::before, .st.in_progress::before { animation: pulse 1.8s ease-in-out infinite; }
  .chip.live .v { animation: pulse 2.2s ease-in-out infinite; }
}
@keyframes pulse { 50% { opacity: .35; } }

/* ---- cards ---- */
.card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--r);
        padding: 1rem 1.1rem; box-shadow: var(--shadow); }
.card h3 { margin: 0 0 .5rem; font-size: .88rem; font-weight: 650; letter-spacing: -.01em; }
.card + .card { margin-top: .7rem; }
.card.attention { border-color: color-mix(in srgb, var(--accent) 55%, transparent);
                  box-shadow: var(--shadow), 0 0 0 1px color-mix(in srgb, var(--accent) 22%, transparent); }
.card.fault { border-color: color-mix(in srgb, var(--danger) 50%, transparent); }
.card pre, pre.block { white-space: pre-wrap; word-break: break-word; font-family: var(--mono);
       font-size: .75rem; line-height: 1.6; color: var(--muted); background: var(--surface-2);
       border: 1px solid var(--border); border-radius: var(--r-sm); padding: .7rem .8rem; margin: .5rem 0 0; }

/* Clickable issue / list rows. A whole card is the target, so it is a <button>
   for keyboard reachability and its control styling is reset back to prose. */
.rowcard { display: block; width: 100%; text-align: left; font: inherit; color: inherit;
           text-transform: none; letter-spacing: normal; cursor: pointer;
           background: var(--surface); border: 1px solid var(--border); border-radius: var(--r);
           padding: .85rem 1rem; box-shadow: var(--shadow); transition: border-color .12s, transform .12s; }
.rowcard:hover { border-color: var(--border-strong); }
@media (prefers-reduced-motion: no-preference) { .rowcard:active { transform: scale(.995); } }
.rowcard .line1 { display: flex; align-items: center; gap: .55rem; flex-wrap: wrap; }
.rowcard .id { font-family: var(--mono); font-size: .74rem; font-weight: 700; color: var(--muted); }
.rowcard .ttl { font-weight: 600; font-size: .92rem; letter-spacing: -.01em; }
.rowcard .line2 { margin-top: .35rem; font-family: var(--mono); font-size: .72rem;
                  color: var(--muted); display: flex; gap: .5rem; flex-wrap: wrap; }

/* ---- segmented step progress ---------------------------------------------
   N segments for N steps, filled to step_index. It answers "how far in is
   this" at a glance, which "4/6" does not. */
.steps { display: flex; gap: 3px; margin-top: .55rem; }
.steps i { height: 4px; flex: 1; border-radius: 2px; background: var(--surface-3); }
.steps i.done { background: var(--success); }
.steps i.at { background: var(--info); }
.steps i.at.stalled { background: var(--danger); }
.steps i.at.gate { background: var(--accent); }

/* ---- metric tiles ---- */
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: .7rem; }
.metric { background: var(--surface); border: 1px solid var(--border); border-radius: var(--r);
          padding: .8rem .9rem; box-shadow: var(--shadow); }
.metric .l { font-size: .68rem; letter-spacing: .06em; text-transform: uppercase; color: var(--muted);
             font-weight: 650; }
.metric .v { font-family: var(--mono); font-variant-numeric: tabular-nums;
             font-size: 1.5rem; font-weight: 650; margin-top: .25rem; letter-spacing: -.02em; }
.metric .s { font-size: .72rem; color: var(--muted); margin-top: .15rem; }

/* ---- tables ---- */
.tablewrap { background: var(--surface); border: 1px solid var(--border); border-radius: var(--r);
             box-shadow: var(--shadow); overflow: hidden; }
.tablewrap .scroll-x { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: .84rem; }
th { text-align: left; padding: .55rem .9rem; background: var(--surface-2);
     border-bottom: 1px solid var(--border); font-size: .68rem; letter-spacing: .06em;
     text-transform: uppercase; color: var(--muted); font-weight: 700; white-space: nowrap; }
td { padding: .6rem .9rem; border-bottom: 1px solid var(--border); vertical-align: middle; }
tbody tr:last-child td { border-bottom: none; }
td.num, th.num { text-align: right; font-family: var(--mono); font-variant-numeric: tabular-nums; }
tr.clickable { cursor: pointer; }
tr.clickable:hover td { background: var(--surface-2); }

/* ---- controls ---- */
button { font: inherit; font-size: .8rem; font-weight: 600; padding: .44rem .85rem;
         border-radius: var(--r-sm); border: 1px solid var(--brand); background: var(--brand);
         color: #fff; cursor: pointer; display: inline-flex; align-items: center; gap: .4rem;
         transition: background .12s, border-color .12s, opacity .12s; }
button:hover { background: var(--brand-deep); border-color: var(--brand-deep); }
button.ghost { background: var(--surface); color: var(--fg); border-color: var(--border-strong); }
button.ghost:hover { background: var(--surface-2); border-color: var(--fg); }
button.danger { background: transparent; color: var(--on-danger); border-color: color-mix(in srgb, var(--danger) 55%, transparent); }
/* Dark ink, not white: white on #F43F5E is 3.67:1, and the hover state of a
   DESTRUCTIVE button is the last place to be a shade under the floor. */
button.danger:hover { background: var(--danger); color: #2A0410; border-color: var(--danger); }
button.approve { background: var(--success); border-color: var(--success); color: #04231a; }
button.approve:hover { background: color-mix(in srgb, var(--success) 82%, black); border-color: color-mix(in srgb, var(--success) 82%, black); }
button.sm { font-size: .74rem; padding: .3rem .6rem; }
button:disabled { opacity: .45; cursor: default; }

label { display: block; font-size: .68rem; letter-spacing: .05em; text-transform: uppercase;
        font-weight: 700; color: var(--muted); margin: .8rem 0 .3rem; }
input, select, textarea { font-family: var(--mono); font-size: .84rem; padding: .48rem .6rem;
  width: 100%; border: 1px solid var(--border-strong); border-radius: var(--r-sm);
  background: var(--bg); color: var(--fg); }
textarea { font-family: var(--ui); min-height: 4.5rem; resize: vertical; line-height: 1.55; }
input:focus, select:focus, textarea:focus { outline: none; border-color: var(--brand);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--brand) 22%, transparent); }
.row { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 0 1.1rem; }
.actions { margin-top: 1.1rem; display: flex; gap: .5rem; align-items: center; flex-wrap: wrap; }
.saved { color: var(--on-success); font-size: .8rem; font-weight: 600; }
.err { color: var(--on-danger); font-size: .8rem; font-weight: 600; }
table input { max-width: 9rem; }

/* Every focusable thing gets the same visible ring. Never removed. */
a:focus-visible, button:focus-visible, input:focus-visible,
select:focus-visible, textarea:focus-visible, [tabindex]:focus-visible {
  outline: 2px solid var(--accent); outline-offset: 2px; }

/* ---- modal ---- */
.scrim { position: fixed; inset: 0; background: rgba(6,8,14,.62); backdrop-filter: blur(3px);
         z-index: 60; display: grid; place-items: start center; padding: 6vh 1rem 2rem; overflow-y: auto; }
.modal { background: var(--surface); border: 1px solid var(--border); border-radius: var(--r-lg);
         box-shadow: var(--shadow-lg); width: min(560px, 100%); padding: 1.2rem 1.3rem 1.3rem; }
.modal h3 { margin: 0 0 .2rem; font-size: 1rem; font-weight: 650; letter-spacing: -.015em; }

/* ---- org chart -----------------------------------------------------------
   A real top-down chart: nested <ul>s laid out as flex rows, with connectors
   drawn by pseudo-element borders. It gets wide before it gets deep with a
   twelve-agent org, so the whole chart scrolls inside its own container rather
   than forcing the page to scroll sideways. */
.chartwrap { overflow-x: auto; padding: .5rem .2rem 1.2rem; }
.chart, .chart ul { list-style: none; margin: 0; padding: 0; display: flex; justify-content: center; }
.chart { min-width: max-content; }
.chart li { position: relative; padding: 26px 9px 0; text-align: center; }
/* the two half-width rules that join a row of siblings */
.chart li::before, .chart li::after {
  content: ""; position: absolute; top: 0; width: 50%; height: 26px;
  border-top: 1px solid var(--border-strong); }
.chart li::after { right: auto; left: 50%; border-left: 1px solid var(--border-strong); }
.chart li::before { right: 50%; left: auto; }
.chart li:only-child::before, .chart li:only-child::after { display: none; }
.chart li:only-child { padding-top: 0; }
.chart li:first-child::after { border-radius: 6px 0 0 0; }
.chart li:last-child::before { border-radius: 0 6px 0 0; }
.chart li:first-child::before, .chart li:last-child::after { border: 0 none; }
.chart li:last-child::before { border-right: 1px solid var(--border-strong); }
/* the stem dropping from a parent into its children's rule */
.chart ul::before { content: ""; position: absolute; top: 0; left: 50%; height: 26px;
                    border-left: 1px solid var(--border-strong); }
.chart ul { position: relative; padding-top: 26px; }
.chart > li { padding-top: 0; }
.chart > li::before, .chart > li::after { display: none; }

.node { display: inline-flex; align-items: center; gap: .55rem; padding: .5rem .7rem;
        min-width: 172px; border: 1px solid var(--border); border-radius: var(--r);
        background: var(--surface); box-shadow: var(--shadow); cursor: pointer;
        text-align: left; text-transform: none; letter-spacing: normal; font-weight: 400;
        font-family: var(--ui); color: var(--fg); transition: border-color .12s, box-shadow .12s; }
.node:hover { border-color: var(--border-strong); }
.node.on { border-color: var(--brand); box-shadow: var(--shadow), 0 0 0 2px color-mix(in srgb, var(--brand) 35%, transparent); }
.node .av { width: 28px; height: 28px; border-radius: 8px; flex: none; display: grid; place-items: center;
            font-family: var(--mono); font-size: .68rem; font-weight: 700; color: #fff;
            background: var(--brand-deep); position: relative; }
.node .av .live { position: absolute; right: -3px; bottom: -3px; width: 9px; height: 9px;
                  border-radius: 999px; border: 2px solid var(--surface); background: var(--muted); }
.node.running .av .live { background: var(--info); }
.node.blocked .av .live { background: var(--danger); }
.node.running .av { background: var(--info); }
.node.blocked .av { background: var(--danger); }
@media (prefers-reduced-motion: no-preference) {
  .node.running .av .live { animation: pulse 1.6s ease-in-out infinite; }
}
.node .who { min-width: 0; }
.node .n { display: block; font-weight: 620; font-size: .82rem; letter-spacing: -.01em; white-space: nowrap; }
.node .k { display: block; font-family: var(--mono); font-size: .68rem; color: var(--muted); white-space: nowrap; }
.node.off { opacity: .45; }
.node.off .av { background: var(--surface-3); color: var(--muted); }
.legend { display: flex; gap: .9rem; flex-wrap: wrap; font-size: .74rem; color: var(--muted); }
.legend span { display: inline-flex; align-items: center; gap: .35rem; }
.legend i { width: 8px; height: 8px; border-radius: 999px; display: inline-block; }

/* ---- issue detail: reading column + facts column ----
   Two columns above 1100px, one below. Declared as a class rather than an
   inline style so the breakpoint can actually win. */
.split2 { display: grid; grid-template-columns: minmax(0, 1.6fr) minmax(0, 1fr);
          gap: var(--pad); align-items: start; margin-top: 1.2rem; }
@media (max-width: 1100px) { .split2 { grid-template-columns: 1fr; } }

/* ---- transcript ---- */
#transcript { font-family: var(--mono); font-size: .76rem; line-height: 1.62;
              white-space: pre-wrap; word-break: break-word; max-height: 62vh;
              overflow-y: auto; background: var(--surface); border: 1px solid var(--border);
              border-radius: var(--r); padding: .9rem 1rem; box-shadow: var(--shadow); }
#transcript div { margin-bottom: .12rem; }
#transcript .ts { color: var(--border-strong); }
#transcript .tool_use { color: var(--on-info); }
#transcript .tool_result { color: var(--muted); }
#transcript .skill { color: var(--on-accent); font-weight: 700; }
#transcript .framing { color: var(--muted); font-style: italic; }

/* ---- timeline (issue detail) ---- */
.tl { list-style: none; margin: 0; padding: 0; }
.tl li { position: relative; padding: 0 0 1rem 1.4rem; }
.tl li::before { content: ""; position: absolute; left: 3px; top: .45rem; width: 8px; height: 8px;
                 border-radius: 999px; background: var(--border-strong); }
.tl li::after { content: ""; position: absolute; left: 6.5px; top: 1.1rem; bottom: 0;
                border-left: 1px solid var(--border); }
.tl li:last-child::after { display: none; }
.tl li.sys::before { background: var(--accent); }
.tl .who { font-size: .72rem; font-family: var(--mono); color: var(--muted); margin-bottom: .2rem; }
.tl .body { font-size: .84rem; white-space: pre-wrap; word-break: break-word; line-height: 1.6; }
.tl .body code { font-family: var(--mono); font-size: .78rem; background: var(--surface-2);
                 border: 1px solid var(--border); border-radius: 4px; padding: .05rem .3rem; }

/* ---- empty states ---- */
.empty { text-align: center; padding: 3.5rem 1rem; color: var(--muted); font-size: .86rem;
         border: 1px dashed var(--border-strong); border-radius: var(--r-lg); background: var(--surface); }
.empty b { display: block; font-size: 1rem; color: var(--fg); margin-bottom: .35rem; font-weight: 650; }
.empty .mono { font-size: .78rem; }

a { color: var(--brand); }
@media (prefers-color-scheme: dark) { a { color: var(--glow); } }

/* ---- responsive: the rail becomes a top strip ---- */
@media (max-width: 900px) {
  .app { grid-template-columns: 1fr; }
  .rail { position: static; height: auto; flex-direction: row; align-items: center;
          border-right: none; border-bottom: 1px solid var(--border); overflow-x: auto; }
  .brand { border-bottom: none; padding: .7rem .8rem; }
  nav { flex-direction: row; padding: .5rem; gap: 4px; }
  nav a { white-space: nowrap; }
  .railfoot { display: none; }
  .top { position: static; }
}
</style>
</head>
<body>
<div class="app">
  <aside class="rail">
    <div class="brand">
      <span class="glyph"></span>
      <span class="name">${theme.logoText}</span>
    </div>
    <nav>${TABS.map(([id, label]) =>
      `<a href="#${id}" data-tab="${id}">${ICONS[id]}${label}</a>`).join("")}</nav>
    <div class="railfoot">
      <div><span class="dot" id="dot"></span><span class="lbl" id="dotlbl">connecting…</span></div>
      <div class="env" id="env"></div>
    </div>
  </aside>
  <div>
    <div class="top">
      <div>
        <h1 id="ptitle">Runs</h1>
        <div class="sub" id="psub"></div>
      </div>
      <div class="strip" id="strip"></div>
      <button id="newrun">+ New run</button>
    </div>
    <main id="view"><div class="empty"><b>Loading</b>Reading the orchestrator.</div></main>
  </div>
</div>
<div id="modal"></div>
<script>
/* Everything below runs in the BROWSER. It may contain no backtick and no
   dollar-brace, comments included — see the header of this file. Where a
   backtick is genuinely needed (markdown fences in agent comments) it is built
   with String.fromCharCode(96). */

const api = async (p, opts) => {
  const r = await fetch(p, Object.assign({ headers: { accept: "application/json" } }, opts || {}));
  if (!r.ok) {
    let detail = "";
    try { detail = (await r.json()).error || ""; } catch (e) { detail = ""; }
    throw new Error(detail || (p + " responded " + r.status));
  }
  return r.json();
};
const send = async (p, method, body) => {
  const r = await fetch(p, {
    method: method,
    headers: { "Content-Type": "application/json", accept: "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let out = null;
  try { out = await r.json(); } catch (e) { out = null; }
  if (!r.ok) throw new Error((out && out.error) || (p + " responded " + r.status));
  return out;
};

const esc = (s) => String(s == null ? "" : s)
  .replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// State as a dot plus its word: the colour is never the only carrier.
const st = (s) => '<span class="st ' + esc(s) + '">' + esc(String(s).replace(/_/g, " ")) + '</span>';

const ago = (iso) => {
  if (!iso) return "—";
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return Math.round(s) + "s ago";
  if (s < 3600) return Math.round(s / 60) + "m ago";
  if (s < 86400) return Math.round(s / 3600) + "h ago";
  return Math.round(s / 86400) + "d ago";
};
const when = (iso) => iso ? new Date(iso).toLocaleString("en-AU") : "—";
const dur = (ms) => {
  if (ms == null) return "—";
  const s = Number(ms) / 1000;
  if (s < 90) return s.toFixed(1) + "s";
  const m = Math.floor(s / 60);
  return m < 60 ? m + "m " + Math.round(s % 60) + "s" : Math.floor(m / 60) + "h " + (m % 60) + "m";
};
// Four decimals: a single cheap step really does cost $0.0043, and rounding it
// to $0.00 is how a bill becomes a surprise.
const money = (n) => n == null ? "—" : "$" + Number(n).toFixed(4);
const num = (n) => Number(n == null ? 0 : n).toLocaleString("en-AU");
const plain = (v) => (v === null || v === undefined || v === "") ? "" : String(Number(v));

/* A deliberately tiny markdown renderer for agent and engine comments, which
   arrive as markdown (fenced stderr, inline code paths). Escapes FIRST, then
   promotes fences and inline code, so nothing user-supplied can inject markup. */
const mdlite = (s) => {
  const BT = String.fromCharCode(96);
  const inline = new RegExp(BT + "([^" + BT + "\\\\n]+)" + BT, "g");
  return String(s == null ? "" : s).split(BT + BT + BT).map((part, i) =>
    i % 2 === 1
      ? '<pre class="block">' + esc(part.replace(/^[a-zA-Z]*\\n/, "").replace(/\\n$/, "")) + '</pre>'
      : esc(part).replace(inline, '<code>$1</code>')
  ).join("");
};

const view = document.getElementById("view");
const modalHost = document.getElementById("modal");

/* /config never changes while the process is up (it is reconciled from the
   config file at boot), so it is fetched once and reused. Every tab wants the
   workflow list; refetching it seven times is latency for no new information. */
let CFG = null;
const config = async () => { if (!CFG) CFG = await api("/config"); return CFG; };
const workflowOf = (key) => (CFG && CFG.workflows.find(w => w.key === key)) || null;

// One poll timer for the whole app: every route change clears it, so leaving a
// transcript open and navigating away cannot leak a second poller.
let poll = null;
const stopPolling = () => { if (poll) { clearInterval(poll); poll = null; } };

const setHead = (title, sub) => {
  document.getElementById("ptitle").textContent = title;
  document.getElementById("psub").textContent = sub || "";
};

const on = (sel, ev, fn, root) => (root || view).querySelectorAll(sel).forEach(el => el.addEventListener(ev, fn));

/* ---- segmented step progress -------------------------------------------- */
const stepBar = (issue) => {
  const wf = workflowOf(issue.workflow_key);
  const total = wf ? wf.steps : Math.max(Number(issue.step_index) + 1, 1);
  const at = Number(issue.step_index);
  let bits = "";
  for (let i = 0; i < total; i++) {
    let cls = "";
    if (i < at) cls = "done";
    else if (i === at) {
      cls = "at";
      if (issue.status === "blocked") cls += " stalled";
      else if (issue.status === "in_review") cls += " gate";
    }
    bits += '<i class="' + cls + '"></i>';
  }
  return '<div class="steps">' + bits + '</div>';
};

const stepName = (issue) => {
  const wf = workflowOf(issue.workflow_key);
  if (!wf || !wf.stepList) return "step " + (Number(issue.step_index) + 1);
  const s = wf.stepList[Number(issue.step_index)];
  const total = wf.steps;
  const nth = "step " + Math.min(Number(issue.step_index) + 1, total) + " of " + total;
  if (!s) return "complete";
  return nth + " — " + s.type + (s.phase ? " (" + s.phase + ")" : "");
};

/* ---- modal -------------------------------------------------------------- */
function closeModal() { modalHost.innerHTML = ""; document.removeEventListener("keydown", escClose); }
function escClose(e) { if (e.key === "Escape") closeModal(); }
function openModal(html) {
  modalHost.innerHTML = '<div class="scrim" id="scrim"><div class="modal" role="dialog" aria-modal="true">' + html + '</div></div>';
  document.addEventListener("keydown", escClose);
  document.getElementById("scrim").addEventListener("click", (e) => { if (e.target.id === "scrim") closeModal(); });
  const first = modalHost.querySelector("input, select, textarea, button");
  if (first) first.focus();
}

/* ---- new run ------------------------------------------------------------
   The form is built from /config's derived params list for the chosen
   workflow, so it asks for exactly the variables that workflow's own templates
   interpolate — and gains a field automatically when a stage starts reading a
   new one. Extra params are still allowed, because POST /issues accepts any
   key and some are optional (a Confluence space, a Jira key). */
async function newRunModal(preset) {
  const c = await config();
  const chosen = preset || (c.workflows[0] && c.workflows[0].key);
  openModal(
    '<h3>Start a run</h3>' +
    '<p class="hint" style="margin:.2rem 0 0">One workflow, one issue. It runs until it needs you.</p>' +
    '<label for="w-key">Workflow</label>' +
    '<select id="w-key">' + c.workflows.map(w =>
      '<option value="' + esc(w.key) + '"' + (w.key === chosen ? " selected" : "") + '>' +
      esc(w.key) + ' — ' + esc(w.label) + '</option>').join("") + '</select>' +
    '<div id="w-params"></div>' +
    '<div id="w-extra"></div>' +
    '<div class="actions">' +
      '<button id="w-go">Start run</button>' +
      '<button class="ghost" id="w-add">+ Parameter</button>' +
      '<button class="ghost" id="w-cancel">Cancel</button>' +
      '<span id="w-msg"></span>' +
    '</div>');

  const sel = document.getElementById("w-key");
  const paramBox = document.getElementById("w-params");
  const extraBox = document.getElementById("w-extra");
  const msg = document.getElementById("w-msg");

  const paint = () => {
    const w = c.workflows.find(x => x.key === sel.value);
    const ps = (w && w.params) || [];
    paramBox.innerHTML = ps.length
      ? '<div class="row">' + ps.map(p =>
          '<div><label for="p-' + esc(p) + '">' + esc(p) + '</label>' +
          '<input id="p-' + esc(p) + '" data-param="' + esc(p) + '" placeholder="' + esc(p) + '"></div>').join("") + '</div>'
      : '<p class="hint" style="margin-top:.8rem">This workflow interpolates no parameters.</p>';
    if (w) {
      paramBox.insertAdjacentHTML("beforeend",
        '<p class="hint" style="margin-top:.6rem">' + esc(w.steps) + ' step(s), assigned to ' +
        '<span class="mono">' + esc(w.assignee) + '</span>.</p>');
    }
  };
  paint();
  sel.addEventListener("change", paint);

  document.getElementById("w-add").addEventListener("click", () => {
    extraBox.insertAdjacentHTML("beforeend",
      '<div class="row" style="margin-top:.4rem"><div><label>Key</label>' +
      '<input class="x-k" placeholder="confluenceSpace"></div>' +
      '<div><label>Value</label><input class="x-v"></div></div>');
  });
  document.getElementById("w-cancel").addEventListener("click", closeModal);

  document.getElementById("w-go").addEventListener("click", async (e) => {
    e.target.disabled = true;
    msg.innerHTML = "";
    const params = {};
    paramBox.querySelectorAll("input[data-param]").forEach(i => {
      if (i.value.trim()) params[i.dataset.param] = i.value.trim();
    });
    const ks = [].slice.call(extraBox.querySelectorAll(".x-k"));
    const vs = [].slice.call(extraBox.querySelectorAll(".x-v"));
    ks.forEach((k, i) => { if (k.value.trim()) params[k.value.trim()] = vs[i].value.trim(); });
    try {
      const issue = await send("/issues", "POST", { workflow: sel.value, params: params });
      closeModal();
      location.hash = "#issue/" + issue.id;
      route();
    } catch (err) {
      msg.innerHTML = '<span class="err">' + esc(err.message) + '</span>';
      e.target.disabled = false;
    }
  });
}

/* ---- runs --------------------------------------------------------------- */
async function allRuns() {
  const issues = await api("/issues");
  const byId = {};
  issues.forEach(i => { byId[i.id] = i; });
  const lists = await Promise.all(issues.map(i => api("/issues/" + i.id + "/runs").catch(() => [])));
  const runs = [].concat.apply([], lists)
    .sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)));
  return { runs: runs, byId: byId };
}

async function renderRuns() {
  setHead("Runs", "Every agent process this orchestrator has spawned, newest first.");
  const both = await allRuns();
  const agents = await api("/agents").catch(() => []);
  const agentName = {};
  agents.forEach(a => { agentName[a.id] = a.key; });

  if (!both.runs.length) {
    view.innerHTML = '<div class="empty"><b>No runs yet</b>' +
      'A run appears the moment a workflow reaches an agent step. Start one with <b>+ New run</b>, ' +
      'from the chatbot, or with <span class="mono">npm run orch -- run &lt;workflow&gt; --project &lt;P&gt;</span>.</div>';
    return;
  }

  // Attempts per step, so a retry is legible as a retry rather than as two
  // unexplained runs a second apart.
  const seq = {};
  const ordered = both.runs.slice().sort((a, b) => String(a.started_at).localeCompare(String(b.started_at)));
  ordered.forEach(r => {
    const k = r.issue_id + ":" + r.step_index;
    seq[k] = (seq[k] || 0) + 1;
    r._attempt = seq[k];
  });

  view.innerHTML = '<div class="tablewrap"><div class="scroll-x"><table>' +
    '<thead><tr><th>Started</th><th>Issue</th><th>Agent</th><th>Phase</th><th>State</th>' +
    '<th class="num">Duration</th><th class="num">Tokens</th><th class="num">Cost</th></tr></thead><tbody>' +
    both.runs.map(r => '<tr class="clickable" data-run="' + esc(r.id) + '">' +
      '<td>' + esc(ago(r.started_at)) + '</td>' +
      '<td class="mono">' + esc(both.byId[r.issue_id] ? both.byId[r.issue_id].identifier : "—") + '</td>' +
      '<td class="mono">' + esc(agentName[r.agent_id] || "—") + '</td>' +
      '<td>' + esc(r.phase || "—") +
        (r._attempt > 1 ? ' <span class="muted mono" style="font-size:.7rem">attempt ' + r._attempt + '</span>' : "") + '</td>' +
      '<td>' + st(r.status) + '</td>' +
      '<td class="num">' + esc(dur(r.duration_ms)) + '</td>' +
      '<td class="num">' + num(r.input_tokens) + "+" + num(r.output_tokens) + '</td>' +
      '<td class="num">' + esc(money(r.cost_usd)) + '</td></tr>').join("") +
    '</tbody></table></div></div>';

  on("tr[data-run]", "click", (e) => { location.hash = "#run/" + e.currentTarget.dataset.run; });
}

/**
 * The live transcript. Polls /runs/:id/transcript with the offset the previous
 * poll returned, so each request carries only what is new — the same
 * incremental contract the chatbot's Live Transcript pane uses, against the
 * same filter module.
 */
async function renderRun(runId) {
  const run = await api("/runs/" + runId);
  setHead("Run", esc(run.phase || "agent run"));
  view.innerHTML =
    '<div class="card"><div class="wrap" style="justify-content:space-between">' +
      '<div><h3 style="margin:0">' + esc(run.phase || "Agent run") + '</h3>' +
      '<span class="muted mono" style="font-size:.72rem">' + esc(runId) + '</span></div>' +
      '<div class="wrap">' +
        (run.issue_id ? '<button class="ghost sm" id="toissue">Open issue</button>' : "") +
        '<button class="ghost sm" id="raw">Raw log</button></div>' +
    '</div>' +
    '<div class="grid" style="margin-top:.9rem">' +
      '<div class="metric"><div class="l">state</div><div class="v" style="font-size:1rem">' + st(run.status) + '</div></div>' +
      '<div class="metric"><div class="l">duration</div><div class="v">' + esc(dur(run.duration_ms)) + '</div></div>' +
      '<div class="metric"><div class="l">cost</div><div class="v">' + esc(money(run.cost_usd)) + '</div></div>' +
      '<div class="metric"><div class="l">turns</div><div class="v">' + num(run.num_turns) + '</div></div>' +
      '<div class="metric"><div class="l">tokens in / out</div><div class="v" style="font-size:1.05rem">' +
        num(run.input_tokens) + " / " + num(run.output_tokens) + '</div></div>' +
    '</div></div>' +
    '<h2 style="margin-top:1.4rem">Transcript</h2><div id="transcript"></div>';

  const box = document.getElementById("transcript");
  document.getElementById("raw").addEventListener("click", () => window.open("/runs/" + runId + "/log", "_blank"));
  const toIssue = document.getElementById("toissue");
  if (toIssue) toIssue.addEventListener("click", () => { location.hash = "#issue/" + run.issue_id; });

  let offset = 0;
  const tick = async () => {
    const out = await api("/runs/" + runId + "/transcript?offset=" + offset);
    offset = out.nextOffset;
    if (out.events.length) {
      const stick = box.scrollTop + box.clientHeight >= box.scrollHeight - 40;
      box.insertAdjacentHTML("beforeend", out.events.map(e => {
        const text = e.kind === "tool_use" ? e.tool + ": " + e.preview
          : e.kind === "skill" ? "skill " + e.name
          : (e.text == null ? (e.preview == null ? "" : e.preview) : e.text);
        return '<div class="' + esc(e.kind) + '"><span class="ts">' + esc(e.ts) + '</span>  ' + esc(text) + '</div>';
      }).join(""));
      if (stick) box.scrollTop = box.scrollHeight;
    }
    const fresh = await api("/runs/" + runId);
    if (fresh.finished_at) stopPolling();
  };
  await tick();
  if (!box.innerHTML) box.innerHTML = '<span class="muted">Nothing logged yet.</span>';
  if (!run.finished_at) poll = setInterval(() => { tick().catch(stopPolling); }, 3000);
}

/* ---- issues -------------------------------------------------------------- */
async function renderIssues() {
  setHead("Issues", "One issue is one workflow run — a stage, a revision, or a project baseline.");
  await config();
  const issues = await api("/issues");
  if (!issues.length) {
    view.innerHTML = '<div class="empty"><b>Nothing in flight</b>' +
      'Start one with <b>+ New run</b>, or from the chatbot.</div>';
    return;
  }
  // What needs a person comes first; then what is broken; then everything else
  // by recency. An operator opening this tab is looking for their own queue.
  const rank = { in_review: 0, blocked: 1, in_progress: 2, todo: 3, done: 4 };
  issues.sort((a, b) => {
    const d = (rank[a.status] == null ? 9 : rank[a.status]) - (rank[b.status] == null ? 9 : rank[b.status]);
    return d !== 0 ? d : String(b.updated_at || b.created_at).localeCompare(String(a.updated_at || a.created_at));
  });

  view.innerHTML = '<div class="stack">' + issues.map(i =>
    '<button class="rowcard" data-issue="' + esc(i.id) + '">' +
      '<div class="line1"><span class="id">' + esc(i.identifier) + '</span>' +
      '<span class="ttl">' + esc(i.title) + '</span>' + st(i.status) + '</div>' +
      '<div class="line2"><span>' + esc(i.workflow_key || "—") + '</span><span>·</span>' +
      '<span>' + esc(stepName(i)) + '</span><span>·</span><span>' + esc(ago(i.updated_at || i.created_at)) + '</span></div>' +
      stepBar(i) +
    '</button>').join("") + '</div>';

  on("button[data-issue]", "click", (e) => { location.hash = "#issue/" + e.currentTarget.dataset.issue; });
}

/**
 * One issue, in full: why it is where it is, what it produced, what it cost,
 * and what a person can do about it. This is the view whose absence meant the
 * Issues tab could tell you an issue was blocked but never why.
 */
async function renderIssue(id) {
  await config();
  const issue = await api("/issues/" + id);
  const rest = await Promise.all([
    api("/issues/" + id + "/comments").catch(() => []),
    api("/issues/" + id + "/work-products").catch(() => []),
    api("/issues/" + id + "/gates").catch(() => []),
    api("/issues/" + id + "/runs").catch(() => []),
    api("/agents").catch(() => []),
  ]);
  const comments = rest[0], products = rest[1], gates = rest[2], runs = rest[3], agents = rest[4];

  const agentName = {}, agentKey = {};
  agents.forEach(a => { agentName[a.id] = a.name; agentKey[a.id] = a.key; });
  const wf = workflowOf(issue.workflow_key);
  const spend = runs.reduce((n, r) => n + Number(r.cost_usd || 0), 0);
  const pending = gates.filter(g => g.status === "pending");
  const params = (issue.params && typeof issue.params === "object") ? issue.params : {};

  setHead(issue.identifier + " · " + issue.title, (issue.workflow_key || "") + " · " + stepName(issue));

  const detailRow = (k, v) =>
    '<div style="display:flex;gap:.6rem;padding:.3rem 0;border-bottom:1px solid var(--border)">' +
    '<span class="muted" style="min-width:6.5rem;font-size:.78rem">' + esc(k) + '</span>' +
    '<span class="mono" style="font-size:.78rem;word-break:break-word">' + v + '</span></div>';

  view.innerHTML =
    '<div class="card' + (issue.status === "blocked" ? " fault" : (pending.length ? " attention" : "")) + '">' +
      '<div class="wrap" style="justify-content:space-between;align-items:flex-start">' +
        '<div><div class="wrap"><span class="mono muted" style="font-weight:700">' + esc(issue.identifier) + '</span>' +
          st(issue.status) + '</div>' +
          '<h3 style="margin:.35rem 0 0;font-size:1.05rem">' + esc(issue.title) + '</h3></div>' +
        '<div class="wrap">' +
          ((issue.status === "blocked" || issue.status === "todo")
            ? '<button id="i-resume">Resume</button>' : "") +
          '<button class="ghost" id="i-del">Delete</button>' +
        '</div>' +
      '</div>' +
      stepBar(issue) +
      '<div class="muted mono" style="font-size:.74rem;margin-top:.4rem">' + esc(stepName(issue)) + '</div>' +
      '<div id="i-msg" style="margin-top:.5rem"></div>' +
    '</div>' +

    '<div class="split2">' +

      // ---- left column
      '<div>' +
        (pending.length
          ? '<h2>Awaiting your approval</h2>' + pending.map(g =>
              '<div class="card attention"><h3>' + esc(g.payload && g.payload.title ? g.payload.title : "Approval") + '</h3>' +
              (g.payload && g.payload.summary ? '<pre class="block">' + esc(g.payload.summary) + '</pre>' : "") +
              '<label for="n-' + esc(g.id) + '">Note (required to reject)</label>' +
              '<textarea id="n-' + esc(g.id) + '" placeholder="What needs to change?"></textarea>' +
              '<div class="actions"><button class="approve" data-approve="' + esc(g.id) + '">Approve</button>' +
              '<button class="danger" data-reject="' + esc(g.id) + '">Reject</button>' +
              '<span class="hint" style="margin:0">Approving publishes. Rejecting rewinds to the generating step.</span></div></div>').join("")
          : "") +

        '<h2>Activity</h2>' +
        (comments.length
          ? '<div class="card"><ul class="tl">' + comments.map(c =>
              '<li class="' + (c.author_agent_id ? "" : "sys") + '">' +
              '<div class="who">' + esc(c.author_agent_id ? (agentName[c.author_agent_id] || "agent") : (c.author_user || "orchestrator")) +
              ' · ' + esc(ago(c.created_at)) + '</div>' +
              '<div class="body">' + mdlite(c.body) + '</div></li>').join("") + '</ul></div>'
          : '<div class="empty"><b>No activity yet</b>Comments from the engine and its agents land here.</div>') +

        '<h2>Runs</h2>' +
        (runs.length
          ? '<div class="tablewrap"><div class="scroll-x"><table><thead><tr><th>Started</th><th>Step</th><th>Phase</th>' +
            '<th>Agent</th><th>State</th><th class="num">Duration</th><th class="num">Cost</th></tr></thead><tbody>' +
            runs.map((r, ix) => '<tr class="clickable" data-run="' + esc(r.id) + '">' +
              '<td>' + esc(ago(r.started_at)) + '</td><td class="num">' + esc(r.step_index) + '</td>' +
              '<td>' + esc(r.phase || "—") + '</td>' +
              '<td class="mono">' + esc(agentKey[r.agent_id] || "—") + '</td>' +
              '<td>' + st(r.status) + '</td><td class="num">' + esc(dur(r.duration_ms)) + '</td>' +
              '<td class="num">' + esc(money(r.cost_usd)) + '</td></tr>').join("") +
            '</tbody></table></div></div>' +
            '<p class="hint">' + esc(money(spend)) + ' across ' + num(runs.length) + ' run(s) on this issue.</p>'
          : '<div class="empty"><b>No runs</b>This issue has not reached an agent step yet.</div>') +
      '</div>' +

      // ---- right column
      '<div>' +
        '<h2>Detail</h2><div class="card">' +
          detailRow("workflow", esc(issue.workflow_key || "—") + (wf ? ' <span class="muted">(' + esc(wf.label) + ')</span>' : "")) +
          detailRow("assignee", esc(agentName[issue.assignee_agent_id] || "—")) +
          detailRow("spend", esc(money(spend))) +
          detailRow("created", esc(when(issue.created_at))) +
          detailRow("updated", esc(when(issue.updated_at))) +
          detailRow("id", esc(issue.id)) +
        '</div>' +

        '<h2>Parameters</h2><div class="card">' +
          (Object.keys(params).length
            ? Object.keys(params).map(k => detailRow(k, esc(String(params[k])))).join("")
            : '<span class="muted" style="font-size:.82rem">None.</span>') +
        '</div>' +

        '<h2>Work products</h2>' +
        (products.length
          ? '<div class="card stack">' + products.map(p =>
              '<div><div style="font-weight:600;font-size:.82rem">' + esc(p.title) + '</div>' +
              '<div class="wrap" style="gap:.35rem;margin-top:.2rem">' +
              '<span class="mono muted" style="font-size:.7rem;word-break:break-all;flex:1">' +
                esc(String(p.url).replace(/^file:\\/\\//, "")) + '</span>' +
              '<button class="ghost sm" data-copy="' + esc(String(p.url).replace(/^file:\\/\\//, "")) + '">Copy path</button>' +
              '</div></div>').join("") + '</div>'
          : '<div class="empty" style="padding:1.5rem 1rem"><b>Nothing attached</b>' +
            'The attach step records outputs here once the stage produces them.</div>') +

        (gates.length > pending.length
          ? '<h2>Decided gates</h2><div class="card stack">' + gates.filter(g => g.status !== "pending").map(g =>
              '<div><div class="wrap">' + st(g.status) +
              '<span style="font-size:.8rem;font-weight:600">' + esc(g.payload && g.payload.title ? g.payload.title : "Approval") + '</span></div>' +
              (g.note ? '<div class="muted" style="font-size:.78rem;margin-top:.2rem">' + esc(g.note) + '</div>' : "") +
              '</div>').join("") + '</div>'
          : "") +
      '</div>' +
    '</div>';

  const msg = document.getElementById("i-msg");
  const fail = (e) => { msg.innerHTML = '<span class="err">' + esc(e.message) + '</span>'; };

  const resume = document.getElementById("i-resume");
  if (resume) resume.addEventListener("click", async () => {
    resume.disabled = true;
    msg.innerHTML = '<span class="muted" style="font-size:.8rem">Resuming — an agent step can take tens of minutes. This view refreshes.</span>';
    try { await send("/issues/" + id + "/advance", "POST"); setTimeout(route, 1200); }
    catch (e) { fail(e); resume.disabled = false; }
  });

  document.getElementById("i-del").addEventListener("click", async () => {
    if (!confirm("Delete " + issue.identifier + " and everything under it? " +
                 "Its comments, work products, gates and run history go too. This cannot be undone.")) return;
    try { await send("/issues/" + id, "DELETE"); location.hash = "#issues"; route(); }
    catch (e) { fail(e); }
  });

  on("button[data-copy]", "click", (e) => {
    const b = e.currentTarget;
    navigator.clipboard.writeText(b.dataset.copy).then(() => {
      b.textContent = "Copied";
      setTimeout(() => { b.textContent = "Copy path"; }, 1400);
    }).catch(() => { b.textContent = "Copy failed"; });
  });

  on("tr[data-run]", "click", (e) => { location.hash = "#run/" + e.currentTarget.dataset.run; });
  wireGateButtons(msg);
}

/* Approve / reject, shared by the Gates tab and the issue detail. The note is
   a textarea rather than window.prompt(): a rejection note is the entire
   instruction the regenerating agent receives, and a one-line prompt box that
   loses its contents on a stray Escape is the wrong tool for it. */
function wireGateButtons(msgEl) {
  const decide = async (btn, id, verb) => {
    const note = (document.getElementById("n-" + id) || {}).value || "";
    if (verb === "reject" && !note.trim()) {
      if (msgEl) msgEl.innerHTML = '<span class="err">A rejection needs a note — it is what the agent is asked to fix.</span>';
      return;
    }
    btn.disabled = true;
    try {
      await send("/gates/" + id + "/" + verb, "POST", { by: "console", note: note });
      setTimeout(route, 1200);
    } catch (e) {
      if (msgEl) msgEl.innerHTML = '<span class="err">' + esc(e.message) + '</span>';
      btn.disabled = false;
    }
  };
  on("button[data-approve]", "click", (e) => decide(e.currentTarget, e.currentTarget.dataset.approve, "approve"));
  on("button[data-reject]", "click", (e) => decide(e.currentTarget, e.currentTarget.dataset.reject, "reject"));
}

/* ---- gates --------------------------------------------------------------- */
async function renderGates() {
  setHead("Gates", "Everything parked on a human decision.");
  const issues = await api("/issues");
  const lists = await Promise.all(issues.map(async i => {
    const gs = await api("/issues/" + i.id + "/gates").catch(() => []);
    return gs.filter(g => g.status === "pending").map(g => ({ g: g, i: i }));
  }));
  const pending = [].concat.apply([], lists);

  if (!pending.length) {
    view.innerHTML = '<div class="empty"><b>Nothing waiting for you</b>' +
      'A gate appears here when a stage has produced its files and needs a person before it publishes.</div>';
    return;
  }
  view.innerHTML = '<div class="stack">' + pending.map(p =>
    '<div class="card attention">' +
      '<div class="wrap" style="justify-content:space-between">' +
        '<h3 style="margin:0">' + esc(p.g.payload && p.g.payload.title ? p.g.payload.title : "Approval") + '</h3>' +
        '<button class="ghost sm" data-open="' + esc(p.i.id) + '">Open issue</button></div>' +
      '<div class="muted mono" style="font-size:.74rem;margin-top:.2rem">' +
        esc(p.i.identifier) + ' · ' + esc(p.i.title) + '</div>' +
      (p.g.payload && p.g.payload.summary ? '<pre class="block">' + esc(p.g.payload.summary) + '</pre>' : "") +
      '<label for="n-' + esc(p.g.id) + '">Note (required to reject)</label>' +
      '<textarea id="n-' + esc(p.g.id) + '" placeholder="What needs to change?"></textarea>' +
      '<div class="actions"><button class="approve" data-approve="' + esc(p.g.id) + '">Approve</button>' +
      '<button class="danger" data-reject="' + esc(p.g.id) + '">Reject</button>' +
      '<span id="g-msg-' + esc(p.g.id) + '"></span></div>' +
    '</div>').join("") + '</div>' +
    '<div id="g-msg" style="margin-top:.6rem"></div>';

  on("button[data-open]", "click", (e) => { location.hash = "#issue/" + e.currentTarget.dataset.open; });
  wireGateButtons(document.getElementById("g-msg"));
}

/* ---- org chart -----------------------------------------------------------
   A real top-down chart, and every node carries live state: what that agent is
   doing right now, what it has cost, how many runs it has. An org chart that
   only draws reporting lines is a diagram; this one is an instrument. */
async function renderOrg(selected) {
  setHead("Org", "Who exists, who they report to, and what each one is doing right now.");
  const c = await config();
  const both = await Promise.all([api("/agents"), api("/issues").catch(() => [])]);
  const agents = both[0], issues = both[1];

  const runLists = await Promise.all(agents.map(a => api("/agents/" + a.key + "/runs").catch(() => [])));
  const stats = {};
  agents.forEach((a, ix) => {
    const rs = runLists[ix];
    stats[a.key] = {
      runs: rs.length,
      cost: rs.reduce((n, r) => n + Number(r.cost_usd || 0), 0),
      running: rs.some(r => !r.finished_at),
      last: rs.length ? rs[0] : null,
    };
  });
  // An agent is "blocked" when an issue assigned to it is blocked — the agent
  // itself has no status of its own beyond enabled/disabled.
  const blockedFor = {};
  issues.forEach(i => {
    if (i.status !== "blocked") return;
    const a = agents.find(x => x.id === i.assignee_agent_id);
    if (a) blockedFor[a.key] = (blockedFor[a.key] || 0) + 1;
  });

  const byId = {};
  agents.forEach(a => { byId[a.id] = a; });
  const children = {}, roots = [];
  agents.forEach(a => {
    const parent = a.reports_to && byId[a.reports_to] ? byId[a.reports_to].key : null;
    if (parent) { (children[parent] = children[parent] || []).push(a); } else { roots.push(a); }
  });

  const initials = (name) => String(name).split(/\\s+/).map(w => w[0]).join("").slice(0, 2).toUpperCase();

  const node = (a) => {
    const s = stats[a.key] || { runs: 0, cost: 0, running: false };
    const isBlocked = !!blockedFor[a.key];
    const cls = (a.status === "disabled" ? "off" : (s.running ? "running" : (isBlocked ? "blocked" : "")));
    return '<li><button class="node ' + cls + (a.key === selected ? " on" : "") +
      '" data-agent="' + esc(a.key) + '" title="' + esc(a.title || a.name) + '">' +
      '<span class="av">' + esc(initials(a.name)) + '<span class="live"></span></span>' +
      '<span class="who"><span class="n">' + esc(a.name) + '</span>' +
      '<span class="k">' + esc(a.key) +
        (s.cost > 0 ? ' · ' + esc(money(s.cost)) : "") + '</span></span>' +
      '</button>' +
      (children[a.key] && children[a.key].length
        ? '<ul>' + children[a.key].map(node).join("") + '</ul>' : "") + '</li>';
  };

  const active = agents.filter(a => a.status !== "disabled").length;
  view.innerHTML =
    '<div class="wrap" style="justify-content:space-between;margin-bottom:.9rem">' +
      '<div class="legend">' +
        '<span><i style="background:var(--info)"></i>running</span>' +
        '<span><i style="background:var(--danger)"></i>blocked</span>' +
        '<span><i style="background:var(--muted)"></i>idle</span>' +
        '<span class="mono">' + active + ' active · ' + (agents.length - active) + ' disabled · defaults ' +
          esc(c.defaults.model || "—") + ' / ' + esc(c.defaults.adapter) + '</span>' +
      '</div>' +
      '<button class="ghost" id="hire">+ Add agent</button>' +
    '</div>' +
    '<div class="chartwrap"><ul class="chart">' + roots.map(node).join("") + '</ul></div>' +
    '<div id="detail">' + (selected ? "" :
      '<div class="empty"><b>Pick an agent</b>Its runtime, budget, spend and instructions open here.</div>') + '</div>';

  on(".node[data-agent]", "click", (e) => { location.hash = "#agent/" + e.currentTarget.dataset.agent; });
  document.getElementById("hire").addEventListener("click", renderHireForm);
  if (selected) await renderAgent(selected, document.getElementById("detail"));
}

function renderHireForm() {
  const d = document.getElementById("detail");
  Promise.all([api("/agents"), api("/runners")]).then(both => {
    const agents = both[0], runners = both[1];
    d.innerHTML = '<div class="card"><h3>Add an agent</h3>' +
      '<p class="hint">Saved to <span class="mono">.orchestrator/overrides.json</span>, merged over ' +
      '<span class="mono">orchestrator.config.ts</span> on every boot.</p>' +
      '<div class="row">' +
      '<div><label for="f-key">Key</label><input id="f-key" placeholder="securityReviewer"></div>' +
      '<div><label for="f-name">Name</label><input id="f-name" placeholder="Security Reviewer"></div>' +
      '<div><label for="f-title">Title</label><input id="f-title"></div>' +
      '<div><label for="f-reports">Reports to</label><select id="f-reports"><option value="">— nobody —</option>' +
        agents.map(a => '<option value="' + esc(a.key) + '">' + esc(a.name) + '</option>').join("") + '</select></div>' +
      '<div><label for="f-adapter">Adapter</label><select id="f-adapter">' +
        runners.map(r => '<option>' + esc(r) + '</option>').join("") + '</select></div>' +
      '<div><label for="f-model">Model</label><input id="f-model" placeholder="claude-sonnet-4-6"></div>' +
      '<div><label for="f-effort">Effort</label><select id="f-effort"><option value="">default</option>' +
        ["low", "medium", "high", "xhigh", "max"].map(e => '<option>' + e + '</option>').join("") + '</select></div>' +
      '<div><label for="f-bundle">Bundle path</label><input id="f-bundle" placeholder="agent-instructions/x.thin.md"></div>' +
      '</div>' +
      '<div class="actions"><button id="f-save">Add agent</button>' +
      '<button class="ghost" id="f-cancel">Cancel</button><span id="f-msg"></span></div></div>';
    d.scrollIntoView({ block: "nearest" });

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
      try {
        const out = await send("/agents", "POST", body);
        location.hash = "#agent/" + out.key;
        route();
      } catch (e) {
        document.getElementById("f-msg").innerHTML = '<span class="err">' + esc(e.message) + '</span>';
      }
    });
  });
}

/** One agent: its runtime config (editable), its bundle, its spend, its runs. */
async function renderAgent(key, target) {
  // target is the org tab's detail pane. Falls back to the main view so the
  // page still works when someone lands on an agent hash directly from a link.
  const out = target || view;
  const all = await Promise.all([
    api("/agents/" + key), config(), api("/runners"),
    api("/agents/" + key + "/runs").catch(() => []),
    api("/budgets").catch(() => []),
  ]);
  const agent = all[0], cfg = all[1], runners = all[2], runs = all[3], budgets = all[4];
  const b = budgets.find(x => x.scope === "agent" && x.scope_key === key) || {};
  const spend = runs.reduce((n, r) => n + Number(r.cost_usd || 0), 0);
  const sel = (opts, cur) => opts.map(o =>
    '<option value="' + esc(o) + '"' + (o === cur ? " selected" : "") + '>' + esc(o || "default") + '</option>').join("");

  out.innerHTML =
    '<h2>' + esc(agent.name) + '</h2>' +
    '<div class="card"><div class="wrap" style="justify-content:space-between">' +
      '<div><h3 style="margin:0">' + esc(agent.name) +
        ' <span class="muted mono" style="font-weight:400">' + esc(agent.key) + '</span></h3>' +
        '<span class="muted" style="font-size:.82rem">' + esc(agent.title || "") + '</span></div>' +
      '<div class="wrap">' + (agent.status === "disabled" ? st("disabled") : "") +
        (agent.bundle_path ? '<button class="ghost sm" id="a-bundle">Instructions</button>' : "") +
      '</div></div>' +
      '<div class="grid" style="margin-top:.9rem">' +
        '<div class="metric"><div class="l">spend</div><div class="v">' + esc(money(spend)) + '</div>' +
          '<div class="s">' + num(runs.length) + ' run(s)</div></div>' +
        '<div class="metric"><div class="l">mcp</div><div class="v" style="font-size:1rem">' +
          (agent.mcp_enabled ? "enabled" : "off") + '</div></div>' +
        '<div class="metric"><div class="l">effective model</div><div class="v" style="font-size:.95rem">' +
          esc(agent.model || cfg.defaults.model || "CLI default") + '</div></div>' +
      '</div>' +
    '</div>' +

    '<div class="card"><h3>Runtime</h3>' +
      '<div class="row">' +
      '<div><label for="a-adapter">Adapter</label><select id="a-adapter">' + sel(runners, agent.adapter) + '</select></div>' +
      '<div><label for="a-model">Model</label><input id="a-model" value="' + esc(agent.model || "") +
        '" placeholder="' + esc(cfg.defaults.model || "default") + '"></div>' +
      '<div><label for="a-effort">Effort</label><select id="a-effort">' +
        sel(["", "low", "medium", "high", "xhigh", "max"], agent.effort || "") + '</select></div>' +
      '<div><label for="a-fallback">Fallback models (comma separated)</label>' +
        '<input id="a-fallback" value="' + esc((agent.fallback_model || []).join(", ")) + '"></div>' +
      '</div>' +
      '<h3 style="margin-top:1.1rem">Budget — a ceiling, not a target</h3>' +
      '<div class="row">' +
      '<div><label for="a-tokens">Max tokens</label><input id="a-tokens" type="number" value="' + esc(plain(b.max_tokens)) + '"></div>' +
      '<div><label for="a-cost">Max cost (USD)</label><input id="a-cost" type="number" step="0.01" value="' + esc(plain(b.max_cost_usd)) + '"></div>' +
      '<div><label for="a-mins">Max duration (minutes)</label><input id="a-mins" type="number" value="' +
        esc(b.max_duration_ms ? Math.round(Number(b.max_duration_ms) / 60000) : "") + '"></div>' +
      '</div>' +
      '<div class="actions"><button id="a-save">Save</button>' +
      (agent.status === "disabled" ? "" : '<button class="danger" id="a-disable">Disable agent</button>') +
      '<span id="a-msg"></span></div>' +
      '<p class="hint" style="margin-top:.7rem">Saved to <span class="mono">.orchestrator/overrides.json</span>, ' +
      'which is merged over <span class="mono">orchestrator.config.ts</span> on every boot — so it survives a restart. ' +
      'Delete that file to go back to the committed defaults.</p>' +
    '</div>' +

    (runs.length
      ? '<h2>Runs</h2><div class="tablewrap"><div class="scroll-x"><table><thead><tr><th>Started</th><th>Phase</th>' +
        '<th>State</th><th class="num">Duration</th><th class="num">Cost</th></tr></thead><tbody>' +
        runs.map(r => '<tr class="clickable" data-run="' + esc(r.id) + '"><td>' + esc(ago(r.started_at)) +
          '</td><td>' + esc(r.phase || "—") + '</td><td>' + st(r.status) + '</td><td class="num">' +
          esc(dur(r.duration_ms)) + '</td><td class="num">' + esc(money(r.cost_usd)) + '</td></tr>').join("") +
        '</tbody></table></div></div>'
      : '<div class="empty" style="margin-top:1rem"><b>Never run</b>Its spend and transcripts appear here after its first run.</div>');

  on("tr[data-run]", "click", (e) => { location.hash = "#run/" + e.currentTarget.dataset.run; }, out);
  const bundleBtn = document.getElementById("a-bundle");
  if (bundleBtn) bundleBtn.addEventListener("click", () => { location.hash = "#bundle/" + key; });

  const msg = document.getElementById("a-msg");
  document.getElementById("a-save").addEventListener("click", async () => {
    const v = (id) => document.getElementById(id).value.trim();
    const body = {
      adapter: v("a-adapter"),
      fallbackModel: v("a-fallback") ? v("a-fallback").split(",").map(x => x.trim()).filter(Boolean) : [],
    };
    if (v("a-model")) body.model = v("a-model");
    if (v("a-effort")) body.effort = v("a-effort");
    try {
      await send("/agents/" + key, "PATCH", body);
      // The budget lives in its own table (the engine reads workflow-then-agent),
      // so it is a second call rather than a field on the agent.
      const budget = { scope: "agent", scopeKey: key };
      if (v("a-tokens")) budget.maxTokens = Number(v("a-tokens"));
      if (v("a-cost")) budget.maxCostUsd = Number(v("a-cost"));
      if (v("a-mins")) budget.maxDurationMs = Number(v("a-mins")) * 60000;
      await send("/budgets", "POST", budget);
      msg.innerHTML = '<span class="saved">Saved — applies to the next run.</span>';
    } catch (e) {
      msg.innerHTML = '<span class="err">' + esc(e.message) + '</span>';
    }
  });

  const disable = document.getElementById("a-disable");
  if (disable) disable.addEventListener("click", async () => {
    if (!confirm("Disable " + agent.name + "? Its history is kept; it leaves the org chart.")) return;
    try { await send("/agents/" + key, "DELETE"); location.hash = "#org"; route(); }
    catch (e) { msg.innerHTML = '<span class="err">' + esc(e.message) + '</span>'; }
  });
}

/**
 * An agent's system-prompt bundle, read off disk at request time — the same
 * bytes the runner will hand the process. Previously routed to but never
 * implemented, so the Instructions link threw.
 */
async function renderBundle(key) {
  setHead("Instructions", key);
  const bundle = await api("/agents/" + key + "/bundle");
  view.innerHTML =
    '<div class="card"><div class="wrap" style="justify-content:space-between">' +
      '<div><h3 style="margin:0">' + esc(key) + '</h3>' +
      '<span class="muted mono" style="font-size:.74rem">' + esc(bundle.path || "no bundle configured") + '</span></div>' +
      '<button class="ghost sm" id="b-back">Back to org</button></div>' +
    (bundle.error
      ? '<p class="err" style="margin-top:.7rem">' + esc(bundle.error) + '</p>' +
        '<p class="hint">The agent declares this path but nothing is there. Claude Code fails fast with ' +
        '<span class="mono">System prompt file not found</span> before any network call, so the run costs nothing — ' +
        'but it will not start until the file exists or the path is cleared.</p>'
      : "") +
    '</div>' +
    (bundle.content
      ? '<pre class="block" style="margin-top:.8rem;max-height:70vh;overflow:auto">' + esc(bundle.content) + '</pre>'
      : (bundle.error ? "" : '<div class="empty"><b>No instructions</b>This agent runs on the bare workflow prompt.</div>'));
  document.getElementById("b-back").addEventListener("click", () => { location.hash = "#org"; });
}

/* ---- budgets ------------------------------------------------------------- */
async function renderBudgets() {
  setHead("Budgets", "A ceiling, not a target. Blank means no limit.");
  const all = await Promise.all([api("/agents"), api("/usage"), config(), api("/budgets")]);
  const agents = all[0], usage = all[1], cfg = all[2], budgets = all[3];
  const limit = (scope, key) => budgets.find(b => b.scope === scope && b.scope_key === key) || {};

  const perAgent = await Promise.all(agents.map(async a => {
    const runs = await api("/agents/" + a.key + "/runs").catch(() => []);
    return { key: a.key, runs: runs.length, cost: runs.reduce((n, r) => n + Number(r.cost_usd || 0), 0) };
  }));

  const mins = (ms) => ms ? Math.round(Number(ms) / 60000) : "";
  const limitRow = (scope, key, label, spendCell) => {
    const l = limit(scope, key);
    return '<tr data-scope="' + esc(scope) + '" data-key="' + esc(key) + '">' +
      '<td>' + esc(label) + '</td>' + spendCell +
      '<td><input class="b-tokens" type="number" aria-label="max tokens" value="' + esc(plain(l.max_tokens)) + '"></td>' +
      '<td><input class="b-cost" type="number" step="0.01" aria-label="max cost" value="' + esc(plain(l.max_cost_usd)) + '"></td>' +
      '<td><input class="b-mins" type="number" aria-label="max minutes" value="' + esc(mins(l.max_duration_ms)) + '"></td>' +
      '<td><button class="ghost sm b-save" disabled>Save</button></td></tr>';
  };

  view.innerHTML =
    '<div class="grid">' +
      '<div class="metric"><div class="l">total spend</div><div class="v">' + esc(money(usage.costUsd)) + '</div>' +
        '<div class="s">' + num(usage.runCount) + ' run(s)</div></div>' +
      '<div class="metric"><div class="l">tokens in</div><div class="v" style="font-size:1.2rem">' + num(usage.inputTokens) + '</div></div>' +
      '<div class="metric"><div class="l">tokens out</div><div class="v" style="font-size:1.2rem">' + num(usage.outputTokens) + '</div></div>' +
      '<div class="metric"><div class="l">cache read</div><div class="v" style="font-size:1.2rem">' + num(usage.cacheReadTokens) + '</div></div>' +
    '</div>' +
    '<p class="hint" style="margin-top:.8rem">Duration is enforced live — the process is killed. Tokens and cost are ' +
    'checked once the run ends and flag it ' + st("over_budget") + '. The engine reads the WORKFLOW limit first and ' +
    'falls back to the one on the agent. Cost figures come from Claude Code&rsquo;s own <span class="mono">result</span> ' +
    'event, not from a price table kept here.</p>' +

    '<h2>Per agent</h2><div class="tablewrap"><div class="scroll-x"><table>' +
    '<thead><tr><th>Agent</th><th>Spent</th><th class="num">Max tokens</th><th class="num">Max $</th>' +
    '<th class="num">Max min</th><th></th></tr></thead><tbody>' +
    agents.map(a => {
      const p = perAgent.find(x => x.key === a.key);
      return limitRow("agent", a.key, a.name,
        '<td class="mono">' + esc(money(p.cost)) + ' <span class="muted">(' + num(p.runs) + ')</span></td>');
    }).join("") + '</tbody></table></div></div>' +

    '<h2>Per workflow</h2><div class="tablewrap"><div class="scroll-x"><table>' +
    '<thead><tr><th>Workflow</th><th>Assignee</th><th class="num">Max tokens</th><th class="num">Max $</th>' +
    '<th class="num">Max min</th><th></th></tr></thead><tbody>' +
    cfg.workflows.map(w => limitRow("workflow", w.key, w.key,
      '<td class="mono muted">' + esc(w.assignee) + '</td>')).join("") +
    '</tbody></table></div></div>';

  on("tr[data-scope] input", "input", (e) => {
    const b = e.currentTarget.closest("tr").querySelector(".b-save");
    b.disabled = false;
  });

  on(".b-save", "click", async (e) => {
    const btn = e.currentTarget;
    const tr = btn.closest("tr");
    const g = (cls) => tr.querySelector("." + cls).value.trim();
    const body = { scope: tr.dataset.scope, scopeKey: tr.dataset.key };
    if (g("b-tokens")) body.maxTokens = Number(g("b-tokens"));
    if (g("b-cost")) body.maxCostUsd = Number(g("b-cost"));
    if (g("b-mins")) body.maxDurationMs = Number(g("b-mins")) * 60000;
    btn.disabled = true;
    try { await send("/budgets", "POST", body); btn.textContent = "Saved"; }
    catch (err) { btn.textContent = "Failed"; btn.disabled = false; }
    setTimeout(() => { btn.textContent = "Save"; }, 1600);
  });
}

/* ---- config -------------------------------------------------------------- */
async function renderConfig() {
  setHead("Config", "The loaded orchestrator config, reconciled from disk on every boot.");
  const c = await config();
  view.innerHTML =
    '<div class="grid">' +
      '<div class="metric"><div class="l">company</div><div class="v" style="font-size:1rem">' + esc(c.company) + '</div></div>' +
      '<div class="metric"><div class="l">adapters</div><div class="v" style="font-size:1rem">' + esc(c.adapters.join(", ")) + '</div></div>' +
      '<div class="metric"><div class="l">default model</div><div class="v" style="font-size:1rem">' +
        esc(c.defaults.model || "CLI default") + '</div></div>' +
      '<div class="metric"><div class="l">workflows</div><div class="v">' + num(c.workflows.length) + '</div></div>' +
    '</div>' +
    '<div class="card" style="margin-top:.8rem"><h3>Workspace</h3>' +
      '<span class="mono" style="font-size:.8rem;word-break:break-all">' + esc(c.workspace) + '</span></div>' +
    '<h2>Workflows</h2><div class="tablewrap"><div class="scroll-x"><table>' +
    '<thead><tr><th>Key</th><th>Label</th><th>Assignee</th><th class="num">Steps</th><th>Parameters</th></tr></thead><tbody>' +
    c.workflows.map(w => '<tr><td class="mono">' + esc(w.key) + '</td><td>' + esc(w.label) +
      '</td><td class="mono">' + esc(w.assignee) + '</td><td class="num">' + esc(w.steps) + '</td>' +
      '<td class="mono" style="font-size:.76rem">' + esc((w.params || []).join(", ") || "—") + '</td>' +
      '</tr>').join("") + '</tbody></table></div></div>' +
    '<p class="hint">Parameters are derived by scanning each workflow&rsquo;s own step templates, so they cannot ' +
    'drift from what the steps actually interpolate. <b>+ New run</b> builds its form from this list.</p>';
}

/* ---- health -------------------------------------------------------------- */
async function renderHealth() {
  setHead("Health", "Runtime, queue and consumption.");
  const both = await Promise.all([api("/health"), api("/usage")]);
  const h = both[0], u = both[1];
  const q = h.queue || {};
  const m = (l, v, tone, sub) => '<div class="metric"><div class="l">' + l + '</div><div class="v"' +
    (tone ? ' style="color:var(--' + tone + ')"' : "") + '>' + v + '</div>' +
    (sub ? '<div class="s">' + sub + '</div>' : "") + '</div>';

  view.innerHTML =
    '<h2>Runtime</h2><div class="grid">' +
      (h.adapters || []).map(a => m(esc(a.key), '<span style="font-size:.95rem">' + esc(a.version) + '</span>',
        null, "adapter")).join("") +
      m("database", '<span style="font-size:.95rem">' + esc(h.db) + '</span>', null, "single-writer") +
    '</div>' +
    '<p class="hint">This is the provenance line: which agent runtime is on PATH and which database is holding ' +
    'state. PGlite is single-writer, so while this server is up the CLI verbs fail on the lock by design.</p>' +

    '<h2>Queue</h2><div class="grid">' +
      m("awaiting you", num(q.awaitingApproval), q.awaitingApproval > 0 ? "accent" : null, "needs a person") +
      m("running", num(q.inProgress), q.inProgress > 0 ? "info" : null) +
      m("queued", num(q.todo)) +
      m("blocked", num(q.blocked), q.blocked > 0 ? "danger" : null, "resume from the issue") +
      m("unfinished runs", num(h.unfinishedRuns), h.unfinishedRuns > 0 ? "danger" : null, "orphaned at next boot") +
    '</div>' +
    '<p class="hint">An unfinished run is one whose process died. It is marked orphaned and its issue re-queued at ' +
    'the next boot — orphan recovery runs once, at startup, and must never be put on a timer.</p>' +

    '<h2>Consumption</h2><div class="grid">' +
      m("spent", esc(money(u.costUsd)), null, "reported by the CLI") +
      m("runs", num(u.runCount)) +
      m("tokens in", num(u.inputTokens)) +
      m("tokens out", num(u.outputTokens)) +
      m("cache read", num(u.cacheReadTokens)) +
    '</div>' +
    '<p class="hint">Cost is not computed here and no price table is kept: every figure is the ' +
    '<span class="mono">total_cost_usd</span> Claude Code reports on its own final <span class="mono">result</span> ' +
    'event. A model the CLI does not price shows as &mdash; rather than as a guess.</p>' +

    '<h2>Self-healing</h2><div class="card"><p class="hint" style="margin:0">' +
    'A failed agent step is retried <b>once</b>, and only when the first attempt demonstrably spent nothing — ' +
    'no accounted tokens and under a minute of wall clock. Anything that ran to completion and failed on its own ' +
    'terms, exceeded its budget, or hit a configuration error blocks immediately instead: there, the retry is the ' +
    'expensive mistake. The blocking comment on the issue always says which of those applied.</p></div>';
}

/* ---- routing ------------------------------------------------------------- */
const ROUTES = { runs: renderRuns, issues: renderIssues, gates: renderGates,
                 org: renderOrg, budgets: renderBudgets, config: renderConfig, health: renderHealth };

// Which nav item lights up for a detail route. A run belongs to Runs, an
// agent and its bundle to Org, an issue to Issues — otherwise drilling in
// leaves the rail with nothing selected and you lose your place.
const OWNER = { run: "runs", issue: "issues", agent: "org", bundle: "org", "new": "runs" };

async function route() {
  stopPolling();
  closeModal();
  const hash = location.hash.slice(1) || "runs";
  const head = hash.split("/")[0];
  const tab = OWNER[head] || head;
  document.querySelectorAll("nav a").forEach(a => a.classList.toggle("on", a.dataset.tab === tab));
  try {
    if (hash.indexOf("run/") === 0) { await renderRun(hash.slice(4)); return; }
    if (hash.indexOf("issue/") === 0) { await renderIssue(hash.slice(6)); return; }
    if (hash.indexOf("bundle/") === 0) { await renderBundle(hash.slice(7)); return; }
    if (hash.indexOf("agent/") === 0) { await renderOrg(hash.slice(6)); return; }
    const fn = ROUTES[hash];
    if (!fn) {
      setHead("Not found", hash);
      view.innerHTML = '<div class="empty"><b>No such view</b>' +
        'Nothing is routed at <span class="mono">#' + esc(hash) + '</span>.</div>';
      return;
    }
    await fn();
  } catch (e) {
    setHead("Error", "");
    view.innerHTML = '<div class="card fault"><h3>Something went wrong</h3>' +
      '<p class="hint" style="margin:0">' + esc(e.message) + '</p></div>';
  }
}

/**
 * The status strip. It is the one thing on this page that is true regardless
 * of which view is open: what needs a human, what is running, what it has
 * cost. "Awaiting you" turns brass because it is the only state that will
 * never resolve itself; blocked turns red because it is a fault, not a
 * request. It also feeds the two nav badges, so the count is visible even
 * when the strip has scrolled out of a narrow viewport.
 */
async function renderStrip() {
  const strip = document.getElementById("strip");
  const dot = document.getElementById("dot"), dotlbl = document.getElementById("dotlbl");
  const badge = (tab, n, fault) => {
    const a = document.querySelector('nav a[data-tab="' + tab + '"]');
    if (!a) return;
    const old = a.querySelector(".badge");
    if (old) old.remove();
    if (n > 0) a.insertAdjacentHTML("beforeend",
      '<span class="badge' + (fault ? " fault" : "") + '">' + n + '</span>');
  };
  try {
    const both = await Promise.all([api("/health"), api("/usage")]);
    const h = both[0], u = both[1];
    const q = h.queue || {};
    const chip = (label, value, cls) =>
      '<div class="chip ' + (cls || "") + '"><span class="v">' + value +
      '</span><span class="l">' + label + '</span></div>';
    strip.innerHTML =
      chip("awaiting you", num(q.awaitingApproval), q.awaitingApproval > 0 ? "live" : "") +
      chip("running", num(q.inProgress), "") +
      chip("queued", num(q.todo), "") +
      chip("blocked", num(q.blocked), q.blocked > 0 ? "fault" : "") +
      chip("spent", money(u.costUsd), "");
    badge("gates", q.awaitingApproval, false);
    badge("issues", q.blocked, true);
    dot.classList.remove("down");
    dotlbl.textContent = "Orchestrator up";
    document.getElementById("env").textContent =
      (h.adapters || []).map(a => a.key + " " + a.version).join(" · ") + " · " + h.db;
  } catch (e) {
    strip.innerHTML = '<div class="chip fault"><span class="l">orchestrator unreachable</span></div>';
    dot.classList.add("down");
    dotlbl.textContent = "Unreachable";
    document.getElementById("env").textContent = "offline";
  }
}

document.getElementById("newrun").addEventListener("click", () => { newRunModal(null); });
window.addEventListener("hashchange", route);
renderStrip();
setInterval(renderStrip, 5000);
route();
</script>
</body>
</html>`;
}
