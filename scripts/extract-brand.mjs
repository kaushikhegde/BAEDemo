#!/usr/bin/env node
// Extract a client's brand — palette, logo, wordmark, type — from a live URL and
// write it as the companion app's theme.
//
//   node scripts/extract-brand.mjs <url> <project>
//   node scripts/extract-brand.mjs <url> <project> --dry
//
// Writes projects/<project>/design/style-guides/theme.json, which is the ONLY
// input the companion-app renderer takes for branding. One project renders one
// companion app, so the theme is per project, not per feature. Also writes
// brand-source.json beside it recording where each value came from, so a wrong
// colour can be traced to the rule that picked it rather than re-guessed.
//
// The logo is inlined as a data URI: the rendered page makes zero network
// requests, so a linked logo would simply not load for the client.
//
// Flags
//   --dry        print what would be written; touch nothing
//   --no-logo    skip logo extraction (palette and wordmark only)
//   --force      overwrite a theme.json that was hand-edited

import fs from "node:fs/promises";
import path from "node:path";
import { WORK_ROOT } from "./lib/roots.mjs";

// The project tree this run operates on. See scripts/lib/roots.mjs for why
// this is not the same question as "where does this code live".
const WORKSPACE = WORK_ROOT;
const SAFE_NAME = /^[A-Za-z0-9._ &-]+$/;
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const MAX_CSS_FILES = 10;
const MAX_CSS_BYTES = 3_000_000;
const MAX_LOGO_BYTES = 256_000;
const FETCH_TIMEOUT_MS = 20_000;

const die = (msg) => { console.error(`\n[extract-brand] ${msg}\n`); process.exit(1); };
const rel = (p) => path.relative(WORKSPACE, p) || ".";

// ---------------------------------------------------------------------------
// Colour
// ---------------------------------------------------------------------------

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const hex2 = (n) => clamp(Math.round(n), 0, 255).toString(16).padStart(2, "0");

function parseColor(raw) {
  if (!raw) return null;
  const s = String(raw).trim().toLowerCase();

  let m = /^#([0-9a-f]{3,8})$/.exec(s);
  if (m) {
    const h = m[1];
    if (h.length === 3 || h.length === 4) return { r: parseInt(h[0] + h[0], 16), g: parseInt(h[1] + h[1], 16), b: parseInt(h[2] + h[2], 16) };
    if (h.length === 6 || h.length === 8) return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
    return null;
  }
  // rgb(0 0 0) and rgb(0, 0, 0) and rgba(...) — modern and legacy syntax
  m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(s);
  if (m) return { r: +m[1], g: +m[2], b: +m[3] };

  m = /^hsla?\(\s*([\d.]+)(?:deg)?[\s,]+([\d.]+)%[\s,]+([\d.]+)%/.exec(s);
  if (m) return hsl2rgb(+m[1] / 360, +m[2] / 100, +m[3] / 100);

  return null;
}

const toHex = ({ r, g, b }) => `#${hex2(r)}${hex2(g)}${hex2(b)}`;

function rgb2hsl({ r, g, b }) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return { h, s, l };
}

function hsl2rgb(h, s, l) {
  if (s === 0) { const v = l * 255; return { r: v, g: v, b: v }; }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return { r: f(h + 1 / 3) * 255, g: f(h) * 255, b: f(h - 1 / 3) * 255 };
}

// Darken toward black in HSL, keeping hue and saturation — that is what a brand's
// "deep" variant is, and it keeps the header gradient reading as one colour.
function darken(hexStr, amount = 0.18) {
  const c = parseColor(hexStr);
  if (!c) return hexStr;
  const { h, s, l } = rgb2hsl(c);
  return toHex(hsl2rgb(h, s, clamp(l - amount, 0.04, 1)));
}

const hueDistance = (a, b) => {
  const d = Math.abs(a - b) % 1;
  return Math.min(d, 1 - d);
};

