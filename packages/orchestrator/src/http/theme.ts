// The Scyne palette and the CSS it renders to. `Theme`'s SHAPE is already
// declared in ../config.ts (so config.ts can express `theme?: Partial<Theme>`
// without depending on this file, which doesn't exist until this task) — this
// module supplies the VALUES and the rendering, and must not redeclare the
// interface.

import type { Theme } from "../config.js";

/**
 * The Scyne wordmark, lifted from `scyne-chatbot/public/scyne-logo-ink.svg` so
 * the console and the chatbot show the same mark rather than two drawings of
 * the same company.
 *
 * Three changes from the source file, each load-bearing:
 *   - the `<defs><style>.cls-1{fill:#363C63}</style></defs>` block is gone. An
 *     inline SVG's `<style>` is NOT scoped to that SVG — `.cls-1` would leak
 *     into the page's global cascade and collide with anything else using it.
 *   - the fill is `currentColor`, so ONE copy serves both themes: ink in light,
 *     near-white in dark, decided by the CSS around it. The repo ships two
 *     files (`scyne-logo.svg` white, `-ink.svg` #363C63) that differ only in
 *     that fill; embedding both would be embedding the same paths twice.
 *   - the XML prolog is dropped, since this is inlined into HTML, not served.
 */
const SCYNE_WORDMARK = `<svg fill="currentColor" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 769.4 265.4"><path d="M0,191.3v-41.4H6c7,23.9,19.4,35.8,37.3,35.8,7.8,0,13.6-2.4,17.4-7.1,3.9-4.7,5.8-9.9,5.8-15.5,0-6.6-2.1-11.9-6.1-16.1-4.2-4.2-12.4-9.3-24.4-15.2-12.7-6.2-21.8-12.4-27.4-18.4C3.1,107.5,.3,100.1,.3,91.4s3-16.2,8.9-23.7c5.9-7.6,14.3-11.4,25.1-11.4s20,4.5,27.2,13.4c1.5-1.5,3.5-5.3,6-11.2h5.7v38.9h-5.7c-2.1-9.3-6.1-17.3-12-24-5.8-6.8-12.8-10.1-20.8-10.1-6.2,0-11.1,1.9-14.9,5.7s-5.7,8.2-5.7,13.2c0,5.5,2.1,10.3,6.3,14.3,4.1,4.1,11.9,8.8,23.5,14,17.4,7.9,28.1,15.6,32,23.1,3.9,7.6,5.8,14.9,5.8,21.8,0,11-3.6,19.9-10.9,26.8-7.2,6.9-16.2,10.3-27.2,10.3-11.6,0-21.9-4.8-30.9-14.3-2.8,3.1-5,7.5-6.8,13.2l-5.9-.1H0Z"/><path d="M204.7,156.6h6.8c-7,23.9-24.4,35.8-52.3,35.8-17.9,0-33.1-6.1-45.3-18.3-12.2-12.2-18.3-28.3-18.3-48.4s6.6-37.3,19.8-50.1,28.9-19.2,46.9-19.2c10.9,0,20.8,2.4,30,7.2,9.1,4.7,13.7,10.5,13.7,17.4,0,2.6-.9,5-2.6,7.2-1.6,2.2-4,3.4-7.2,3.4-6.8,0-10.9-3.9-12.5-11.8-1.2-5.9-3.1-10.1-5.7-12.4-2.7-2.4-7.8-3.5-15.5-3.5-13.7,0-24.1,4.8-31.1,14.3-6.9,9.5-10.3,23.9-10.3,43s3.7,35.2,11.1,46.4c7.5,11.2,18.8,16.8,33.8,16.8,20.3-.2,33.2-9.4,38.7-27.8h0Z"/><path d="M306.2,163.5l29.2-69.9c4.2-10.2,6.3-15.9,6.3-17.1,0-5.1-5.7-7.8-17.1-8v-7.1h44.3v7.1c-6.9,.3-11.9,2.1-15.1,5.5-3.2,3.3-7.1,10.6-11.8,22l-56.1,135.4c-5.3,12.9-10,21.7-14.1,26.3-4.1,4.7-8.6,7.1-13.5,7.1-6.7,0-10-3-10-9.1,0-7,5.3-12.9,16-17.7,6.2-2.8,10.4-5.1,12.5-7.1s4.2-5.5,6.3-10.6l12-30-47.4-101.4c-4.2-8.9-7.7-14.6-10.5-16.9s-7.5-3.5-14.1-3.5v-7.1h57.8v7.1c-10.1,.3-15.2,2.4-15.2,6.3,0,1.5,2,6.6,6,15.1l34.5,73.6h0Z"/><path d="M419.7,56.4h4.1c2.4,6.4,3.7,15,4,26,7.4-8.7,15.1-15.2,23.2-19.5,8.1-4.3,16.5-6.5,25.4-6.5,10,0,18.2,2.1,24.6,6.3,6.5,4.2,10.6,9.4,12.5,15.5,1.8,6.1,2.8,14.9,2.8,26.6v39.4c0,14.6,.3,23.4,.8,26.6s2.1,5.6,4.8,7.2c2.8,1.5,7.8,2.3,15.1,2.3v7.1h-64.4v-7.1h2.9c7.4,0,12.2-1.1,14.5-3.2,2.2-2.1,3.5-4.7,3.8-7.5,.3-2.9,.5-11.3,.5-25.4v-40.6c0-9.9-.5-17-1.5-21.2-.9-4.3-3.5-8.1-7.8-11.4-4.2-3.3-9.6-4.9-16.1-4.9-7.5,0-14.7,2.2-21.5,6.8-6.8,4.4-13.2,11.1-19.2,20v51.3c0,14.6,.3,23.4,.8,26.6,.6,3.2,2.3,5.6,4.9,7.2,2.8,1.5,7.8,2.3,15.2,2.3v7.1h-63.6v-7.1c7.1,0,12-.7,14.8-2.1s4.5-3.6,5.1-6.5c.7-3,1.1-12.1,1.1-27.5v-37.5c0-14.6-.3-23.5-.9-26.6-.5-3.2-2.1-5.5-4.9-7.1-2.7-1.6-7.7-2.5-15.1-2.5v-7.1c10.7-1.2,22.3-3.6,34.1-7h0Z"/><path d="M650.5,104h-87.8c-.4,6.1-.6,10.6-.6,13.5,0,22.1,3.4,38.8,10.3,50,7,11.1,17.3,16.6,31,16.6,18.7,0,31.9-8.4,39.7-25.1h7.4c-3.3,10.5-9.8,18.6-19.5,24.6-9.7,5.8-20.3,8.8-31.8,8.8-10.7,0-20.8-2.7-30.3-8-9.4-5.4-17.2-13.1-23.2-22.9-6-9.8-9.1-21.8-9.1-35.8,0-19.9,5.8-36.4,17.5-49.5,11.7-13.2,26.3-19.8,43.8-19.8,16.5,0,29.3,5,38.3,15.1,9,10,13.8,20.8,14.3,32.5h0Zm-26.9-6.1c.3-2.4,.5-4.5,.5-6.3,0-9-2.7-16-8-20.9-5.2-5-11.7-7.5-19.4-7.5-18.7,0-29.8,11.6-33.4,34.7h60.3Z"/><rect x="706.1" y="51.3" width="11.8" height="214.1"/><rect x="745.7" width="23.7" height="214.1"/></svg>`;

