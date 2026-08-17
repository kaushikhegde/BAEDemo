// The Scyne palette and the CSS it renders to. `Theme`'s SHAPE is already
// declared in ../config.ts (so config.ts can express `theme?: Partial<Theme>`
// without depending on this file, which doesn't exist until this task) — this
// module supplies the VALUES and the rendering, and must not redeclare the
// interface.

import type { Theme } from "../config.js";

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
};

/**
 * Merge a consumer's override over the Scyne default. Naming only the tokens
 * that differ (e.g. `{ brand: "#1f4c71", logoText: "Acme Delivery" }`) keeps
 * every other token — a consumer never has to restate the whole palette to
 * rebrand one colour.
 */
export function resolveTheme(override: Partial<Theme> = {}): Theme {
  return { ...SCYNE_THEME, ...override };
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
    .filter(([k]) => k !== "logoText")   // not a colour — never emitted as a var
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