// A brand colour is saturated and mid-range. Greys, near-whites and near-blacks
// are page furniture, not brand — they dominate any frequency count if kept.
const isBrandCandidate = ({ h, s, l }) => s >= 0.18 && l >= 0.12 && l <= 0.86;

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

async function get(url, { as = "text", maxBytes = MAX_CSS_BYTES } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: ctl.signal,
      headers: { "user-agent": UA, accept: as === "text" ? "text/html,text/css,*/*" : "*/*" },
    });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) return null;
    return as === "text"
      ? { body: buf.toString("utf8"), url: res.url, type: res.headers.get("content-type") || "" }
      : { buf, url: res.url, type: res.headers.get("content-type") || "" };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

function attr(tag, name) {
  const m = new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
  return m ? (m[2] ?? m[3] ?? m[4] ?? "").trim() : null;
}

function collectStylesheets(html, baseUrl) {
  const urls = [];
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    const rels = (attr(tag, "rel") || "").toLowerCase();
    if (!rels.includes("stylesheet")) continue;
    const href = attr(tag, "href");
    if (!href) continue;
    try { urls.push(new URL(href, baseUrl).href); } catch { /* malformed href */ }
  }
  return [...new Set(urls)].slice(0, MAX_CSS_FILES);
}

const inlineStyles = (html) => [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join("\n");

// Colours declared on a custom property whose NAME says brand. This is the
// strongest signal there is — a design system naming its own primary — so these
// are scored far above frequency.
function namedBrandColors(css) {
  const out = [];
  const re = /--([a-z0-9-]*(?:brand|primary|accent|theme|main|corporate)[a-z0-9-]*)\s*:\s*([^;{}]+)/gi;
  for (const m of css.matchAll(re)) {
    const c = parseColor(m[2]);
    if (c) out.push({ name: m[1].toLowerCase(), hex: toHex(c) });
  }
  return out;
}

function colorFrequency(css) {
  const counts = new Map();
  const bump = (raw, weight = 1) => {
    const c = parseColor(raw);
    if (!c) return;
    const hex = toHex(c);
    counts.set(hex, (counts.get(hex) || 0) + weight);
  };
  for (const m of css.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) bump(m[0]);
  for (const m of css.matchAll(/rgba?\([^)]*\)/gi)) bump(m[0]);
  for (const m of css.matchAll(/hsla?\([^)]*\)/gi)) bump(m[0]);
  return counts;
}

function pickPalette(css, metaThemeColor) {
  const evidence = {};
  const named = namedBrandColors(css);
  const counts = colorFrequency(css);

  const score = new Map();
  const add = (hex, n, why) => {
    const c = parseColor(hex);
    if (!c || !isBrandCandidate(rgb2hsl(c))) return;
    const cur = score.get(hex) || { hex, score: 0, why: [] };
    cur.score += n;
    if (!cur.why.includes(why)) cur.why.push(why);
    score.set(hex, cur);
  };

  // A variable literally called --brand / --primary outranks anything counted.
  for (const { name, hex } of named) {
    const weight = /brand|primary|corporate/.test(name) ? 400 : 180;
    add(hex, weight, `--${name}`);
  }
  if (metaThemeColor) add(metaThemeColor, 300, "meta[theme-color]");
  for (const [hex, n] of counts) add(hex, Math.min(n, 120), "css frequency");

  const ranked = [...score.values()].sort((a, b) => b.score - a.score);
  if (!ranked.length) return null;

  const brand = ranked[0];
  evidence.brand = { hex: brand.hex, score: Math.round(brand.score), from: brand.why };

  // Accent must be visibly a different colour, not a shade of the brand.
  const brandHsl = rgb2hsl(parseColor(brand.hex));
  const accent =
    ranked.slice(1).find((c) => hueDistance(rgb2hsl(parseColor(c.hex)).h, brandHsl.h) > 0.09) || null;
  if (accent) evidence.accent = { hex: accent.hex, score: Math.round(accent.score), from: accent.why };

  return {
    brand: brand.hex,
    brandDeep: darken(brand.hex, 0.16),
    // No second colour on the page: rotate the brand rather than invent one at
    // random, so the pair still reads as deliberate.
    accent: accent ? accent.hex : toHex(hsl2rgb((brandHsl.h + 0.5) % 1, clamp(brandHsl.s * 0.85, 0.25, 0.7), 0.52)),
    _evidence: evidence,
    _accentDerived: !accent,
    _ranked: ranked.slice(0, 8).map((c) => ({ hex: c.hex, score: Math.round(c.score), from: c.why })),
  };
}