/**
 * The Scyne palette, taken from scyne-chatbot/tailwind.config.js — the curated
 * set, not a fresh extraction. `scripts/extract-brand.mjs` against
 * https://www.scyne.com.au/ on 2026-08-17 independently confirmed `brand`
 * (#464e7e, by CSS frequency). Its accent pick (#220054) was a gradient stop and
 * is deliberately not used.
 */
export const SCYNE_THEME: Theme = {
  brand:      "#464E7E",
  brandDeep:  "#363C63",
  line:       "#E7E9F0",
  accent:     "#C8A878",
  ink50:      "#EEF0F7",
  ink100:     "#D9DDEB",
  ink200:     "#B6BDD6",
  ink500:     "#5C6593",
  glow:       "#7C82C8",
  success:    "#10B981",
  warning:    "#F59E0B",
  danger:     "#F43F5E",
  info:       "#3B82F6",
  fontFamily: 'Arial, "Helvetica Neue", Helvetica, sans-serif',
  logoText:   "Scyne Orchestrator",
  logoSvg:    SCYNE_WORDMARK,
};

/**
 * Merge a consumer's override over the Scyne default. Naming only the tokens
 * that differ (e.g. `{ brand: "#1f4c71", logoText: "Acme Delivery" }`) keeps
 * every other token — a consumer never has to restate the whole palette to
 * rebrand one colour.
 */
export function resolveTheme(override: Partial<Theme> = {}): Theme {
  const t = { ...SCYNE_THEME, ...override };
  // A consumer who renames the product has rebranded. Leaving the Scyne
  // wordmark in place would put THEIR name under OUR mark — worse than no logo,
  // and not something they would notice until a client did. Supplying their own
  // `logoSvg` opts back in.
  if (override.logoText !== undefined && override.logoSvg === undefined) delete t.logoSvg;
  return t;
}

// camelCase → kebab-case for CSS custom property names. Handles BOTH kinds of
// transition the 15 Theme keys contain: a lowercase→uppercase boundary
// ("brandDeep" → "brand-Deep") and a letter→digit boundary ("ink500" →
// "ink-500", since the token scale suffixes — 50/100/200/500 — are digits,
// not capitals, and a naive `/[A-Z]/` swap alone leaves them glued to the
// word ahead of them).
const kebab = (k: string): string => k.replace(/([a-z])([A-Z0-9])/g, "$1-$2").toLowerCase();

/**
 * Render `t` as CSS custom properties. Tokens are declared on bare `:root`
 * (the light state) and then REDEFINED — not merely extended — under
 * `@media (prefers-color-scheme: dark)`. Both states are written out
 * explicitly: `scripts/audit-a11y.mjs` in the parent project records that
 * headless Chrome defaults to dark and that a palette can pass one state
 * while silently failing the other, so there is no "just don't set it and let
 * it inherit" option here.
 *
 * Zero network requests: no `@import`, no `url(...)`, no `https://` — the
 * font stack is the system stack, not a web font.
 */
export function themeCss(t: Theme): string {
  const vars = Object.entries(t)
    .filter(([k]) => k !== "logoText" && k !== "logoSvg")   // not colours — never emitted as vars
    .map(([k, v]) => `  --${kebab(k)}: ${v};`)
    .join("\n");
  return `:root {
${vars}
  --bg: #ffffff;
  --fg: #1a1c2b;
  --surface: #f7f8fc;
  --border: var(--line);
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #14161f;
    --fg: #e9eaf2;
    --surface: #1c1f2c;
    --border: #2b2f42;
    --brand: ${t.glow};
    --line: #2b2f42;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--fg);
  font-family: ${t.fontFamily};
}`;
}