function pickWordmark(html, baseUrl) {
  const meta = (prop) => {
    const re = new RegExp(`<meta\\b[^>]*(?:property|name)\\s*=\\s*["']${prop}["'][^>]*>`, "i");
    const m = re.exec(html);
    return m ? attr(m[0], "content") : null;
  };
  const site = meta("og:site_name") || meta("application-name") || meta("apple-mobile-web-app-title");
  if (site) return { text: site.trim(), from: "og:site_name" };

  const t = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (t) {
    // "Acme Corp | Home" and "Home – Acme Corp" both happen; take the longest part.
    const parts = t[1].replace(/\s+/g, " ").trim().split(/\s*[|–—·-]\s*/).filter(Boolean);
    const best = parts.sort((a, b) => b.length - a.length)[0];
    if (best && best.length <= 40) return { text: best, from: "<title>" };
  }
  try {
    return { text: new URL(baseUrl).hostname.replace(/^www\./, ""), from: "hostname" };
  } catch {
    return { text: "Companion", from: "fallback" };
  }
}

// Keyword families and the system-font aliases. A stack made only of these is a
// CSS reset (`code,kbd,pre{font-family:monospace,monospace}`), not a brand face.
const GENERIC_FAMILY = new Set([
  "monospace", "serif", "sans-serif", "cursive", "fantasy", "system-ui",
  "ui-monospace", "ui-serif", "ui-sans-serif", "ui-rounded", "math", "emoji",
  "inherit", "initial", "unset", "revert", "none", "auto",
  "-apple-system", "blinkmacsystemfont", "-moz-fixed",
]);

function cleanStack(raw) {
  const s = raw.replace(/\s+/g, " ").replace(/["']/g, "").trim().replace(/[,\s]+$/, "");
  if (!s || s.length > 160) return null;
  // A var() reference resolves to a token this script cannot see — unusable.
  if (/var\(|url\(|[;{}<>\\]/i.test(s)) return null;
  const families = s.split(",").map((f) => f.trim().toLowerCase()).filter(Boolean);
  if (!families.length) return null;
  if (!families.some((f) => !GENERIC_FAMILY.has(f) && f.length > 1)) return null;
  return s;
}

function pickFontFamily(css) {
  const counts = new Map();
  let fromBody = null;

  for (const rule of css.matchAll(/([^{}]{0,400})\{([^{}]{0,4000})\}/g)) {
    const decl = /font-family\s*:\s*([^;}]+)/i.exec(rule[2]);
    if (!decl) continue;
    const stack = cleanStack(decl[1]);
    if (!stack) continue;

    // Prefer what body / html / :root declares — that is the page's reading face.
    const selectors = rule[1].split(",").map((s) => s.trim().toLowerCase());
    if (!fromBody && selectors.some((s) => s === "body" || s === "html" || s === ":root")) fromBody = stack;
    counts.set(stack, (counts.get(stack) || 0) + 1);
  }
  if (fromBody) return { stack: fromBody, from: "body/html/:root font-family" };

  const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  return top ? { stack: top[0], from: `most-used font-family (${top[1]} rules)` } : null;
}

function findLogoCandidates(html, baseUrl) {
  const out = [];
  const push = (href, why, rank) => {
    if (!href || /^data:/i.test(href)) return;
    try { out.push({ url: new URL(href, baseUrl).href, why, rank }); } catch { /* malformed */ }
  };

  // A header <img> whose src/alt/class says "logo" is the real wordmark; a
  // favicon is the fallback because it is usually a cropped monogram.
  const head = html.slice(0, 200_000);
  for (const m of head.matchAll(/<img\b[^>]*>/gi)) {
    const tag = m[0];
    const hay = `${attr(tag, "src") || ""} ${attr(tag, "alt") || ""} ${attr(tag, "class") || ""} ${attr(tag, "id") || ""}`.toLowerCase();
    if (!/logo|brand|wordmark/.test(hay)) continue;
    push(attr(tag, "src") || attr(tag, "data-src"), "img[logo]", /\.svg(\?|$)/i.test(hay) ? 10 : 20);
  }
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    const relv = (attr(tag, "rel") || "").toLowerCase();
    if (!/icon/.test(relv)) continue;
    const sizes = attr(tag, "sizes") || "";
    const px = parseInt(sizes, 10) || 0;
    push(attr(tag, "href"), `link[${relv}${sizes ? ` ${sizes}` : ""}]`, px >= 180 ? 40 : 60);
  }
  for (const m of html.matchAll(/<meta\b[^>]*property\s*=\s*["']og:image["'][^>]*>/gi)) {
    push(attr(m[0], "content"), "og:image", 90);
  }
  return out.sort((a, b) => a.rank - b.rank);
}

const MIME = { ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".ico": "image/x-icon" };

async function fetchLogo(candidates) {
  for (const c of candidates.slice(0, 6)) {
    const got = await get(c.url, { as: "buffer", maxBytes: MAX_LOGO_BYTES });
    if (!got) continue;
    let type = (got.type.split(";")[0] || "").trim();
    if (!type.startsWith("image/")) type = MIME[path.extname(new URL(got.url).pathname).toLowerCase()] || "";
    if (!type.startsWith("image/")) continue;
    return { dataUri: `data:${type};base64,${got.buf.toString("base64")}`, url: got.url, bytes: got.buf.length, type, why: c.why };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const argv = process.argv.slice(2);
  const flags = new Set(argv.filter((a) => a.startsWith("--")));
  for (const f of flags) {
    if (!["--dry", "--no-logo", "--force"].includes(f)) die(`unknown flag ${f}`);
  }
  // The brand is the CLIENT's, and one project renders one companion app, so the
  // theme is per project. A trailing feature name is accepted and ignored rather
  // than rejected, because older agent instructions still pass one.
  const [rawUrl, project, ...rest] = argv.filter((a) => !a.startsWith("--"));

  if (!rawUrl || !project) {
    die(`Usage: node scripts/extract-brand.mjs <url> <project> [--dry] [--no-logo]\n\n` +
        `  e.g. npm run brand -- https://www.sapowernetworks.com.au SAPN`);
  }
  if (!SAFE_NAME.test(project)) die("project name contains unexpected characters");
  if (rest.length) console.warn(`[extract-brand] ignoring "${rest.join(" ")}" — branding is project-level now`);

  let url;
  try { url = new URL(/^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`); } catch { die(`not a URL: ${rawUrl}`); }
  if (!/^https?:$/.test(url.protocol)) die(`only http(s) URLs are supported, got ${url.protocol}`);

  const projectRoot = path.join(WORKSPACE, "projects", project);
  try { await fs.access(projectRoot); } catch { die(`no such project: projects/${project}`); }

  console.log(`\n[extract-brand] reading ${url.href}\n`);
  const page = await get(url.href);
  if (!page) die(`could not fetch ${url.href} (network blocked, timeout, non-200, or larger than ${MAX_CSS_BYTES} bytes)`);

  const html = page.body;
  const baseUrl = page.url;

  // Stylesheets carry the design tokens; the inline <style> block usually carries
  // the above-the-fold overrides. Both matter, so both are concatenated.
  const sheets = collectStylesheets(html, baseUrl);
  let css = inlineStyles(html);
  const fetched = [];
  for (const href of sheets) {
    const got = await get(href);
    if (!got) continue;
    css += `\n${got.body}`;
    fetched.push(href);
    if (css.length > MAX_CSS_BYTES) break;
  }
  console.log(`  html   ${html.length.toLocaleString()} bytes`);
  console.log(`  css    ${css.length.toLocaleString()} bytes from ${fetched.length}/${sheets.length} stylesheet(s) + inline\n`);

  const metaTheme = (() => {
    const m = /<meta\b[^>]*name\s*=\s*["']theme-color["'][^>]*>/i.exec(html);
    return m ? attr(m[0], "content") : null;
  })();

  const palette = pickPalette(css, metaTheme);
  if (!palette) die(`no brand-like colour found on ${baseUrl}\nThe page may render its CSS via JavaScript. Try a deeper page, or write theme.json by hand.`);

  const wordmark = pickWordmark(html, baseUrl);
  const font = pickFontFamily(css);
  const fontFamily = font?.stack || null;
  const logo = flags.has("--no-logo") ? null : await fetchLogo(findLogoCandidates(html, baseUrl));

  const theme = {
    brand: palette.brand,
    brandDeep: palette.brandDeep,
    accent: palette.accent,
    logoText: wordmark.text,
    ...(logo ? { logoSrc: logo.dataUri } : {}),
    ...(fontFamily ? { fontFamily } : {}),
  };

  const source = {
    extractedFrom: baseUrl,
    stylesheets: fetched,
    brand: palette._evidence.brand || null,
    accent: palette._accentDerived
      ? { hex: palette.accent, from: ["derived — no second brand colour found; hue-rotated from brand"] }
      : palette._evidence.accent || null,
    brandDeep: { hex: palette.brandDeep, from: ["derived — brand darkened 16% in HSL"] },
    logoText: wordmark,
    fontFamily: font ? { value: font.stack, from: font.from } : null,
    logo: logo ? { url: logo.url, type: logo.type, bytes: logo.bytes, from: logo.why } : null,
    metaThemeColor: metaTheme || null,
    rankedCandidates: palette._ranked,
  };

  console.log(`  brand      ${theme.brand}   ${(source.brand?.from || []).join(", ")}`);
  console.log(`  brandDeep  ${theme.brandDeep}   derived`);
  console.log(`  accent     ${theme.accent}   ${(source.accent?.from || []).join(", ")}`);
  console.log(`  logoText   ${theme.logoText}   (${wordmark.from})`);
  console.log(`  logo       ${logo ? `${logo.type}, ${(logo.bytes / 1024).toFixed(1)} KB, inlined  (${logo.why})` : "none found"}`);
  console.log(`  font       ${fontFamily || "none found — renderer default"}`);
  console.log(`\n  other candidates considered:`);
  for (const c of palette._ranked.slice(1, 6)) console.log(`    ${c.hex}  score ${c.score}  ${c.from.join(", ")}`);

  const outDir = path.join(projectRoot, "design", "style-guides");
  const themePath = path.join(outDir, "theme.json");

  if (flags.has("--dry")) {
    console.log(`\n  --dry: would write ${rel(themePath)}\n`);
    console.log(JSON.stringify({ ...theme, logoSrc: logo ? `<data URI, ${(logo.bytes / 1024).toFixed(1)} KB>` : undefined }, null, 2));
    console.log("");
    return;
  }

  let existing = null;
  try { existing = JSON.parse(await fs.readFile(themePath, "utf8")); } catch { /* none yet */ }
  if (existing && !existing._extractedFrom && !flags.has("--force")) {
    die(`${rel(themePath)} exists and was NOT written by this script — it looks hand-authored.\nRe-run with --force to overwrite it.`);
  }

  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(themePath, `${JSON.stringify({ ...theme, _extractedFrom: baseUrl }, null, 2)}\n`);
  await fs.writeFile(path.join(outDir, "brand-source.json"), `${JSON.stringify(source, null, 2)}\n`);

  console.log(`\n  wrote ${rel(themePath)}`);
  console.log(`  wrote ${rel(path.join(outDir, "brand-source.json"))}   (why each value was chosen)`);
  console.log(`\nRe-render the companion app to apply it:\n  npm run app ${project}\n`);
}

main().catch((e) => die(e.stack || String(e)));
